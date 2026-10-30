#!/usr/bin/env bun
/**
 * Context-relief A/B — claudin builds, env variants of one build and Claude
 * Code, each on the same long, mixed search → read → edit session.
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
 *  - Sonnet 5 pinned on every arm. A run reporting another model is flagged.
 *  - Arm order ROTATES across reps, so each arm takes the cold first slot in
 *    turn. `--parallel` runs a rep's arms at once instead: every arm starts
 *    cold, at the same hour.
 *  - `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true` on every arm so the server
 *    `clear_tool_uses` does not confound (the measured week ran without it).
 *    The host session's CLAUDECODE / CLAUDE_CODE_* / CLAUDIN_* variables
 *    never reach an arm (session-cache-ab's `armEnv`); an arm's own variables
 *    come from `--variant=<label>:K=V,…`, which runs `--bin-a`'s binary.
 *  - Cost is priced call by call with session-cache-ab's table (`costOf`),
 *    which knows 1h writes. Claude Code's own figure under-prices them and
 *    cliUsage's `estimateCost` prices every write at 5m; the CLI figure is
 *    printed beside it, never compared.
 *  - `clipped ids` is the last `clip-state` the transcript recorded: the
 *    check that a relief arm's mechanism fired at all (Claude Code has none).
 *  - Graded: the marker comments that actually landed. A cheap arm that
 *    skipped edits is not a win.
 *
 * Usage:
 *   bun scripts/bench/ab/context-relief-ab.ts --dry-run
 *   bun scripts/bench/ab/context-relief-ab.ts \
 *     --bin-a=v1.1.24:/tmp/claudin-v1.1.24/bin/claudin \
 *     --bin-b=branch:./bin/claudin --reps=3
 *   bun scripts/bench/ab/context-relief-ab.ts ... --window=140000 --json
 *   bun scripts/bench/ab/context-relief-ab.ts --bin-a=claudindev:./bin/claudin \
 *     --bin-b=claude:$(command -v claude) --variant=off:CLAUDIN_DISABLE_RELIEF_POLICY=1 \
 *     --variant=placebo:CLAUDIN_BENCH_PLACEBO=1 --window=140000 --reps=5 --parallel
 *
 * `--window` caps the context window (CLAUDIN_AUTO_COMPACT_WINDOW, and Claude
 * Code's CLAUDE_CODE_AUTO_COMPACT_WINDOW); without it a native-1M model never
 * reaches the trigger in 30 turns and the arms are indistinguishable.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { REPO_ROOT } from '../../repoRoot'
import { sessionIdFrom, toolCallsFrom, transcriptPath } from './cliUsage'
import { armEnv, armTable, costOf, type ArmRow } from './session-cache-ab'

const DEFAULT_MODEL = 'claude-sonnet-5'
const MARKER = 'relief-ab'
const SOURCE_DIRS = ['src/agent/compact', 'src/agent/cache']
/** How many of the largest files the read phase reads, by default. */
const DEFAULT_LARGE = 12
/**
 * A read-phase file past this many bytes risks Read's token limit, and a Read
 * it refuses grows nothing. Only applied with `--dirs`, so the default corpus
 * stays the one older runs used.
 */
const MAX_READ_BYTES = 70_000

// ---------------------------------------------------------------------------
// Workspace + turn script.
// ---------------------------------------------------------------------------

function buildWorkspace(dirs: readonly string[] = SOURCE_DIRS): string {
  const root = mkdtempSync(join(tmpdir(), 'relief-ab-'))
  for (const dir of dirs) {
    const dst = join(root, dir)
    mkdirSync(dst, { recursive: true })
    cpSync(join(REPO_ROOT, dir), dst, { recursive: true })
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'relief-ab', private: true, type: 'module' }, null, 2) + '\n')
  return root
}

type Corpus = { files: string[]; large: string[]; symbols: string[] }

/**
 * Deterministic: `files` sorted by path, `large` by size descending. `large`
 * holds the `large` biggest; with more `--per-phase` turns than that the read
 * phase asks for some again, which a Read of an unchanged file answers with a
 * stub, so the context stops growing. `--dirs` and `--large` exist to make the
 * corpus big enough instead.
 */
