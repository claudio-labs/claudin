#!/usr/bin/env bun
// Slim Code agent A/B: how much of a fresh `Code` agent's context is the
// orientation the harness injects, and does dropping it change the answer?
//
// The 2026-09-10 census attributed 43% of everything a fresh Code agent read
// to attachments the transcript never shows: the CLAUDE.md family at its
// first tool call (AGENTS.md, always-on rules, both MEMORY.md indexes, the
// parent's git status — ~23k tokens) and the path-scoped rules on its first
// `src/` Read (~15k). Two changes act on it: the Code agent now omits the
// memory indexes and git status by default, and `readOnly: true` on the
// Agent input applies Plan's full omission (no CLAUDE.md at all) plus the
// write-tool denylist.
//
// Three arms, same task, same scratch cwd shape:
//   full      CLAUDIN_DISABLE_SLIM_CODE_AGENT=1  (the pre-change agent)
//   slim      default                             (indexes + git status out)
//   readonly  default, the parent is told to pass readOnly: true
//
// The scratch cwd carries what makes the injection real: a copy of this
// repo's AGENTS.md, .claudin/rules and .claudin/memory (both indexes plus
// a few memory files), a git init so git status exists, and twelve small
// generated `src/*.ts` modules the child has to Read — which is what loads
// the `src/**` rules. The parent delegates one research question per rep
// (a constant's value in one module, the exports of another) and relays the
// report; correctness is the two facts in the final text.
//
// What is measured, per child transcript (parent ids removed, forkBench):
//   firstCtx   the child's first request (system + tools + prompt)
//   inject     ctx(2nd call) − ctx(1st) − its own first result: the
//              orientation that arrived with the first tool result
//   readTok    every cached token the child read across its calls
//   cost       the child's spend, priced by --model
//
// Measured 2026-09-10, Sonnet 5, reps=3, 9/9 answers correct, 2 child calls
// each — the orientation is the whole difference:
//   full      inject 43.4k tok  child $0.1234 [0.1233–0.1714]
//   slim      inject 31.8k tok  child $0.0944 [0.0936–0.0945]  −23.5%, disjoint
//   readonly  inject  4.0k tok  child $0.0223 [0.0222–0.0569]  −81.9%, disjoint
//             (firstCtx 16.4k vs 22.7k too: five fewer tool schemas)
//
// Usage:
//   bun run scripts/bench/ab/slim-code-agent-ab.ts --model=claude-sonnet-5 --reps=3

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { BENCH_ENV, cost, ctx, loadSession, priceFor, range, rangesOverlap, type AgentCalls } from './forkBench.ts'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'

type Arm = 'full' | 'slim' | 'readonly'
const ARMS: Arm[] = ['full', 'slim', 'readonly']
const MODULES = 12

