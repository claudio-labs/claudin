#!/usr/bin/env bun
/**
 * Context-relief A/B — two claudin binaries on the same long, mixed
 * search → read → edit session.
 *
 * What it measures: how each build pays for context relief over a session
 * long enough to cross the relief triggers — prompt-cache writes and prefix
 * breaks (the cost side), and Read calls on paths the model had already read
 * (the information-loss side, which the token columns cannot show). It was
 * written to gate `perf(cache): unify context relief into one usage-driven
 * policy` against the v1.1.24 build (`19b5c673`); see
 * docs/tech/cache/context-relief-policy.md.
 *
 * Protocol:
 *  - A throwaway workspace under the OS temp dir holding a byte-identical
 *    copy of `src/agent/compact/` + `src/agent/cache/` from this checkout
 *    (real files, 1–70 KB), rebuilt before every arm of every rep. Never this
 *    checkout — session state is keyed by project directory.
 *  - ONE session per arm, driven turn by turn over `--input-format
 *    stream-json` (identical pacing by construction, like
 *    cache-lockstep-bench.ts). The turn script is deterministic and comes in
 *    three phases of `--per-phase` turns (default 10, i.e. 30 turns):
 *      1. SEARCH — Grep one symbol per turn (small results, cache warms);
 *      2. READ   — Read the largest files in full, one per turn (the
 *                  context grows fast; this is where relief fires);
 *      3. EDIT   — insert a marker comment in each file read in phase 2.
 *                  The model can edit from what it read, or look it up
 *                  again: every non-Edit tool call in this phase is the
 *                  information-loss signal (`edit-turn lookups`). Count
 *                  ALL tools — measured 2026-09-03, v1.1.24 relocated with
 *                  Grep and the policy build with Read(outline), so the
 *                  Read-only `re-reads` column split 8 vs 15 on equal loss.
 *    Small on purpose — it is for watching how the cache behaves across
 *    the relief triggers, not a cost claim. Raise `--per-phase` to push
 *    past the old display cap (300 messages) on a bigger workload.
 *  - Sonnet 5 pinned on both arms. A run reporting another model is flagged.
 *  - Arm order ALTERNATES across reps; whichever runs first pays the cold
 *    prompt cache.
 *  - `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true` on both arms so the server
 *    `clear_tool_uses` does not confound (the measured week ran without it).
 *  - Graded: the marker comments that actually landed. A cheap arm that
 *    skipped edits is not a win.
 *
 * Usage:
 *   bun scripts/bench/ab/context-relief-ab.ts --dry-run
 *   bun scripts/bench/ab/context-relief-ab.ts \
 *     --bin-a=v1.1.24:/tmp/claudin-v1.1.24/bin/claudin \
 *     --bin-b=branch:./bin/claudin --reps=3
 *   bun scripts/bench/ab/context-relief-ab.ts ... --window=140000 --json
 *
 * `--window` caps the context window (CLAUDIN_AUTO_COMPACT_WINDOW, honored by
 * both builds); without it a native-1M model never reaches the trigger in 30
 * turns and the two arms are indistinguishable.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { REPO_ROOT } from '../../repoRoot'
import { estimateCost, toolCallsFrom, type TimelineRow } from './cliUsage'

const DEFAULT_MODEL = 'claude-sonnet-5'
const MARKER = 'relief-ab'
const SOURCE_DIRS = ['src/agent/compact', 'src/agent/cache']

// ---------------------------------------------------------------------------
// Workspace + turn script.
// ---------------------------------------------------------------------------

function buildWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'relief-ab-'))
  for (const dir of SOURCE_DIRS) {
    const dst = join(root, dir)
    mkdirSync(dst, { recursive: true })
    cpSync(join(REPO_ROOT, dir), dst, { recursive: true })
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'relief-ab', private: true, type: 'module' }, null, 2) + '\n')
  return root
}

type Corpus = { files: string[]; large: string[]; symbols: string[] }

/** Deterministic: `files` sorted by path, `large` by size descending. */
function corpusFrom(root: string): Corpus {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.ts')) continue
      files.push(`${dir}/${name}`)
    }
  }
  files.sort()
  // Implementation files with a top-level export (the edit phase's anchor),
  // biggest first so the read phase grows the context as fast as it can.
  const large = files
    .filter(f => !f.endsWith('.test.ts') && /^export (function|const)\b/m.test(readFileSync(join(root, f), 'utf8')))
    .sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size)
    .slice(0, 12)
  const symbols = [
    'applyStableStubs',
    'getClippedIds',
    'pinShieldsBlock',
    'getCacheProfile',
    'findTurnCutoffIndex',
    'microcompactMessages',
    'getEffectiveContextWindowSize',
    'stubOneBlock',
    'resetClippedIds',
    'addClippedIds',
    'isClipStubContent',
    'getAutoCompactThreshold',
  ]
  return { files, large, symbols }
}