export function corpusFrom(root: string, dirs: readonly string[] = SOURCE_DIRS, large = DEFAULT_LARGE): Corpus {
  const files: string[] = []
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir))) {
      if (!name.endsWith('.ts') || !statSync(join(root, dir, name)).isFile()) continue
      files.push(`${dir}/${name}`)
    }
  }
  files.sort()
  const fits = (f: string) => dirs === SOURCE_DIRS || statSync(join(root, f)).size <= MAX_READ_BYTES
  // Implementation files with a top-level export (the edit phase's anchor),
  // biggest first so the read phase grows the context as fast as it can.
  const largest = files
    .filter(f => !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && fits(f) && /^export (function|const)\b/m.test(readFileSync(join(root, f), 'utf8')))
    .sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size)
    .slice(0, large)
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
  return { files, large: largest, symbols }
}

type Turn = { text: string; kind: 'grep' | 'read' | 'edit'; path?: string }

function turnScript(c: Corpus, perPhase: number): Turn[] {
  const turns: Turn[] = []
  for (let i = 0; i < perPhase; i++) {
    const sym = c.symbols[i % c.symbols.length]!
    turns.push({ kind: 'grep', text: `Use Grep to find every file under src/ that mentions \`${sym}\` and reply with the list of file paths, nothing else.` })
  }
  for (let i = 0; i < perPhase; i++) {
    const big = c.large[i % c.large.length]!
    turns.push({ kind: 'read', path: big, text: `Read ${big} in full (pass view: 'full') and reply with a one-line summary.` })
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
      const markerRe = new RegExp(`^\\s*//\\s*${MARKER}:(\\d+)\\s*$`)
      lines.forEach((line, i) => {
        const m = line.match(markerRe)
        if (!m) return
        const n = Number(m[1])
        // Past 12 edits a file is edited twice, and both markers go above
        // the same export: skip the other markers stacked below this one.
        let j = i + 1
        while (markerRe.test(lines[j] ?? '')) j++
        if (!/^export (function|const)\b/.test(lines[j] ?? '')) return
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

/** One API call's usage, the 1h/5m split of its cache write included. */
export type UsageRow = { in: number; out: number; cR: number; cW: number; cW5m: number; cW1h: number }

const USAGE_KEYS: ReadonlyArray<keyof UsageRow> = ['in', 'out', 'cR', 'cW', 'cW5m', 'cW1h']

/** One session per rep: a binary, and the variables it runs with on top of the bench's. */
export type ArmSpec = { label: string; path: string; env: Record<string, string> }

export type ArmResult = {
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
  pricedUsd: number
  model: string | null
  toolCalls: number
  toolMix: Record<string, number>
  reads: number
  rereads: number
  editLookups: number
  clippedIds: number
  /** The turn (1-based) of each compact_boundary the session streamed. */
  compactionTurns: number[]
  /** The turn (1-based) of each re-read the script did not ask for. */
  rereadTurns: number[]
  verdict: { landed: number; expected: number; duplicated: number }
  timeline: UsageRow[]
  workspace: string
  stderrHead: string
}

type Args = {
  arms: ArmSpec[]
  reps: number
  perPhase: number
  model: string
  turnTimeoutMs: number
  window: number | null
  keep: boolean
  json: boolean
  dryRun: boolean
  parallel: boolean
  /** `base,placebo,candidate`: print the compaction gate for those labels. */
  gate: [string, string, string] | null
  /** Source dirs the workspace copies and the read phase draws from. */
  dirs: string[]
  /** How many of the largest files the read phase reads. */
  large: number
  /** `--effort` passed to every arm; null leaves each CLI's default. */
  effort: string | null
}

function parseBin(spec: string): ArmSpec {
  const i = spec.indexOf(':')
  if (i <= 0) throw new Error(`--bin-x expects <label>:<path>, got ${spec}`)
  return { label: spec.slice(0, i), path: resolve(spec.slice(i + 1)), env: {} }
}

/**
 * Re-reads the script did not ask for. With `--per-phase` over 12 the read
 * phase asks for the 12 largest files again (`large[i % 12]`), and counting
 * those as the model recovering lost content inflated the column by the
 * repeats. A read past the number of times the script asked for that path is
 * the model's own. Returns the positions in `reads` of those re-reads.
 */
export function rereadsOutsideScript(reads: readonly string[], asked: readonly string[]): number[] {
  const allowed = new Map<string, number>()
  for (const path of asked) allowed.set(path, (allowed.get(path) ?? 0) + 1)
  const seen = new Map<string, number>()
  const extra: number[] = []
  reads.forEach((path, i) => {
    const n = (seen.get(path) ?? 0) + 1
    seen.set(path, n)
    if (n > Math.max(allowed.get(path) ?? 0, 1)) extra.push(i)
  })
  return extra
}

/**
 * The indices in `events` of compact_boundary events, once per uuid (the
 * stream may repeat one).
 */
export function compactionsIn(events: readonly Record<string, unknown>[]): number[] {
  const seen = new Set<unknown>()
  const at: number[] = []
  events.forEach((v, i) => {
    if (v.type !== 'system' || v.subtype !== 'compact_boundary') return
    const key = v.uuid ?? `#${i}`
    if (seen.has(key)) return
    seen.add(key)
    at.push(i)
  })
  return at
}

/** The family a model id names (opus, sonnet, haiku), or the id itself. */
function family(model: string): string {
  return /opus|sonnet|haiku/.exec(model)?.[0] ?? model
}

/** Null when the served model is of the requested family; the warning otherwise. */
export function modelWarning(served: string, requested: string): string | null {
  return family(served) === family(requested) ? null : `served model ${served} ≠ ${requested}: do not compare cost across tiers`
}

/**
 * The compaction run's gate, pre-registered 10-30 in
 * `.claudin/plans/peaceful-foraging-kahn.md` ("Validação"):
 *
 * - mechanism: at least 2 compactions in every candidate rep, and no clip or
 *   compaction in any base rep, or the run is not the comparison it claims;
 * - cost: the candidate's median at least 15% below the base's, ranges
 *   SEPARATED;
 * - every edit landed in every candidate rep;
 * - edit-turn lookups: the candidate's median at most twice the base's;
 * - re-reads after the candidate's first compaction: per rep, against the
 *   base's re-reads from that same turn on, the medians within 1.5×;
 * - the placebo's cost range overlaps the base's (a noise check).
 */
export function compactionGate(
  runs: readonly ArmResult[],
  base: string,
  placebo: string,
  candidate: string,
): { verdict: 'PASS' | 'FAIL' | 'NOT EXERCISED'; detail: string } {
  const of = (l: string) => runs.filter(r => r.label === l)
  const [b, p, c] = [of(base), of(placebo), of(candidate)]
  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y)
    return s.length === 0 ? Number.NaN : s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
  }
  const med = (rs: ArmResult[], f: (r: ArmResult) => number) => median(rs.map(f))
  const cost = (r: ArmResult) => r.pricedUsd
  const mechanism = c.length > 0 && c.every(r => r.compactionTurns.length >= 2) && b.every(r => r.compactionTurns.length === 0 && r.clippedIds === 0)
  if (!mechanism) {
    return {
      verdict: 'NOT EXERCISED',
      detail: `${candidate} compactions per rep ${c.map(r => r.compactionTurns.length).join(',')}; ${base} compactions ${b.map(r => r.compactionTurns.length).join(',')}, clipped ids ${b.map(r => r.clippedIds).join(',')}`,
    }
  }
  const max = (rs: ArmResult[]) => Math.max(...rs.map(cost))
  const min = (rs: ArmResult[]) => Math.min(...rs.map(cost))
  const cheaper = med(c, cost) <= med(b, cost) * 0.85 && max(c) < min(b)
  const edits = c.every(r => r.verdict.landed === r.verdict.expected)
  const lookups = med(c, r => r.editLookups) <= 2 * med(b, r => r.editLookups)
  // Per rep: the base's re-reads from the turn the candidate first compacted.
  const after = c.map(r => {
    const from = r.compactionTurns[0]!
    const twin = b.find(x => x.rep === r.rep)
    return { cand: r.rereadTurns.filter(t => t >= from).length, base: twin ? twin.rereadTurns.filter(t => t >= from).length : 0 }
  })
  const rereads = median(after.map(a => a.cand)) <= 1.5 * median(after.map(a => a.base))
  const placeboOverlaps = p.length === 0 || (min(p) <= max(b) && max(p) >= min(b))
  return {
    verdict: cheaper && edits && lookups && rereads && placeboOverlaps ? 'PASS' : 'FAIL',
    detail: [
      `cost ${cheaper ? 'ok' : 'NO'}: median $ ${candidate} ${med(c, cost).toFixed(3)} vs ${base} ${med(b, cost).toFixed(3)} (${((100 * med(c, cost)) / med(b, cost) - 100).toFixed(1)}%), separated ${max(c) < min(b)}`,
      `edits ${edits ? 'ok' : 'NO'}`,
      `lookups ${lookups ? 'ok' : 'NO'}: ${med(c, r => r.editLookups)} vs ${med(b, r => r.editLookups)}`,
      `re-reads after compacting ${rereads ? 'ok' : 'NO'}: ${after.map(a => `${a.cand}/${a.base}`).join(',')}`,
      `placebo overlaps ${placeboOverlaps ? 'ok' : 'NO'}`,
    ].join('; '),
  }
}

/** `<label>:K=V,K2=V2` → an arm on `--bin-a`'s binary with those variables. */
function parseVariant(spec: string, base: ArmSpec): ArmSpec {
  const colon = spec.indexOf(':')
  const label = colon < 0 ? spec : spec.slice(0, colon)
  if (!label) throw new Error(`--variant expects <label>:K=V,…, got ${spec}`)
  const env: Record<string, string> = {}
  for (const pair of colon < 0 ? [] : spec.slice(colon + 1).split(',').filter(Boolean)) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`--variant ${label}: expected K=V, got ${pair}`)
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { label, path: base.path, env }
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    arms: [],
    reps: 1,
    perPhase: 10,
    model: DEFAULT_MODEL,
    turnTimeoutMs: 300_000,
    window: null,
    keep: false,
    json: false,
    dryRun: false,
    parallel: false,
    gate: null,
    dirs: [...SOURCE_DIRS],
    large: DEFAULT_LARGE,
    effort: null,
  }
  let binA: ArmSpec | null = null
  let binB: ArmSpec | null = null
  const variants: string[] = []
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--json') a.json = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x === '--parallel') a.parallel = true
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--per-phase=')) a.perPhase = positiveInt('--per-phase', x.slice('--per-phase='.length))
    else if (x.startsWith('--large=')) a.large = positiveInt('--large', x.slice('--large='.length))
    else if (x.startsWith('--dirs=')) a.dirs = x.slice('--dirs='.length).split(',').filter(Boolean)
    else if (x.startsWith('--effort=')) a.effort = x.slice('--effort='.length)
    else if (x.startsWith('--model=')) a.model = x.slice('--model='.length)
    else if (x.startsWith('--window=')) a.window = Number(x.slice('--window='.length))
    else if (x.startsWith('--turn-timeout=')) a.turnTimeoutMs = Number(x.slice('--turn-timeout='.length))
    else if (x.startsWith('--bin-a=')) binA = parseBin(x.slice('--bin-a='.length))
    else if (x.startsWith('--bin-b=')) binB = parseBin(x.slice('--bin-b='.length))
    else if (x.startsWith('--variant=')) variants.push(x.slice('--variant='.length))
    else if (x.startsWith('--gate=')) {
      const labels = x.slice('--gate='.length).split(',')
      if (labels.length !== 3) throw new Error(`--gate expects base,placebo,candidate, got ${x}`)
      a.gate = labels as [string, string, string]
    }
    else throw new Error(`unknown arg ${x}`)
  }
  // After the loop, so a --bin-a given after its variants still applies.
  if (variants.length > 0 && !binA) throw new Error("--variant runs --bin-a's binary: give --bin-a")
  const arms = [binA, binB, ...variants.map(v => parseVariant(v, binA!))].filter((x): x is ArmSpec => x !== null)
  const labels = arms.map(arm => arm.label)
  const dup = labels.find((l, i) => labels.indexOf(l) !== i)
  if (dup) throw new Error(`two arms are labelled ${dup}`)
  a.arms = arms
  return a
}

