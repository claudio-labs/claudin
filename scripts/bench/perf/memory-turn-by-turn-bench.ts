#!/usr/bin/env bun
// Turn-by-turn memory profiler — Memory Gargalo Hunter.
//
// The problem this bench exists to solve: user-reported leak where heap
// stays stable for N turns, then enters linear growth near the end of a
// long session. Mitigations in e3caa36 (ContentReplacementState prune)
// and 5bdbfc1 (evictOldStubbedMessages) did not close the gap.
//
// Approach: run a parametric multi-turn session with synthetic payloads
// but REAL Claudin memory components (ContentReplacementState from
// toolResultStorage, applyStableStubs-shaped substitution that mirrors
// the production path). Measure per-turn:
//   - total heap + RSS + external
//   - mutableMessages length + approx bytes
//   - ContentReplacementState.{seenIds, replacements}.size
//   - perKeyClippedIds entries + total clipped IDs
//   - fileReadCache.size + readFileState.size (if --with-file-state)
// Then identify the inflection point where slope jumps and report the
// top contributors correlated with the linear-phase heap delta.
//
// Why no QueryEngine boot: QueryEngine's module graph drags ~100 MB of
// static state (openaiShim ~2.2k lines, analytics stubs, MCP clients,
// provider configs). That overwhelms the signal we care about. We use
// the SAME functions QueryEngine calls into — applyStableStubs,
// provisionContentReplacementState — through a narrow import surface.
// Leak behaviors we DO capture: mutableMessages unbounded growth,
// stub-set fragmentation, ContentReplacementState orphaning, stubbed-
// message eviction gaps. Behaviors we don't capture (document honestly):
// MCP reconnection, agent fork cleanup, streaming buffer drain — those
// need separate benches.
//
// Usage:
//   bun --expose-gc scripts/bench/perf/memory-turn-by-turn-bench.ts
//   bun --expose-gc scripts/bench/perf/memory-turn-by-turn-bench.ts \
//     --turns=500 --payload-kb=200 --payload-jitter=100 \
//     --with-compact --with-clear --inflection \
//     --output=mem.json --csv=mem.csv
//
// Required: --expose-gc (bin/claudin sets this by default in production).

import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import v8 from 'node:v8'

// ---- Args ----------------------------------------------------------------

type Args = {
  turns: number
  payloadKb: number
  payloadJitter: number
  toolsPerTurn: number
  withCompact: boolean
  withClear: boolean
  compactEvery: number
  clearEvery: number
  breakdown: boolean
  snapshotEvery: number
  output: string | null
  csv: string | null
  inflection: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    turns: 500,
    payloadKb: 200,
    payloadJitter: 100,
    toolsPerTurn: 2,
    withCompact: false,
    withClear: false,
    compactEvery: 100,
    clearEvery: 200,
    breakdown: true,
    snapshotEvery: 0,
    output: null,
    csv: null,
    inflection: false,
    json: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true
    else if (arg === '--json') a.json = true
    else if (arg === '--inflection') a.inflection = true
    else if (arg === '--with-compact') a.withCompact = true
    else if (arg === '--with-clear') a.withClear = true
    else if (arg === '--no-breakdown') a.breakdown = false
    else if (arg.startsWith('--turns=')) a.turns = Number(arg.slice(8)) || a.turns
    else if (arg.startsWith('--payload-kb=')) a.payloadKb = Number(arg.slice(13)) || a.payloadKb
    else if (arg.startsWith('--payload-jitter=')) a.payloadJitter = Number(arg.slice(17)) || a.payloadJitter
    else if (arg.startsWith('--tools-per-turn=')) a.toolsPerTurn = Number(arg.slice(17)) || a.toolsPerTurn
    else if (arg.startsWith('--compact-every=')) a.compactEvery = Number(arg.slice(16)) || a.compactEvery
    else if (arg.startsWith('--clear-every=')) a.clearEvery = Number(arg.slice(14)) || a.clearEvery
    else if (arg.startsWith('--snapshot-every=')) a.snapshotEvery = Number(arg.slice(17)) || 0
    else if (arg.startsWith('--output=')) a.output = arg.slice(9)
    else if (arg.startsWith('--csv=')) a.csv = arg.slice(6)
  }
  return a
}

