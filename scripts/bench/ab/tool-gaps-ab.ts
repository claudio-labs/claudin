#!/usr/bin/env bun
/**
 * Tool-gaps A/B: one headless two-phase session per arm and rep against the
 * `__fixtures__/tool-gaps-ab/` service, measuring the levers of the 10-30
 * census branch (`toolGapsMechanisms.ts`) and what the session cost.
 *
 *   bun scripts/bench/ab/tool-gaps-ab.ts --dry-run                 # validate the fixture, no tokens
 *   bun scripts/bench/ab/tool-gaps-ab.ts --only=combo --reps=1 --phases=1   # the live probe
 *   bun scripts/bench/ab/tool-gaps-ab.ts --reps=5 --bin=main:<worktree>/bin/claudin
 *   bun scripts/bench/ab/tool-gaps-ab.ts --only=main,current,current-placebo --reps=5 --bin=main:<worktree>/bin/claudin
 *   bun scripts/bench/ab/tool-gaps-ab.ts --report=/tmp/tool-gaps-ab/<stamp>   # recount a finished run
 *
 * Phase 1 plans in plan mode, implements against the docs, starts the service
 * with a script that backgrounds it and returns, and stops it. Phase 2
 * (`--resume`) commits, has an Explore agent review a 7-file branch, and fixes
 * its three planted bugs. Hidden acceptance tests grade each phase.
 *
 * Arms run side by side, each rep in its own workspace with its own port:
 *
 *   main     the build of the branch point (`--bin=main:<path>`), flags unset
 *   base     this checkout, every lever off — pinned to the state the 10-30
 *            runs measured, since two of them became defaults afterwards
 *   placebo  base plus a variable nothing reads
 *   combo    this checkout, every lever on
 *
 * Plan approval: `-p` cannot show the ExitPlanMode dialog, so every arm runs
 * with `approver.ts` as `--permission-prompt-tool` (it approves the plan and
 * declines AskUserQuestion). Task tools need `CLAUDIN_ENABLE_TASKS=1` in `-p`.
 *
 * Leaks: after each phase, every process whose cwd is inside the workspace is
 * recorded and killed. That is the server a session started and never stopped.
 *
 * The gates are the ones pre-registered in the plan of the 10-30 census branch;
 * `report.md` prints each with its verdict. Results land in
 * `/tmp/tool-gaps-ab/<stamp>/`. `dist/cli.mjs` must be built.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, transcriptPath } from './cliUsage'
import {
  analyzeSession,
  costOf,
  git,
  materialize,
  phaseArgs,
  phaseRunOf,
  spawnCollect,
  stamp,
  subagentUsage,
  table,
  type PhaseRun,
} from './session-cache-ab'
import { dedicatedReadShare, emptyMechanisms, type Mechanisms, mechanismsOf } from './toolGapsMechanisms'

type Json = Record<string, unknown>
type Phase = 1 | 2

const FIXTURE = join(import.meta.dir, '__fixtures__', 'tool-gaps-ab')
const BENCH_ROOT = '/tmp/tool-gaps-ab'
const APPROVER = join(import.meta.dir, 'approver.ts')
const DIFF_MIN_CHARS = 6000
const PORT_BASE = 46100

/** The defaults before 2026-10-30's promotion: task ids off, the file-tools note on. */
const LEVERS_OFF = { CLAUDIN_PLAN_TASK_IDS: '0', CLAUDIN_FILE_TOOLS_NOTE: '1' }

export const ARM_ENV: Record<string, Record<string, string>> = {
  main: {},
  base: { ...LEVERS_OFF },
  placebo: { ...LEVERS_OFF, CLAUDIN_BENCH_PLACEBO: '1' },
  combo: {
    CLAUDIN_PLAN_TASK_IDS: '1',
    CLAUDIN_OUTLINE_PROSE_BY_LINES: '1',
    CLAUDIN_ADOPT_LEFTOVERS: '1',
    CLAUDIN_DISABLE_TOOL_REDIRECT: '1',
  },
  // The call-forms run compares against this branch's defaults, the 10-30
  // promotion included: `--only=current,current-placebo,meta`.
  current: {},
  'current-placebo': { CLAUDIN_BENCH_PLACEBO: '1' },
  meta: { CLAUDIN_DEFERRED_CALL_FORMS: '1' },
}
const ALL_ARMS = Object.keys(ARM_ENV)
/** Arms built from this branch: the diff-wording fix must hold in all of them. */
const BRANCH_ARMS = ['base', 'placebo', 'combo', 'current', 'current-placebo', 'meta']