type Turn = { text: string; kind: 'grep' | 'read' | 'edit' }

function turnScript(c: Corpus, perPhase: number): Turn[] {
  const turns: Turn[] = []
  for (let i = 0; i < perPhase; i++) {
    const sym = c.symbols[i % c.symbols.length]!
    turns.push({ kind: 'grep', text: `Use Grep to find every file under src/ that mentions \`${sym}\` and reply with the list of file paths, nothing else.` })
  }
  for (let i = 0; i < perPhase; i++) {
    const big = c.large[i % c.large.length]!
    turns.push({ kind: 'read', text: `Read ${big} in full (pass view: 'full') and reply with a one-line summary.` })
  }
  for (let i = 0; i < perPhase; i++) {
    const target = c.large[i % c.large.length]!
    turns.push({
      kind: 'edit',
      text: `In ${target}, insert the single comment line \`// ${MARKER}:${i + 1}\` immediately ABOVE the first line that starts with \`export function\` or \`export const\` (use the Edit tool). Reply "done" when the edit is applied.`,
    })
  }
  return turns
}

/** Grade: how many edit markers landed, each exactly once, above an export. */
function verify(root: string, expected: number): { landed: number; expected: number; duplicated: number } {
  const seen = new Map<number, number>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const lines = readFileSync(p, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const m = line.match(new RegExp(`^\\s*//\\s*${MARKER}:(\\d+)\\s*$`))
        if (!m) return
        const n = Number(m[1])
        const next = lines[i + 1] ?? ''
        if (!/^export (function|const)\b/.test(next)) return
        seen.set(n, (seen.get(n) ?? 0) + 1)
      })
    }
  }
  walk(join(root, 'src'))
  let landed = 0
  let duplicated = 0
  for (let i = 1; i <= expected; i++) {
    const c = seen.get(i) ?? 0
    if (c >= 1) landed++
    if (c > 1) duplicated++
  }
  return { landed, expected, duplicated }
}

// ---------------------------------------------------------------------------
// One arm = one session.
// ---------------------------------------------------------------------------

type ArmResult = {
  label: string
  bin: string
  rep: number
  exitCode: number
  wallMs: number
  turnsDone: number
  turnsPlanned: number
  apiCalls: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  rw: number
  prefixBreaks: number
  breakTokens: number
  peakContext: number
  endContext: number
  costUsd: number | null
  estCostUsd: number
  model: string | null
  toolCalls: number
  toolMix: Record<string, number>
  reads: number
  rereads: number
  editLookups: number
  verdict: { landed: number; expected: number; duplicated: number }
  timeline: TimelineRow[]
  workspace: string
  stderrHead: string
}

type Args = {
  binA: { label: string; path: string } | null
  binB: { label: string; path: string } | null
  reps: number
  perPhase: number
  model: string
  turnTimeoutMs: number
  window: number | null
  keep: boolean
  json: boolean
  dryRun: boolean
}

function parseBin(spec: string): { label: string; path: string } {
  const i = spec.indexOf(':')
  if (i <= 0) throw new Error(`--bin-x expects <label>:<path>, got ${spec}`)
  return { label: spec.slice(0, i), path: resolve(spec.slice(i + 1)) }
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    binA: null,
    binB: null,
    reps: 1,
    perPhase: 10,
    model: DEFAULT_MODEL,
    turnTimeoutMs: 300_000,
    window: null,
    keep: false,
    json: false,
    dryRun: false,
  }
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--json') a.json = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--per-phase=')) a.perPhase = Number(x.slice('--per-phase='.length))
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--window=')) a.window = Number(x.slice('--window='.length))
    else if (x.startsWith('--turn-timeout=')) a.turnTimeoutMs = Number(x.slice('--turn-timeout='.length))
    else if (x.startsWith('--bin-a=')) a.binA = parseBin(x.slice('--bin-a='.length))
    else if (x.startsWith('--bin-b=')) a.binB = parseBin(x.slice('--bin-b='.length))
    else throw new Error(`unknown arg ${x}`)
  }
  return a
}

