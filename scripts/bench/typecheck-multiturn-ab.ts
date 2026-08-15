#!/usr/bin/env bun
/**
 * Multi-turn A/B: the SHIPPED binary (no Typecheck tool) against the LOCAL
 * build (with it), over a 10-turn editing session on a project that carries a
 * pre-existing error backlog.
 *
 *   A = `claudin`     — the published npm release; type-checks through Bash.
 *   B = `claudindev`  — this checkout's build; Bash refuses a bare type-check
 *                       once and points at Typecheck.
 *
 * The single-turn `typecheck-ab.ts` measures the payload of ONE tool result.
 * This one measures what that payload does to a session: every compiler dump
 * stays in the transcript and is re-sent on every later request, so the cost of
 * a verbose check compounds with the number of turns that follow it. That is
 * what the context column reports.
 *
 * Both variants run the same fixture, the same ten prompts and the same model.
 * Usage is read from the session transcript rather than the CLI's final JSON so
 * that every request in a turn is counted, not just the last one.
 *
 *   bun scripts/bench/typecheck-multiturn-ab.ts --reps 3
 *   bun scripts/bench/typecheck-multiturn-ab.ts --reps 1 --turns 4 --keep
 *
 * Headless orphans auto-background sub-agents, which would drop their usage
 * from the totals — CLAUDIN_DISABLE_BACKGROUND_TASKS=1 is forced below.
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')

type Variant = 'A' | 'B'
const BIN: Record<Variant, string> = {
  A: process.env.CLAUDIN_BENCH_BIN_A ?? 'claudin',
  B: process.env.CLAUDIN_BENCH_BIN_B ?? 'claudindev',
}
const LABEL: Record<Variant, string> = {
  A: 'A  claudin (release, no Typecheck)',
  B: 'B  claudindev (with Typecheck)',
}

/**
 * Ten small tasks, each ending in the same verification clause. The clause is
 * what makes the run comparable: both variants are asked to confirm the same
 * thing ten times, and only the cost of confirming it differs.
 */
const CONFIRM = 'Then confirm the project still type-checks with no new problems.'
const PROMPTS: string[] = [
  `Add \`formatCents(cents: number): string\` to src/money.ts rendering 1234 as "$12.34". ${CONFIRM}`,
  `Add \`parseMoney(text: string): number\` to src/money.ts, the inverse of formatCents. ${CONFIRM}`,
  `Make formatCents render negatives as "-$12.34" rather than "$-12.34". ${CONFIRM}`,
  `Add src/cart.ts exporting \`total(items: { price: number; qty: number }[]): number\`. ${CONFIRM}`,
  `Add \`discount(amount: number, pct: number): number\` to src/cart.ts, clamping pct to 0-100. ${CONFIRM}`,
  `Add src/receipt.ts exporting \`renderReceipt\`, which lays the cart items out one per line using formatCents. ${CONFIRM}`,
  `Give formatCents an optional \`currency\` parameter defaulting to "$", and update its callers. ${CONFIRM}`,
  `Add src/tax.ts exporting \`withTax(amount: number, rate: number): number\`, and use it in renderReceipt. ${CONFIRM}`,
  `Rename \`total\` in src/cart.ts to \`subtotal\` and update every reference. ${CONFIRM}`,
  `Add a one-line JSDoc comment to each function you added in this session. ${CONFIRM}`,
]

interface Args {
  reps: number
  turns: number
  errors: number
  errorFiles: number
  model: string
  timeoutMs: number
  keep: boolean
  only: Variant | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = { reps: 3, turns: 10, errors: 120, errorFiles: 24, model: 'claude-sonnet-5', timeoutMs: 420_000, keep: false, only: null }
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1]
    switch (argv[i]) {
      case '--reps': args.reps = Number(next); i++; break
      case '--turns': args.turns = Number(next); i++; break
      case '--errors': args.errors = Number(next); i++; break
      case '--error-files': args.errorFiles = Number(next); i++; break
      case '--model': args.model = String(next); i++; break
      case '--timeout': args.timeoutMs = Number(next) * 1000; i++; break
      case '--only': args.only = next === 'A' ? 'A' : 'B'; i++; break
      case '--keep': args.keep = true; break
    }
  }
  return args
}