function printHelp(): void {
  console.log(`memory-turn-by-turn-bench — detect the inflection point where
heap growth turns linear during a long session, and identify the top
component contributors.

Flags:
  --turns=N               number of turns (default 500)
  --payload-kb=N          mean tool_result payload KB (default 200)
  --payload-jitter=N      +/- KB jitter around mean (default 100)
  --tools-per-turn=N      tool_uses per turn (default 2)
  --with-compact          force stub substitution every --compact-every
  --compact-every=N       turns between forced compacts (default 100)
  --with-clear            force full /clear every --clear-every
  --clear-every=N         turns between forced clears (default 200)
  --no-breakdown          skip per-component sizing (faster, less info)
  --snapshot-every=N      v8.writeHeapSnapshot every N turns (0 = off)
  --output=PATH           write full history JSON
  --csv=PATH              write history CSV (one row per turn)
  --inflection            analyze + print inflection point at end
  --json                  emit result as JSON to stdout
  --help                  this message
`)
}

// ---- GC + sampling -------------------------------------------------------

function forceGC(): void {
  if (typeof global.gc === 'function') global.gc()
}

async function idle(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

type MemSample = {
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  arrayBuffers: number
}

function sampleMem(): MemSample {
  const m = process.memoryUsage()
  return {
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    rss: m.rss,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  }
}

// ---- Synthetic payload factories (reused from query-engine-mem-bench) ----

const FILE_READ_LINE_RE = /./ // placeholder for future filtering
void FILE_READ_LINE_RE

function makeFileReadPayload(sizeBytes: number): string {
  const lines: string[] = []
  let total = 0
  let lineNo = 1
  while (total < sizeBytes) {
    const line = `${String(lineNo).padStart(5, ' ')}→  const value_${lineNo} = computeSomething(${lineNo}, "argument-${lineNo}")\n`
    lines.push(line)
    total += line.length
    lineNo++
  }
  return lines.join('')
}

function makeBashPayload(sizeBytes: number): string {
  const lines: string[] = []
  let total = 0
  let i = 0
  while (total < sizeBytes) {
    const line = `[2026-05-06 12:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}] INFO  worker[${i}] processing job batch_${i} (${i % 100} items)\n`
    lines.push(line)
    total += line.length
    i++
  }
  return lines.join('')
}

function makeGrepPayload(sizeBytes: number): string {
  const lines: string[] = []
  let total = 0
  let i = 0
  while (total < sizeBytes) {
    const line = `src/file-${i % 200}.ts:${(i % 500) + 1}:  const match_${i} = someFunction(${i}) // result of grep\n`
    lines.push(line)
    total += line.length
    i++
  }
  return lines.join('')
}

// ---- Message shapes (Anthropic SDK compatible) ---------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

type Message = {
  type: 'user' | 'assistant'
  uuid: string
  message: { role: 'user' | 'assistant'; content: string | ContentBlock[] }
}

function makeAssistantText(text: string): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function makeAssistantToolUse(uses: Array<{ id: string; name: string }>): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: uses.map(t => ({
        type: 'tool_use' as const,
        id: t.id,
        name: t.name,
        input: { path: `/tmp/file-${t.id}.ts`, query: 'something' },
      })),
    },
  }
}

function makeUserToolResult(results: Array<{ id: string; content: string }>): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
      })),
    },
  }
}

function makeUserPrompt(text: string): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: text },
  }
}

// ---- Stable stub substitution (mirrors stableStubState.applyStableStubs) --

const CLIP_PATTERN = /^\[clipped: ~\d+ tokens from .+\]$/

function buildClipStub(toolName: string, approxTokens: number): string {
  return `[clipped: ~${Math.max(0, Math.round(approxTokens))} tokens from ${toolName}]`
}

