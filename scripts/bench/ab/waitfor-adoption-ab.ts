#!/usr/bin/env bun
// WaitFor adoption A/B: does the flag-gated Bash refusal
// (`CLAUDIN_ENABLE_WAITFOR_REDIRECT=1`) move a `sleep N && check` poll loop
// onto the WaitFor tool, and does that cost fewer API calls?
//
// Two arms (OFF = no flag, ON = flag) × two tasks × N reps, each in a fresh
// scratch cwd (a shared cwd lets the server cache serve the other arm's
// prefix and the arms stop being independent):
//   (a) file  — a background `sh -c 'sleep 4; echo READY > x.txt'` is started
//               right before the CLI; the model must wait for it.
//   (b) tmux  — the model starts `sleep 3; echo hi` in a tmux session and has
//               to wait for the pane to show the output.
//
// Per run: API calls, Bash calls whose command holds `sleep`, WaitFor calls,
// `Blocked:` refusals, cost, correctness. Tool inputs are not on the
// stream-json surface, so Bash commands are read back from the session
// transcript (`transcriptPath`).
//
// Pass per task: ON arm used WaitFor in ≥2/3 reps, ON arm made no Bash sleep
// poll after its first refusal, ON median API calls ≤ OFF median, and every
// answer was correct. Exit 1 on any failure.
//
// Usage:
//   bun run scripts/bench/ab/waitfor-adoption-ab.ts --bin=claudindev --model=claude-sonnet-5 --reps=3
//
// --long: does a higher WaitFor cap turn a long wait into one call
// (perf/tool-repeat-calls, 1800 s since 2026-10-31)? Three arms on one build,
// the cap scaled down by CLAUDIN_WAITFOR_MAX_TIMEOUT_S so a rep takes a
// minute: base 20 s, placebo 20 s plus a variable nothing reads, lever 60 s.
// A background writer puts READY in x.txt 50 s after the rep starts. Passes,
// as pre-registered in `.claudin/plans/structured-toasting-rossum.md`, when
// the lever waits with one WaitFor call in ≥4/5 reps and asks for more than
// the base cap in ≥4/5, its median API calls sit below every base and placebo
// rep, and every answer is right.
//   bun run scripts/bench/ab/waitfor-adoption-ab.ts --long --bin=claudindev --model=claude-opus-5-5 --effort=medium --reps=5

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { median, parseArgs, runHeadless, transcriptPath, type HeadlessRun } from './headlessProbe.ts'

const SLEEP_RE = /\bsleep\b/
const BLOCKED_RE = /^(?:<tool_use_error>)?Blocked:/

type Arm = 'off' | 'on'
type Task = 'file' | 'tmux'

type RunRow = {
  arm: Arm
  task: Task
  rep: number
  calls: number
  bashSleep: number
  bashSleepAfterRefusal: number
  waitFor: number
  refusals: number
  cost: number
  correct: boolean
  answer: string
}

/** Tool uses in transcript order, read back from the session .jsonl. */
function toolUsesFromTranscript(cwd: string, sessionId: string): Array<{ name: string; input: Record<string, unknown> }> {
  let raw: string
  try {
    raw = readFileSync(transcriptPath(cwd, sessionId), 'utf8')
  } catch {
    return []
  }
  const out: Array<{ name: string; input: Record<string, unknown> }> = []
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(line) } catch { continue }
    if (v.type !== 'assistant') continue
    const content = ((v.message as Record<string, unknown> | undefined)?.content ?? []) as Array<Record<string, unknown>>
    for (const b of content) {
      if (b.type !== 'tool_use') continue
      const id = String(b.id ?? '')
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> })
    }
  }
  return out
}

function analyze(arm: Arm, task: Task, rep: number, run: HeadlessRun, cwd: string, expected: string): RunRow {
  const uses = toolUsesFromTranscript(cwd, run.sessionId)
  // Refusals are tool_results; pair them with their tool_use to know WHEN
  // the first one happened relative to later Bash sleeps.
  const refusedIds = new Set(run.toolResults.filter(r => BLOCKED_RE.test(r.text)).map(r => r.toolUseId))
  let firstRefusalIdx = -1
  const idsInOrder: string[] = run.calls.flatMap(c => c.toolUseIds)
  for (let i = 0; i < idsInOrder.length; i++) {
    if (refusedIds.has(idsInOrder[i]!)) { firstRefusalIdx = i; break }
  }
  let bashSleep = 0
  let bashSleepAfterRefusal = 0
  let waitFor = 0
  uses.forEach((u, i) => {
    if (u.name === 'WaitFor') waitFor++
    if (u.name === 'Bash' && SLEEP_RE.test(String(u.input.command ?? ''))) {
      bashSleep++
      // The refused call itself is a Bash sleep; only count those AFTER it.
      if (firstRefusalIdx >= 0 && i > firstRefusalIdx) bashSleepAfterRefusal++
    }
  })
  return {
    arm,
    task,
    rep,
    calls: run.calls.length,
    bashSleep,
    bashSleepAfterRefusal,
    waitFor,
    refusals: refusedIds.size,
    cost: run.totalCostUsd,
    correct: run.finalText.includes(expected),
    answer: run.finalText.replace(/\s+/g, ' ').slice(0, 40),
  }
}

