#!/usr/bin/env bun
// Fork-clip A/B: does clipping old tool_results out of a fork's inherited
// history (`CLAUDIN_FORK_CLIP_HISTORY=1`, see forkSubagent.ts) lower the
// TOTAL cost of parent + child, at equal answers?
//
// The cost model says it should NOT for short forks: a clipped child must
// write its diverged prefix once, and a 1h cache write costs 20× a read on
// Sonnet 5 ($4 vs $0.2 per Mtok), so the clip only pays once the child has
// re-read that prefix ~20 times. This bench measures instead of arguing.
//
// One headless run per arm per rep, fresh scratch cwd each time:
//   step 1  the parent Reads 8 generated fixture files (~50 KB each, one
//           tool call per assistant message so the "keep last N turns" rule
//           has turns to count) → ~150k tokens of context;
//   step 2  it forks (Agent with no subagent_type, inline) a child that must
//           find SECRET_TOKEN in f3.txt — the THIRD read, i.e. one the clip
//           stubs, so a clipped child has to re-read it (the quality trap) —
//           and count lines in all 8 files (one call per file, to give the
//           child enough turns for the clip to matter);
//   step 3  the parent reports the token.
//
// Cost is computed from the transcripts (parent .jsonl + subagents/*.jsonl,
// deduped by message.id) at the Sonnet 5 tier, because the stream-json
// `total_cost_usd` is checked but not trusted to include the child. Also
// reported: child API calls, child cache_read sum, and the child's first
// request context vs the parent's last (proves whether the clip landed).
//
// Pass: ON median total cost < OFF median AND the ranges do not overlap AND
// the token is reported in every run. Otherwise FAIL with the numbers — a
// FAIL is a valid result here; thresholds are not tuned to force a pass.
//
// Usage:
//   bun run scripts/bench/ab/fork-clip-ab.ts --bin=claudindev --model=claude-sonnet-5 --reps=3

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDir, median, parseArgs, runHeadless, transcriptPath } from './headlessProbe.ts'

// Sonnet 5 tier (src/providers/usage/modelCost.ts COST_TIER_2_10), $ per Mtok.
const PRICE = { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 }

const FILES = 8
// ~20k tokens each at the ~2.5 chars/token this numbered pseudo-prose gets;
// the Read tool refuses a single result above 25k tokens.
const FILE_BYTES = 50_000
const SECRET_LINE = 300

type Arm = 'off' | 'on'

type Usage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

type Row = {
  arm: Arm
  rep: number
  parentCalls: number
  childCalls: number
  childReads: number
  childFirstCtx: number
  parentLastCtx: number
  parentCost: number
  childCost: number
  total: number
  reportedCost: number
  correct: boolean
}

// Deterministic pseudo-prose so runs are comparable and nothing on disk is
// anyone's real text. xorshift32.
function makeRng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 0xffffffff
  }
}

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega buffer cursor index vector matrix tensor kernel socket packet frame header footer schema record field column table query index cache prefix marker token budget window relief clip stub'.split(' ')

function fixture(seed: number, secret?: string): string {
  const rng = makeRng(seed)
  const lines: string[] = []
  let bytes = 0
  while (bytes < FILE_BYTES) {
    const n = 8 + Math.floor(rng() * 8)
    const words: string[] = []
    for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)]!)
    const line = `${String(lines.length + 1).padStart(4, '0')} ${words.join(' ')}.`
    lines.push(line)
    bytes += line.length + 1
  }
  if (secret) lines[SECRET_LINE - 1] = `SECRET_TOKEN=${secret}`
  return lines.join('\n') + '\n'
}

function usageCost(u: Usage): number {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens
  const write =
    w5 !== undefined || w1h !== undefined
      ? (w5 ?? 0) * PRICE.write5m + (w1h ?? 0) * PRICE.write1h
      : (u.cache_creation_input_tokens ?? 0) * PRICE.write1h
  return (
    ((u.input_tokens ?? 0) * PRICE.input +
      write +
      (u.cache_read_input_tokens ?? 0) * PRICE.read +
      (u.output_tokens ?? 0) * PRICE.output) /
    1e6
  )
}

type Summ = { calls: number; cost: number; reads: number; firstCtx: number; lastCtx: number; cacheReadSum: number }