function applyStableStubsLocal(
  messages: Message[],
  clippedIds: Set<string>,
  toolNames: Map<string, string>,
): Message[] {
  if (clippedIds.size === 0) return messages
  let any = false
  const out = messages.map(msg => {
    const content = msg.message.content
    if (!Array.isArray(content)) return msg
    let touched = false
    const newContent = content.map(block => {
      if (block.type !== 'tool_result' || !clippedIds.has(block.tool_use_id)) return block
      if (typeof block.content === 'string' && CLIP_PATTERN.test(block.content)) return block
      if (block.content == null || block.content === '') return block
      const approxTokens = Math.ceil(block.content.length / 4)
      touched = true
      return {
        ...block,
        content: buildClipStub(toolNames.get(block.tool_use_id) ?? 'tool', approxTokens),
      }
    })
    if (!touched) return msg
    any = true
    return { ...msg, message: { ...msg.message, content: newContent } }
  })
  return any ? out : messages
}

// ---- ContentReplacementState shape (mirrors toolResultStorage type) ------
//
// Why not import the real one: the real module pulls in message.js types
// that transitively drag in the telemetry/analytics graph. We mirror the
// shape (Set + Map) so size tracking matches byte-for-byte — the leak
// profile is about container growth, not wire-format parity.

type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

function createReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

function provisionFromMessages(messages: Message[]): ContentReplacementState {
  const s = createReplacementState()
  for (const msg of messages) {
    const c = msg.message.content
    if (!Array.isArray(c)) continue
    for (const block of c) {
      if (block.type === 'tool_result') s.seenIds.add(block.tool_use_id)
    }
  }
  return s
}

function pruneReplacementState(
  state: ContentReplacementState,
  messages: Message[],
): void {
  const live = new Set<string>()
  for (const msg of messages) {
    const c = msg.message.content
    if (!Array.isArray(c)) continue
    for (const block of c) {
      if (block.type === 'tool_use') live.add(block.id)
      else if (block.type === 'tool_result') live.add(block.tool_use_id)
    }
  }
  for (const id of state.seenIds) if (!live.has(id)) state.seenIds.delete(id)
  for (const id of state.replacements.keys()) if (!live.has(id)) state.replacements.delete(id)
}

// ---- perKeyClippedIds simulation ----------------------------------------
//
// Mirrors stableStubState.perKeyClippedIds — Map<sessionKey, Set<toolUseId>>
// with a cap of 16 keys. We exercise the cap so the bench can detect
// per-bucket growth (MAX_TRACKED_KEYS hides it from the Map-size metric).

const MAX_TRACKED_KEYS = 16

class ClippedIdsStore {
  private buckets = new Map<string, Set<string>>()

  addForKey(key: string, id: string): void {
    let set = this.buckets.get(key)
    if (!set) {
      if (this.buckets.size >= MAX_TRACKED_KEYS) {
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
      }
      set = new Set()
      this.buckets.set(key, set)
    }
    set.add(id)
  }

  getForKey(key: string): Set<string> {
    return this.buckets.get(key) ?? new Set()
  }

  get mapSize(): number {
    return this.buckets.size
  }

  get totalIds(): number {
    let n = 0
    for (const s of this.buckets.values()) n += s.size
    return n
  }

  pruneOrphans(key: string, liveIds: Set<string>): void {
    const set = this.buckets.get(key)
    if (!set) return
    for (const id of set) if (!liveIds.has(id)) set.delete(id)
  }

  resetKey(key: string): void {
    this.buckets.delete(key)
  }
}

// ---- Approx bytes ---------------------------------------------------------

function approxBytes(messages: Message[]): number {
  let bytes = 0
  for (const m of messages) {
    bytes += 200
    const c = m.message.content
    if (typeof c === 'string') bytes += c.length
    else {
      for (const block of c) {
        if (block.type === 'text') bytes += block.text.length
        else if (block.type === 'tool_result') bytes += (block.content ?? '').length + 50
        else if (block.type === 'tool_use') bytes += JSON.stringify(block.input).length + 100
      }
    }
  }
  return bytes
}

// ---- Turn record ---------------------------------------------------------

type TurnRecord = {
  turn: number
  ts: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  arrayBuffers: number
  breakdown?: {
    mutableMessagesCount: number
    mutableMessagesApproxBytes: number
    contentReplacementSeenIds: number
    contentReplacementReplacements: number
    perKeyClippedIdsEntries: number
    perKeyClippedIdsTotalIds: number
  }
  event?: string // 'compact', 'clear'
}

// ---- Bench loop ----------------------------------------------------------