/** A count flag's value, or an error: `Number('20+')` is NaN and ran 0 turns. */
function positiveInt(flag: string, value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} expects a positive integer, got ${value}`)
  return n
}

/** Rep r starts at arm (r − 1) mod n, so each arm takes the cold first slot in turn. */
export function armOrder<T>(arms: readonly T[], rep: number): T[] {
  const k = (((rep - 1) % arms.length) + arms.length) % arms.length
  return [...arms.slice(k), ...arms.slice(0, k)]
}

/** The host's env minus its own CLI variables, the bench's switches, then the arm's. */
export function armProcessEnv(arm: ArmSpec, window: number | null): NodeJS.ProcessEnv {
  return armEnv({
    // No server-side clear_tool_uses: the client policy is what is under test.
    CLAUDIN_DISABLE_EXPERIMENTAL_BETAS: 'true',
    // `--window` shrinks the window every arm sees, Claude Code's included,
    // so a 30-turn session crosses the relief trigger.
    ...(window ? { CLAUDIN_AUTO_COMPACT_WINDOW: String(window), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } : {}),
    ...arm.env,
  })
}

export function pricedUsd(model: string, rows: readonly UsageRow[]): number {
  const sum: UsageRow = { in: 0, out: 0, cR: 0, cW: 0, cW5m: 0, cW1h: 0 }
  for (const r of rows) for (const k of USAGE_KEYS) sum[k] += r[k]
  return costOf(model, sum)
}

/** Ids (results + inputs) in the last clip-state a transcript recorded; 0 without one. */
export function clippedIdsFrom(transcript: string): number {
  let n = 0
  for (const line of transcript.split('\n')) {
    if (!line.includes('"clip-state"')) continue
    let e: { type?: unknown; resultIds?: unknown; inputFields?: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'clip-state') continue
    const results = Array.isArray(e.resultIds) ? e.resultIds.length : 0
    const inputs = e.inputFields && typeof e.inputFields === 'object' ? Object.keys(e.inputFields).length : 0
    n = results + inputs
  }
  return n
}

async function runArm(arm: ArmSpec, rep: number, args: Args): Promise<ArmResult> {
  const cwd = buildWorkspace(args.dirs)
  const corpus = corpusFrom(cwd, args.dirs, args.large)
  const turns = turnScript(corpus, args.perPhase)

  const child = spawn(
    arm.path,
    [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--print',
      '--model', args.model,
      ...(args.effort ? ['--effort', args.effort] : []),
      '--permission-mode', 'bypassPermissions',
    ],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: armProcessEnv(arm, args.window),
    },
  )

  const events: Record<string, unknown>[] = []
  const eventKind: Turn['kind'][] = []
  const eventTurn: number[] = []
  let turnsDone = 0
  let activeKind: Turn['kind'] = 'grep'
  const rows = new Map<string, UsageRow>()
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
    eventTurn.push(turnsDone + 1)
    if (v.type === 'assistant') {
      const m = (v.message ?? {}) as Record<string, unknown>
      if (!servedModel && typeof m.model === 'string') servedModel = m.model
      const u = (m.usage ?? {}) as Record<string, number>
      const split = ((m.usage ?? {}) as { cache_creation?: Record<string, number> }).cache_creation ?? {}
      const id = String(m.id ?? '')
      if (!id) return
      const row: UsageRow = {
        in: u.input_tokens ?? 0,
        out: u.output_tokens ?? 0,
        cR: u.cache_read_input_tokens ?? 0,
        cW: u.cache_creation_input_tokens ?? 0,
        cW5m: split.ephemeral_5m_input_tokens ?? 0,
        cW1h: split.ephemeral_1h_input_tokens ?? 0,
      }
      const prev = rows.get(id)
      if (!prev) {
        order.push(id)
        rows.set(id, row)
        return
      }
      // MAX per field: usage rows repeat per content block and output grows.
      const merged = { ...prev }
      for (const k of USAGE_KEYS) merged[k] = Math.max(prev[k], row[k])
      rows.set(id, merged)
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
    // Parallel arms would overwrite each other's progress line.
    if (!args.parallel) process.stderr.write(`\r${arm.label} rep ${rep}: turn ${turnsDone}/${turns.length} (${turn.kind})   `)
  }
  child.stdin!.end()
  const exitCode = await Promise.race([exitPromise, new Promise<number>(r => setTimeout(() => r(-2), 15_000))])
  child.kill()
  const wallMs = performance.now() - t0
  process.stderr.write(args.parallel ? `${arm.label} rep ${rep}: ${turnsDone}/${turns.length} turns\n` : '\n')

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
  const readPaths: string[] = []
  const readTurns: number[] = []
  let reads = 0
  events.forEach((v, idx) => {
    if (v.type !== 'assistant') return
    const content = ((v.message ?? {}) as Record<string, unknown>).content
    if (!Array.isArray(content)) return
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
      readPaths.push(rel)
      readTurns.push(eventTurn[idx]!)
      seenPaths.add(rel)
    }
  })
  const rereadTurns = rereadsOutsideScript(readPaths, turns.filter(t => t.kind === 'read').map(t => t.path!)).map(i => readTurns[i]!)
  const rereads = rereadTurns.length

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

  const sessionId = sessionIdFrom(events)
  const transcript = sessionId ? transcriptPath(sessionId) : null
  const clippedIds = transcript ? clippedIdsFrom(readFileSync(transcript, 'utf8')) : 0

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
    pricedUsd: pricedUsd(servedModel ?? args.model, timeline),
    model: servedModel,
    toolCalls: calls.length,
    toolMix,
    reads,
    rereads,
    editLookups,
    clippedIds,
    compactionTurns: compactionsIn(events).map(i => eventTurn[i]!),
    rereadTurns,
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

function printArm(a: ArmResult): void {
  const mix = Object.entries(a.toolMix).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(`  ${a.label} rep ${a.rep}  exit=${a.exitCode}  model=${a.model ?? '?'}  ${(a.wallMs / 1000).toFixed(0)}s`)
  console.log(`    turns ${a.turnsDone}/${a.turnsPlanned}  api calls ${a.apiCalls}  tool calls ${a.toolCalls}  [${mix}]`)
  console.log(`    in ${fmt(a.input)}  out ${fmt(a.output)}  cache read ${fmt(a.cacheRead)}  cache write ${fmt(a.cacheCreation)}  r:w ${a.rw === Infinity ? 'inf' : a.rw.toFixed(1)}:1`)
  console.log(`    prefix breaks ${a.prefixBreaks} (${fmt(a.breakTokens)} rewritten)  peak ctx ${fmt(a.peakContext)}  end ctx ${fmt(a.endContext)}`)
  console.log(`    reads ${a.reads}  re-reads ${a.rereads}  lookups in edit turns ${a.editLookups}  clipped ids ${a.clippedIds}  edits landed ${a.verdict.landed}/${a.verdict.expected}${a.verdict.duplicated ? ` (${a.verdict.duplicated} duplicated)` : ''}`)
  console.log(`    cost usd priced ${a.pricedUsd.toFixed(4)}  (CLI ${a.costUsd === null ? 'n/a' : a.costUsd.toFixed(4)})`)
  if (a.apiCalls === 0 && a.stderrHead) console.log(`    STDERR: ${a.stderrHead}`)
}

/** Every arm against the first, median [min–max] with the range verdict once a rep repeats. */
export function summaryTable(runs: readonly ArmResult[], labels: readonly string[]): string {
  const of = (pick: (r: ArmResult) => number) => labels.map(l => runs.filter(r => r.label === l).map(pick))
  const usd = (n: number) => `$${n.toFixed(3)}`
  const int = (n: number) => String(Math.round(n))
  const rows: ArmRow[] = [
    ['cost, one price table', of(r => r.pricedUsd), usd],
    ['cache write', of(r => r.cacheCreation), fmt],
    ['cache read', of(r => r.cacheRead), fmt],
    ['uncached input', of(r => r.input), fmt],
    ['output', of(r => r.output), fmt],
    ['api calls', of(r => r.apiCalls), int],
    ['prefix breaks', of(r => r.prefixBreaks), int],
    ['break tokens', of(r => r.breakTokens), fmt],
    ['peak context', of(r => r.peakContext), fmt],
    ['end context', of(r => r.endContext), fmt],
    ['clipped ids', of(r => r.clippedIds), int],
    ['compactions', of(r => r.compactionTurns?.length ?? 0), int],
    ['re-reads', of(r => r.rereads), int],
    ['edit-turn lookups', of(r => r.editLookups), int],
    ['edits landed', of(r => r.verdict.landed), int],
  ]
  return armTable([...labels], rows, runs.length > labels.length)
}

function dryRun(args: Args): void {
  const root = buildWorkspace(args.dirs)
  const corpus = corpusFrom(root, args.dirs, args.large)
  const turns = turnScript(corpus, args.perPhase)
  console.log(`workspace: ${root} (${corpus.files.length} files; ${args.dirs.join(', ')})`)
  console.log(`large: ${corpus.large.join(', ')}`)
  // What the read phase loads, first reads only: a repeat comes back as a stub.
  const firstReads = [...new Set(turns.filter(t => t.kind === 'read').map(t => t.path!))]
  const bytes = firstReads.reduce((n, f) => n + statSync(join(root, f)).size, 0)
  console.log(`read phase: ${firstReads.length} distinct files, ${bytes} bytes ≈ ${Math.round(bytes / 4 / 1000)}k tokens`)
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
  if (args.arms.length < 2) {
    console.error('need --bin-a=<label>:<path> and a second arm: --bin-b=<label>:<path> or --variant=<label>:K=V')
    process.exit(1)
  }
  for (const b of args.arms) {
    if (!existsSync(b.path)) {
      console.error(`${b.label}: ${b.path} not found`)
      process.exit(1)
    }
  }

  const runs: ArmResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const ordered = armOrder(args.arms, rep)
    const results: ArmResult[] = []
    if (args.parallel) results.push(...(await Promise.all(ordered.map(arm => runArm(arm, rep, args)))))
    else for (const arm of ordered) results.push(await runArm(arm, rep, args))
    for (const r of results) {
      runs.push(r)
      printArm(r)
      const warning = r.model ? modelWarning(r.model, args.model) : null
      if (warning) console.log(`    ⚠ ${warning}`)
    }
  }

  const labels = args.arms.map(a => a.label)
  console.log(`\n=== ${labels.join(' vs ')}  (${args.reps} rep(s)${args.parallel ? ', parallel' : ''}, model ${args.model}, ${args.perPhase} turns per phase, window ${args.window ?? 'native'}) ===\n`)
  console.log(summaryTable(runs, labels))
  if (args.reps < 3) console.log(`  ↑ ${args.reps} rep(s): directional only. Re-run with --reps=3 and compare RANGES, not medians.`)
  if (args.gate) {
    const g = compactionGate(runs, ...args.gate)
    console.log(`\ncompaction gate: ${g.verdict} — ${g.detail}`)
  }

  if (args.json) {
    // Under /tmp, one file per run: a fixed path in the repo was overwritten by
    // every run, which is why the 10-24 data is gone.
    const out = join(tmpdir(), `context-relief-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(out, JSON.stringify(runs, null, 2))
    console.log(`\njson → ${out}`)
  }
}

if (import.meta.main) await main()
