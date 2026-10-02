/**
 * The engine the Go-project benches share — build-project-ab.ts and
 * read-files-ab.ts. Both run a prompt against the same 13-file `logstat`
 * project (`__fixtures__/build-project-ab/project/`); a bench brings its prompt,
 * its grader and its report, and this module does the rest:
 *
 *  - one git workspace per arm and rep, the arms of a rep run concurrently
 *    (or rotated with --sequential), each CLI headless with model and effort
 *    pinned and the host's CLAUDECODE / CLAUDE_CODE_* / CLAUDIN_* variables
 *    stripped;
 *  - usage merged across stream and transcript as the max per message id, the
 *    sub-agents' added, thinking from the recording proxy (on by default);
 *  - the per-session metrics every Go bench reports, as arm tables with the
 *    range verdict (only a SEPARATED row supports a claim at small N).
 *
 * `--variant=<label>:<ENV>=<value>[,<ENV>=<value>]` is one more arm: this
 * checkout's binary with those variables set, as in session-cache-ab.ts.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, transcriptPath } from './cliUsage'
import {
  analyzeSession,
  type ArmRow,
  armTable,
  BREAK_TOKENS,
  type Call,
  costOf,
  costSplit,
  emptySubagents,
  fillThinking,
  fmtInt,
  fmtK,
  fmtPct,
  fmtUsd,
  git,
  materialize,
  type PhaseRun,
  phaseRunOf,
  type RequestCensus,
  requestCensus,
  spawnCollect,
  stamp,
  type SubagentUsage,
  subagentUsage,
  table,
  toolSummary,
  type Turn,
  turnTable,
  version,
} from './session-cache-ab'
import {
  isMessagesPath,
  proxyEnv,
  readBody,
  readKindedRequests,
  readProxyRecords,
  readProxyThinking,
  requestKind,
  startWireProxy,
  type WireProxy,
} from './wire-proxy'

/** 'claude', 'claudindev', or the label of a --variant. */
export type Arm = string

/** The pristine project both benches start from: 13 files, gofmt-clean, `go vet` and `go test` green. */
export const PROJECT_FIXTURE = join(import.meta.dir, '__fixtures__', 'build-project-ab', 'project')
export const PROJECT_FILES = 13

type Json = Record<string, unknown>
export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export type Args = {
  reps: number
  only: Arm[] | null
  sequential: boolean
  model: string
  effort: string
  maxTurns: number
  budgetUsd: number
  timeoutMs: number
  dryRun: boolean
  replay: string
  proxy: boolean
  bins: Record<Arm, string>
  /** Extra environment per arm — set only for --variant arms. */
  env: Record<Arm, Record<string, string>>
  /** --variant labels, in the order given. */
  variants: Arm[]
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 1,
    only: null,
    sequential: false,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    maxTurns: 60,
    budgetUsd: 10,
    timeoutMs: 30 * 60_000,
    dryRun: false,
    replay: '',
    proxy: true,
    bins: { claude: 'claude', claudindev: join(REPO_ROOT, 'bin', 'claudin') },
    env: {},
    variants: [],
  }
  const variantSpecs: string[] = []
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--sequential') a.sequential = true
    else if (k === '--no-proxy') a.proxy = false
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--max-turns') a.maxTurns = Number(v)
    else if (k === '--budget') a.budgetUsd = Number(v)
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--replay') a.replay = v
    else if (k === '--bin-claude') a.bins.claude = v
    else if (k === '--bin-claudindev') a.bins.claudindev = v
    else if (k === '--variant') variantSpecs.push(v)
    else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  // After the loop, so a --bin-claudindev given later still applies.
  for (const spec of variantSpecs) {
    const colon = spec.indexOf(':')
    const pairs = colon < 0 ? [] : spec.slice(colon + 1).split(',').filter(Boolean)
    addVariant(
      a,
      colon < 0 ? spec : spec.slice(0, colon),
      Object.fromEntries(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])),
    )
  }
  return a
}

/** One more arm: this checkout's binary with `env` set on top of the base environment. */
export function addVariant(args: Args, label: string, env: Record<string, string>): void {
  args.bins[label] = args.bins.claudindev!
  args.env[label] = env
  args.variants.push(label)
}

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

