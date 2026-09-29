#!/usr/bin/env bun
/**
 * Build-project A/B — Claude Code (`claude`) vs this checkout (`claudindev`) on
 * one prompt over a 13-file Go project (`logstat`, an access-log summarizer):
 * two features, a p99 and a bug fix across four packages, tests, the README,
 * then `make build`. The question is what each CLI spends on that job:
 *
 *  - API CALLS: the main thread's requests, read off the stream and the
 *    transcript, plus every sub-agent's; with the recording proxy (on by
 *    default) also every HTTP request the CLI sent, side requests included.
 *  - CACHE: cache read and write (by TTL), the uncached tail and the prefix
 *    breaks, per call and per session.
 *  - CONTEXT: every call's context — first, peak, end, and the sum over the
 *    session, which is all the input it paid for one way or another.
 *
 * Model and effort are pinned on both arms (Sonnet 5.5 at `high` by default).
 * Through the proxy the report shows the model and `output_config.effort`
 * each arm's agent loop actually sent, so a pin that did not land shows up.
 *
 * The fixture lives in `__fixtures__/build-project-ab/` as `.tpl` files:
 *   project/   the pristine project — 13 files, gofmt-clean, `go vet` and `go test` green
 *   hidden/    the logs the black-box grader runs the binary over, never shown to a model
 *   solution/  a reference implementation, overlaid by --dry-run only
 *   prompts/   the one user prompt
 *
 * Grading, after the session: the bench builds the workspace itself, runs
 * `go vet`, `gofmt -l` and `go test`, runs seven hidden checks against its own
 * build, and records whether the model's `bin/logstat` is newer than every
 * non-test .go file — whether it built what it wrote.
 *
 * The protocol is session-cache-ab.ts's — one git workspace per arm and rep,
 * the arms of a rep run concurrently, the host's CLAUDECODE / CLAUDE_CODE_* /
 * CLAUDIN_* variables stripped, usage merged across stream and transcript as
 * the max per message id — and so are most of the helpers.
 *
 * Usage:
 *   bun scripts/bench/ab/build-project-ab.ts --dry-run          # validate fixture + grader, no tokens
 *   bun scripts/bench/ab/build-project-ab.ts                    # 1 rep, both arms in parallel
 *   bun scripts/bench/ab/build-project-ab.ts --reps=3
 *   bun scripts/bench/ab/build-project-ab.ts --model=claude-opus-5-5 --effort=medium
 *   bun scripts/bench/ab/build-project-ab.ts --replay=/tmp/build-project-ab/<stamp>/results.json
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
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

/** 'claude' or 'claudindev'. */
type Arm = string
const ARMS: readonly Arm[] = ['claude', 'claudindev']

const FIXTURE = join(import.meta.dir, '__fixtures__', 'build-project-ab')
const BENCH_ROOT = '/tmp/build-project-ab'
/** Where `make build` puts the binary, relative to the workspace. */
const MODEL_BIN = join('bin', 'logstat')
const PROJECT_FILES = 13

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

type Args = {
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
}

type Check = { name: string; ok: boolean; detail: string }

type Grade = {
  /** The bench's own `go build` of the workspace. */
  build: boolean
  vet: boolean
  /** `gofmt -l` listed nothing. */
  gofmt: boolean
  tests: { ok: boolean; pass: number; fail: number }
  /** The model's `bin/logstat` is newer than every non-test .go file: it built what it wrote. */
  built: boolean
  hidden: Check[]
  /** The README mentions --format, --method and p99. */
  readme: boolean
}

/** Models and `output_config.effort` values of the agent-loop requests, as the proxy saw them. */
type Wire = { models: string[]; efforts: string[] }

type RunResult = {
  arm: Arm
  rep: number
  bin: string
  workspace: string
  model: string | null
  run: PhaseRun
  turns: Turn[]
  calls: Call[]
  subagents: SubagentUsage
  grade: Grade
  transcript: string | null
  usageSource: string
  thinkSource: ReturnType<typeof fillThinking>
  /** Set on --proxy runs only. */
  requests?: RequestCensus
  wire?: Wire
}

