#!/usr/bin/env bun
/**
 * Read-files A/B — does counting a Bash `cat`/`head`/`sed -n` as a Read pay off?
 *
 * The question behind it: the read-before-edit gate counts only the Read tool,
 * so a file the model saw through Bash is "never read" when it edits it, and
 * the refusal costs a round trip. `CLAUDIN_BASH_READ_CREDIT` (count what a
 * `cat` printed whole as read) with `CLAUDIN_BASH_FILE_READ_PASSTHROUGH` (print
 * a pure read whole instead of capped) turns that off — at the price of longer
 * Bash results. Both flags are off by default (team memory
 * `bash-read-passthrough-not-promoted`).
 *
 * The task is reading-heavy with a few small edits, on the same 13-file Go
 * project as build-project-ab.ts: six questions whose answers sit in six
 * different files, written to ANSWERS.md, then three one-line changes in three
 * files the model has to read first, with `go test` green. The grader checks
 * every answer against the key and the edits through the bench's own build.
 *
 * Arms, in report order (every Δ is against the first):
 *   claudindev  the default: the credit off
 *   catread     both flags on
 *   placebo     a variable nothing reads — the noise floor at this N
 *   claude      Claude Code, for reference
 * `--variant` replaces the two default variants; `--only` picks arms.
 *
 * Pre-registered gate: the credit is promoted only if catread beats claudindev
 * on BOTH est. cost and API calls with ranges SEPARATED from the placebo arm's,
 * at equal answers and edits. Anything less keeps it off.
 *
 * Usage:
 *   bun scripts/bench/ab/read-files-ab.ts --dry-run          # validate fixture + grader, no tokens
 *   bun scripts/bench/ab/read-files-ab.ts --reps=5
 *   bun scripts/bench/ab/read-files-ab.ts --replay=/tmp/read-files-ab/<stamp>/results.json
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addVariant,
  type Args,
  brief,
  comparisonTable,
  exec,
  type GoTests,
  goTest,
  makeGrader,
  makeWorkspace,
  type Meta,
  type MetricRow,
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

const FIXTURE = join(import.meta.dir, '__fixtures__', 'read-files-ab')

type Check = { name: string; ok: boolean; detail: string }

type Grade = {
  answers: Check[]
  edits: Check[]
  build: boolean
  vet: boolean
  gofmt: boolean
  tests: GoTests
}

type RunResult = SessionResult<Grade>

function readPrompt(): string {
  return readFileSync(join(FIXTURE, 'prompts', 'task.md'), 'utf8').trim()
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/** The key: what each answer must say, read off the pristine project. */
const ANSWER_KEY: ReadonlyArray<[question: string, pattern: RegExp]> = [
  // cmd/logstat/main.go: `return 2` on a usage error, `return 1` when the log cannot be read
  ['Q1 exit statuses (main.go)', /usage\s*=\s*2\b.*read\s*=\s*1\b/i],
  // internal/logparse/parse.go: `status < 100 || status > 599`
  ['Q2 status range (parse.go)', /\b100\s*[-–]\s*599\b/],
  // internal/stats/stats.go: Percentile(latencies, 50) and (…, 95)
  ['Q3 percentiles (stats.go)', /\bp?50\b.*\bp?95\b/i],
  // internal/report/text.go: "%-10s"
  ['Q4 label column width (text.go)', /^\D*\b10\b/],
  // TestParseLine, TestParseLineRejects, TestParseCountsMalformed, TestText, TestPercentile, TestSummarize
  ['Q5 test functions (*_test.go)', /^\D*\b6\b/],
  // internal/filter/filter.go: fmt.Errorf("--status %q: want one of 2xx, 3xx, 4xx, 5xx", …)
  ['Q6 --status 6xx error (filter.go)', /--status\s+\\?"6xx\\?":\s*want one of 2xx,\s*3xx,\s*4xx,\s*5xx/i],
]

const ANSWER_LINE_RE = /^[\s>*_-]*Q(\d)\s*[*_]*\s*[:.)]\s*(.+?)\s*$/gm
const BACKTICKS_RE = /`/g

function gradeAnswers(ws: string): Check[] {
  let text = ''
  try {
    text = readFileSync(join(ws, 'ANSWERS.md'), 'utf8')
  } catch {
    return ANSWER_KEY.map(([name]) => ({ name, ok: false, detail: 'no ANSWERS.md' }))
  }
  const answers = new Map<number, string>()
  for (const m of text.matchAll(ANSWER_LINE_RE)) {
    if (!answers.has(Number(m[1]))) answers.set(Number(m[1]), m[2]!.replace(BACKTICKS_RE, '').trim())
  }
  return ANSWER_KEY.map(([name, pattern], i) => {
    const given = answers.get(i + 1)
    return { name, ok: given !== undefined && pattern.test(given), detail: given ?? 'missing' }
  })
}

const TOP_ROW_RE = /^ +\d+ {2}\/\S*$/gm
/** hidden/comments.log: three requests between `//` and `#` comment lines. */
const COMMENTS_ROWS_RE: readonly RegExp[] = [/^requests +3$/m, /^malformed +0$/m]