export function makeWorkspace(dir: string): void {
  materialize(PROJECT_FIXTURE, dir)
  const steps: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '.git/no-hooks'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'chore: import logstat 0.4.0'],
  ]
  for (const step of steps) {
    const r = git(dir, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${dir}: ${r.out}`)
  }
}

/** The grader dir: a bench's hidden inputs, and one binary per graded workspace under bin/. */
export function makeGrader(runDir: string, hiddenFixture: string): string {
  const dir = join(runDir, 'grader')
  materialize(hiddenFixture, dir)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  return dir
}

export function countFiles(dir: string): number {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
  }
  return n
}

export type Out = { code: number; stdout: string; stderr: string }

export function exec(cmd: string, args: string[], cwd: string): Out {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000 })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const GO_TEST_RESULT_RE = /^\s*--- (PASS|FAIL): /gm

export type GoTests = { ok: boolean; pass: number; fail: number }

export function goTest(ws: string): GoTests {
  const r = exec('go', ['test', '-count=1', '-v', './...'], ws)
  let pass = 0
  let fail = 0
  for (const m of r.stdout.matchAll(GO_TEST_RESULT_RE)) {
    if (m[1] === 'PASS') pass++
    else fail++
  }
  return { ok: r.code === 0, pass, fail }
}

const WHITESPACE_RE = /\s+/g

/** One line of what a command printed, for a grade's detail column. */
export function brief(r: Out): string {
  const shown = (r.stdout || r.stderr).replace(WHITESPACE_RE, ' ').trim()
  return `exit ${r.code}: ${shown.slice(0, 110)}`
}

export const yes = (ok: boolean): string => (ok ? 'yes' : 'NO')

// ---------------------------------------------------------------------------
// Running an arm
// ---------------------------------------------------------------------------

/** What a bench brings: the prompt, and how to grade a finished workspace. */
export type Task<G> = {
  prompt: string
  grade: (ws: string, graderDir: string, label: string) => G
  /** The grade's part of the one-line console summary. */
  summary: (g: G) => string
}

/** Models and `output_config.effort` values of the agent-loop requests, as the proxy saw them. */
export type Wire = { models: string[]; efforts: string[] }

export type SessionResult<G> = {
  arm: Arm
  rep: number
  bin: string
  workspace: string
  model: string | null
  run: PhaseRun
  turns: Turn[]
  calls: Call[]
  subagents: SubagentUsage
  grade: G
  transcript: string | null
  usageSource: string
  thinkSource: ReturnType<typeof fillThinking>
  /** Set on proxied runs only. */
  requests?: RequestCensus
  wire?: Wire
}

export type Meta = {
  bench: string
  started: string
  runDir: string
  model: string
  effort: string
  maxTurns: number
  reps: number
  arms: Arm[]
  versions: Record<Arm, string>
  /** The variables each arm ran with beyond the base environment — only --variant arms have any. */
  armEnv: Record<Arm, Record<string, string>>
  proxy: boolean
  /** `go test` cases passing on the pristine project. */
  baselineTests: number
}

export type RunContext = { args: Args; runDir: string; graderDir: string; proxy: WireProxy | null }

function cliArgs(args: Args, prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    args.model,
    '--effort',
    args.effort,
    '--max-turns',
    String(args.maxTurns),
    '--max-budget-usd',
    String(args.budgetUsd),
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

function wireOf(logDir: string, label: string): Wire {
  const models = new Set<string>()
  const efforts = new Set<string>()
  for (const r of readProxyRecords(logDir, label)) {
    if (!r.reqFile || r.status >= 400 || !isMessagesPath(r.path)) continue
    const body = readBody(logDir, label, r.reqFile)
    if (requestKind(body) !== 'main') continue
    models.add(String(body.model))
    const config = body.output_config
    efforts.add(isRecord(config) && typeof config.effort === 'string' ? config.effort : 'none')
  }
  return { models: [...models], efforts: [...efforts] }
}

export async function runArm<G>(arm: Arm, rep: number, ctx: RunContext, task: Task<G>): Promise<SessionResult<G>> {
  const { args, runDir, proxy } = ctx
  const label = `${arm}-r${rep}`
  const ws = join(runDir, label)
  makeWorkspace(ws)
  const res = await spawnCollect(
    args.bins[arm]!,
    cliArgs(args, task.prompt),
    ws,
    join(runDir, label),
    args.timeoutMs,
    { ...(proxy ? proxyEnv(proxy.url(label)) : {}), ...args.env[arm] },
  )
  const events = parseJsonl(res.stdout) as Json[]
  const run = phaseRunOf(1, res, events)

  const tPath = run.sessionId ? transcriptPath(run.sessionId) : null
  let transcript: Json[] | null = null
  let archived: string | null = null
  if (tPath && existsSync(tPath)) {
    transcript = parseJsonl(readFileSync(tPath, 'utf8')) as Json[]
    archived = join(runDir, `${label}.transcript.jsonl`)
    copyFileSync(tPath, archived)
  }
  const session = analyzeSession([events], new Set(), transcript)
  const thinkSource = fillThinking(session.turns, [run], proxy ? readProxyThinking(proxy.logDir, [label]) : null)
  const subagents =
    tPath && run.sessionId
      ? subagentUsage(join(dirname(tPath), run.sessionId), join(runDir, `${label}.subagents`))
      : emptySubagents()
  const g = task.grade(ws, ctx.graderDir, label)
  console.log(
    `[${label}] ${run.subtype ?? `exit ${run.exitCode}`}${run.timedOut ? ' (TIMED OUT)' : ''}, ` +
      `${session.turns.length} API calls, ${(run.wallMs / 1000).toFixed(0)}s, CLI $${(run.cliCostUsd ?? 0).toFixed(2)} — ` +
      task.summary(g),
  )
  return {
    arm,
    rep,
    bin: args.bins[arm]!,
    workspace: ws,
    model: session.turns[0]?.model ?? null,
    run,
    turns: session.turns,
    calls: session.calls,
    subagents,
    grade: g,
    transcript: archived,
    usageSource: session.source,
    thinkSource,
    ...(proxy
      ? { requests: requestCensus([readKindedRequests(proxy.logDir, label)]), wire: wireOf(proxy.logDir, label) }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Metrics every Go bench reports
// ---------------------------------------------------------------------------

export type SessionMetrics = {
  apiCalls: number
  mainCalls: number
  subagentCalls: number
  httpRequests: number
  sideRequests: number
  toolCalls: number
  toolErrors: number
  refusals: number
  resultChars: number
  firstCtx: number
  peakCtx: number
  endCtx: number
  sumCtx: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  cacheWrite5m: number
  input: number
  reusePct: number
  breaks: number
  output: number
  thinking: number
  estCost: number
  costThinking: number
  costResent: number
  costVisible: number
  costPrefix: number
  costResults: number
  resentOut: number
  subagentCost: number
  cliCost: number
  wallSec: number
}

/** Context is per call of the main thread; token totals add the sub-agents'. */
export function sessionMetrics(r: SessionResult<unknown>): SessionMetrics {
  const t = r.turns
  const sub = r.subagents.usage
  const sum = (f: (x: Turn) => number): number => t.reduce((a, x) => a + f(x), 0)
  const ctxs = t.map(x => x.ctx)
  const cacheRead = sum(x => x.cR) + sub.cR
  const cacheWrite = sum(x => x.cW) + sub.cW
  const input = sum(x => x.in) + sub.in
  const req = r.requests
  const split = costSplit(r)
  return {
    apiCalls: t.length + r.subagents.turns,
    mainCalls: t.length,
    subagentCalls: r.subagents.turns,
    httpRequests: req ? req.main + req.classifier + req.other : Number.NaN,
    sideRequests: req ? req.classifier + req.other : Number.NaN,
    toolCalls: r.calls.length,
    toolErrors: r.calls.filter(c => c.isError).length,
    refusals: r.calls.filter(c => c.refused).length,
    resultChars: sum(x => x.resultChars),
    firstCtx: ctxs[0] ?? 0,
    peakCtx: Math.max(0, ...ctxs),
    endCtx: ctxs.at(-1) ?? 0,
    sumCtx: ctxs.reduce((a, b) => a + b, 0),
    cacheRead,
    cacheWrite,
    cacheWrite1h: sum(x => x.cW1h) + sub.cW1h,
    cacheWrite5m: cacheWrite - sum(x => x.cW1h) - sub.cW1h,
    input,
    reusePct: cacheRead + cacheWrite + input ? (cacheRead / (cacheRead + cacheWrite + input)) * 100 : 0,
    breaks: t.filter(x => (x.lost ?? 0) > BREAK_TOKENS).length,
    output: sum(x => x.out) + sub.out,
    thinking: sum(x => x.think ?? 0),
    estCost: sum(x => costOf(x.model, x)) + r.subagents.costUsd,
    costThinking: split.thinking,
    costResent: split.resent,
    costVisible: split.visible,
    costPrefix: split.prefix,
    costResults: split.results,
    resentOut: split.resentOut,
    subagentCost: r.subagents.costUsd,
    cliCost: r.run.cliCostUsd ?? Number.NaN,
    wallSec: r.run.wallMs / 1000,
  }
}

export type MetricRow<M> = [label: string, key: keyof M, fmt: (n: number) => string]

export const SESSION_ROWS: MetricRow<SessionMetrics>[] = [
  ['API calls (main thread + sub-agents)', 'apiCalls', fmtInt],
  ['  main thread', 'mainCalls', fmtInt],
  ['  sub-agents', 'subagentCalls', fmtInt],
  ['HTTP requests on the wire (proxy)', 'httpRequests', fmtInt],
  ['  of which side requests (titles, classifier, …)', 'sideRequests', fmtInt],
  ['tool calls', 'toolCalls', fmtInt],
  ['  with an error (failing commands included)', 'toolErrors', fmtInt],
  ['  answered by the harness (parse errors, gates)', 'refusals', fmtInt],
  ['tool result chars', 'resultChars', fmtK],
  ['first-turn context', 'firstCtx', fmtK],
  ['peak context', 'peakCtx', fmtK],
  ['end context', 'endCtx', fmtK],
  ['context summed over main-thread calls', 'sumCtx', fmtK],
  ['cache read', 'cacheRead', fmtK],
  ['cache write', 'cacheWrite', fmtK],
  ['  of which 1h TTL', 'cacheWrite1h', fmtK],
  ['  of which 5m TTL', 'cacheWrite5m', fmtK],
  ['input (uncached)', 'input', fmtK],
  ['cache reuse (read / all input)', 'reusePct', fmtPct],
  [`cache breaks (> ${BREAK_TOKENS} lost)`, 'breaks', fmtInt],
  ['output', 'output', fmtK],
  ['  of which thinking (main thread)', 'thinking', fmtK],
  ['  of which an edit re-sent after a refused one', 'resentOut', fmtK],
  ['est. cost, one price table', 'estCost', fmtUsd],
  ['  main thread by source: thinking', 'costThinking', fmtUsd],
  ['    edit re-sent after a refused one', 'costResent', fmtUsd],
  ['    other visible output', 'costVisible', fmtUsd],
  ['    first request (prefix), re-read every call', 'costPrefix', fmtUsd],
  ['    tool results and reminders', 'costResults', fmtUsd],
  ['  of which sub-agents', 'subagentCost', fmtUsd],
  ['CLI-reported cost', 'cliCost', fmtUsd],
  ['wall time (s)', 'wallSec', fmtInt],
]

/** Every other arm against the first; a row no arm has a finite value for is left out. */
export function comparisonTable<R extends SessionResult<unknown>, M>(
  runs: R[],
  arms: Arm[],
  metricsOf: (r: R) => M,
  rows: MetricRow<M>[],
): string {
  const byArm = arms.map(a => runs.filter(r => r.arm === a).map(metricsOf))
  const tableRows = rows
    .map(([label, key, fmt]): ArmRow => [
      label,
      byArm.map(ms => ms.map(m => m[key] as number).filter(Number.isFinite)),
      fmt,
    ])
    .filter(([, perArm]) => perArm.some(values => values.length))
  return armTable(arms, tableRows, runs.length > arms.length)
}

/** Title, run line, and each arm's binary version with the variables it ran with. */
export function reportHeader(meta: Meta): string[] {
  return [
    `# ${meta.bench} — ${meta.started}`,
    '',
    `model \`${meta.model}\`, effort \`${meta.effort}\`, max turns ${meta.maxTurns}, ${meta.reps} rep(s), ` +
      `proxy ${meta.proxy ? 'on' : 'off'} — ${meta.runDir}`,
    '',
    ...meta.arms.map(arm => {
      const env = Object.entries(meta.armEnv?.[arm] ?? {})
      return `- ${arm}: ${meta.versions[arm]}${env.length ? ` — ${env.map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`
    }),
  ]
}

/** The tool calls of every rep per arm, then rep 1's calls, one table per arm. */
export function toolAndCallSections(runs: SessionResult<unknown>[], arms: Arm[]): string[] {
  const tools = arms.map(a => [a, toolSummary(runs.filter(r => r.arm === a).flatMap(r => r.calls.map(c => c.name)))])
  const out = ['', '## Tool calls, all reps', '', table(['arm', 'tools'], tools)]
  for (const arm of arms) {
    const r = runs.find(x => x.arm === arm && x.rep === 1) ?? runs.find(x => x.arm === arm)
    if (r) out.push('', `## Per call — ${arm} r${r.rep}`, '', turnTable(r))
  }
  return out
}

// ---------------------------------------------------------------------------
// A whole bench run, and --replay
// ---------------------------------------------------------------------------

export type Bench<G> = {
  /** The report title and the run directory's parent, /tmp/<name>. */
  name: string
  /** The hidden inputs the grader runs the binary over, never shown to a model. */
  hiddenFixture: string
  /** The arms when --only is not given; the first is what every Δ column compares against. */
  defaultArms: (args: Args) => Arm[]
  task: Task<G>
  report: (runs: SessionResult<G>[], meta: Meta) => string
}

function save<G>(runDir: string, runs: SessionResult<G>[], meta: Meta): string {
  const path = join(runDir, 'results.json')
  writeFileSync(path, JSON.stringify({ meta, runs }, null, 1))
  return path
}

/** Merges saved results files into one report; the first file's run dir gets it. */
export function replayBench<G>(bench: Bench<G>, args: Args): void {
  const saved = args.replay
    .split(',')
    .filter(Boolean)
    .map(file => JSON.parse(readFileSync(file, 'utf8')) as { meta: Meta; runs: SessionResult<G>[] })
  const arms = [...new Set(saved.flatMap(s => s.meta.arms))].filter(a => !args.only || args.only.includes(a))
  const meta: Meta = {
    ...saved[0]!.meta,
    bench: saved[0]!.meta.bench ?? bench.name,
    arms,
    versions: Object.assign({}, ...saved.map(s => s.meta.versions)),
    armEnv: Object.assign({}, ...saved.map(s => s.meta.armEnv ?? {})),
    reps: Math.max(...saved.map(s => s.meta.reps)),
  }
  const text = bench.report(saved.flatMap(s => s.runs).filter(r => arms.includes(r.arm)), meta)
  writeFileSync(join(meta.runDir, 'report.md'), text)
  console.log(text)
}

export async function runBench<G>(bench: Bench<G>, args: Args): Promise<void> {
  const arms = args.only ?? bench.defaultArms(args)
  const unknown = arms.filter(a => !args.bins[a])
  if (unknown.length) {
    console.error(`no binary for ${unknown.join(', ')} — declare a variant with --variant=<label>:<ENV>=<value>`)
    process.exit(2)
  }
  if (arms.some(a => args.bins[a] === args.bins.claudindev) && !existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const runDir = join('/tmp', bench.name, stamp())
  mkdirSync(runDir, { recursive: true })
  const graderDir = makeGrader(runDir, bench.hiddenFixture)
  const pristine = join(runDir, 'pristine')
  makeWorkspace(pristine)
  const baseline = goTest(pristine)
  if (!baseline.ok) {
    console.error(`the pristine project is not green (${baseline.fail} fail) — run --dry-run`)
    process.exit(1)
  }
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim()
  const meta: Meta = {
    bench: bench.name,
    started: new Date().toISOString(),
    runDir,
    model: args.model,
    effort: args.effort,
    maxTurns: args.maxTurns,
    reps: args.reps,
    arms,
    versions: Object.fromEntries(
      arms.map(a => [
        a,
        args.bins[a] === args.bins.claudindev
          ? `${version(args.bins[a]!)} @ ${head}${dirty ? ' (src dirty)' : ''}`
          : version(args.bins[a]!),
      ]),
    ),
    armEnv: Object.fromEntries(arms.map(a => [a, args.env[a] ?? {}])),
    proxy: args.proxy,
    baselineTests: baseline.pass,
  }
  console.log(`${bench.name} → ${runDir}`)
  for (const line of reportHeader(meta).slice(4)) console.log(`  ${line}`)

  const proxy = args.proxy ? await startWireProxy(join(runDir, 'proxy')) : null
  if (proxy) console.log(`  recording proxy on 127.0.0.1:${proxy.port} → ${proxy.logDir}`)
  const ctx: RunContext = { args, runDir, graderDir, proxy }
  const runs: SessionResult<G>[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    if (args.sequential) {
      // Rotate who goes first, so the cold prefix is not always the same arm's.
      const order = rep % 2 ? arms : [...arms].reverse()
      for (const arm of order) runs.push(await runArm(arm, rep, ctx, bench.task))
    } else {
      runs.push(...(await Promise.all(arms.map(arm => runArm(arm, rep, ctx, bench.task)))))
    }
    save(runDir, runs, meta)
  }
  await proxy?.close()

  const text = bench.report(runs, meta)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${save(runDir, runs, meta)}\nreport  → ${join(runDir, 'report.md')}`)
}
