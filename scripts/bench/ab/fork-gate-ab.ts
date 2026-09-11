#!/usr/bin/env bun
// Fork gate A/B: when the parent is told to fork at ~200k of context, does
// the one-shot refusal (CLAUDIN_FORK_MAX_PARENT_TOKENS, default 150k) move
// the model to a fresh `Code` agent, and what does the session cost either
// way?
//
// Same fixture as fork-vs-fresh-ab.ts: the parent Reads 8 × 50 KB files,
// one per message, so its context sits around 200k when it delegates; the
// child counts lines and greps each file and reports a per-rep secret. The
// only difference between arms is the gate:
//
//   off   CLAUDIN_FORK_MAX_PARENT_TOKENS=0   the fork goes through
//   on    default (150k)                     refused once, with the
//                                            fresh-agent alternative
//
// The prompt asks for a fork explicitly, on purpose: the gate exists for the
// day the model reaches for one anyway, and what this measures is what it
// does when refused — switch to `subagent_type: "Code"` (the outcome the
// message asks for), re-send the identical call (the escape hatch), or
// answer without delegating. The child's type and the total cost are the
// result; the answer must be correct in every arm.
//
// Measured 2026-09-10, Sonnet 5, reps=3, parent ~204k, 6/6 answers correct:
//   off  fork ×3            total $2.23 [2.18–2.24]  child $1.27
//   on   fresh ×2, fork ×1  total $1.36 [1.34–2.29]  child $0.34 (fresh)
//   → −39% total at the median; ranges overlap because one rep took the
//     escape hatch — re-sent the identical call and forked, as the prompt
//     had literally asked. Refused once in every gated rep (refusals=1).
//
// Usage:
//   bun run scripts/bench/ab/fork-gate-ab.ts --model=claude-sonnet-5 --reps=3

import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BENCH_ENV, cost, ctx, fixture, loadSession, priceFor, range, rangesOverlap, spawnCall } from './forkBench.ts'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'

const FILES = 8
type Arm = 'off' | 'on'

type Row = {
  arm: Arm
  rep: number
  parentLastCtx: number
  outcome: 'fork' | 'fresh' | 'none'
  refusals: number
  childCalls: number
  childCost: number
  total: number
  correct: boolean
}

async function runArm(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<Row> {
  const cwd = mkdtempSync(join(tmpdir(), `fork-gate-${arm}-`))
  const secret = randomBytes(8).toString('hex')
  const lineCounts: number[] = []
  for (let i = 1; i <= FILES; i++) {
    const f = fixture(1000 * rep + i, i === 3 ? secret : undefined)
    writeFileSync(join(cwd, `f${i}.txt`), f.text)
    lineCounts.push(f.lines)
  }
  const names = Array.from({ length: FILES }, (_, i) => `f${i + 1}.txt`).join(', ')
  const task =
    `For each of ${names} in the current directory: report its line count with one Bash call running wc -l on that file, ` +
    `then report how many of its lines contain the word cache with one Bash call running grep -c cache on that file. ` +
    `Exactly ONE tool call per assistant message. Also report the value of SECRET_TOKEN in f3.txt. ` +
    `Reply with a table: file, lines, cache-lines; then the line SECRET_TOKEN=<value>.`
  const prompt =
    `Step 1: Read ${names} with the Read tool, one full read each (no offset/limit), exactly ONE tool call per assistant message. ` +
    `Step 2: launch an Agent with NO subagent_type (a fork) and run_in_background false, with exactly this prompt: '${task}' ` +
    `Step 3: reply with the agent's table and SECRET_TOKEN line verbatim, nothing else.`
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt,
    env: { ...BENCH_ENV, ...(arm === 'off' ? { CLAUDIN_FORK_MAX_PARENT_TOKENS: '0' } : {}) },
    timeoutMs: args.timeoutMs,
    extraArgs: ['--max-turns', '40'],
  })
  const session = loadSession(cwd, run.sessionId)
  const { price } = priceFor(args.model)
  const child = session.children[0]
  const calls = child?.calls ?? []
  const refusals = run.toolResults.filter(r => r.name === 'Agent' && r.text.includes('Blocked: a fork would inherit')).length
  const spawnAt = spawnCall(session.parent)
  const childCost = cost(calls, price).total
  return {
    arm,
    rep,
    parentLastCtx: spawnAt ? ctx(spawnAt) : 0,
    outcome: !child ? 'none' : child.agentType === 'fork' ? 'fork' : 'fresh',
    refusals,
    childCalls: calls.length,
    childCost,
    total: childCost + cost(session.parent, price).total,
    correct: run.finalText.includes(secret) && lineCounts.every(n => new RegExp(`\\b${n}\\b`).test(run.finalText)),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5', timeoutMs: 600_000 })
  const rows: Row[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const order: Arm[] = rep % 2 === 1 ? ['off', 'on'] : ['on', 'off']
    for (const arm of order) {
      const r = await runArm(arm, rep, args)
      rows.push(r)
      console.log(
        `gate ${arm.padEnd(3)} rep=${rep} ${r.correct ? 'PASS' : 'FAIL'} parentCtx=${r.parentLastCtx} outcome=${r.outcome.padEnd(5)} refusals=${r.refusals} childCalls=${String(r.childCalls).padStart(2)} child=$${r.childCost.toFixed(4)} total=$${r.total.toFixed(4)}`,
      )
    }
  }
  console.log(`\n=== FORK GATE A/B model=${args.model} reps=${args.reps} ===`)
  for (const arm of ['off', 'on'] as Arm[]) {
    const xs = rows.filter(r => r.arm === arm)
    if (!xs.length) continue
    const outcomes = xs.map(r => r.outcome).join(',')
    console.log(
      `gate ${arm.padEnd(3)} n=${xs.length} outcomes=[${outcomes}] total median=$${median(xs.map(r => r.total)).toFixed(4)} range=${range(xs.map(r => r.total), 4)} child median=$${median(xs.map(r => r.childCost)).toFixed(4)} correct=${xs.filter(r => r.correct).length}/${xs.length}`,
    )
  }
  const off = rows.filter(r => r.arm === 'off').map(r => r.total)
  const on = rows.filter(r => r.arm === 'on').map(r => r.total)
  if (off.length && on.length) {
    console.log(`   on vs off: ${(((median(on) - median(off)) / median(off)) * 100).toFixed(1)}% total, ranges ${rangesOverlap(on, off) ? 'OVERLAP' : 'disjoint'}`)
  }
  const bad = rows.filter(r => r.outcome === 'none' || !r.correct)
  console.log(`failures (no child or wrong answer): ${bad.length}`)
  process.exit(bad.length ? 1 : 0)
}

main()