async function run(args: Args): Promise<{
  baseline: MemSample
  history: TurnRecord[]
  wallMs: number
}> {
  let messages: Message[] = []
  let replacementState: ContentReplacementState = createReplacementState()
  const clippedStore = new ClippedIdsStore()
  const allToolUseIds: string[] = []
  const toolNames = new Map<string, string>()

  const sessionKey = `bench-session-${Date.now()}`

  // Lock baseline AFTER initial allocations settle.
  forceGC()
  await idle(20)
  forceGC()
  const baseline = sampleMem()
  const t0 = performance.now()

  const history: TurnRecord[] = []

  for (let turn = 1; turn <= args.turns; turn++) {
    // 1. user prompt
    messages.push(makeUserPrompt(`turn ${turn}: investigate task ${turn}`))

    // 2. assistant tool_use
    const uses = Array.from({ length: args.toolsPerTurn }, (_, i) => {
      const id = `toolu_${turn}_${i}`
      const name = ['Read', 'Bash', 'Grep'][(turn + i) % 3]!
      allToolUseIds.push(id)
      toolNames.set(id, name)
      return { id, name }
    })
    messages.push(makeAssistantToolUse(uses))

    // 3. user tool_result with jittered payload size
    const results = uses.map((u, i) => {
      const jitter = args.payloadJitter > 0
        ? Math.floor(((turn * 31 + i * 17) % (args.payloadJitter * 2 + 1)) - args.payloadJitter)
        : 0
      const sizeKb = Math.max(1, args.payloadKb + jitter)
      const sizeBytes = sizeKb * 1024
      const payload =
        u.name === 'Read'
          ? makeFileReadPayload(sizeBytes)
          : u.name === 'Bash'
            ? makeBashPayload(sizeBytes)
            : makeGrepPayload(sizeBytes)
      return { id: u.id, content: payload + `\n// turn ${turn} idx ${i}\n` }
    })
    messages.push(makeUserToolResult(results))

    // Update ContentReplacementState — production prunes orphans each turn
    // (commit e3caa36). Mirror that behavior.
    for (const r of results) replacementState.seenIds.add(r.id)
    pruneReplacementState(replacementState, messages)

    // 4. assistant text
    messages.push(makeAssistantText(`Result of turn ${turn}: value is ${turn * 13}.`))

    // 5. forced compact? (mirrors stableStubState substitution hot path)
    let event: string | undefined
    if (args.withCompact && turn % args.compactEvery === 0 && allToolUseIds.length > 4) {
      const toClip = allToolUseIds.slice(0, -4)
      for (const id of toClip) clippedStore.addForKey(sessionKey, id)
      const clipped = clippedStore.getForKey(sessionKey)
      messages = applyStableStubsLocal(messages, clipped, toolNames)
      // simulate replacement-record growth from the compact path
      for (const id of toClip) {
        if (!replacementState.replacements.has(id)) {
          replacementState.replacements.set(id, buildClipStub(toolNames.get(id) ?? 'tool', 1000))
        }
      }
      event = 'compact'
    }

    // 6. forced clear? (mirrors /clear semantics)
    if (args.withClear && turn % args.clearEvery === 0) {
      messages = []
      replacementState = createReplacementState()
      clippedStore.resetKey(sessionKey)
      allToolUseIds.length = 0
      toolNames.clear()
      event = event ? `${event}+clear` : 'clear'
    }

    // 7. stabilize before measuring every N turns to reduce noise
    if (turn % 10 === 0) forceGC()

    // 8. measure
    const mem = sampleMem()
    const record: TurnRecord = {
      turn,
      ts: performance.now() - t0,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      event,
    }
    if (args.breakdown) {
      record.breakdown = {
        mutableMessagesCount: messages.length,
        mutableMessagesApproxBytes: approxBytes(messages),
        contentReplacementSeenIds: replacementState.seenIds.size,
        contentReplacementReplacements: replacementState.replacements.size,
        perKeyClippedIdsEntries: clippedStore.mapSize,
        perKeyClippedIdsTotalIds: clippedStore.totalIds,
      }
    }
    history.push(record)

    if (args.snapshotEvery > 0 && turn % args.snapshotEvery === 0) {
      const path = `heap-turn-${turn}.heapsnapshot`
      v8.writeHeapSnapshot(path)
      console.error(`  [snapshot] ${path}`)
    }
  }

  const wallMs = performance.now() - t0
  return { baseline, history, wallMs }
}