/** Per-call usage from one transcript, deduped by message.id (max output_tokens wins). */
function summarize(path: string): Summ {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { calls: 0, cost: 0, reads: 0, firstCtx: 0, lastCtx: 0, cacheReadSum: 0 }
  }
  const byId = new Map<string, { u: Usage; ts: number; tools: string[] }>()
  const order: string[] = []
  const seenTool = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let v: Record<string, unknown>
    try { v = JSON.parse(line) } catch { continue }
    if (v.type !== 'assistant') continue
    const m = (v.message ?? {}) as Record<string, unknown>
    const id = String(m.id ?? '')
    const u = m.usage as Usage | undefined
    if (!id || !u) continue
    let e = byId.get(id)
    if (!e) { e = { u, ts: Date.parse(String(v.timestamp ?? 0)), tools: [] }; byId.set(id, e); order.push(id) }
    if ((u.output_tokens ?? 0) >= (e.u.output_tokens ?? 0)) e.u = u
    for (const b of (m.content ?? []) as Array<Record<string, unknown>>) {
      if (b.type !== 'tool_use') continue
      const tid = String(b.id ?? '')
      if (seenTool.has(tid)) continue
      seenTool.add(tid)
      e.tools.push(String(b.name))
    }
  }
  const ctx = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  let cost = 0, reads = 0, cacheReadSum = 0
  for (const id of order) {
    const e = byId.get(id)!
    cost += usageCost(e.u)
    cacheReadSum += e.u.cache_read_input_tokens ?? 0
    reads += e.tools.filter(t => t === 'Read' || t === 'Bash').length
  }
  const first = order.length ? byId.get(order[0]!)!.u : {}
  const last = order.length ? byId.get(order[order.length - 1]!)!.u : {}
  return { calls: order.length, cost, reads, firstCtx: ctx(first), lastCtx: ctx(last), cacheReadSum }
}

function subagentTranscripts(cwd: string, sessionId: string): string[] {
  const dir = join(configDir(), 'projects', cwd.replace(/\//g, '-'), sessionId, 'subagents')
  try {
    return readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => join(dir, n))
  } catch {
    return []
  }
}

async function runArm(arm: Arm, rep: number, args: ReturnType<typeof parseArgs>): Promise<Row> {
  const cwd = mkdtempSync(join(tmpdir(), `fork-clip-ab-${arm}-`))
  mkdirSync(cwd, { recursive: true })
  const secret = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')).join('')
  for (let i = 1; i <= FILES; i++) {
    writeFileSync(join(cwd, `f${i}.txt`), fixture(1000 * rep + i, i === 3 ? secret : undefined))
  }
  const names = Array.from({ length: FILES }, (_, i) => `f${i + 1}.txt`).join(', ')
  const prompt =
    `Step 1: Read ${names} with the Read tool, one full read each (no offset/limit), and exactly ONE tool call per assistant message — do not batch the reads. ` +
    `Step 2: launch an Agent with NO subagent_type (a fork) and run_in_background false, with exactly this prompt: ` +
    `'Find the value of SECRET_TOKEN in f3.txt in this directory and report it; then count the number of lines in each of ${names} using one Read or Bash call per file, one tool call per assistant message, and report the ${FILES} counts.' ` +
    `Step 3: reply with exactly the SECRET_TOKEN value the agent reported, nothing else.`
  const run = await runHeadless({
    bin: args.bin,
    model: args.model,
    cwd,
    prompt,
    env: arm === 'on' ? { CLAUDIN_FORK_CLIP_HISTORY: '1' } : {},
    timeoutMs: args.timeoutMs,
  })
  const parent = summarize(transcriptPath(cwd, run.sessionId))
  const subs = subagentTranscripts(cwd, run.sessionId).map(summarize)
  // Fork transcripts mirror the parent's history; `summarize` dedupes by
  // message.id per file, but a child's file also carries the parent's
  // messages, so subtract the parent's ids: recompute over both with one map.
  const child = mergeChild(parent, subs, transcriptPath(cwd, run.sessionId), subagentTranscripts(cwd, run.sessionId))
  return {
    arm,
    rep,
    parentCalls: parent.calls,
    childCalls: child.calls,
    childReads: child.reads,
    childFirstCtx: child.firstCtx,
    parentLastCtx: parent.lastCtx,
    parentCost: parent.cost,
    childCost: child.cost,
    total: parent.cost + child.cost,
    reportedCost: run.totalCostUsd,
    correct: run.finalText.includes(secret),
  }
}

/** Child-only usage: ids present in subagent transcripts but not in the parent's. */
function mergeChild(_parent: Summ, _subs: Summ[], parentPath: string, subPaths: string[]): Summ {
  const parentIds = new Set<string>()
  for (const line of readFileSync(parentPath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const v = JSON.parse(line) as Record<string, unknown>
      if (v.type === 'assistant') parentIds.add(String((v.message as Record<string, unknown>).id ?? ''))
    } catch { /* skip */ }
  }
  const byId = new Map<string, { u: Usage; tools: string[] }>()
  const order: string[] = []
  const seenTool = new Set<string>()
  for (const p of subPaths) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      let v: Record<string, unknown>
      try { v = JSON.parse(line) } catch { continue }
      if (v.type !== 'assistant') continue
      const m = (v.message ?? {}) as Record<string, unknown>
      const id = String(m.id ?? '')
      const u = m.usage as Usage | undefined
      if (!id || !u || parentIds.has(id)) continue
      let e = byId.get(id)
      if (!e) { e = { u, tools: [] }; byId.set(id, e); order.push(id) }
      if ((u.output_tokens ?? 0) >= (e.u.output_tokens ?? 0)) e.u = u
      for (const b of (m.content ?? []) as Array<Record<string, unknown>>) {
        if (b.type !== 'tool_use') continue
        const tid = String(b.id ?? '')
        if (seenTool.has(tid)) continue
        seenTool.add(tid)
        e.tools.push(String(b.name))
      }
    }
  }
  const ctx = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  let cost = 0, reads = 0, cacheReadSum = 0
  for (const id of order) {
    const e = byId.get(id)!
    cost += usageCost(e.u)
    cacheReadSum += e.u.cache_read_input_tokens ?? 0
    reads += e.tools.filter(t => t === 'Read' || t === 'Bash').length
  }
  const first = order.length ? byId.get(order[0]!)!.u : {}
  const last = order.length ? byId.get(order[order.length - 1]!)!.u : {}
  return { calls: order.length, cost, reads, firstCtx: ctx(first), lastCtx: ctx(last), cacheReadSum }
}