function makeCwd(rep: number): { cwd: string; secret: number; exportsOf: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), `slim-agent-${rep}-`))
  // The orientation the harness injects, copied from this checkout.
  cpSync(join(REPO_ROOT, 'AGENTS.md'), join(cwd, 'AGENTS.md'))
  cpSync(join(REPO_ROOT, '.claudin', 'rules'), join(cwd, '.claudin', 'rules'), { recursive: true })
  cpSync(join(REPO_ROOT, '.claudin', 'memory'), join(cwd, '.claudin', 'memory'), { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  const secret = 1000 + rep * 37
  const exportsOf = ['alpha', 'beta', 'gamma'].map(n => `${n}${rep}`)
  for (let i = 1; i <= MODULES; i++) {
    const names = i === 3 ? exportsOf : [`fn${i}a`, `fn${i}b`]
    const body = names.map(n => `export function ${n}(x: number): number {\n  return x + ${i}\n}\n`).join('\n')
    const constant = i === 7 ? `export const SECRET_LIMIT = ${secret}\n\n` : ''
    writeFileSync(join(cwd, 'src', `mod${i}.ts`), `// module ${i}\n${constant}${body}`)
  }
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', ['add', '-A'], { cwd })
  execFileSync('git', ['-c', 'user.email=b@b', '-c', 'user.name=bench', 'commit', '-q', '-m', 'fixture'], { cwd })
  return { cwd, secret, exportsOf }
}

type Row = {
  arm: Arm
  rep: number
  childType: string
  childCalls: number
  firstCtx: number
  inject: number
  readTok: number
  child: ReturnType<typeof cost>
  total: number
  correct: boolean
}

async function runArm(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<Row> {
  const { cwd, secret, exportsOf } = makeCwd(rep)
  const flag = arm === 'readonly' ? ' and readOnly: true' : ''
  const prompt =
    `Use the Agent tool with subagent_type "Code"${flag} (run_in_background false) and exactly this prompt: ` +
    `'In the current directory, report the numeric value of SECRET_LIMIT in src/mod7.ts and the names of every function exported by src/mod3.ts. ` +
    `Read the two files with the Read tool; reply with the value and the names only.' ` +
    `Then reply with the agent's report verbatim, nothing else.`
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt,
    env: { ...BENCH_ENV, ...(arm === 'full' ? { CLAUDIN_DISABLE_SLIM_CODE_AGENT: '1' } : {}) },
    timeoutMs: args.timeoutMs,
    extraArgs: ['--max-turns', '30'],
  })
  const session = loadSession(cwd, run.sessionId)
  const { price } = priceFor(args.model)
  const child: AgentCalls | undefined = session.children[0]
  const calls = child?.calls ?? []
  const first = calls[0]
  const second = calls[1]
  const inject = first && second ? Math.max(0, ctx(second) - ctx(first) - first.out) : 0
  const childCost = cost(calls, price)
  return {
    arm,
    rep,
    childType: child?.agentType ?? 'none',
    childCalls: calls.length,
    firstCtx: first ? ctx(first) : 0,
    inject,
    readTok: calls.reduce((s, c) => s + c.read, 0),
    child: childCost,
    total: childCost.total + cost(session.parent, price).total,
    correct: run.finalText.includes(String(secret)) && exportsOf.every(n => run.finalText.includes(n)),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5', timeoutMs: 600_000 })
  if (!existsSync(join(REPO_ROOT, '.claudin', 'memory', 'team', 'MEMORY.md'))) {
    throw new Error('this bench copies .claudin/memory/team/MEMORY.md — run it from a checkout that has one')
  }
  const rows: Row[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    const order = rep % 2 === 1 ? ARMS : [...ARMS].reverse()
    for (const arm of order) {
      const r = await runArm(arm, rep, args)
      rows.push(r)
      console.log(
        `${arm.padEnd(8)} rep=${rep} ${r.correct ? 'PASS' : 'FAIL'} child=${r.childType} calls=${String(r.childCalls).padStart(2)} firstCtx=${r.firstCtx} inject=${String(r.inject).padStart(6)} readTok=${String(r.readTok).padStart(7)} child=$${r.child.total.toFixed(4)} total=$${r.total.toFixed(4)}`,
      )
    }
  }
  console.log(`\n=== SLIM CODE AGENT A/B model=${args.model} reps=${args.reps} ===`)
  for (const arm of ARMS) {
    const xs = rows.filter(r => r.arm === arm)
    if (!xs.length) continue
    console.log(
      `${arm.padEnd(8)} n=${xs.length} inject median=${median(xs.map(r => r.inject))} readTok median=${median(xs.map(r => r.readTok))} child cost median=$${median(xs.map(r => r.child.total)).toFixed(4)} range=${range(xs.map(r => r.child.total), 4)} calls=${median(xs.map(r => r.childCalls))} correct=${xs.filter(r => r.correct).length}/${xs.length}`,
    )
  }
  const full = rows.filter(r => r.arm === 'full').map(r => r.child.total)
  for (const arm of ['slim', 'readonly'] as Arm[]) {
    const xs = rows.filter(r => r.arm === arm).map(r => r.child.total)
    if (!xs.length || !full.length) continue
    console.log(`   ${arm} vs full: ${(((median(xs) - median(full)) / median(full)) * 100).toFixed(1)}% child cost, ranges ${rangesOverlap(xs, full) ? 'OVERLAP' : 'disjoint'}`)
  }
  const bad = rows.filter(r => r.childCalls === 0 || !r.correct)
  console.log(`failures (no child or wrong answer): ${bad.length}`)
  process.exit(bad.length ? 1 : 0)
}

main()
