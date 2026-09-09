#!/usr/bin/env bun
// Fork vs fresh A/B: for a delegated task that needs a BRIEF and not the
// parent's history, is a fork (Agent with no subagent_type — inherits the
// parent's context and prompt cache) cheaper than a fresh named agent
// (`subagent_type: "Code"`, zero context, own cache)?
//
// The 2026-09-04..09 census found fork children re-read the inherited prefix
// on every call — 84% of child read tokens, 36% of child spend — while their
// first call is a cache hit 18/18 times. So the fork's advantage is one
// cheap first call; its cost is P × calls reads. A fresh agent pays one
// small prefix write and then reads ~25k per call. Which wins depends on P
// and on the child's call count, and nobody had measured it on the same
// task. This bench does, at equal answers.
//
// One headless run per arm per rep, fresh scratch cwd each time:
//   step 1  the parent Reads 8 fixture files (~50 KB each, one call per
//           assistant message) → ~150–200k tokens of context, the census's
//           median fork inheritance;
//   step 2  it delegates the SAME task text to either a fork or a Code
//           agent: `wc -l` per file, `grep -c cache` per file, one call per
//           message (≈16 calls — the census median child is 27), plus the
//           SECRET_TOKEN in f3.txt;
//   step 3  the parent relays the agent's table.
//
// Cost comes from the transcripts (parent + subagents/*.jsonl, parent ids
// removed from the child — see forkBench.ts), priced by `--model`.
// Correctness: the secret and all 8 line counts must appear in the final
// text, so a fork that "remembers" the files instead of counting them is
// caught the same way a fresh agent that skips a file is.
//
// This is a measurement, not a gate: the verdict names the cheaper arm and
// whether the ranges are disjoint. Exit 1 only when a run produced no child
// or a wrong answer (harness or model failure, not a result).
//
// Usage:
//   bun run scripts/bench/ab/fork-vs-fresh-ab.ts --bin=claudindev --model=claude-sonnet-5 --reps=3

import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'
import { type AgentCalls, BENCH_ENV, cost, ctx, fixture, loadSession, priceFor, range, rangesOverlap, spawnCall } from './forkBench.ts'

const FILES = 8
type Arm = 'fork' | 'fresh'

type Row = {
  arm: Arm
  rep: number
  parentCalls: number
  parentLastCtx: number
  childType: string
  childCalls: number
  childFirstCtx: number
  childFirstRead: number
  childReadTokens: number
  child: ReturnType<typeof cost>
  parent: ReturnType<typeof cost>
  total: number
  reportedCost: number
  secretOk: boolean
  countsOk: number
}

function childTask(names: string, secretFile: string): string {
  return (
    `For each of ${names} in the current directory: report its line count with one Bash call running wc -l on that file, ` +
    `then report how many of its lines contain the word cache with one Bash call running grep -c cache on that file. ` +
    `Exactly ONE tool call per assistant message — do not batch and do not use other tools. ` +
    `Also report the value of SECRET_TOKEN in ${secretFile}. ` +
    `Reply with a table: file, lines, cache-lines; then the line SECRET_TOKEN=<value>.`
  )
}