function fmt(r: Row): string {
  return `${r.arm.padEnd(3)} rep=${r.rep} parentCalls=${r.parentCalls} parentLastCtx=${r.parentLastCtx} | childCalls=${String(r.childCalls).padStart(2)} childReads=${r.childReads} childFirstCtx=${r.childFirstCtx} | parent=$${r.parentCost.toFixed(3)} child=$${r.childCost.toFixed(3)} total=$${r.total.toFixed(3)} (reported=$${r.reportedCost.toFixed(3)}) ${r.correct ? 'ok ' : 'BAD'}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { timeoutMs: 600_000 })
  const rows: Row[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const arm of ['off', 'on'] as Arm[]) {
      const r = await runArm(arm, rep, args)
      rows.push(r)
      console.log(fmt(r))
    }
  }
  const off = rows.filter(r => r.arm === 'off'), on = rows.filter(r => r.arm === 'on')
  const range = (xs: number[]) => `${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}`
  const offTot = off.map(r => r.total), onTot = on.map(r => r.total)
  const offMed = median(offTot), onMed = median(onTot)
  const overlap = Math.min(...onTot) <= Math.max(...offTot) && Math.min(...offTot) <= Math.max(...onTot)
  const correct = rows.every(r => r.correct)
  const clipLanded = on.every(r => r.childFirstCtx > 0 && r.childFirstCtx < r.parentLastCtx)
  const reasons: string[] = []
  if (!(onMed < offMed)) reasons.push(`ON median $${onMed.toFixed(3)} not below OFF $${offMed.toFixed(3)}`)
  if (overlap) reasons.push(`ranges overlap (OFF ${range(offTot)} vs ON ${range(onTot)})`)
  if (!correct) reasons.push('wrong answer in some run')
  const pass = reasons.length === 0
  console.log('')
  console.log(`OFF: median total=$${offMed.toFixed(3)} range=${range(offTot)} median childCalls=${median(off.map(r => r.childCalls))} childCost=$${median(off.map(r => r.childCost)).toFixed(3)}`)
  console.log(`ON : median total=$${onMed.toFixed(3)} range=${range(onTot)} median childCalls=${median(on.map(r => r.childCalls))} childCost=$${median(on.map(r => r.childCost)).toFixed(3)} clipLanded=${clipLanded}`)
  console.log(`\n=== FORK CLIP A/B bin=${args.bin} model=${args.model ?? 'default'} reps=${args.reps} ${pass ? 'PASS' : 'FAIL'}${reasons.length ? ' [' + reasons.join('; ') + ']' : ''} ===`)
  process.exit(pass ? 0 : 1)
}

main()