type Meta = {
  started: string
  runDir: string
  model: string
  effort: string
  maxTurns: number
  reps: number
  arms: Arm[]
  versions: Record<Arm, string>
  proxy: boolean
  /** `go test` cases passing on the pristine project. */
  baselineTests: number
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeWorkspace(dir: string): void {
  materialize(join(FIXTURE, 'project'), dir)
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

/** The grader dir: the hidden logs, and one binary per graded workspace under bin/. */
function makeGrader(runDir: string): string {
  const dir = join(runDir, 'grader')
  materialize(join(FIXTURE, 'hidden'), dir)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  return dir
}

function readPrompt(): string {
  return readFileSync(join(FIXTURE, 'prompts', 'task.md'), 'utf8').trim()
}

function countFiles(dir: string): number {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
  }
  return n
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

type Out = { code: number; stdout: string; stderr: string }

function exec(cmd: string, args: string[], cwd: string): Out {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000 })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const GO_TEST_RESULT_RE = /^\s*--- (PASS|FAIL): /gm

function goTest(ws: string): Grade['tests'] {
  const r = exec('go', ['test', '-count=1', '-v', './...'], ws)
  let pass = 0
  let fail = 0
  for (const m of r.stdout.matchAll(GO_TEST_RESULT_RE)) {
    if (m[1] === 'PASS') pass++
    else fail++
  }
  return { ok: r.code === 0, pass, fail }
}

/** Directories no source of the project lives in: the binary's, git's, and each CLI's own. */
const NOT_SOURCE_DIRS: ReadonlySet<string> = new Set(['.git', 'bin', '.claudin', '.claude'])

/** What the binary is built from: every non-test .go file, and go.mod. */
function binarySources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!NOT_SOURCE_DIRS.has(entry.name)) out.push(...binarySources(path))
    } else if ((entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) || entry.name === 'go.mod') {
      out.push(path)
    }
  }
  return out
}

function builtByModel(ws: string): boolean {
  const bin = join(ws, MODEL_BIN)
  if (!existsSync(bin)) return false
  const builtAt = statSync(bin).mtimeMs
  return binarySources(ws).every(f => statSync(f).mtimeMs <= builtAt)
}

// Expected answers over hidden/mixed.log: 20 requests, one malformed line, and
// two latencies written in seconds (1.5s, 2s) that the pristine parser drops.
const JSON_ALL = {
  requests: 20,
  malformed: 1,
  bytes: 22688,
  status: { '2xx': 14, '3xx': 1, '4xx': 3, '5xx': 2 },
  latency_ms: { p50: 60, p95: 1500, p99: 2000 },
  top_paths: [
    { path: '/api/users', count: 7 },
    { path: '/api/orders', count: 5 },
    { path: '/health', count: 4 },
    { path: '/login', count: 3 },
    { path: '/api/items', count: 1 },
  ],
}
// The filtered ones leave `malformed` out: the prompt does not say whether a
// filter applies to it, only that it is a number.
const JSON_POST = {
  requests: 5,
  bytes: 1344,
  status: { '2xx': 3, '3xx': 1, '4xx': 1, '5xx': 0 },
  latency_ms: { p50: 200, p95: 450, p99: 450 },
  top_paths: [
    { path: '/login', count: 3 },
    { path: '/api/orders', count: 2 },
  ],
}
const JSON_GET_5XX = {
  requests: 2,
  bytes: 256,
  status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 2 },
  latency_ms: { p50: 800, p95: 2000, p99: 2000 },
  top_paths: [{ path: '/api/orders', count: 2 }],
}
const P99_ROW_RE = /^p95 +1\.5s\np99 +2s$/m
/** hidden/seconds.log: 1.5s, 850ms, 2s and 0.25s — all four must parse. */
const SECONDS_ROWS_RE: readonly RegExp[] = [/^requests +4$/m, /^malformed +0$/m, /^p50 +850ms$/m, /^p95 +2s$/m]
const README_MENTIONS_RE: readonly RegExp[] = [/--format/, /--method/, /p99/]