// ---- Inflection analysis -------------------------------------------------

type LinReg = { slope: number; intercept: number; r2: number }

function linearRegression(xs: number[], ys: number[]): LinReg {
  const n = xs.length
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 }
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!
    const y = ys[i]!
    sumX += x
    sumY += y
    sumXY += x * y
    sumX2 += x * x
    sumY2 += y * y
  }
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  // r²
  let ssRes = 0, ssTot = 0
  const meanY = sumY / n
  for (let i = 0; i < n; i++) {
    const y = ys[i]!
    const pred = slope * xs[i]! + intercept
    ssRes += (y - pred) ** 2
    ssTot += (y - meanY) ** 2
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  return { slope, intercept, r2 }
}

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]! }
  const mx = sx / n, my = sy / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx
    const b = ys[i]! - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const denom = Math.sqrt(dx * dy)
  return denom === 0 ? 0 : num / denom
}

type InflectionReport = {
  metric: 'rss' | 'heapUsed'
  inflectionTurn: number | null
  stablePhaseSlopeBytesPerTurn: number
  linearPhaseSlopeBytesPerTurn: number
  topContributors: Array<{
    component: string
    pearsonR: number
    slopePerTurn: number
    unit: string
  }>
}

// We analyze RSS, not heapUsed. Rationale: large string payloads from
// tool_results can live in V8's off-heap buffers or be reclaimed between
// the synchronous gc() call and memoryUsage() sampling, leaving heapUsed
// misleadingly flat while the process grows. RSS is the bottom-line
// "memory the OS sees Claudin consuming" — that is the user-visible leak.
// We additionally inspect heapUsed as a secondary signal.

type Metric = 'rss' | 'heapUsed'

function analyzeInflection(
  history: TurnRecord[],
  metric: Metric = 'rss',
): InflectionReport {
  const WINDOW = Math.max(20, Math.floor(history.length / 20))
  const CALIB_TURNS = Math.min(100, Math.floor(history.length / 3))

  const pick = (r: TurnRecord): number => metric === 'rss' ? r.rss : r.heapUsed

  // Reference slope from the first CALIB_TURNS turns
  const calibHist = history.slice(0, CALIB_TURNS)
  const calibSlope = linearRegression(
    calibHist.map(h => h.turn),
    calibHist.map(pick),
  ).slope

  // Slide a window and find the first turn where slope > 2 * calibSlope
  // (or > 500 KB/turn if calibration is essentially flat).
  const threshold = Math.max(calibSlope * 2, 500 * 1024)

  let inflection: number | null = null
  for (let start = CALIB_TURNS; start + WINDOW <= history.length; start++) {
    const win = history.slice(start, start + WINDOW)
    const reg = linearRegression(
      win.map(h => h.turn),
      win.map(pick),
    )
    if (reg.slope > threshold) {
      inflection = win[0]!.turn
      break
    }
  }

  const stableEnd = inflection ?? history.length
  const stable = history.slice(0, stableEnd)
  const linear = inflection ? history.slice(stableEnd - 1) : []
  const stableSlope = linearRegression(
    stable.map(h => h.turn),
    stable.map(pick),
  ).slope
  const linearSlope = linear.length > 1
    ? linearRegression(linear.map(h => h.turn), linear.map(pick)).slope
    : 0

  // Top contributors: correlate each breakdown component with the
  // chosen metric in the linear (or late-calibration) phase.
  const contributors: InflectionReport['topContributors'] = []
  const phase = linear.length > 1 ? linear : history.slice(CALIB_TURNS)
  if (phase.length > 5 && phase[0]?.breakdown) {
    const components: Array<{ name: string; extract: (r: TurnRecord) => number; unit: string }> = [
      { name: 'mutableMessagesApproxBytes', extract: r => r.breakdown?.mutableMessagesApproxBytes ?? 0, unit: 'bytes' },
      { name: 'mutableMessagesCount', extract: r => r.breakdown?.mutableMessagesCount ?? 0, unit: 'messages' },
      { name: 'contentReplacementSeenIds', extract: r => r.breakdown?.contentReplacementSeenIds ?? 0, unit: 'ids' },
      { name: 'contentReplacementReplacements', extract: r => r.breakdown?.contentReplacementReplacements ?? 0, unit: 'entries' },
      { name: 'perKeyClippedIdsTotalIds', extract: r => r.breakdown?.perKeyClippedIdsTotalIds ?? 0, unit: 'ids' },
      { name: 'perKeyClippedIdsEntries', extract: r => r.breakdown?.perKeyClippedIdsEntries ?? 0, unit: 'keys' },
    ]
    const turnsArr = phase.map(h => h.turn)
    const metricArr = phase.map(pick)
    for (const c of components) {
      const ys = phase.map(c.extract)
      const r = pearsonR(metricArr, ys)
      const reg = linearRegression(turnsArr, ys)
      contributors.push({ component: c.name, pearsonR: r, slopePerTurn: reg.slope, unit: c.unit })
    }
    contributors.sort((a, b) => Math.abs(b.pearsonR) - Math.abs(a.pearsonR))
  }

  return {
    metric,
    inflectionTurn: inflection,
    stablePhaseSlopeBytesPerTurn: stableSlope,
    linearPhaseSlopeBytesPerTurn: linearSlope,
    topContributors: contributors,
  }
}