async function runArm(arm: { label: string; path: string }, rep: number, args: Args): Promise<ArmResult> {
  const cwd = buildWorkspace()
  const corpus = corpusFrom(cwd)
  const turns = turnScript(corpus, args.perPhase)

  const child = spawn(
    arm.path,
    [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
      '--model', args.model,
      '--permission-mode', 'bypassPermissions',
    ],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Headless `-p` drains auto-backgrounded sub-agents non-deterministically;
        // an orphaned one hides its tokens from the parent's usage.
        CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
        // Both arms without the server-side clear_tool_uses — the client
        // policy is what is under test.
        CLAUDIN_DISABLE_EXPERIMENTAL_BETAS: 'true',
        // `--window` shrinks the context window both arms see (same env in
        // both builds) so a 30-turn session crosses the relief trigger.
        ...(args.window ? { CLAUDIN_AUTO_COMPACT_WINDOW: String(args.window) } : {}),
      },
    },
  )

  const events: Record<string, unknown>[] = []
  const eventKind: Turn['kind'][] = []
  let activeKind: Turn['kind'] = 'grep'
  const rows = new Map<string, TimelineRow>()
  const order: string[] = []
  let servedModel: string | null = null
  let costUsd: number | null = null
  let resolveTurn: (() => void) | null = null

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', line => {
    const s = line.trim()
    if (!s.startsWith('{')) return
    let v: Record<string, unknown>
    try {
      v = JSON.parse(s) as Record<string, unknown>
    } catch {
      return
    }
    events.push(v)
    eventKind.push(activeKind)
    if (v.type === 'assistant') {
      const m = (v.message ?? {}) as Record<string, unknown>
      if (!servedModel && typeof m.model === 'string') servedModel = m.model
      const u = (m.usage ?? {}) as Record<string, number>
      const id = String(m.id ?? '')
      if (!id) return
      const row: TimelineRow = {
        in: u.input_tokens ?? 0,
        out: u.output_tokens ?? 0,
        cR: u.cache_read_input_tokens ?? 0,
        cW: u.cache_creation_input_tokens ?? 0,
      }
      const prev = rows.get(id)
      if (!prev) {
        order.push(id)
        rows.set(id, row)
        return
      }
      // MAX per field: usage rows repeat per content block and output grows.
      rows.set(id, {
        in: Math.max(prev.in, row.in),
        out: Math.max(prev.out, row.out),
        cR: Math.max(prev.cR, row.cR),
        cW: Math.max(prev.cW, row.cW),
      })
    } else if (v.type === 'result') {
      if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd
      resolveTurn?.()
    }
  })

  const stderrChunks: string[] = []
  child.stderr!.on('data', d => stderrChunks.push(String(d)))
  const exitPromise = new Promise<number>(res => child.on('close', c => res(c ?? -1)))

  const send = (text: string) => {
    child.stdin!.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
    )
  }

  const t0 = performance.now()
  let turnsDone = 0
  for (const turn of turns) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<void>((res, rej) => {
      resolveTurn = () => {
        clearTimeout(timer)
        res()
      }
      timer = setTimeout(() => rej(new Error(`turn ${turnsDone + 1} (${turn.kind}) timed out`)), args.turnTimeoutMs)
    })
    activeKind = turn.kind
    send(turn.text)
    try {
      await done
    } catch (e) {
      console.error(`\n${arm.label} rep ${rep}: ${String(e)}`)
      clearTimeout(timer)
      break
    }
    turnsDone++
    process.stderr.write(`\r${arm.label} rep ${rep}: turn ${turnsDone}/${turns.length} (${turn.kind})   `)
  }
  child.stdin!.end()
  const exitCode = await Promise.race([exitPromise, new Promise<number>(r => setTimeout(() => r(-2), 15_000))])
  child.kill()
  const wallMs = performance.now() - t0
  process.stderr.write('\n')

  const timeline = order.map(id => rows.get(id)!)
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0
  let prefixBreaks = 0, breakTokens = 0, prevCr = 0
  let peakContext = 0
  for (const r of timeline) {
    input += r.in; output += r.out; cacheRead += r.cR; cacheCreation += r.cW
    // A cached prefix only grows within a session; a drop means part of it
    // was rewritten, and the write that follows is what the drop cost.
    if (r.cR < prevCr - 2_000) {
      prefixBreaks++
      breakTokens += r.cW
    }
    prevCr = r.cR
    peakContext = Math.max(peakContext, r.in + r.cR + r.cW)
  }
  const last = timeline[timeline.length - 1]
  const endContext = last ? last.in + last.cR + last.cW : 0

  const calls = toolCallsFrom(events)
  const toolMix: Record<string, number> = {}
  for (const c of calls) toolMix[c.name] = (toolMix[c.name] ?? 0) + 1
  // Re-reads: a Read on a path already read in this session. The script
  // never asks for one, so every re-read is the model recovering content it
  // had lost — the leak the old evictions caused.
  const seenPaths = new Set<string>()
  const seenReadIds = new Set<string>()
  let reads = 0, rereads = 0
  for (const v of events) {
    if (v.type !== 'assistant') continue
    const content = ((v.message ?? {}) as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || block.name !== 'Read') continue
      // The stream repeats an assistant message per content block.
      const id = typeof block.id === 'string' ? block.id : ''
      if (id && seenReadIds.has(id)) continue
      if (id) seenReadIds.add(id)
      const fp = String(((block.input ?? {}) as Record<string, unknown>).file_path ?? '')
      if (!fp) continue
      const rel = relative(cwd, fp)
      reads++
      if (seenPaths.has(rel)) rereads++
      seenPaths.add(rel)
    }
  }

  // Lookups inside edit turns: every tool call that is not the Edit itself.
  // The script asks for edits in files read one phase earlier, so each of
  // these is the model relocating content it no longer has — whichever tool
  // it reaches for (v1.1.24 Greps, the policy build Reads the outline; a
  // Read-only count would miss one arm).
  const seenLookupIds = new Set<string>()
  let editLookups = 0
  events.forEach((v, idx) => {
    if (eventKind[idx] !== 'edit' || v.type !== 'assistant') return
    const content = ((v.message ?? {}) as Record<string, unknown>).content
    if (!Array.isArray(content)) return
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || block.name === 'Edit') continue
      const id = typeof block.id === 'string' ? block.id : ''
      if (id && seenLookupIds.has(id)) continue
      if (id) seenLookupIds.add(id)
      editLookups++
    }
  })

  const verdict = verify(cwd, args.perPhase)
  if (!args.keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label: arm.label,
    bin: arm.path,
    rep,
    exitCode,
    wallMs,
    turnsDone,
    turnsPlanned: turns.length,
    apiCalls: timeline.length,
    input, output, cacheRead, cacheCreation,
    rw: cacheCreation > 0 ? cacheRead / cacheCreation : Infinity,
    prefixBreaks,
    breakTokens,
    peakContext,
    endContext,
    costUsd,
    estCostUsd: estimateCost(servedModel ?? args.model, { input, output, cacheRead, cacheCreation }),
    model: servedModel,
    toolCalls: calls.length,
    toolMix,
    reads,
    rereads,
    editLookups,
    verdict,
    timeline,
    workspace: args.keep ? cwd : '(removed)',
    stderrHead: stderrChunks.join('').slice(0, 800),
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

function printArm(a: ArmResult): void {
  const mix = Object.entries(a.toolMix).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(`  ${a.label} rep ${a.rep}  exit=${a.exitCode}  model=${a.model ?? '?'}  ${(a.wallMs / 1000).toFixed(0)}s`)
  console.log(`    turns ${a.turnsDone}/${a.turnsPlanned}  api calls ${a.apiCalls}  tool calls ${a.toolCalls}  [${mix}]`)
  console.log(`    in ${fmt(a.input)}  out ${fmt(a.output)}  cache read ${fmt(a.cacheRead)}  cache write ${fmt(a.cacheCreation)}  r:w ${a.rw === Infinity ? 'inf' : a.rw.toFixed(1)}:1`)
  console.log(`    prefix breaks ${a.prefixBreaks} (${fmt(a.breakTokens)} rewritten)  peak ctx ${fmt(a.peakContext)}  end ctx ${fmt(a.endContext)}`)
  console.log(`    reads ${a.reads}  re-reads ${a.rereads}  lookups in edit turns ${a.editLookups}  edits landed ${a.verdict.landed}/${a.verdict.expected}${a.verdict.duplicated ? ` (${a.verdict.duplicated} duplicated)` : ''}`)
  console.log(`    cost usd (CLI) ${a.costUsd === null ? 'n/a' : a.costUsd.toFixed(4)}  est ${a.estCostUsd.toFixed(4)}`)
  if (a.apiCalls === 0 && a.stderrHead) console.log(`    STDERR: ${a.stderrHead}`)
}

function dryRun(args: Args): void {
  const root = buildWorkspace()
  const corpus = corpusFrom(root)
  const turns = turnScript(corpus, args.perPhase)
  console.log(`workspace: ${root} (${corpus.files.length} files; ${SOURCE_DIRS.join(', ')})`)
  console.log(`large: ${corpus.large.join(', ')}`)
  console.log(`\n${turns.length} turns for --per-phase=${args.perPhase}:`)
  turns.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)} ${t.kind.padEnd(5)} ${t.text}`))
  // Prove the grader: plant every marker where the edit phase asks for it.
  for (let i = 0; i < args.perPhase; i++) {
    const target = join(root, corpus.large[i % corpus.large.length]!)
    const lines = readFileSync(target, 'utf8').split('\n')
    const at = lines.findIndex(l => /^export (function|const)\b/.test(l))
    lines.splice(at, 0, `// ${MARKER}:${i + 1}`)
    writeFileSync(target, lines.join('\n'))
  }
  const full = verify(root, args.perPhase)
  console.log(`\ngrader: planted ${args.perPhase} → landed ${full.landed}/${full.expected}, duplicated ${full.duplicated}`)
  rmSync(root, { recursive: true, force: true })
  if (full.landed !== args.perPhase) {
    console.error('grader does not recognize its own reference — fix the fixture before spending tokens')
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    dryRun(args)
    return
  }
  if (!args.binA || !args.binB) {
    console.error('need --bin-a=<label>:<path> and --bin-b=<label>:<path>')
    process.exit(1)
  }
  for (const b of [args.binA, args.binB]) {
    if (!existsSync(b.path)) {
      console.error(`${b.label}: ${b.path} not found`)
      process.exit(1)
    }
  }

  const runs: ArmResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    // Alternate: odd reps A first, even reps B first.
    const orderArms = rep % 2 === 1 ? [args.binA, args.binB] : [args.binB, args.binA]
    for (const arm of orderArms) {
      const r = await runArm(arm, rep, args)
      runs.push(r)
      printArm(r)
      if (r.model && !r.model.includes('sonnet-5')) console.log(`    ⚠ served model ${r.model} ≠ ${args.model}: do not compare cost across tiers`)
    }
  }

  const byLabel = (label: string) => runs.filter(r => r.label === label)
  const A = byLabel(args.binA.label)
  const B = byLabel(args.binB.label)
  const med = (rs: ArmResult[], k: keyof ArmResult) => median(rs.map(r => Number(r[k]) || 0))
  console.log(`\n=== ${args.binA.label} vs ${args.binB.label}  (median of ${args.reps}, model ${args.model}, ${args.perPhase} turns per phase, window ${args.window ?? 'native'}) ===`)
  const line = (name: string, k: keyof ArmResult, f: (n: number) => string = fmt) =>
    console.log(`  ${name.padEnd(18)} ${f(med(A, k)).padStart(10)}  ${f(med(B, k)).padStart(10)}`)
  console.log(`  ${''.padEnd(18)} ${args.binA.label.padStart(10)}  ${args.binB.label.padStart(10)}`)
  line('cache write', 'cacheCreation')
  line('cache read', 'cacheRead')
  line('uncached input', 'input')
  line('r:w', 'rw', n => `${n.toFixed(1)}:1`)
  line('prefix breaks', 'prefixBreaks', String)
  line('break tokens', 'breakTokens')
  line('peak context', 'peakContext')
  line('re-reads', 'rereads', String)
  line('edit-turn lookups', 'editLookups', String)
  console.log(`  ${'edits landed'.padEnd(18)} ${A.map(r => `${r.verdict.landed}/${r.verdict.expected}`).join(' ').padStart(10)}  ${B.map(r => `${r.verdict.landed}/${r.verdict.expected}`).join(' ').padStart(10)}`)
  line('cost usd (CLI)', 'costUsd', n => `$${n.toFixed(3)}`)
  line('est cost usd', 'estCostUsd', n => `$${n.toFixed(3)}`)
  if (args.reps < 3) console.log(`  ↑ ${args.reps} rep(s): directional only. Re-run with --reps=3 and compare RANGES, not medians.`)

  if (args.json) {
    const out = join(REPO_ROOT, 'scripts', 'bench', 'ab', 'context-relief-ab.json')
    writeFileSync(out, JSON.stringify(runs, null, 2))
    console.log(`\njson → ${out}`)
  }
}

main()