function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null // not JSON: the check fails on it, and its detail shows the output
  }
}

function sameBesidesMalformed(value: unknown, want: Json): boolean {
  if (!isRecord(value) || typeof value.malformed !== 'number') return false
  const { malformed: _, ...rest } = value
  return isDeepStrictEqual(rest, want)
}

type Cli = (...args: string[]) => Out
type Logs = { mixed: string; seconds: string }

const WHOLE_CHECK = 'json: the whole report'
const REJECT_CHECK = '--format xml: exit 2, nothing on stdout'
const SECONDS_CHECK = 'text: latencies in seconds parse'

/** Each check runs the binary and says whether the output is right, and which output to show. */
const HIDDEN_CHECKS: ReadonlyArray<[name: string, judge: (cli: Cli, logs: Logs) => [ok: boolean, shown: Out]]> = [
  [
    WHOLE_CHECK,
    (cli, { mixed }) => {
      const r = cli('--format', 'json', mixed)
      return [r.code === 0 && isDeepStrictEqual(jsonOf(r.stdout), JSON_ALL), r]
    },
  ],
  [
    'json: --method post (case-insensitive)',
    (cli, { mixed }) => {
      const r = cli('--method', 'post', '--format', 'json', mixed)
      return [r.code === 0 && sameBesidesMalformed(jsonOf(r.stdout), JSON_POST), r]
    },
  ],
  [
    'json: --method GET --status 5xx --top 1',
    (cli, { mixed }) => {
      const r = cli('--method', 'GET', '--status', '5xx', '--top', '1', '--format', 'json', mixed)
      return [r.code === 0 && sameBesidesMalformed(jsonOf(r.stdout), JSON_GET_5XX), r]
    },
  ],
  [
    'text: a p99 row right after p95',
    (cli, { mixed }) => {
      const r = cli(mixed)
      return [r.code === 0 && P99_ROW_RE.test(r.stdout), r]
    },
  ],
  [
    'text: --format text is the default report',
    (cli, { mixed }) => {
      const plain = cli(mixed)
      const r = cli('--format', 'text', mixed)
      return [plain.code === 0 && r.code === 0 && r.stdout === plain.stdout && r.stdout !== '', r]
    },
  ],
  [
    REJECT_CHECK,
    (cli, { mixed }) => {
      const r = cli('--format', 'xml', mixed)
      return [r.code === 2 && r.stdout === '' && r.stderr !== '', r]
    },
  ],
  [
    SECONDS_CHECK,
    (cli, { seconds }) => {
      const r = cli(seconds)
      return [r.code === 0 && SECONDS_ROWS_RE.every(re => re.test(r.stdout)), r]
    },
  ],
]

const WHITESPACE_RE = /\s+/g

function brief(r: Out): string {
  const shown = (r.stdout || r.stderr).replace(WHITESPACE_RE, ' ').trim()
  return `exit ${r.code}: ${shown.slice(0, 110)}`
}

/** The hidden checks against `bin`, the bench's own build of a workspace — or all failed, when it did not build. */
function hiddenChecks(bin: string | null, graderDir: string): Check[] {
  if (!bin) return HIDDEN_CHECKS.map(([name]) => ({ name, ok: false, detail: 'the workspace does not build' }))
  const cli: Cli = (...args) => exec(bin, args, graderDir)
  const logs: Logs = { mixed: join(graderDir, 'mixed.log'), seconds: join(graderDir, 'seconds.log') }
  return HIDDEN_CHECKS.map(([name, judge]) => {
    const [ok, shown] = judge(cli, logs)
    return { name, ok, detail: brief(shown) }
  })
}

function grade(ws: string, graderDir: string, label: string): Grade {
  const bin = join(graderDir, 'bin', label)
  const build = exec('go', ['build', '-o', bin, './cmd/logstat'], ws).code === 0
  const fmt = exec('gofmt', ['-l', '.'], ws)
  const readmePath = join(ws, 'README.md')
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
  return {
    build,
    vet: exec('go', ['vet', './...'], ws).code === 0,
    gofmt: fmt.code === 0 && fmt.stdout.trim() === '',
    tests: goTest(ws),
    built: builtByModel(ws),
    hidden: hiddenChecks(build ? bin : null, graderDir),
    readme: README_MENTIONS_RE.every(re => re.test(readme)),
  }
}