async function runArm(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<Row> {
  const cwd = mkdtempSync(join(tmpdir(), `fork-vs-fresh-${arm}-`))
  // Not a security value — a per-rep token so a cached answer from another
  // rep cannot pass; randomBytes only because CodeQL flags Math.random here.
  const secret = randomBytes(8).toString('hex')
  const lineCounts: number[] = []
  for (let i = 1; i <= FILES; i++) {
    const f = fixture(1000 * rep + i, i === 3 ? secret : undefined)
    writeFileSync(join(cwd, `f${i}.txt`), f.text)
    lineCounts.push(f.lines)
  }
  const names = Array.from({ length: FILES }, (_, i) => `f${i + 1}.txt`).join(', ')
  const spawn =
    arm === 'fork'
      ? 'launch an Agent with NO subagent_type (a fork) and run_in_background false'
      : 'launch an Agent with subagent_type "Code" and run_in_background false'
  const prompt =
    `Step 1: Read ${names} with the Read tool, one full read each (no offset/limit), and exactly ONE tool call per assistant message — do not batch the reads. ` +
    `Step 2: ${spawn}, with exactly this prompt: '${childTask(names, 'f3.txt')}' ` +
    `Step 3: reply with the agent's table and SECRET_TOKEN line verbatim, nothing else.`
  const run = await runHeadless({ bin: args.bin, model: args.model, cwd, prompt, env: BENCH_ENV, timeoutMs: args.timeoutMs })
  const session = loadSession(cwd, run.sessionId)
  const { price } = priceFor(args.model)
  const child: AgentCalls | undefined = session.children[0]
  const childCalls = child?.calls ?? []
  const spawnAt = spawnCall(session.parent)
  const first = childCalls[0]
  return {
    arm,
    rep,
    parentCalls: session.parent.length,
    parentLastCtx: spawnAt ? ctx(spawnAt) : 0,
    childType: child?.agentType ?? 'none',
    childCalls: childCalls.length,
    childFirstCtx: first ? ctx(first) : 0,
    childFirstRead: first?.read ?? 0,
    childReadTokens: childCalls.reduce((s, c) => s + c.read, 0),
    child: cost(childCalls, price),
    parent: cost(session.parent, price),
    total: cost(session.parent, price).total + cost(childCalls, price).total,
    reportedCost: run.totalCostUsd,
    secretOk: run.finalText.includes(secret),
    countsOk: lineCounts.filter(n => new RegExp(`\\b${n}\\b`).test(run.finalText)).length,
  }
}

function fmt(r: Row): string {
  const c = r.child
  return (
    `${r.arm.padEnd(5)} rep=${r.rep} parentCalls=${r.parentCalls} parentLastCtx=${r.parentLastCtx} | ` +
    `child=${r.childType} calls=${String(r.childCalls).padStart(2)} firstCtx=${r.childFirstCtx} firstRead=${r.childFirstRead} readTok=${r.childReadTokens} | ` +
    `child=$${c.total.toFixed(3)} (in ${c.input.toFixed(3)} w ${c.write.toFixed(3)} r ${c.read.toFixed(3)} o ${c.output.toFixed(3)}) ` +
    `parent=$${r.parent.total.toFixed(3)} total=$${r.total.toFixed(3)} (reported=$${r.reportedCost.toFixed(3)}) ` +
    `${r.secretOk ? 'secret ok' : 'secret BAD'} counts ${r.countsOk}/${FILES}`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { timeoutMs: 600_000 })
  const { label } = priceFor(args.model)
  console.log(`price tier: ${label}`)
  const rows: Row[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of ['fork', 'fresh'] as Arm[]) {
      const r = await runArm(arm, rep, args)
      rows.push(r)
      console.log(fmt(r))
    }
  }
  const fork = rows.filter(r => r.arm === 'fork'), fresh = rows.filter(r => r.arm === 'fresh')
  const forkTot = fork.map(r => r.total), freshTot = fresh.map(r => r.total)
  const forkMed = median(forkTot), freshMed = median(freshTot)
  const overlap = rangesOverlap(forkTot, freshTot)
  const wrong = rows.filter(r => r.childCalls === 0 || !r.secretOk || r.countsOk < FILES)
  const typeOk = fork.every(r => r.childType === 'fork') && fresh.every(r => r.childType !== 'fork')
  console.log('')
  for (const [name, xs] of [['FORK ', fork], ['FRESH', fresh]] as const) {
    console.log(
      `${name}: median total=$${median(xs.map(r => r.total)).toFixed(3)} range=${range(xs.map(r => r.total))} ` +
      `child=$${median(xs.map(r => r.child.total)).toFixed(3)} (read $${median(xs.map(r => r.child.read)).toFixed(3)}, write $${median(xs.map(r => r.child.write)).toFixed(3)}) ` +
      `childCalls=${median(xs.map(r => r.childCalls))} childReadTok=${median(xs.map(r => r.childReadTokens))} firstCtx=${median(xs.map(r => r.childFirstCtx))}`,
    )
  }
  const cheaper = freshMed < forkMed ? 'FRESH' : 'FORK'
  const pct = Math.abs(1 - Math.min(forkMed, freshMed) / Math.max(forkMed, freshMed)) * 100
  const notes: string[] = []
  if (!typeOk) notes.push('an arm spawned the wrong agent type — see child= in the rows')
  if (wrong.length) notes.push(`${wrong.length} run(s) with no child or a wrong answer`)
  console.log(
    `\n=== FORK vs FRESH bin=${args.bin} model=${args.model ?? 'default'} reps=${args.reps}: ${cheaper} cheaper by ${pct.toFixed(1)}% (medians), ranges ${overlap ? 'OVERLAP — not separable at this N' : 'disjoint'}` +
    `${notes.length ? ' [' + notes.join('; ') + ']' : ''} ===`,
  )
  process.exit(wrong.length || !typeOk ? 1 : 0)
}

main()
