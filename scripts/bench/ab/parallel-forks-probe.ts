#!/usr/bin/env bun
// Parallel-forks probe: when the parent launches 2–3 forks in ONE assistant
// message (three `Agent` tool_use blocks, run concurrently — AgentTool is
// `isConcurrencySafe`), do they all still hit the parent's prompt cache, do
// they write the shared prefix more than once, and does the parent's own
// prefix survive their return?
//
// Every fork this week's census saw was launched alone or backgrounded, so
// the concurrent case had never been observed: three children send the same
// inherited prefix within milliseconds of each other, and each returns a
// tool_result the parent folds into a single user message.
//
// Arms, one headless run per arm per rep, fresh scratch cwd each time:
//   parallel  the parent Reads 8 fixture files (context), then spawns N forks
//             in the same message; fork k finds SECRET_TOKEN in f<k>.txt and
//             `wc -l`s two files (≈3–4 calls each);
//   serial    same, but one fork at a time — the control that tells a
//             concurrency effect from a fork effect.
//
// Per child: first-call cache_read as a share of the spawning call's context
// (≥0.9 = hit), first-call cache write (5m/1h), calls, start/end. Per run:
// whether the children's time ranges actually overlapped (if not, the
// parallel arm did not test concurrency and says so), the parent's first
// call after the last child returned (read share of the spawn context), and
// total cost. PASS for the parallel arm = every child hit, children
// overlapped, parent-after read ≥0.9 of spawn context.
//
// Usage:
//   bun run scripts/bench/ab/parallel-forks-probe.ts --bin=claudindev --model=claude-sonnet-5 --reps=3 --agents=3

import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { median, parseArgs, runHeadless } from './headlessProbe.ts'
import { BENCH_ENV, type Call, callAfter, cost, ctx, fixture, loadSession, priceFor, range } from './forkBench.ts'

const FILES = 8
const HIT = 0.9
type Arm = 'parallel' | 'serial'

type ChildRow = {
  agentType: string
  calls: number
  firstCtx: number
  firstRead: number
  firstWrite5m: number
  firstWrite1h: number
  spawnCtx: number
  hit: boolean
  start: number
  end: number
}

type Row = {
  arm: Arm
  rep: number
  children: ChildRow[]
  overlapped: boolean
  parentSpawnCtx: number
  parentAfterRead: number
  parentAfterWrite: number
  parentAfterShare: number
  total: number
  secretsOk: number
}

function agentsArg(argv: string[]): number {
  for (const s of argv) if (s.startsWith('--agents=')) return Number(s.slice(9))
  return 3
}

/** The parent call immediately before `ts` — for a serial arm, each child's own spawn. */
function callBefore(parent: Call[], ts: number): Call | undefined {
  let last: Call | undefined
  for (const c of parent) {
    if (c.ts >= ts) break
    last = c
  }
  return last
}

async function runArm(arm: Arm, rep: number, agents: number, args: ReturnType<typeof parseArgs>): Promise<Row> {
  const cwd = mkdtempSync(join(tmpdir(), `parallel-forks-${arm}-`))
  // Not security values — per-rep tokens so a cached answer cannot pass.
  const secrets = Array.from({ length: agents }, () => randomBytes(8).toString('hex'))
  for (let i = 1; i <= FILES; i++) {
    writeFileSync(join(cwd, `f${i}.txt`), fixture(1000 * rep + i, i <= agents ? secrets[i - 1] : undefined).text)
  }
  const names = Array.from({ length: FILES }, (_, i) => `f${i + 1}.txt`).join(', ')
  const tasks = Array.from({ length: agents }, (_, k) => {
    const a = k + 1, b = k + 1 + agents
    return `Agent ${a}: 'Report the value of SECRET_TOKEN in f${a}.txt, then the line counts of f${a}.txt and f${b}.txt using one Bash wc -l call per file, one tool call per assistant message. Reply with SECRET_TOKEN=<value> and the two counts.'`
  }).join(' ')
  const spawn =
    arm === 'parallel'
      ? `launch ${agents} Agents with NO subagent_type (forks) and run_in_background false, ALL ${agents} tool calls in the SAME assistant message so they run concurrently`
      : `launch ${agents} Agents with NO subagent_type (forks) and run_in_background false, ONE AT A TIME — launch Agent 1, wait for its result, then launch Agent 2, and so on`
  const prompt =
    `Step 1: Read ${names} with the Read tool, one full read each (no offset/limit), exactly ONE tool call per assistant message. ` +
    `Step 2: ${spawn}, with these prompts: ${tasks} ` +
    `Step 3: reply with the ${agents} SECRET_TOKEN lines the agents reported, nothing else.`
  const run = await runHeadless({ bin: args.bin, model: args.model, cwd, prompt, env: BENCH_ENV, timeoutMs: args.timeoutMs })
  const session = loadSession(cwd, run.sessionId)
  const { price } = priceFor(args.model)
  const children: ChildRow[] = session.children
    .filter(c => c.calls.length > 0)
    .map(c => {
      const first = c.calls[0]!
      const spawnAt = callBefore(session.parent, first.ts)
      const spawnCtx = spawnAt ? ctx(spawnAt) : 0
      return {
        agentType: c.agentType,
        calls: c.calls.length,
        firstCtx: ctx(first),
        firstRead: first.read,
        firstWrite5m: first.write5m,
        firstWrite1h: first.write1h,
        spawnCtx,
        hit: spawnCtx > 0 && first.read >= HIT * spawnCtx,
        start: first.ts,
        end: c.calls[c.calls.length - 1]!.ts,
      }
    })
  let overlapped = false
  for (let i = 0; i < children.length; i++)
    for (let j = i + 1; j < children.length; j++)
      if (children[i]!.start <= children[j]!.end && children[j]!.start <= children[i]!.end) overlapped = true
  const lastEnd = Math.max(0, ...children.map(c => c.end))
  const after = callAfter(session.parent, lastEnd)
  const spawnCtx = children.length ? Math.max(...children.map(c => c.spawnCtx)) : 0
  const childCalls = session.children.flatMap(c => c.calls)
  return {
    arm,
    rep,
    children,
    overlapped,
    parentSpawnCtx: spawnCtx,
    parentAfterRead: after?.read ?? 0,
    parentAfterWrite: after ? after.write5m + after.write1h : 0,
    parentAfterShare: after && spawnCtx ? after.read / spawnCtx : 0,
    total: cost(session.parent, price).total + cost(childCalls, price).total,
    secretsOk: secrets.filter(s => run.finalText.includes(s)).length,
  }
}

