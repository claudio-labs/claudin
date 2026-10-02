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
 * The run itself — workspaces, arms, proxy, usage, the per-session metrics —
 * is goProjectBench.ts, shared with read-files-ab.ts.
 *
 * Usage:
 *   bun scripts/bench/ab/build-project-ab.ts --dry-run          # validate fixture + grader, no tokens
 *   bun scripts/bench/ab/build-project-ab.ts                    # 1 rep, both arms in parallel
 *   bun scripts/bench/ab/build-project-ab.ts --reps=3
 *   bun scripts/bench/ab/build-project-ab.ts --model=claude-opus-5-5 --effort=medium
 *   bun scripts/bench/ab/build-project-ab.ts --variant=atomic:CLAUDIN_PATCH_ALL_OR_NOTHING=1
 *   bun scripts/bench/ab/build-project-ab.ts --replay=/tmp/build-project-ab/<stamp>/results.json
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  type Args,
  brief,
  comparisonTable,
  countFiles,
  exec,
  type GoTests,
  goTest,
  isRecord,
  makeGrader,
  makeWorkspace,
  type Meta,
  type MetricRow,
  type Out,
  PROJECT_FILES,
  PROJECT_FIXTURE,
  parseArgs,
  replayBench,
  reportHeader,
  runBench,
  SESSION_ROWS,
  type SessionMetrics,
  type SessionResult,
  sessionMetrics,
  toolAndCallSections,
  yes,
} from './goProjectBench'
import { fmtInt, materialize, stamp, table } from './session-cache-ab'

const FIXTURE = join(import.meta.dir, '__fixtures__', 'build-project-ab')
/** Where `make build` puts the binary, relative to the workspace. */
const MODEL_BIN = join('bin', 'logstat')

type Json = Record<string, unknown>

type Check = { name: string; ok: boolean; detail: string }

type Grade = {
  /** The bench's own `go build` of the workspace. */
  build: boolean
  vet: boolean
  /** `gofmt -l` listed nothing. */
  gofmt: boolean
  tests: GoTests
  /** The model's `bin/logstat` is newer than every non-test .go file: it built what it wrote. */
  built: boolean
  hidden: Check[]
  /** The README mentions --format, --method and p99. */
  readme: boolean
}

type RunResult = SessionResult<Grade>

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function readPrompt(): string {
  return readFileSync(join(FIXTURE, 'prompts', 'task.md'), 'utf8').trim()
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

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
// Reporting
// ---------------------------------------------------------------------------

type Metrics = SessionMetrics & { testsPass: number; hiddenPass: number }

function metricsOf(r: RunResult): Metrics {
  return {
    ...sessionMetrics(r),
    testsPass: r.grade.tests.pass,
    hiddenPass: r.grade.hidden.filter(c => c.ok).length,
  }
}

function metricRows(meta: Meta): MetricRow<Metrics>[] {
  return [
    ...SESSION_ROWS,
    [`go test cases passing (pristine: ${meta.baselineTests})`, 'testsPass', fmtInt],
    [`hidden checks passed (of ${HIDDEN_CHECKS.length})`, 'hiddenPass', fmtInt],
  ]
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
  const out = [...reportHeader(meta), '', '## Grade', '', gradeTable(runs)]
  const failed = runs.flatMap(r => r.grade.hidden.filter(c => !c.ok).map(c => `- ${r.arm} r${r.rep} — ${c.name}: ${c.detail}`))
  if (failed.length) out.push('', 'Failed hidden checks:', '', ...failed)
  out.push('', '## Per session', '', comparisonTable(runs, meta.arms, metricsOf, metricRows(meta)))
  out.push(...toolAndCallSections(runs, meta.arms))
  return out.join('\n')
}

const BENCH = {
  name: 'build-project-ab',
  hiddenFixture: join(FIXTURE, 'hidden'),
  defaultArms: (args: Args) => ['claude', 'claudindev', ...args.variants],
  task: {
    prompt: readPrompt(),
    grade,
    summary: (g: Grade) =>
      `build ${yes(g.build)}, go test ${g.tests.pass}/${g.tests.pass + g.tests.fail}, built by model ${yes(g.built)}, ` +
      `hidden ${g.hidden.filter(c => c.ok).length}/${g.hidden.length}`,
  },
  report,
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
  const dir = join('/tmp', BENCH.name, `dry-run-${stamp()}`)
  const graderDir = makeGrader(dir, BENCH.hiddenFixture)
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
  const files = countFiles(PROJECT_FIXTURE)
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) dryRun()
  else if (args.replay) replayBench(BENCH, args)
  else await runBench(BENCH, args)
}

if (import.meta.main) await main()