function gradeEdits(bin: string | null, graderDir: string): Check[] {
  const names = ['E1 --top defaults to 3', 'E2 heading is "busiest paths"', 'E3 // lines are comments']
  if (!bin) return names.map(name => ({ name, ok: false, detail: 'the workspace does not build' }))
  const access = exec(bin, [join(graderDir, 'access.log')], graderDir)
  const comments = exec(bin, [join(graderDir, 'comments.log')], graderDir)
  const rows = access.stdout.match(TOP_ROW_RE)?.length ?? 0
  return [
    { name: names[0]!, ok: access.code === 0 && rows === 3, detail: `${rows} path rows` },
    {
      name: names[1]!,
      ok: access.code === 0 && /^busiest paths$/m.test(access.stdout) && !/^top paths$/m.test(access.stdout),
      detail: brief(access),
    },
    { name: names[2]!, ok: comments.code === 0 && COMMENTS_ROWS_RE.every(re => re.test(comments.stdout)), detail: brief(comments) },
  ]
}

function grade(ws: string, graderDir: string, label: string): Grade {
  const bin = join(graderDir, 'bin', label)
  const build = exec('go', ['build', '-o', bin, './cmd/logstat'], ws).code === 0
  const fmt = exec('gofmt', ['-l', '.'], ws)
  return {
    answers: gradeAnswers(ws),
    edits: gradeEdits(build ? bin : null, graderDir),
    build,
    vet: exec('go', ['vet', './...'], ws).code === 0,
    gofmt: fmt.code === 0 && fmt.stdout.trim() === '',
    tests: goTest(ws),
  }
}

const passed = (checks: Check[]): number => checks.filter(c => c.ok).length

// ---------------------------------------------------------------------------
// Reading, from the tool calls
// ---------------------------------------------------------------------------

/** A Bash command that prints files: `cat`, `head`, `tail`, `nl`, `less`, `more`, `bat`, or `sed -n`. */
const BASH_READ_RE = /(?:^|[\s;&|(])(?:cat|head|tail|nl|less|more|bat)\s|\bsed\s+-n\b/
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'Patch', 'apply_patch', 'NotebookEdit'])

type Metrics = SessionMetrics & {
  readCalls: number
  batchReads: number
  filesRead: number
  reReads: number
  bashReads: number
  grepContent: number
  globCalls: number
  credited: number
  editCalls: number
  gateRefusals: number
  answersRight: number
  editsRight: number
}

function metricsOf(r: RunResult): Metrics {
  const seen = new Set<string>()
  let readCalls = 0
  let batchReads = 0
  let reReads = 0
  for (const c of r.calls) {
    if (c.name !== 'Read') continue
    readCalls++
    const paths = Array.isArray(c.input.file_paths) ? c.input.file_paths : [c.input.file_path]
    if (Array.isArray(c.input.file_paths)) batchReads++
    for (const p of paths) {
      if (typeof p !== 'string') continue
      if (seen.has(p)) reReads++
      seen.add(p)
    }
  }
  return {
    ...sessionMetrics(r),
    readCalls,
    batchReads,
    filesRead: seen.size,
    reReads,
    bashReads: r.calls.filter(c => c.name === 'Bash' && BASH_READ_RE.test(String(c.input.command ?? ''))).length,
    grepContent: r.calls.filter(c => c.name === 'Grep' && c.input.output_mode === 'content').length,
    globCalls: r.calls.filter(c => c.name === 'Glob').length,
    credited: r.calls.reduce((a, c) => a + (c.credited?.length ?? 0), 0),
    editCalls: r.calls.filter(c => EDIT_TOOLS.has(c.name)).length,
    gateRefusals: r.calls.filter(c => c.refused && EDIT_TOOLS.has(c.name)).length,
    answersRight: passed(r.grade.answers),
    editsRight: passed(r.grade.edits),
  }
}