type Args = {
  reps: number
  arms: string[]
  phases: Phase[]
  model: string
  effort: string
  maxTurns: [number, number]
  budgetUsd: number
  timeoutMs: number
  dryRun: boolean
  /** A finished run's directory: recount its archived transcripts and print the report. */
  reportDir: string
  bins: Record<string, string>
}

type TestRun = { ok: boolean; pass: number; fail: number; failed: string[] }
type Leak = { pid: number; command: string }

type RunResult = {
  arm: string
  rep: number
  sessionId: string | null
  phases: PhaseRun[]
  hidden: TestRun[]
  tests: TestRun[]
  leaks: Leak[][]
  committed: { main: boolean; branch: boolean } | null
  costUsd: number
  apiCalls: number
  subagentCalls: number
  mechanisms: Mechanisms
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 1,
    arms: ['main', 'base', 'placebo', 'combo'],
    phases: [1, 2],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    maxTurns: [70, 50],
    budgetUsd: 6,
    timeoutMs: 40 * 60_000,
    dryRun: false,
    reportDir: '',
    bins: Object.fromEntries(ALL_ARMS.map(arm => [arm, join(REPO_ROOT, 'bin', 'claudin')])),
  }
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--report') a.reportDir = v
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.arms = v.split(',').filter(Boolean)
    else if (k === '--phases') a.phases = v.split(',').map(Number) as Phase[]
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--max-turns') a.maxTurns = v.split(',').map(Number) as [number, number]
    else if (k === '--budget') a.budgetUsd = Number(v)
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--bin') {
      const [label, path] = v.split(/:(.*)/s, 2) as [string, string?]
      if (!path) throw new Error(`--bin needs <label>:<path>, got ${v}`)
      a.bins[label] = path
    } else throw new Error(`unknown argument ${x}`)
  }
  for (const arm of a.arms) if (!(arm in ARM_ENV)) throw new Error(`unknown arm ${arm}; arms: ${ALL_ARMS.join(', ')}`)
  if (!a.dryRun && !a.reportDir && a.arms.includes('main') && a.bins.main === a.bins.base) {
    throw new Error('the main arm needs --bin=main:<path to a build of the branch point>')
  }
  return a
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function commitAll(ws: string, message: string): void {
  for (const step of [['add', '-A'], ['commit', '-q', '-m', message]]) {
    const r = git(ws, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${ws}: ${r.out}`)
  }
}

/** `main` with the service, `feature/bulk` beside it, `config/port` written and ignored. */
export function makeWorkspace(ws: string, port: number): void {
  materialize(join(FIXTURE, 'project'), ws)
  mkdirSync(join(ws, 'config'), { recursive: true })
  writeFileSync(join(ws, 'config', 'port'), `${port}\n`)
  for (const step of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '.git/no-hooks'],
  ]) {
    const r = git(ws, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${ws}: ${r.out}`)
  }
  commitAll(ws, 'chore: import inventory-svc 0.4.0')
  git(ws, 'checkout', '-q', '-b', 'feature/bulk')
  materialize(join(FIXTURE, 'branch'), ws)
  commitAll(ws, 'feat(bulk): add POST /items/bulk import')
  const back = git(ws, 'checkout', '-q', 'main')
  if (!back.ok) throw new Error(`git checkout main failed in ${ws}: ${back.out}`)
}

function makeGrader(runDir: string): string {
  const dir = join(runDir, 'grader')
  materialize(join(FIXTURE, 'hidden'), dir)
  return dir
}

function prompt(phase: Phase): string {
  const base = join(FIXTURE, 'prompts', `phase${phase}.md`)
  return readFileSync(existsSync(base) ? base : `${base}.tpl`, 'utf8').trim()
}

// ---------------------------------------------------------------------------
// Grading and leaks
// ---------------------------------------------------------------------------

const TEST_RESULT_RE = /^\((pass|fail)\) (.+?)(?: \[[\d.]+m?s\])?$/gm
const TEST_COUNT_RE = /^\s*(\d+) (pass|fail)$/gm