// ---- Output helpers ------------------------------------------------------

function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function writeCSV(path: string, history: TurnRecord[]): void {
  const header = [
    'turn', 'ts_ms', 'heapUsed', 'heapTotal', 'rss', 'external', 'arrayBuffers',
    'mutableMessagesCount', 'mutableMessagesApproxBytes',
    'contentReplacementSeenIds', 'contentReplacementReplacements',
    'perKeyClippedIdsEntries', 'perKeyClippedIdsTotalIds', 'event',
  ].join(',')
  const rows = history.map(r => [
    r.turn, r.ts.toFixed(1), r.heapUsed, r.heapTotal, r.rss, r.external, r.arrayBuffers,
    r.breakdown?.mutableMessagesCount ?? '',
    r.breakdown?.mutableMessagesApproxBytes ?? '',
    r.breakdown?.contentReplacementSeenIds ?? '',
    r.breakdown?.contentReplacementReplacements ?? '',
    r.breakdown?.perKeyClippedIdsEntries ?? '',
    r.breakdown?.perKeyClippedIdsTotalIds ?? '',
    r.event ?? '',
  ].join(','))
  writeFileSync(path, [header, ...rows].join('\n') + '\n')
}

function reportHuman(
  args: Args,
  baseline: MemSample,
  history: TurnRecord[],
  wallMs: number,
  inflection: InflectionReport[] | null,
): void {
  const first = history[0]!
  const last = history[history.length - 1]!

  console.log(`Turn-by-turn memory profile`)
  console.log(`  turns=${args.turns}  payload=${args.payloadKb}±${args.payloadJitter} KB  tools/turn=${args.toolsPerTurn}`)
  console.log(`  features: ${[args.withCompact ? 'compact' : null, args.withClear ? 'clear' : null].filter(Boolean).join(', ') || 'none'}`)
  console.log(`  wall: ${(wallMs / 1000).toFixed(1)}s\n`)

  console.log(`Baseline (post-stabilization):`)
  console.log(`  heapUsed: ${fmtBytes(baseline.heapUsed)}  rss: ${fmtBytes(baseline.rss)}\n`)

  console.log(`Final delta from baseline:`)
  console.log(`  heapUsed: ${fmtBytes(last.heapUsed - baseline.heapUsed)} (${fmtBytes(last.heapUsed)})`)
  console.log(`  rss:      ${fmtBytes(last.rss - baseline.rss)} (${fmtBytes(last.rss)})`)
  if (last.breakdown) {
    console.log(`  messages: ${last.breakdown.mutableMessagesCount} (${fmtBytes(last.breakdown.mutableMessagesApproxBytes)})`)
    console.log(`  replacement state: seen=${last.breakdown.contentReplacementSeenIds} replaced=${last.breakdown.contentReplacementReplacements}`)
    console.log(`  perKey clipped: ${last.breakdown.perKeyClippedIdsEntries} keys / ${last.breakdown.perKeyClippedIdsTotalIds} ids\n`)
  }

  // Sparse sample table — every ~10% of turns
  const step = Math.max(1, Math.floor(history.length / 10))
  console.log(`Trend (every ~${step} turns):`)
  console.log(`  turn     heap         Δheap        rss          messages  approxBytes  event`)
  for (let i = 0; i < history.length; i += step) {
    const r = history[i]!
    const dh = r.heapUsed - baseline.heapUsed
    const msgs = r.breakdown?.mutableMessagesCount ?? '—'
    const appr = r.breakdown?.mutableMessagesApproxBytes
    console.log(
      `  ${String(r.turn).padStart(5)}  ${fmtBytes(r.heapUsed).padStart(10)}  ${fmtBytes(dh).padStart(10)}  ${fmtBytes(r.rss).padStart(10)}  ${String(msgs).padStart(8)}  ${(appr != null ? fmtBytes(appr) : '—').padStart(11)}  ${r.event ?? ''}`,
    )
  }
  // always include last row
  if (history.length > 0 && (history.length - 1) % step !== 0) {
    const r = last
    const dh = r.heapUsed - baseline.heapUsed
    const msgs = r.breakdown?.mutableMessagesCount ?? '—'
    const appr = r.breakdown?.mutableMessagesApproxBytes
    console.log(
      `  ${String(r.turn).padStart(5)}  ${fmtBytes(r.heapUsed).padStart(10)}  ${fmtBytes(dh).padStart(10)}  ${fmtBytes(r.rss).padStart(10)}  ${String(msgs).padStart(8)}  ${(appr != null ? fmtBytes(appr) : '—').padStart(11)}  ${r.event ?? ''}`,
    )
  }
  console.log()

  if (inflection) {
    for (const infl of inflection) {
      const label = infl.metric === 'rss' ? 'RSS (process footprint)' : 'heapUsed (V8 heap)'
      console.log(`─── Inflection analysis: ${label} ───`)
      if (infl.inflectionTurn != null) {
        console.log(`  inflection at turn ${infl.inflectionTurn}`)
        console.log(`  stable phase (turns ${first.turn}-${infl.inflectionTurn}): ${fmtBytes(infl.stablePhaseSlopeBytesPerTurn)}/turn`)
        console.log(`  linear phase (turns ${infl.inflectionTurn}-${last.turn}): ${fmtBytes(infl.linearPhaseSlopeBytesPerTurn)}/turn`)
      } else {
        console.log(`  NO INFLECTION (growth stayed within 2× of calibration slope)`)
        console.log(`  overall slope: ${fmtBytes(infl.stablePhaseSlopeBytesPerTurn)}/turn`)
      }
      if (infl.topContributors.length > 0) {
        console.log(`  top contributors (Pearson r with ${infl.metric}):`)
        for (const c of infl.topContributors.slice(0, 5)) {
          const unit = c.unit === 'bytes' ? fmtBytes(c.slopePerTurn) : `${c.slopePerTurn.toFixed(2)} ${c.unit}`
          console.log(`    ${c.component.padEnd(36)} r=${c.pearsonR.toFixed(2).padStart(6)}  slope=${unit}/turn`)
        }
      }
      console.log()
    }
  }
}

// ---- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  const { baseline, history, wallMs } = await run(args)
  const inflection = args.inflection
    ? [analyzeInflection(history, 'rss'), analyzeInflection(history, 'heapUsed')]
    : null

  if (args.csv) writeCSV(args.csv, history)
  if (args.output) {
    writeFileSync(args.output, JSON.stringify({ args, baseline, history, wallMs, inflection }, null, 2) + '\n')
  }

  if (args.json) {
    const summary = {
      args,
      baseline,
      wallMs,
      turnsRecorded: history.length,
      finalHeapUsed: history[history.length - 1]?.heapUsed ?? 0,
      finalHeapDelta: (history[history.length - 1]?.heapUsed ?? 0) - baseline.heapUsed,
      inflection,
    }
    console.log(JSON.stringify(summary, null, 2))
  } else {
    reportHuman(args, baseline, history, wallMs, inflection)
  }
}

// Export for in-process tests
export { run, analyzeInflection, linearRegression, pearsonR }
export type { Args, TurnRecord, InflectionReport, MemSample }

if (import.meta.main) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