async function runFileTask(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<RunRow> {
  const cwd = mkdtempSync(join(tmpdir(), `waitfor-ab-file-${arm}-`))
  const writer = spawn('sh', ['-c', `sleep 4; echo READY > ${join(cwd, 'x.txt')}`], { stdio: 'ignore', detached: true })
  writer.unref()
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt:
      'The file x.txt in this directory will contain the word READY within a few seconds (it is being written by another process). Wait until it does, then reply with exactly the file\'s content.',
    env: arm === 'on' ? { CLAUDIN_ENABLE_WAITFOR_REDIRECT: '1' } : {},
    timeoutMs: args.timeoutMs,
  })
  return analyze(arm, 'file', rep, run, cwd, 'READY')
}

async function runTmuxTask(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<RunRow> {
  const cwd = mkdtempSync(join(tmpdir(), `waitfor-ab-tmux-${arm}-`))
  const session = `probe-${arm}-${rep}-${process.pid}`
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt:
      `Start a tmux session named ${session} running the command: sleep 3; echo hi. Wait until it has printed its output, capture the pane, and reply with exactly what the command printed. Kill the session when done.`,
    env: arm === 'on' ? { CLAUDIN_ENABLE_WAITFOR_REDIRECT: '1' } : {},
    timeoutMs: args.timeoutMs,
  })
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
  return analyze(arm, 'tmux', rep, run, cwd, 'hi')
}

function fmtRow(r: RunRow): string {
  return `${r.arm.padEnd(4)} ${r.task.padEnd(5)} rep=${r.rep} calls=${String(r.calls).padStart(2)} bashSleep=${r.bashSleep} afterRefusal=${r.bashSleepAfterRefusal} waitFor=${r.waitFor} refusals=${r.refusals} cost=$${r.cost.toFixed(3)} ${r.correct ? 'ok ' : 'BAD'} "${r.answer}"`
}

type LongArm = 'base' | 'placebo' | 'lever'

export const LONG_BASE_CAP_S = 20
const LONG_LEVER_CAP_S = 60
const LONG_WRITE_AFTER_S = 50
const LONG_ENV: Record<LongArm, Record<string, string>> = {
  base: { CLAUDIN_WAITFOR_MAX_TIMEOUT_S: String(LONG_BASE_CAP_S) },
  placebo: { CLAUDIN_WAITFOR_MAX_TIMEOUT_S: String(LONG_BASE_CAP_S), CLAUDIN_BENCH_PLACEBO: '1' },
  lever: { CLAUDIN_WAITFOR_MAX_TIMEOUT_S: String(LONG_LEVER_CAP_S) },
}

export type LongRow = {
  arm: LongArm
  rep: number
  calls: number
  waitFor: number
  /** The largest `timeout_s` any WaitFor call asked for; 0 with none. */
  maxTimeoutAsked: number
  cost: number
  correct: boolean
}

async function runLongTask(arm: LongArm, rep: number, args: ReturnType<typeof parseArgs>, effort: string): Promise<LongRow> {
  const cwd = mkdtempSync(join(tmpdir(), `waitfor-ab-long-${arm}-`))
  const writer = spawn('sh', ['-c', `sleep ${LONG_WRITE_AFTER_S}; echo READY > ${join(cwd, 'x.txt')}`], { stdio: 'ignore', detached: true })
  writer.unref()
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt:
      "The file x.txt in this directory will contain the word READY in about a minute (another process is writing it). Wait until it does, then reply with exactly the file's content.",
    env: LONG_ENV[arm],
    timeoutMs: args.timeoutMs,
    extraArgs: ['--effort', effort],
  })
  const waits = toolUsesFromTranscript(cwd, run.sessionId).filter(u => u.name === 'WaitFor')
  return {
    arm,
    rep,
    calls: run.calls.length,
    waitFor: waits.length,
    maxTimeoutAsked: Math.max(0, ...waits.map(u => Number(u.input.timeout_s ?? 0))),
    cost: run.totalCostUsd,
    correct: run.finalText.includes('READY'),
  }
}