function git(cwd: string, gitArgs: string[]): void {
  spawnSync('git', ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', ...gitArgs], { cwd, encoding: 'utf8' })
}

/** A committed project whose backlog is large enough that dumping it hurts. */
function makeFixture(errorCount: number, errorFiles: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcmt-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  try {
    symlinkSync(TSC, join(dir, 'node_modules', '.bin', 'tsc'))
  } catch {
    /* a global tsc on PATH is an acceptable fallback */
  }
  writeFileSync(join(dir, '.gitignore'), '.claudin/\nnode_modules/\n')
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'shop', private: true, scripts: { typecheck: 'tsc --noEmit' } }, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }, include: ['src'] }, null, 2)}\n`,
  )
  // Spread across modules on purpose. With the whole backlog in ONE file the
  // release variant just greps that filename out and pays almost nothing, which
  // flatters it — a real legacy backlog is scattered, and hand-filtering it
  // stops being a one-liner.
  mkdirSync(join(dir, 'src', 'legacy'), { recursive: true })
  for (let f = 0; f < errorFiles; f++) {
    const lines: string[] = []
    for (let i = f; i < errorCount; i += errorFiles) {
      lines.push(`export const legacyField${i}: number = "pending migration ${i}"`)
    }
    if (lines.length === 0) continue
    writeFileSync(join(dir, 'src', 'legacy', `module${f}.ts`), `${lines.join('\n')}\n`)
  }
  writeFileSync(join(dir, 'src', 'money.ts'), 'export const CURRENCY = "$"\n')
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'shop with a legacy backlog'])
  return dir
}

/** Bytes of raw compiler output — what a Bash type-check pastes into context. */
function rawCompilerBytes(dir: string): number {
  const res = spawnSync(join(dir, 'node_modules', '.bin', 'tsc'), ['--noEmit', '--pretty', 'false'], {
    cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.length
}

interface TurnResult {
  sessionId: string
  costUsd: number
  ok: boolean
}

function runTurn(bin: string, cwd: string, prompt: string, model: string, first: boolean, timeoutMs: number): TurnResult {
  const argv = ['-p', prompt, '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
  if (!first) argv.push('--continue')
  const res = spawnSync(bin, argv, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CLAUDIN_DISABLE_BACKGROUND_TASKS: '1' },
  })
  const last = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    const parsed = JSON.parse(last) as Record<string, unknown>
    return {
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
      costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
      ok: parsed.is_error !== true,
    }
  } catch {
    return { sessionId: '', costUsd: 0, ok: false }
  }
}

function sessionPath(sessionId: string, cwd: string): string | null {
  const projectsDir = join(CONFIG_DIR, 'projects')
  const direct = join(projectsDir, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const proj of readdirSync(projectsDir)) {
      const p = join(projectsDir, proj, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* no transcript */
  }
  return null
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

const TSC_COMMAND_RE = /\b(?:tsc|vue-tsc|tsgo)\b|run\s+(?:typecheck|type-check)\b/

interface Metrics {
  input: number
  cacheCreate: number
  cacheRead: number
  output: number
  /** Prompt size on the last request of the session — the context it ended at. */
  finalContext: number
  peakContext: number
  requests: number
  bashChecks: number
  typecheckCalls: number
  /** Characters of tool_result text handed back by those checks. */
  checkResultChars: number
}

function measure(paths: string[]): Metrics {
  const m: Metrics = {
    input: 0, cacheCreate: 0, cacheRead: 0, output: 0,
    finalContext: 0, peakContext: 0, requests: 0,
    bashChecks: 0, typecheckCalls: 0, checkResultChars: 0,
  }
  const checkIds = new Set<string>()
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      let obj: Record<string, any>
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const content = obj?.message?.content
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, any>>) {
          if (block?.type === 'tool_use') {
            const isTypecheck = block.name === 'Typecheck'
            const isBashCheck = block.name === 'Bash' && TSC_COMMAND_RE.test(String(block.input?.command ?? ''))
            if (isTypecheck) m.typecheckCalls++
            if (isBashCheck) m.bashChecks++
            if ((isTypecheck || isBashCheck) && typeof block.id === 'string') checkIds.add(block.id)
          } else if (block?.type === 'tool_result' && checkIds.has(String(block.tool_use_id))) {
            m.checkResultChars += blockText(block.content).length
          }
        }
      }
      if (obj?.type !== 'assistant') continue
      const u = obj?.message?.usage
      if (!u || typeof u.output_tokens !== 'number') continue
      const inp = Number(u.input_tokens ?? 0)
      const cc = Number(u.cache_creation_input_tokens ?? 0)
      const cr = Number(u.cache_read_input_tokens ?? 0)
      m.input += inp
      m.cacheCreate += cc
      m.cacheRead += cr
      m.output += Number(u.output_tokens ?? 0)
      m.requests++
      const context = inp + cc + cr
      m.finalContext = context
      if (context > m.peakContext) m.peakContext = context
    }
  }
  return m
}

interface RunRow {
  variant: Variant
  rep: number
  metrics: Metrics
  costUsd: number
  wallMs: number
  turnsOk: number
  rawBytes: number
}

function runOnce(variant: Variant, args: Args, rep: number): RunRow {
  const sandbox = makeFixture(args.errors, args.errorFiles)
  const rawBytes = rawCompilerBytes(sandbox)
  const sessions = new Set<string>()
  let costUsd = 0
  let turnsOk = 0
  const t0 = performance.now()
  for (let t = 0; t < args.turns; t++) {
    const turn = runTurn(BIN[variant], sandbox, PROMPTS[t % PROMPTS.length]!, args.model, t === 0, args.timeoutMs)
    if (turn.sessionId) sessions.add(turn.sessionId)
    costUsd += turn.costUsd
    if (turn.ok) turnsOk++
    process.stdout.write(`      turn ${String(t + 1).padStart(2)} ${turn.ok ? '·' : '✗'}\n`)
  }
  const wallMs = performance.now() - t0
  const paths = [...sessions].map(id => sessionPath(id, sandbox)).filter((p): p is string => p !== null)
  const metrics = measure(paths)
  if (!args.keep) rmSync(sandbox, { recursive: true, force: true })
  else process.stdout.write(`      sandbox: ${sandbox}\n`)
  return { variant, rep, metrics, costUsd, wallMs, turnsOk, rawBytes }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const variants: Variant[] = args.only ? [args.only] : ['A', 'B']

  process.stdout.write(`\nTypecheck multi-turn A/B — ${args.turns} turns × ${args.reps} reps · ${args.model}\n`)
  process.stdout.write(`fixture: ${args.errors} pre-existing errors across ${args.errorFiles} files\n\n`)

  const rows: RunRow[] = []
  for (const variant of variants) {
    process.stdout.write(`${LABEL[variant]}  [${BIN[variant]}]\n`)
    for (let rep = 1; rep <= args.reps; rep++) {
      process.stdout.write(`   rep ${rep}\n`)
      const row = runOnce(variant, args, rep)
      rows.push(row)
      process.stdout.write(
        `      → ctx ${fmt(row.metrics.finalContext)} · out ${fmt(row.metrics.output)} · checks ${row.metrics.bashChecks}B/${row.metrics.typecheckCalls}T · ${(row.wallMs / 1000).toFixed(0)}s\n`,
      )
    }
  }

  const pick = (v: Variant, f: (r: RunRow) => number) => median(rows.filter(r => r.variant === v).map(f))
  const raw = rows[0]?.rawBytes ?? 0
  process.stdout.write(`\nraw \`tsc --noEmit\` output: ${fmt(raw)} chars per run\n\n`)

  const metrics: Array<[string, (r: RunRow) => number]> = [
    ['final context', r => r.metrics.finalContext],
    ['peak context', r => r.metrics.peakContext],
    ['cache create', r => r.metrics.cacheCreate],
    ['cache read', r => r.metrics.cacheRead],
    ['output tok', r => r.metrics.output],
    ['requests', r => r.metrics.requests],
    ['check chars', r => r.metrics.checkResultChars],
    ['cost usd', r => r.costUsd],
    ['wall s', r => r.wallMs / 1000],
  ]
  process.stdout.write(`${'metric'.padEnd(15)}${'A (release)'.padStart(14)}${'B (Typecheck)'.padStart(15)}${'delta'.padStart(12)}\n`)
  for (const [name, f] of metrics) {
    const a = pick('A', f)
    const b = pick('B', f)
    const delta = a === 0 ? '—' : `${(((b - a) / a) * 100).toFixed(1)}%`
    const show = (n: number) => (name === 'cost usd' ? n.toFixed(3) : fmt(n))
    process.stdout.write(`${name.padEnd(15)}${show(a).padStart(14)}${show(b).padStart(15)}${delta.padStart(12)}\n`)
  }
  const okA = rows.filter(r => r.variant === 'A').map(r => r.turnsOk)
  const okB = rows.filter(r => r.variant === 'B').map(r => r.turnsOk)
  process.stdout.write(`\nturns completed — A: ${okA.join(',')}  B: ${okB.join(',')} (of ${args.turns})\n`)
}

main()