function bunTest(cwd: string, files: string[], env: Record<string, string> = {}): TestRun {
  const r = spawnSync('bun', ['test', ...files], { cwd, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  let pass = 0
  let fail = 0
  for (const m of out.matchAll(TEST_COUNT_RE)) {
    if (m[2] === 'pass') pass = Number(m[1])
    else fail = Number(m[1])
  }
  const failed = [...out.matchAll(TEST_RESULT_RE)].filter(m => m[1] === 'fail').map(m => m[2]!)
  return { ok: r.status === 0, pass, fail, failed }
}

function hiddenRun(graderDir: string, ws: string, phase: Phase): TestRun {
  return bunTest(graderDir, [`./phase${phase}.acceptance.test.ts`], { TGA_WORKSPACE: ws })
}

/** Every process whose cwd is inside `ws`, killed after it is recorded. Linux only. */
export function reapLeaks(ws: string, procRoot = '/proc'): Leak[] {
  const leaks: Leak[] = []
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue
    let cwd: string
    try {
      cwd = readlinkSync(join(procRoot, name, 'cwd'))
    } catch {
      continue
    }
    if (cwd !== ws && !cwd.startsWith(`${ws}/`)) continue
    let command = ''
    try {
      command = readFileSync(join(procRoot, name, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim()
    } catch {
      // gone already
    }
    leaks.push({ pid: Number(name), command })
  }
  for (const { pid } of leaks) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone already
    }
  }
  return leaks
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function mcpConfig(): string {
  return JSON.stringify({ mcpServers: { approver: { type: 'stdio', command: process.execPath, args: [APPROVER] } } })
}

async function runArm(arm: string, rep: number, args: Args, runDir: string, graderDir: string): Promise<RunResult> {
  const label = `${arm}-r${rep}`
  const ws = join(runDir, label)
  makeWorkspace(ws, PORT_BASE + ALL_ARMS.indexOf(arm) * 20 + rep)
  const cliArgs = { ...args, args: { [arm]: ['--mcp-config', mcpConfig(), '--strict-mcp-config', '--permission-prompt-tool', 'mcp__approver__allow'] } }
  const env = { CLAUDIN_ENABLE_TASKS: '1', ...ARM_ENV[arm] }
  const phases: PhaseRun[] = []
  const streams: Json[][] = []
  const hidden: TestRun[] = []
  const tests: TestRun[] = []
  const leaks: Leak[][] = []
  let sessionId: string | null = null
  for (const phase of args.phases) {
    if (phase === 2 && !sessionId) break
    const cli = phaseArgs(cliArgs as never, arm, phase, prompt(phase), phase === 2 ? sessionId : null)
    const res = await spawnCollect(args.bins[arm]!, cli, ws, join(runDir, `${label}.p${phase}`), args.timeoutMs, env)
    const events = parseJsonl(res.stdout) as Json[]
    const run = phaseRunOf(phase, res, events)
    phases.push(run)
    streams.push(events)
    sessionId ??= run.sessionId
    leaks.push(reapLeaks(ws))
    hidden.push(hiddenRun(graderDir, ws, phase))
    tests.push(bunTest(ws, ['src']))
    const h = hidden.at(-1)!
    console.log(
      `[${label}] phase ${phase}: ${run.subtype ?? `exit ${run.exitCode}`}${run.timedOut ? ' (TIMED OUT)' : ''}, ` +
        `${run.messageIds.length} calls, ${(run.wallMs / 1000).toFixed(0)}s — hidden ${h.pass}/${h.pass + h.fail}, ` +
        `leaked ${leaks.at(-1)!.length}`,
    )
  }
  const committed = args.phases.includes(2)
    ? {
        main: Number(git(ws, 'rev-list', '--count', 'main').out.trim()) > 1,
        branch: Number(git(ws, 'rev-list', '--count', 'main..feature/bulk').out.trim()) > 1,
      }
    : null

  const tPath = sessionId ? transcriptPath(sessionId) : null
  const transcript = tPath && existsSync(tPath) ? (parseJsonl(readFileSync(tPath, 'utf8')) as Json[]) : null
  if (transcript && tPath) writeFileSync(join(runDir, `${label}.transcript.jsonl`), readFileSync(tPath))
  const phase2Ids = new Set(phases.find(p => p.phase === 2)?.messageIds ?? [])
  const session = analyzeSession(streams, phase2Ids, transcript)
  const archive = join(runDir, `${label}.subagents`)
  const subagents = tPath && sessionId ? subagentUsage(join(dirname(tPath), sessionId), archive) : null
  const subThreads = existsSync(archive)
    ? readdirSync(archive).filter(f => f.endsWith('.jsonl')).map(f => parseJsonl(readFileSync(join(archive, f), 'utf8')) as Json[])
    : []
  const mainCost = session.turns.reduce((sum, t) => sum + costOf(t.model, t), 0)
  return {
    arm,
    rep,
    sessionId,
    phases,
    hidden,
    tests,
    leaks,
    committed,
    costUsd: mainCost + (subagents?.costUsd ?? 0),
    apiCalls: session.turns.length + (subagents?.turns ?? 0),
    subagentCalls: subagents?.turns ?? 0,
    mechanisms: transcript ? mechanismsOf(transcript, subThreads) : emptyMechanisms(),
  }
}

// ---------------------------------------------------------------------------
// Report and gates
// ---------------------------------------------------------------------------

const median = (xs: number[]): number => {
  const s = xs.filter(x => !Number.isNaN(x)).sort((a, b) => a - b)
  if (s.length === 0) return Number.NaN
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
const hiddenPass = (r: RunResult) => r.hidden.reduce((n, h) => n + h.pass, 0)
const leaked = (r: RunResult) => r.leaks.reduce((n, l) => n + l.length, 0)
const broken = (r: RunResult) => r.phases.some(p => p.timedOut || (p.subtype !== null && p.subtype !== 'success')) || r.phases.length === 0

type Gate = { gate: string; verdict: 'PASS' | 'FAIL' | 'NO HEADROOM' | 'n/a'; detail: string }

export function gates(results: readonly RunResult[]): Gate[] {
  const of = (arm: string) => results.filter(r => r.arm === arm)
  if (of('meta').length > 0) return metaGates(results)
  if (of('main').length > 0 && of('current').length > 0) return devFormGates(results)
  const base = of('base')
  const combo = of('combo')
  const placebo = of('placebo')
  if (base.length === 0 || combo.length === 0) return [{ gate: 'all', verdict: 'n/a', detail: 'needs base and combo' }]
  const count = (rs: RunResult[], f: (r: RunResult) => boolean) => rs.filter(f).length
  const m = (rs: RunResult[], f: (x: Mechanisms) => number) => rs.map(r => f(r.mechanisms))
  const out: Gate[] = []
  const lever = (gate: string, headroom: number, verdict: boolean, detail: string) =>
    out.push({ gate, verdict: headroom < Math.ceil(base.length * 0.6) ? 'NO HEADROOM' : verdict ? 'PASS' : 'FAIL', detail: `base shows it ${headroom}/${base.length}; ${detail}` })

  const correctness = results.every(r => !broken(r)) && ALL_ARMS.every(arm => of(arm).length === 0 || of(arm).reduce((n, r) => n + hiddenPass(r), 0) >= base.reduce((n, r) => n + hiddenPass(r), 0))
  out.push({ gate: 'correctness', verdict: correctness ? 'PASS' : 'FAIL', detail: ALL_ARMS.filter(a => of(a).length).map(a => `${a} hidden ${of(a).reduce((n, r) => n + hiddenPass(r), 0)}, broken ${count(of(a), broken)}`).join('; ') })

  const taskClean = (r: RunResult) => r.mechanisms.taskToolSearchAfterPlan === 0 && r.mechanisms.taskListBeforeFirstUpdate === 0
  const unloadedErr = combo.reduce((n, r) => n + r.mechanisms.taskUpdateUnloadedErr, 0)
  lever('tasks', count(base, r => !taskClean(r)), count(combo, taskClean) >= Math.ceil(combo.length * 0.8) && unloadedErr === 0, `combo clean ${count(combo, taskClean)}/${combo.length}, unloaded TaskUpdate errors ${unloadedErr}`)

  lever('outline', count(base, r => r.mechanisms.docsOutlined > 0), count(combo, r => r.mechanisms.docsOutlineThenBody === 0) === combo.length, `combo outline→body ${m(combo, x => x.docsOutlineThenBody).join(',')}`)

  const procMed = (rs: RunResult[]) => median(m(rs, x => x.processBash))
  lever(
    'processes',
    count(base, r => r.mechanisms.processBash > 0 || leaked(r) > 0),
    count(combo, r => leaked(r) === 0) === combo.length && procMed(combo) < procMed(base) && count(combo, r => r.mechanisms.taskStops > 0) >= Math.ceil(combo.length * 0.6),
    `combo leaks ${combo.map(leaked).join(',')}, process Bash median ${procMed(combo)} vs base ${procMed(base)}, TaskStop in ${count(combo, r => r.mechanisms.taskStops > 0)}/${combo.length}`,
  )

  const share = (rs: RunResult[]) => median(rs.map(r => dedicatedReadShare(r.mechanisms)))
  out.push({ gate: 'file-tools note off', verdict: share(combo) >= share(base) - 10 ? 'PASS' : 'FAIL', detail: `Read/Grep/Glob share ${share(combo).toFixed(1)}% vs base ${share(base).toFixed(1)}%` })

  const cost = (rs: RunResult[]) => median(rs.map(r => r.costUsd))
  const calls = (rs: RunResult[]) => median(rs.map(r => r.apiCalls))
  const ceiling = placebo.length ? Math.max(cost(base), cost(placebo)) : cost(base)
  out.push({
    gate: 'cost and calls',
    verdict: cost(combo) <= cost(base) && cost(combo) <= ceiling && calls(combo) <= calls(base) ? 'PASS' : 'FAIL',
    detail: `median $ combo ${cost(combo).toFixed(3)} base ${cost(base).toFixed(3)}${placebo.length ? ` placebo ${cost(placebo).toFixed(3)}` : ''}; calls combo ${calls(combo)} base ${calls(base)}`,
  })

  const branch = results.filter(r => BRANCH_ARMS.includes(r.arm))
  const reruns = branch.reduce((n, r) => n + r.mechanisms.diffCatReruns + r.mechanisms.diffPivotsNamingGitToBash, 0)
  out.push({ gate: 'diff wording (branch arms)', verdict: reruns === 0 ? 'PASS' : 'FAIL', detail: `| cat re-runs + Git-tool hints to Bash: ${reruns}; main arm: ${of('main').reduce((n, r) => n + r.mechanisms.diffCatReruns, 0)} re-runs` })
  return out
}

/**
 * The call-forms run (CLAUDIN_DEFERRED_CALL_FORMS), pre-registered 10-30 in
 * `.claudin/plans/peaceful-foraging-kahn.md`. Its baseline is this branch's
 * defaults (`current`), with a placebo of the same defaults. Passes when every
 * arm keeps the hidden tests, ToolSearch-only requests fall in at least 2 of 3
 * meta reps, no direct call to a deferred tool errors, and the meta arm's
 * median cost is no higher than the higher of current and its placebo.
 */
function metaGates(results: readonly RunResult[]): Gate[] {
  const of = (arm: string) => results.filter(r => r.arm === arm)
  const main = of('current')
  const placebo = of('current-placebo')
  const meta = of('meta')
  const hidden = (rs: RunResult[]) => rs.reduce((n, r) => n + hiddenPass(r), 0)
  const out: Gate[] = []
  const arms = [main, placebo, meta].filter(rs => rs.length)
  out.push({
    gate: 'correctness',
    verdict: results.every(r => !broken(r)) && arms.every(rs => hidden(rs) >= hidden(main)) ? 'PASS' : 'FAIL',
    detail: `hidden current ${hidden(main)}, placebo ${hidden(placebo)}, meta ${hidden(meta)}`,
  })
  const tsMain = median(main.map(r => r.mechanisms.toolSearchOnlyRequests))
  const fell = meta.filter(r => r.mechanisms.toolSearchOnlyRequests < tsMain).length
  const errs = meta.reduce((n, r) => n + r.mechanisms.directDeferredErr, 0)
  out.push({
    gate: 'call forms: ToolSearch-only requests',
    verdict: tsMain === 0 ? 'NO HEADROOM' : fell >= Math.ceil(meta.length * 0.6) && errs === 0 ? 'PASS' : 'FAIL',
    detail: `current median ${tsMain}; meta per rep ${meta.map(r => r.mechanisms.toolSearchOnlyRequests).join(',')}; direct deferred calls ok ${meta.reduce((n, r) => n + r.mechanisms.directDeferredOk, 0)}, errors ${errs}`,
  })
  const cost = (rs: RunResult[]) => median(rs.map(r => r.costUsd))
  const ceiling = placebo.length ? Math.max(cost(main), cost(placebo)) : cost(main)
  out.push({
    gate: 'cost',
    verdict: cost(meta) <= ceiling ? 'PASS' : 'FAIL',
    detail: `median $ meta ${cost(meta).toFixed(3)}, current ${cost(main).toFixed(3)}${placebo.length ? `, placebo ${cost(placebo).toFixed(3)}` : ''}`,
  })
  return out
}

/**
 * The dev-tool call forms run (perf/tool-repeat-calls), pre-registered in
 * `.claudin/plans/structured-toasting-rossum.md`: the build of the branch point
 * (`main`) against this branch's defaults (`current`) and its placebo. Passes
 * when every arm keeps the hidden tests, `current` loads none of the four dev
 * tools through ToolSearch in at least 4 of 5 reps while `main` loads one in
 * its median rep, no direct call to a deferred tool errors, and `current`'s
 * median cost is no higher than the higher of `main` and the placebo.
 */
function devFormGates(results: readonly RunResult[]): Gate[] {
  const of = (arm: string) => results.filter(r => r.arm === arm)
  const main = of('main')
  const current = of('current')
  const placebo = of('current-placebo')
  const hidden = (rs: RunResult[]) => rs.reduce((n, r) => n + hiddenPass(r), 0)
  const out: Gate[] = []
  out.push({
    gate: 'correctness',
    verdict: results.every(r => !broken(r)) && [current, placebo].every(rs => rs.length === 0 || hidden(rs) >= hidden(main)) ? 'PASS' : 'FAIL',
    detail: `hidden main ${hidden(main)}, current ${hidden(current)}, placebo ${hidden(placebo)}`,
  })
  const loadsMain = median(main.map(r => r.mechanisms.devToolLoads))
  const clean = current.filter(r => r.mechanisms.devToolLoads === 0).length
  const errs = current.reduce((n, r) => n + r.mechanisms.directDeferredErr, 0)
  out.push({
    gate: 'dev-tool forms: ToolSearch loads',
    verdict: loadsMain === 0 ? 'NO HEADROOM' : clean >= Math.ceil(current.length * 0.8) && errs === 0 ? 'PASS' : 'FAIL',
    detail: `main median ${loadsMain}; current per rep ${current.map(r => r.mechanisms.devToolLoads).join(',')}; direct deferred calls ok ${current.reduce((n, r) => n + r.mechanisms.directDeferredOk, 0)}, errors ${errs}`,
  })
  const cost = (rs: RunResult[]) => median(rs.map(r => r.costUsd))
  const ceiling = placebo.length ? Math.max(cost(main), cost(placebo)) : cost(main)
  out.push({
    gate: 'cost',
    verdict: cost(current) <= ceiling ? 'PASS' : 'FAIL',
    detail: `median $ current ${cost(current).toFixed(3)}, main ${cost(main).toFixed(3)}${placebo.length ? `, placebo ${cost(placebo).toFixed(3)}` : ''}`,
  })
  return out
}

/**
 * Not gates: what the pre-registered gates count literally, next to the cost
 * each lever exists to remove. Two wordings missed it on the first rep:
 *
 * - the tasks gate counts any ToolSearch naming a Task tool, including one that
 *   loads TaskStop for an adopted server and takes TaskUpdate along, which
 *   costs no request of its own;
 * - the diff gate counts `| cat` re-runs, and the shell wording now names
 *   `| cat` as the way to the raw diff. The bug was a pivot naming the Git
 *   tool to a reader that has none.
 */
export function diagnostics(results: readonly RunResult[]): Gate[] {
  const of = (arm: string) => results.filter(r => r.arm === arm)
  const sum = (rs: RunResult[], f: (m: Mechanisms) => number) => rs.reduce((n, r) => n + f(r.mechanisms), 0)
  const perArm = (f: (m: Mechanisms) => number) =>
    ALL_ARMS.filter(a => of(a).length).map(a => `${a} ${of(a).map(r => f(r.mechanisms)).join(',')}`).join('; ')
  const out: Gate[] = []
  const combo = of('combo')
  if (combo.length) {
    const clean = combo.filter(r => r.mechanisms.taskOnlyToolSearchAfterPlan === 0 && r.mechanisms.taskListBeforeFirstUpdate === 0).length
    out.push({
      gate: 'tasks: task-only loads',
      verdict: clean >= Math.ceil(combo.length * 0.8) ? 'PASS' : 'FAIL',
      detail: `combo clean ${clean}/${combo.length}; task-only ToolSearch per rep: ${perArm(m => m.taskOnlyToolSearchAfterPlan)}`,
    })
  }
  const branch = results.filter(r => BRANCH_ARMS.includes(r.arm))
  const hints = sum(branch, m => m.diffPivotsNamingGitToBash)
  out.push({
    gate: 'diff: Git-tool hint to a Bash reader',
    verdict: hints === 0 ? 'PASS' : 'FAIL',
    detail: `branch arms ${hints}; main arm ${sum(of('main'), m => m.diffPivotsNamingGitToBash)}; pivots per rep: ${perArm(m => m.diffPivots)}`,
  })
  return out
}

const MECHANISM_ROWS: Array<[string, (r: RunResult) => number]> = [
  ['cost $ (main + sub-agents)', r => r.costUsd],
  ['API calls (main + sub-agents)', r => r.apiCalls],
  ['hidden tests passed', hiddenPass],
  ['Task ToolSearch after plan', r => r.mechanisms.taskToolSearchAfterPlan],
  ['  of which task-only', r => r.mechanisms.taskOnlyToolSearchAfterPlan],
  ['TaskList before 1st update', r => r.mechanisms.taskListBeforeFirstUpdate],
  ['TaskUpdate calls', r => r.mechanisms.taskUpdates],
  ['TaskUpdate unloaded, ok', r => r.mechanisms.taskUpdateUnloadedOk],
  ['TaskUpdate unloaded, error', r => r.mechanisms.taskUpdateUnloadedErr],
  ['docs outlined', r => r.mechanisms.docsOutlined],
  ['docs outline → body', r => r.mechanisms.docsOutlineThenBody],
  ['process Bash calls', r => r.mechanisms.processBash],
  ['TaskStop calls', r => r.mechanisms.taskStops],
  ['adopted notes', r => r.mechanisms.adoptedNotes],
  ['servers leaked', leaked],
  ['diff pivots', r => r.mechanisms.diffPivots],
  ['pivots naming the Git tool to Bash', r => r.mechanisms.diffPivotsNamingGitToBash],
  ['| cat re-runs after a pivot', r => r.mechanisms.diffCatReruns],
  ['file-tools notes', r => r.mechanisms.fileToolsNotes],
  ['file-tools notes followed', r => r.mechanisms.fileToolsNotesFollowed],
  ['Read/Grep/Glob share %', r => dedicatedReadShare(r.mechanisms)],
  ['ToolSearch-only requests', r => r.mechanisms.toolSearchOnlyRequests],
  ['other meta-only requests', r => r.mechanisms.otherMetaOnlyRequests],
  ['direct deferred calls, ok', r => r.mechanisms.directDeferredOk],
  ['direct deferred calls, error', r => r.mechanisms.directDeferredErr],
]

export function report(results: readonly RunResult[], args: Args): string {
  const arms = args.arms.filter(arm => results.some(r => r.arm === arm))
  const rows = MECHANISM_ROWS.map(([label, f]) => [
    label,
    ...arms.map(arm => {
      const values = results.filter(r => r.arm === arm).map(f)
      const fmt = (v: number) => (Number.isNaN(v) ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(2))
      return `${fmt(median(values))} (${values.map(fmt).join(' ')})`
    }),
  ])
  return [
    `# tool-gaps A/B — ${args.model}, effort ${args.effort}, ${args.reps} rep(s), phases ${args.phases.join('+')}`,
    '',
    'Median per arm, every rep in parentheses.',
    '',
    table(['metric', ...arms], rows),
    '',
    '## Gates',
    '',
    table(['gate', 'verdict', 'detail'], gates(results).map(g => [g.gate, g.verdict, g.detail])),
    '',
    '## Diagnostics (not gates)',
    '',
    table(['check', 'verdict', 'detail'], diagnostics(results).map(g => [g.gate, g.verdict, g.detail])),
  ].join('\n')
}

/** A finished run, its mechanisms recounted from the transcripts it archived. */
function recount(runDir: string): RunResult[] {
  const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as RunResult[]
  return results.map(r => {
    const label = `${r.arm}-r${r.rep}`
    const main = join(runDir, `${label}.transcript.jsonl`)
    if (!existsSync(main)) return r
    const archive = join(runDir, `${label}.subagents`)
    const subs = existsSync(archive)
      ? readdirSync(archive).filter(f => f.endsWith('.jsonl')).map(f => parseJsonl(readFileSync(join(archive, f), 'utf8')) as Json[])
      : []
    return { ...r, mechanisms: mechanismsOf(parseJsonl(readFileSync(main, 'utf8')) as Json[], subs) }
  })
}

// ---------------------------------------------------------------------------
// Dry run: the fixture holds what the gates assume, at no token cost
// ---------------------------------------------------------------------------

function dryRun(runDir: string): boolean {
  const ws = join(runDir, 'dry')
  makeWorkspace(ws, PORT_BASE - 1)
  const grader = makeGrader(runDir)
  const doc = (name: string) => readFileSync(join(ws, 'docs', name), 'utf8')
  const sized = (name: string) => {
    const text = doc(name)
    const lines = text.split('\n').length - 1
    return { lines, chars: text.length, ok: lines < 250 && text.length >= 10_000 && text.length <= 25_000 }
  }
  const spec = sized('SPEC.md')
  const api = sized('API.md')
  const own1 = bunTest(ws, ['src'])
  const p1 = hiddenRun(grader, ws, 1)
  const diff = git(ws, 'diff', 'main...feature/bulk').out
  const solved1 = join(runDir, 'dry-solved-p1')
  makeWorkspace(solved1, PORT_BASE - 2)
  materialize(join(FIXTURE, 'solution', 'p1'), solved1)
  const s1 = hiddenRun(grader, solved1, 1)
  const ownS1 = bunTest(solved1, ['src'])
  git(ws, 'checkout', '-q', 'feature/bulk')
  const ownBranch = bunTest(ws, ['src'])
  const p2 = hiddenRun(grader, ws, 2)
  const solved2 = join(runDir, 'dry-solved-p2')
  makeWorkspace(solved2, PORT_BASE - 3)
  git(solved2, 'checkout', '-q', 'feature/bulk')
  materialize(join(FIXTURE, 'solution', 'p2'), solved2)
  const s2 = hiddenRun(grader, solved2, 2)
  const approver = spawnSync(process.execPath, [APPROVER], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  })
  const checks: Array<[string, boolean, string]> = [
    ['SPEC.md pivots today and reads whole under the lever', spec.ok, `${spec.lines} lines, ${spec.chars} chars`],
    ['API.md pivots today and reads whole under the lever', api.ok, `${api.lines} lines, ${api.chars} chars`],
    ['the shipped suite is green', own1.ok && own1.fail === 0 && own1.pass > 0, `${own1.pass}/${own1.pass + own1.fail}`],
    ['phase-1 grader fails on pristine main', p1.fail > 0, `${p1.pass}/${p1.pass + p1.fail}`],
    ['phase-1 solution passes the grader and the suite', s1.ok && s1.fail === 0 && ownS1.ok, `${s1.pass}/${s1.pass + s1.fail}, suite ${ownS1.pass}/${ownS1.pass + ownS1.fail}`],
    ['the branch diff pivots', diff.length >= DIFF_MIN_CHARS, `${diff.length} chars`],
    ["the branch's own suite hides its bugs", ownBranch.ok && ownBranch.fail === 0, `${ownBranch.pass}/${ownBranch.pass + ownBranch.fail}`],
    ['phase-2 grader fails exactly the three bugs', p2.fail === 3, `${p2.pass}/${p2.pass + p2.fail}: ${p2.failed.join('; ')}`],
    ['phase-2 solution passes the grader', s2.ok && s2.fail === 0 && s2.pass > 0, `${s2.pass}/${s2.pass + s2.fail}`],
    ['the approver lists its tool', /"name":"allow"/.test(approver.stdout ?? ''), (approver.stdout ?? '').slice(0, 80)],
  ]
  console.log(table(['check', 'ok', 'detail'], checks.map(([c, ok, d]) => [c, ok ? 'yes' : 'NO', d])))
  for (const dir of [ws, solved1, solved2]) reapLeaks(dir)
  return checks.every(([, ok]) => ok)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.reportDir) {
    const results = recount(args.reportDir)
    const meta = JSON.parse(readFileSync(join(args.reportDir, 'meta.json'), 'utf8')) as Args
    const md = report(results, { ...args, model: meta.model, effort: meta.effort, reps: meta.reps, phases: meta.phases, arms: meta.arms })
    writeFileSync(join(args.reportDir, 'report.md'), md)
    console.log(md)
    return
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  if (args.dryRun) process.exit(dryRun(runDir) ? 0 : 1)
  if (!existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) throw new Error('dist/cli.mjs is missing: run bun run build first')
  const graderDir = makeGrader(runDir)
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ started: new Date().toISOString(), ...args, armEnv: ARM_ENV }, null, 2))
  console.log(`tool-gaps A/B → ${runDir}`)
  const results: RunResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const batch = await Promise.all(args.arms.map(arm => runArm(arm, rep, args, runDir, graderDir)))
    results.push(...batch)
    writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2))
  }
  const md = report(results, args)
  writeFileSync(join(runDir, 'report.md'), md)
  console.log(`\n${md}\n\n${runDir}/report.md`)
}

if (import.meta.main) await main()