export function longWaitVerdict(rows: readonly LongRow[]): { pass: boolean; reasons: string[] } {
  const lever = rows.filter(r => r.arm === 'lever')
  const others = rows.filter(r => r.arm !== 'lever')
  if (lever.length === 0 || others.length === 0) return { pass: false, reasons: ['needs the lever and a base or placebo arm'] }
  const need = Math.ceil(lever.length * 0.8)
  const oneCall = lever.filter(r => r.waitFor === 1).length
  const askedMore = lever.filter(r => r.maxTimeoutAsked > LONG_BASE_CAP_S).length
  const leverCalls = median(lever.map(r => r.calls))
  const floor = Math.min(...others.map(r => r.calls))
  const reasons: string[] = []
  if (oneCall < need) reasons.push(`one WaitFor call in ${oneCall}/${lever.length} lever reps`)
  if (askedMore < need) reasons.push(`timeout_s above ${LONG_BASE_CAP_S} in ${askedMore}/${lever.length} lever reps`)
  if (leverCalls >= floor) reasons.push(`lever median calls ${leverCalls} not below the base/placebo minimum ${floor}`)
  if (!rows.every(r => r.correct)) reasons.push('wrong answer in some run')
  return { pass: reasons.length === 0, reasons }
}

async function mainLong(args: ReturnType<typeof parseArgs>, effort: string): Promise<void> {
  const rows: LongRow[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of ['base', 'placebo', 'lever'] as LongArm[]) {
      const r = await runLongTask(arm, rep, args, effort)
      rows.push(r)
      console.log(
        `${arm.padEnd(7)} rep=${rep} calls=${String(r.calls).padStart(2)} waitFor=${r.waitFor} maxTimeout=${r.maxTimeoutAsked} cost=$${r.cost.toFixed(3)} ${r.correct ? 'ok' : 'BAD'}`,
      )
    }
  }
  for (const arm of ['base', 'placebo', 'lever'] as LongArm[]) {
    const of = rows.filter(r => r.arm === arm)
    console.log(`${arm}: median calls=${median(of.map(r => r.calls))} cost=$${median(of.map(r => r.cost)).toFixed(3)} waitFor per rep ${of.map(r => r.waitFor).join(',')}`)
  }
  const v = longWaitVerdict(rows)
  console.log(`\n=== WAITFOR LONG WAIT A/B bin=${args.bin} model=${args.model ?? 'default'} effort=${effort} reps=${args.reps}: ${v.pass ? 'PASS' : `FAIL [${v.reasons.join('; ')}]`} ===`)
  process.exit(v.pass ? 0 : 1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { timeoutMs: 240_000 })
  if (process.argv.includes('--long')) {
    const effort = process.argv.find(s => s.startsWith('--effort='))?.slice(9) ?? 'medium'
    return mainLong(args, effort)
  }
  const rows: RunRow[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of ['off', 'on'] as Arm[]) {
      rows.push(await runFileTask(arm, rep, args))
      console.log(fmtRow(rows[rows.length - 1]!))
      rows.push(await runTmuxTask(arm, rep, args))
      console.log(fmtRow(rows[rows.length - 1]!))
    }
  }

  let failures = 0
  const verdicts: string[] = []
  for (const task of ['file', 'tmux'] as Task[]) {
    const off = rows.filter(r => r.task === task && r.arm === 'off')
    const on = rows.filter(r => r.task === task && r.arm === 'on')
    const onWaitFor = on.filter(r => r.waitFor > 0).length
    const onPollsAfter = on.reduce((s, r) => s + r.bashSleepAfterRefusal, 0)
    const offCalls = median(off.map(r => r.calls))
    const onCalls = median(on.map(r => r.calls))
    const offCost = median(off.map(r => r.cost))
    const onCost = median(on.map(r => r.cost))
    const correct = rows.filter(r => r.task === task).every(r => r.correct)
    const reasons: string[] = []
    if (onWaitFor < Math.min(2, on.length)) reasons.push(`WaitFor used in ${onWaitFor}/${on.length} ON reps`)
    if (onPollsAfter > 0) reasons.push(`${onPollsAfter} Bash sleep polls after the refusal`)
    if (onCalls > offCalls) reasons.push(`ON median calls ${onCalls} > OFF ${offCalls}`)
    if (!correct) reasons.push('wrong answer in some run')
    const pass = reasons.length === 0
    if (!pass) failures++
    verdicts.push(
      `${task}: ${pass ? 'PASS' : 'FAIL'} — OFF median calls=${offCalls} cost=$${offCost.toFixed(3)} | ON median calls=${onCalls} cost=$${onCost.toFixed(3)} waitForReps=${onWaitFor}/${on.length} pollsAfterRefusal=${onPollsAfter}${reasons.length ? ' [' + reasons.join('; ') + ']' : ''}`,
    )
  }
  console.log('')
  for (const v of verdicts) console.log(v)
  console.log(`\n=== WAITFOR ADOPTION A/B bin=${args.bin} model=${args.model ?? 'default'} reps=${args.reps} failures=${failures} ===`)
  process.exit(failures > 0 ? 1 : 0)
}

if (import.meta.main) main()