const READ_ROWS: MetricRow<Metrics>[] = [
  ['Read calls', 'readCalls', fmtInt],
  ['  of which batch (file_paths)', 'batchReads', fmtInt],
  ['  distinct files read', 'filesRead', fmtInt],
  ['  files read again', 'reReads', fmtInt],
  ['Bash calls that print files (cat/head/tail/sed -n…)', 'bashReads', fmtInt],
  ['  files the credit counted as read', 'credited', fmtInt],
  ['Grep calls in content mode', 'grepContent', fmtInt],
  ['Glob calls', 'globCalls', fmtInt],
  ['edit calls (Edit/Write/Patch)', 'editCalls', fmtInt],
  ['  refused by the harness (read gate)', 'gateRefusals', fmtInt],
  [`answers right (of ${ANSWER_KEY.length})`, 'answersRight', fmtInt],
  ['edits right (of 3)', 'editsRight', fmtInt],
]

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function gradeTable(runs: RunResult[]): string {
  const rows = runs.map(r => {
    const g = r.grade
    const m = metricsOf(r)
    return [
      `${r.arm} r${r.rep}`,
      r.run.subtype ?? `exit ${r.run.exitCode}`,
      String(r.turns.length),
      `${passed(g.answers)}/${g.answers.length}`,
      `${passed(g.edits)}/${g.edits.length}`,
      `${g.tests.pass}/${g.tests.pass + g.tests.fail}`,
      yes(g.vet && g.gofmt),
      `${m.readCalls} / ${m.bashReads}`,
      String(m.gateRefusals),
      r.wire ? `${r.wire.models.join(', ')} / ${r.wire.efforts.join(', ')}` : '—',
    ]
  })
  const head = ['run', 'result', 'API calls', 'answers', 'edits', 'go test', 'vet+gofmt', 'Read / Bash reads', 'gate refusals', 'wire: model / effort']
  return table(head, rows)
}

function report(runs: RunResult[], meta: Meta): string {
  const out = [...reportHeader(meta), '', '## Grade', '', gradeTable(runs)]
  const failed = runs.flatMap(r =>
    [...r.grade.answers, ...r.grade.edits].filter(c => !c.ok).map(c => `- ${r.arm} r${r.rep} — ${c.name}: ${c.detail}`),
  )
  if (failed.length) out.push('', 'Failed checks:', '', ...failed)
  out.push('', '## Reading', '', comparisonTable(runs, meta.arms, metricsOf, READ_ROWS))
  out.push('', '## Per session', '', comparisonTable(runs, meta.arms, metricsOf, SESSION_ROWS as MetricRow<Metrics>[]))
  out.push(...toolAndCallSections(runs, meta.arms))
  return out.join('\n')
}

const BENCH = {
  name: 'read-files-ab',
  hiddenFixture: join(FIXTURE, 'hidden'),
  defaultArms: (args: Args) => ['claudindev', ...args.variants, 'claude'],
  task: {
    prompt: readPrompt(),
    grade,
    summary: (g: Grade) =>
      `answers ${passed(g.answers)}/${g.answers.length}, edits ${passed(g.edits)}/${g.edits.length}, ` +
      `go test ${g.tests.pass}/${g.tests.pass + g.tests.fail}`,
  },
  report,
}

// ---------------------------------------------------------------------------
// Dry run — the fixture and the grader, no tokens
// ---------------------------------------------------------------------------

function dryRun(): void {
  const dir = join('/tmp', BENCH.name, `dry-run-${stamp()}`)
  const graderDir = makeGrader(dir, BENCH.hiddenFixture)
  const pristine = join(dir, 'pristine')
  const solved = join(dir, 'solution')
  // The answers alone: every question right, no change made.
  const answersOnly = join(dir, 'answers-only')
  for (const ws of [pristine, solved, answersOnly]) makeWorkspace(ws)
  materialize(join(FIXTURE, 'solution'), solved)
  copyFileSync(join(FIXTURE, 'solution', 'ANSWERS.md.tpl'), join(answersOnly, 'ANSWERS.md'))

  const p = grade(pristine, graderDir, 'pristine')
  const s = grade(solved, graderDir, 'solution')
  const a = grade(answersOnly, graderDir, 'answers-only')
  const failing = (checks: Check[]) => checks.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`).join('; ') || 'none'
  const gates: Array<[string, boolean, string]> = [
    ['pristine builds, vets, is gofmt-clean, its tests pass', p.build && p.vet && p.gofmt && p.tests.ok && p.tests.pass > 0, `${p.tests.pass} pass`],
    ['pristine has no answers and fails every edit check', passed(p.answers) === 0 && passed(p.edits) === 0, `edits: ${failing(p.edits)}`],
    ['the solution answers every question', passed(s.answers) === ANSWER_KEY.length, `failing: ${failing(s.answers)}`],
    ['the solution passes every edit check, vet, gofmt and go test', passed(s.edits) === 3 && s.vet && s.gofmt && s.tests.ok, `failing: ${failing(s.edits)}`],
    ['answers alone: every answer right, every edit check failing', passed(a.answers) === ANSWER_KEY.length && passed(a.edits) === 0, `edits: ${failing(a.edits)}`],
    ['the prompt asks all six questions and three changes', (readPrompt().match(/^\d\. /gm) ?? []).length === 9, 'prompts/task.md'],
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
  if (args.dryRun) return dryRun()
  if (args.replay) return replayBench(BENCH, args)
  if (!args.variants.length) {
    addVariant(args, 'catread', { CLAUDIN_BASH_READ_CREDIT: '1', CLAUDIN_BASH_FILE_READ_PASSTHROUGH: '1' })
    addVariant(args, 'placebo', { CLAUDIN_BENCH_PLACEBO: '1' })
  }
  await runBench(BENCH, args)
}

if (import.meta.main) await main()