function fmt(r: Row, agents: number): string {
  const kids = r.children
    .map(c => `[${c.agentType} calls=${c.calls} first r=${c.firstRead}/${c.spawnCtx} (${(c.spawnCtx ? c.firstRead / c.spawnCtx : 0).toFixed(2)}) w5m=${c.firstWrite5m} w1h=${c.firstWrite1h} ${c.hit ? 'hit' : 'MISS'}]`)
    .join(' ')
  return (
    `${r.arm.padEnd(8)} rep=${r.rep} children=${r.children.length}/${agents} overlapped=${r.overlapped} ${kids} | ` +
    `parent after: read=${r.parentAfterRead} write=${r.parentAfterWrite} share=${r.parentAfterShare.toFixed(2)} | total=$${r.total.toFixed(3)} secrets ${r.secretsOk}/${agents}`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { timeoutMs: 600_000 })
  const agents = agentsArg(process.argv.slice(2))
  console.log(`price tier: ${priceFor(args.model).label}; agents=${agents}`)
  const rows: Row[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of ['parallel', 'serial'] as Arm[]) {
      const r = await runArm(arm, rep, agents, args)
      rows.push(r)
      console.log(fmt(r, agents))
    }
  }
  const par = rows.filter(r => r.arm === 'parallel'), ser = rows.filter(r => r.arm === 'serial')
  console.log('')
  for (const [name, xs] of [['PARALLEL', par], ['SERIAL  ', ser]] as const) {
    const kids = xs.flatMap(r => r.children)
    const hits = kids.filter(k => k.hit).length
    console.log(
      `${name}: children ${kids.length} hit ${hits}/${kids.length} | first-call write median 5m=${median(kids.map(k => k.firstWrite5m))} 1h=${median(kids.map(k => k.firstWrite1h))} | ` +
      `parent-after share median ${median(xs.map(r => r.parentAfterShare)).toFixed(2)} | total median $${median(xs.map(r => r.total)).toFixed(3)} range ${range(xs.map(r => r.total))} | overlapped ${xs.filter(r => r.overlapped).length}/${xs.length}`,
    )
  }
  const reasons: string[] = []
  if (!par.every(r => r.children.length === agents)) reasons.push('a parallel run spawned fewer children than asked')
  if (!par.every(r => r.overlapped)) reasons.push('children did not overlap in time — concurrency not exercised')
  if (!par.every(r => r.children.every(k => k.hit))) reasons.push(`a parallel child's first call read <${HIT} of the spawn context`)
  if (!par.every(r => r.parentAfterShare >= HIT)) reasons.push(`parent's first call after the return read <${HIT} of the spawn context`)
  if (!rows.every(r => r.secretsOk === agents)) reasons.push('a run reported the wrong secrets')
  const pass = reasons.length === 0
  console.log(`\n=== PARALLEL FORKS bin=${args.bin} model=${args.model ?? 'default'} reps=${args.reps} agents=${agents} ${pass ? 'PASS' : 'FAIL'}${reasons.length ? ' [' + reasons.join('; ') + ']' : ''} ===`)
  process.exit(pass ? 0 : 1)
}

main()
