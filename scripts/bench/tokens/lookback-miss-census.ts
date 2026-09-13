#!/usr/bin/env bun
// Full-history cache rewrites across recorded sessions: how many, how big, and
// what the `[Cache: …]` line said about each.
//
// A "full rewrite" here is one API call whose cache_read fell from the
// previous call's by ≥ 2k (the detector's own threshold) while it wrote
// ≥ --min-rewrite tokens (default 20k). Each event is tagged with what the
// transcript can tell about it:
//   floor        cache_read landed on the session's floor — the system+tools
//                breakpoint — i.e. NOTHING of the message history was found
//   marker-jump  input_tokens collapsed on the same call (the deferred marker
//                moved to the tail): the lookback-miss signature that the
//                lagging marker (src/providers/shims/claude/lagCacheMarker.ts)
//                removes
//   new-turn     the call opened a user turn (prompt, often with a screenshot)
//   compact      a compaction summary landed between the two calls (expected)
//   idle>1h      more than an hour since the previous call — the 1h TTL
//                expired, the rewrite is expected (idle>5m likewise for 5m)
//   reason=…     the `[Cache: …]` line whose "rewrote N" matches this call
//
// Baseline the fix was measured against (2026-09-13):
//   ab1e69e8  calls=879  events=7  rewritten=3.06M  (81% of 3.80M cache writes)
//   --since=30: 213 sessions, 414 events, 35.9M of 92.9M cache writes (38.6%);
//   389 on the floor, 201 with the marker-jump signature, only 15 behind an
//   idle>1h gap. 403 of the 414 carry no `[Cache:]` line — the reason only
//   started reaching the transcript on 2026-09-09.
//
// Usage:
//   bun run scripts/bench/tokens/lookback-miss-census.ts                # every session
//   bun run scripts/bench/tokens/lookback-miss-census.ts --since=7      # last 7 days
//   bun run scripts/bench/tokens/lookback-miss-census.ts --session=ab1e69e8 --verbose
//
// Reads transcripts only; never writes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Args = { since?: number; session?: string; minRewrite: number; verbose: boolean }

function parseArgs(argv: string[]): Args {
  const a: Args = { minRewrite: 20_000, verbose: false }
  for (const s of argv) {
    if (s.startsWith('--since=')) a.since = Number(s.slice(8))
    else if (s.startsWith('--session=')) a.session = s.slice(10)
    else if (s.startsWith('--min-rewrite=')) a.minRewrite = Number(s.slice(14))
    else if (s === '--verbose' || s === '-v') a.verbose = true
  }
  return a
}

const MIN_CACHE_MISS_TOKENS = 2_000
const FLOOR_SLACK_TOKENS = 512

type Call = {
  line: number
  t: string
  ms: number
  in: number
  cw: number
  cr: number
  /** True when the first message of the call was a user prompt (not a tool_result). */
  newTurn: boolean
  compactBefore: boolean
}

type Event = Call & { prev: Call; tags: string[]; reason?: string }

type SessionReport = {
  id: string
  file: string
  calls: number
  cacheWrite: number
  events: Event[]
}

const REWROTE_RE = /rewrote ([\d.]+)([km]?)/i

function parseRewrote(line: string): number | undefined {
  const m = REWROTE_RE.exec(line)
  if (!m) return undefined
  const n = Number(m[1])
  return m[2]?.toLowerCase() === 'k' ? n * 1000 : m[2]?.toLowerCase() === 'm' ? n * 1_000_000 : n
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function censusSession(file: string): SessionReport | null {
  const lines = readFileSync(file, 'utf8').split('\n')
  const seen = new Set<string>()
  const calls: Call[] = []
  const cacheLines: string[] = []
  let pendingNewTurn = false
  let pendingCompact = false
  let cacheWrite = 0
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (!raw) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    if (o.isSidechain) continue
    const message = o.message as Record<string, unknown> | undefined
    if (o.type === 'user' && message) {
      const content = message.content
      const blocks = Array.isArray(content) ? (content as Array<{ type: string }>) : []
      const isToolResult = blocks.some(b => b.type === 'tool_result')
      if (o.isCompactSummary) pendingCompact = true
      if (!isToolResult && !o.isMeta) pendingNewTurn = true
      continue
    }
    if (o.type === 'system' && o.subtype === 'informational') {
      const c = String(o.content ?? '')
      if (c.includes('[Cache:')) cacheLines.push(c)
      continue
    }
    if (o.type !== 'assistant' || !message) continue
    const id = String(message.id ?? '')
    const usage = message.usage as Record<string, number> | undefined
    if (!id || !usage || seen.has(id)) continue
    seen.add(id)
    const call: Call = {
      line: i,
      t: String(o.timestamp ?? '').slice(11, 19),
      ms: Date.parse(String(o.timestamp ?? '')) || 0,
      in: usage.input_tokens ?? 0,
      cw: usage.cache_creation_input_tokens ?? 0,
      cr: usage.cache_read_input_tokens ?? 0,
      newTurn: pendingNewTurn,
      compactBefore: pendingCompact,
    }
    pendingNewTurn = false
    pendingCompact = false
    cacheWrite += call.cw
    calls.push(call)
  }
  if (calls.length === 0) return null

  const positiveReads = calls.map(c => c.cr).filter(cr => cr > 0)
  const floor = positiveReads.length > 0 ? Math.min(...positiveReads) : 0
  const events: Event[] = []
  for (let i = 1; i < calls.length; i += 1) {
    const prev = calls[i - 1]!
    const c = calls[i]!
    if (prev.cr - c.cr < MIN_CACHE_MISS_TOKENS) continue
    if (c.cw < ARGS.minRewrite) continue
    const tags: string[] = []
    if (c.cr <= floor + FLOOR_SLACK_TOKENS) tags.push('floor')
    if (prev.in >= MIN_CACHE_MISS_TOKENS && c.in < prev.in / 4) tags.push('marker-jump')
    if (c.newTurn) tags.push('new-turn')
    if (c.compactBefore) tags.push('compact')
    const gapMs = prev.ms && c.ms ? c.ms - prev.ms : 0
    if (gapMs > 3_600_000) tags.push('idle>1h')
    else if (gapMs > 300_000) tags.push('idle>5m')
    const reasonLine = cacheLines.find(l => {
      const rewrote = parseRewrote(l)
      return rewrote !== undefined && Math.abs(rewrote - c.cw) <= Math.max(100, c.cw * 0.002)
    })
    const reason = reasonLine?.match(/cache break: (.*?) — read/)?.[1] ?? reasonLine?.match(/cache break: (.*)\]$/)?.[1]
    events.push({ ...c, prev, tags, reason })
  }
  const id = file.split('/').pop()!.replace('.jsonl', '')
  return { id, file, calls: calls.length, cacheWrite, events }
}