// ---------------------------------------------------------------------------
// Running an arm
// ---------------------------------------------------------------------------

type RunContext = { args: Args; runDir: string; graderDir: string; proxy: WireProxy | null }

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

const yes = (ok: boolean): string => (ok ? 'yes' : 'NO')

async function runArm(arm: Arm, rep: number, ctx: RunContext): Promise<RunResult> {
  const { args, runDir, proxy } = ctx
  const label = `${arm}-r${rep}`
  const ws = join(runDir, label)
  makeWorkspace(ws)
  const res = await spawnCollect(
    args.bins[arm]!,
    cliArgs(args, readPrompt()),
    ws,
    join(runDir, label),
    args.timeoutMs,
    proxy ? proxyEnv(proxy.url(label)) : {},
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
  const g = grade(ws, ctx.graderDir, label)
  console.log(
    `[${label}] ${run.subtype ?? `exit ${run.exitCode}`}${run.timedOut ? ' (TIMED OUT)' : ''}, ` +
      `${session.turns.length} API calls, ${(run.wallMs / 1000).toFixed(0)}s, CLI $${(run.cliCostUsd ?? 0).toFixed(2)} — ` +
      `build ${yes(g.build)}, go test ${g.tests.pass}/${g.tests.pass + g.tests.fail}, built by model ${yes(g.built)}, ` +
      `hidden ${g.hidden.filter(c => c.ok).length}/${g.hidden.length}`,
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
// Reporting
// ---------------------------------------------------------------------------

type Metrics = {
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
  testsPass: number
  hiddenPass: number
}

/** Context is per call of the main thread; token totals add the sub-agents'. */
function metricsOf(r: RunResult): Metrics {
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
    testsPass: r.grade.tests.pass,
    hiddenPass: r.grade.hidden.filter(c => c.ok).length,
  }
}

function metricRows(meta: Meta): Array<[label: string, key: keyof Metrics, fmt: (n: number) => string]> {
  return [
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
    [`go test cases passing (pristine: ${meta.baselineTests})`, 'testsPass', fmtInt],
    [`hidden checks passed (of ${HIDDEN_CHECKS.length})`, 'hiddenPass', fmtInt],
  ]
}

function comparisonTable(runs: RunResult[], meta: Meta): string {
  const byArm = meta.arms.map(a => runs.filter(r => r.arm === a).map(metricsOf))
  const rows = metricRows(meta)
    .map(([label, key, fmt]): ArmRow => [label, byArm.map(ms => ms.map(m => m[key]).filter(Number.isFinite)), fmt])
    .filter(([, perArm]) => perArm.some(values => values.length))
  return armTable(meta.arms, rows, runs.length > meta.arms.length)
}

function gradeTable(runs: RunResult[]): string {
  const rows = runs.map(r => {
    const g = r.grade
    return [
      `${r.arm} r${r.rep}`,
      r.run.subtype ?? `exit ${r.run.exitCode}`,
      String(r.turns.length),
      yes(g.build),
      yes(g.vet),
      yes(g.gofmt),
      `${g.tests.pass}/${g.tests.pass + g.tests.fail}`,
      yes(g.built),
      `${g.hidden.filter(c => c.ok).length}/${g.hidden.length}`,
      yes(g.readme),
      r.wire ? `${r.wire.models.join(', ')} / ${r.wire.efforts.join(', ')}` : '—',
    ]
  })
  const head = ['run', 'result', 'API calls', 'build', 'vet', 'gofmt', 'go test', 'built by model', 'hidden', 'README', 'wire: model / effort']
  return table(head, rows)
}

function report(runs: RunResult[], meta: Meta): string {
  const out = [
    `# build-project-ab — ${meta.started}`,
    '',
    `model \`${meta.model}\`, effort \`${meta.effort}\`, max turns ${meta.maxTurns}, ${meta.reps} rep(s), ` +
      `proxy ${meta.proxy ? 'on' : 'off'} — ${meta.runDir}`,
    '',
    ...Object.entries(meta.versions).map(([arm, v]) => `- ${arm}: ${v}`),
    '',
    '## Grade',
    '',
    gradeTable(runs),
  ]
  const failed = runs.flatMap(r => r.grade.hidden.filter(c => !c.ok).map(c => `- ${r.arm} r${r.rep} — ${c.name}: ${c.detail}`))
  if (failed.length) out.push('', 'Failed hidden checks:', '', ...failed)
  out.push('', '## Per session', '', comparisonTable(runs, meta))
  const tools = meta.arms.map(a => [a, toolSummary(runs.filter(r => r.arm === a).flatMap(r => r.calls.map(c => c.name)))])
  out.push('', '## Tool calls, all reps', '', table(['arm', 'tools'], tools))
  for (const arm of meta.arms) {
    const r = runs.find(x => x.arm === arm && x.rep === 1) ?? runs.find(x => x.arm === arm)
    if (r) out.push('', `## Per call — ${arm} r${r.rep}`, '', turnTable(r))
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Dry run — the fixture and the grader, no tokens
// ---------------------------------------------------------------------------

const README_SAMPLE_RE = /^ {4}\$ bin\/logstat testdata\/access\.log\n((?: {4}.*\n)+)/m
const INDENT_RE = /^ {4}/gm

/** Whether the README's sample output is what `bin` prints for testdata/access.log. */
function readmeSampleIsCurrent(ws: string, bin: string): boolean {
  const m = README_SAMPLE_RE.exec(readFileSync(join(ws, 'README.md'), 'utf8'))
  return !!m && m[1]!.replace(INDENT_RE, '') === exec(bin, ['testdata/access.log'], ws).stdout
}

function dryRun(): void {
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  const graderDir = makeGrader(dir)
  const pristine = join(dir, 'pristine')
  const solved = join(dir, 'solution')
  // The reference solution with the pristine parser: one missed piece.
  const partial = join(dir, 'partial')
  for (const ws of [pristine, solved, partial]) makeWorkspace(ws)
  materialize(join(FIXTURE, 'solution'), solved)
  materialize(join(FIXTURE, 'solution'), partial)
  copyFileSync(join(FIXTURE, 'project', 'internal', 'logparse', 'parse.go.tpl'), join(partial, 'internal', 'logparse', 'parse.go'))

  const p = grade(pristine, graderDir, 'pristine')
  const make = exec('make', ['build'], solved)
  const s = grade(solved, graderDir, 'solution')
  // A source edit after the build makes the binary stale.
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(solved, 'cmd', 'logstat', 'main.go'), later, later)
  const staleAfterEdit = !builtByModel(solved)
  const h = grade(partial, graderDir, 'partial')

  const passed = (g: Grade) => g.hidden.filter(c => c.ok).map(c => c.name).join('; ') || 'none'
  const failing = (g: Grade) => g.hidden.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`).join('; ') || 'none'
  const okIn = (g: Grade, name: string) => g.hidden.find(c => c.name === name)?.ok === true
  const files = countFiles(join(FIXTURE, 'project'))
  const gates: Array<[string, boolean, string]> = [
    [`the project has ${PROJECT_FILES} files`, files === PROJECT_FILES, `${files}`],
    ['pristine builds, vets, is gofmt-clean, its tests pass', p.build && p.vet && p.gofmt && p.tests.ok && p.tests.pass > 0, `${p.tests.pass} pass / ${p.tests.fail} fail`],
    ['pristine fails every hidden check but the --format rejection', p.hidden.every(c => c.ok === (c.name === REJECT_CHECK)), `passed: ${passed(p)}`],
    ['pristine has no model build', !p.built, MODEL_BIN],
    ["pristine README's sample is its output", readmeSampleIsCurrent(pristine, join(graderDir, 'bin', 'pristine')), 'README.md'],
    ['pristine README fails the README check', !p.readme, ''],
    ['`make build` works on the solution', make.code === 0 && s.built, brief(make)],
    ['the solution builds, vets, is gofmt-clean, adds passing tests', s.build && s.vet && s.gofmt && s.tests.ok && s.tests.pass > p.tests.pass, `${s.tests.pass} pass / ${s.tests.fail} fail`],
    ['the solution passes every hidden check', s.hidden.every(c => c.ok), `failing: ${failing(s)}`],
    ["the solution README passes, and its sample is current", s.readme && readmeSampleIsCurrent(solved, join(graderDir, 'bin', 'solution')), 'README.md'],
    ['a source edit after the build is not "built"', staleAfterEdit, 'main.go touched +60s'],
    ['without the latency fix, the seconds and whole-report checks fail', !okIn(h, SECONDS_CHECK) && !okIn(h, WHOLE_CHECK) && h.build, `passed: ${passed(h)}`],
    ['the prompt exists', readPrompt().length > 500, 'prompts/task.md'],
  ]
  console.log(`dry run in ${dir}\n`)
  console.log(table(['gate', 'ok', 'detail'], gates.map(([g, ok, d]) => [g, ok ? 'yes' : 'NO', d])))
  if (gates.some(([, ok]) => !ok)) process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
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
  }
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
    else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  return a
}

function save(runDir: string, runs: RunResult[], meta: Meta): string {
  const path = join(runDir, 'results.json')
  writeFileSync(path, JSON.stringify({ meta, runs }, null, 1))
  return path
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    dryRun()
    return
  }
  if (args.replay) {
    const saved = args.replay
      .split(',')
      .filter(Boolean)
      .map(file => JSON.parse(readFileSync(file, 'utf8')) as { meta: Meta; runs: RunResult[] })
    const arms = [...new Set(saved.flatMap(s => s.meta.arms))].filter(a => !args.only || args.only.includes(a))
    const meta: Meta = {
      ...saved[0]!.meta,
      arms,
      versions: Object.assign({}, ...saved.map(s => s.meta.versions)),
      reps: Math.max(...saved.map(s => s.meta.reps)),
    }
    const text = report(saved.flatMap(s => s.runs).filter(r => arms.includes(r.arm)), meta)
    writeFileSync(join(meta.runDir, 'report.md'), text)
    console.log(text)
    return
  }

  const arms = args.only ?? [...ARMS]
  const unknown = arms.filter(a => !args.bins[a])
  if (unknown.length) {
    console.error(`no binary for ${unknown.join(', ')}`)
    process.exit(2)
  }
  if (arms.includes('claudindev') && !existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const graderDir = makeGrader(runDir)
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
        a === 'claudindev' ? `${version(args.bins[a]!)} @ ${head}${dirty ? ' (src dirty)' : ''}` : version(args.bins[a]!),
      ]),
    ),
    proxy: args.proxy,
    baselineTests: baseline.pass,
  }
  console.log(`build-project-ab → ${runDir}`)
  for (const [k, v] of Object.entries(meta.versions)) console.log(`  ${k}: ${v}`)

  const proxy = args.proxy ? await startWireProxy(join(runDir, 'proxy')) : null
  if (proxy) console.log(`  recording proxy on 127.0.0.1:${proxy.port} → ${proxy.logDir}`)
  const ctx: RunContext = { args, runDir, graderDir, proxy }
  const runs: RunResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    if (args.sequential) {
      // Rotate who goes first, so the cold prefix is not always the same arm's.
      const order = rep % 2 ? arms : [...arms].reverse()
      for (const arm of order) runs.push(await runArm(arm, rep, ctx))
    } else {
      runs.push(...(await Promise.all(arms.map(arm => runArm(arm, rep, ctx)))))
    }
    save(runDir, runs, meta)
  }
  await proxy?.close()

  const text = report(runs, meta)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${save(runDir, runs, meta)}\nreport  → ${join(runDir, 'report.md')}`)
}

if (import.meta.main) await main()