function listTranscripts(root: string, since?: number): string[] {
  const out: string[] = []
  const cutoff = since ? Date.now() - since * 86_400_000 : 0
  let projects: string[] = []
  try {
    projects = readdirSync(root)
  } catch {
    return out
  }
  for (const p of projects) {
    const dir = join(root, p)
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue
      const f = join(dir, e)
      if (cutoff && statSync(f).mtimeMs < cutoff) continue
      out.push(f)
    }
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))

function main() {
  const configDir = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
  let files = listTranscripts(join(configDir, 'projects'), ARGS.since)
  if (ARGS.session) files = files.filter(f => f.includes(ARGS.session!))
  const reports = files.map(censusSession).filter((r): r is SessionReport => r !== null && r.calls >= 20)
  reports.sort((a, b) => b.events.reduce((s, e) => s + e.cw, 0) - a.events.reduce((s, e) => s + e.cw, 0))

  let totalEvents = 0
  let totalRewritten = 0
  let totalWrites = 0
  let floorEvents = 0
  let jumpEvents = 0
  console.log('session   calls  events  rewritten   writes   share  floor  marker-jump')
  for (const r of reports) {
    const rewritten = r.events.reduce((s, e) => s + e.cw, 0)
    const fl = r.events.filter(e => e.tags.includes('floor')).length
    const mj = r.events.filter(e => e.tags.includes('marker-jump')).length
    totalEvents += r.events.length
    totalRewritten += rewritten
    totalWrites += r.cacheWrite
    floorEvents += fl
    jumpEvents += mj
    if (r.events.length === 0 && !ARGS.session) continue
    const share = r.cacheWrite > 0 ? `${((rewritten / r.cacheWrite) * 100).toFixed(0)}%` : '-'
    console.log(
      `${r.id.slice(0, 8)}  ${String(r.calls).padStart(5)}  ${String(r.events.length).padStart(6)}  ${fmt(rewritten).padStart(9)}  ${fmt(r.cacheWrite).padStart(7)}  ${share.padStart(5)}  ${String(fl).padStart(5)}  ${String(mj).padStart(11)}`,
    )
    if (ARGS.verbose) {
      for (const e of r.events) {
        console.log(
          `    ${e.t}  read ${fmt(e.prev.cr)}→${fmt(e.cr)}  rewrote ${fmt(e.cw)}  in ${e.prev.in}→${e.in}  [${e.tags.join(',') || '-'}]${e.reason ? `  reason=${e.reason}` : ''}`,
        )
      }
    }
  }
  console.log(
    `\nsessions=${reports.length} events=${totalEvents} rewritten=${fmt(totalRewritten)} of ${fmt(totalWrites)} cache writes` +
      ` (${totalWrites > 0 ? ((totalRewritten / totalWrites) * 100).toFixed(1) : '0'}%)` +
      `  floor=${floorEvents}  marker-jump=${jumpEvents}`,
  )

  // What the transcript said about each event, numbers stripped so the
  // reasons bucket. A `[Cache:]` line only lands at the end of a turn, so an
  // interrupted turn leaves its rewrite unlabeled ("(no line)").
  const byReason = new Map<string, { n: number; tokens: number }>()
  const byTags = new Map<string, { n: number; tokens: number }>()
  for (const r of reports) {
    for (const e of r.events) {
      const reason = (e.reason ?? '(no line)').replace(/\d[\d.,]*[km]?/g, 'N')
      const rb = byReason.get(reason) ?? { n: 0, tokens: 0 }
      rb.n += 1
      rb.tokens += e.cw
      byReason.set(reason, rb)
      const tags = e.tags.join(',') || '-'
      const tb = byTags.get(tags) ?? { n: 0, tokens: 0 }
      tb.n += 1
      tb.tokens += e.cw
      byTags.set(tags, tb)
    }
  }
  console.log('\nby reason:')
  for (const [reason, v] of [...byReason].sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${String(v.n).padStart(4)}  ${fmt(v.tokens).padStart(8)}  ${reason}`)
  }
  console.log('by tags:')
  for (const [tags, v] of [...byTags].sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${String(v.n).padStart(4)}  ${fmt(v.tokens).padStart(8)}  ${tags}`)
  }
}

if (import.meta.main) main()
