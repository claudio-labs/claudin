/**
 * Classifier cache replay: what the auto-mode classifier's transcript costs in
 * prompt-cache writes, call by call, under the stable cut and under the
 * newest-first fill it replaced (`CLAUDIN_CLASSIFIER_STABLE_CUT=0`).
 *
 * The 2026-10-23..24 census put the classifier at ~24% of all spend, 90% of
 * it cache writes: past `MAX_CLASSIFIER_TRANSCRIPT_CHARS` the newest-first fill
 * dropped the oldest kept entry on every call, so the transcript after the
 * CLAUDE.md block was never a prefix of the previous call's. This replays
 * every recorded classifier decision (a tool_result whose `permissionDecision`
 * has `reason: 'classifier'`) through the REAL serializer, in both arms, and
 * runs the result through a model of Anthropic's prompt cache:
 *
 *   - a request is the transcript blocks plus the action block, with the one
 *     breakpoint the classifier places, on the action (`classify.ts`);
 *   - a breakpoint writes an entry for the prefix up to it; a later request
 *     reads the longest prefix ending on a block boundary at most 20 blocks
 *     before its own breakpoint that matches a live entry;
 *   - an entry lives 1h from its last use (the classifier's TTL);
 *   - tokens are chars / 4. The system prompt and the CLAUDE.md block are left
 *     out: both arms send the same ones, and both stay cached.
 *
 * Tools are an identity stub (each projects its raw input), the same in both
 * arms: the real `toAutoClassifierInput` projections need the tool registry,
 * which a bare `bun scripts/…` run cannot load. Absolute sizes are therefore
 * approximate; the comparison between arms is what it is for. In session
 * 4c2d912b the old arm comes to ~15.5k written per call, where the app's
 * cost-state recorded 15.7k.
 *
 * Gate (pre-registered for the stable cut, printed as PASS/FAIL):
 *   1. threads that pass the budget with ≥30 decisions: writes per call fall
 *      by 60% or more in total;
 *   2. threads whose history stays ≤150k chars: the two arms send identical
 *      blocks on every call;
 *   3. past the budget, a stable-cut transcript keeps at least the budget
 *      minus the chunk that was dropped: under two chunks for a run of small
 *      entries, or the one entry that was a chunk of its own;
 *   4. serializing the largest decision takes under 50 ms.
 *
 * Run:
 *   bun scripts/bench/tokens/classifier-cache-replay.ts --since=2026-10-20
 *   bun scripts/bench/tokens/classifier-cache-replay.ts --since=2026-10-20 --session=4c2d912b
 *
 * Transcripts are DATA: only aggregates and session ids are printed.
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import type { Tools } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import {
  buildToolLookup,
  CLASSIFIER_TRANSCRIPT_CHUNK_CHARS,
  classifierTranscriptBudget,
  MAX_CLASSIFIER_TRANSCRIPT_CHARS,
  serializeTranscriptForClassifier,
  toCompact,
} from 'src/permissions/yoloClassifier/transcript.js'
import { pad, padLeft, projectDirs, transcriptFiles } from './transcriptCorpus.js'

const KILLSWITCH = 'CLAUDIN_CLASSIFIER_STABLE_CUT'
const CHARS_PER_TOKEN = 4
const LOOKBACK_BLOCKS = 20
const TTL_MS = 60 * 60 * 1000
const GATE_MIN_DECISIONS = 30
const GATE_WRITE_DROP = 0.6
const GATE_IDENTICAL_BELOW_CHARS = 150_000
const GATE_SERIALIZE_MS = 50

// ---------------------------------------------------------------------------
// Cache model (pure; tested in classifier-cache-replay.test.ts)
// ---------------------------------------------------------------------------

export type CacheRequest = {
  /** Block texts in order; the breakpoint is after the last one. */
  readonly blocks: readonly string[]
  readonly atMs: number
}

export type CacheTotals = { writes: number; reads: number; calls: number; fullMisses: number }

/** djb2 over a block, chained: each prefix gets its own key. */
function prefixKeys(blocks: readonly string[]): number[] {
  const keys = [5381]
  let h = 5381
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) h = ((h * 33) ^ block.charCodeAt(i)) >>> 0
    h = ((h * 33) ^ 0x1f) >>> 0
    keys.push(h)
  }
  return keys
}

/** Replays requests in order and returns the token totals they cost. */
export function simulateCache(requests: readonly CacheRequest[]): CacheTotals {
  const live = new Map<number, number>()
  const totals: CacheTotals = { writes: 0, reads: 0, calls: 0, fullMisses: 0 }
  for (const req of requests) {
    const keys = prefixKeys(req.blocks)
    const lens = [0]
    for (const block of req.blocks) lens.push(lens[lens.length - 1]! + block.length)
    const bp = req.blocks.length
    let hit = 0
    for (let k = bp; k >= Math.max(1, bp - LOOKBACK_BLOCKS); k--) {
      const lastUse = live.get(keys[k]!)
      if (lastUse !== undefined && req.atMs - lastUse <= TTL_MS) {
        hit = k
        live.set(keys[k]!, req.atMs)
        break
      }
    }
    if (hit === 0 && totals.calls > 0) totals.fullMisses++
    totals.reads += lens[hit]! / CHARS_PER_TOKEN
    totals.writes += (lens[bp]! - lens[hit]!) / CHARS_PER_TOKEN
    totals.calls++
    live.set(keys[bp]!, req.atMs)
  }
  return totals
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type Args = { since: number; session: string | null }

function parseArgs(argv: string[]): Args {
  const a: Args = { since: Date.now() - 7 * 24 * 60 * 60 * 1000, session: null }
  for (const s of argv) {
    if (s.startsWith('--since=')) a.since = Date.parse(`${s.slice(8)}T00:00:00Z`)
    else if (s.startsWith('--session=')) a.session = s.slice(10)
  }
  if (Number.isNaN(a.since)) throw new Error('--since must be YYYY-MM-DD')
  return a
}

type Decision = { atMs: number; history: Message[]; action: Message }
type Thread = { id: string; decisions: Decision[]; toolNames: Set<string> }

type Rec = {
  type?: string
  timestamp?: string
  message?: { content?: unknown }
  permissionDecision?: { reason?: string }
}

/** One transcript's classifier decisions, each with the history before it. */
let tornLines = 0
function readThread(path: string, since: number, seen: Set<string>): Thread {
  const records: Rec[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try {
      records.push(JSON.parse(line) as Rec)
    } catch {
      // A torn last line from a session still being written; reported at the end.
      tornLines++
    }
  }
  const useAt = new Map<string, number>()
  const toolNames = new Set<string>()
  records.forEach((r, i) => {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) return
    for (const b of r.message.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (b.type === 'tool_use' && b.id) useAt.set(b.id, i)
      if (b.type === 'tool_use' && b.name) toolNames.add(b.name)
    }
  })
  const decisions: Decision[] = []
  const messages = records.filter(r => r.type === 'user' || r.type === 'assistant' || r.type === 'attachment')
  const indexOf = new Map(messages.map((r, i) => [r, i]))
  for (const r of records) {
    if (r.permissionDecision?.reason !== 'classifier' || !Array.isArray(r.message?.content)) continue
    const atMs = Date.parse(r.timestamp ?? '')
    if (!(atMs >= since)) continue
    for (const b of r.message.content as Array<{ type?: string; tool_use_id?: string }>) {
      if (b.type !== 'tool_result' || !b.tool_use_id || seen.has(b.tool_use_id)) continue
      const at = useAt.get(b.tool_use_id)
      if (at === undefined) continue
      seen.add(b.tool_use_id)
      const assistant = records[at]!
      const use = (assistant.message!.content as Array<{ id?: string }>).find(x => x.id === b.tool_use_id)
      decisions.push({
        atMs,
        history: messages.slice(0, indexOf.get(assistant) ?? 0) as unknown as Message[],
        action: { type: 'assistant', message: { role: 'assistant', content: [use] } } as unknown as Message,
      })
    }
  }
  const id = path.includes('/subagents/')
    ? `${basename(dirname(dirname(path))).slice(0, 8)}/${basename(path, '.jsonl').slice(6, 14)}`
    : basename(path, '.jsonl').slice(0, 8)
  return { id, decisions, toolNames }
}

function identityTools(names: Iterable<string>): Tools {
  return [...names].map(name => ({
    name,
    aliases: [],
    toAutoClassifierInput: (input: unknown) => input,
  })) as unknown as Tools
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

type ArmResult = {
  requests: CacheRequest[]
  keptChars: number[]
  historyChars: number[]
  maxSerializeMs: number
}

function replayArm(thread: Thread, tools: Tools, stable: boolean): ArmResult {
  if (stable) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = '0'
  const lookup = buildToolLookup(tools)
  const out: ArmResult = { requests: [], keptChars: [], historyChars: [], maxSerializeMs: 0 }
  for (const d of thread.decisions) {
    const action = toCompact(
      { role: 'assistant', content: (d.action.message.content as Array<{ name: string; input: unknown }>).map(u => ({ type: 'tool_use' as const, name: u.name, input: u.input })) },
      lookup,
    )
    if (action === '') continue
    const started = performance.now()
    const t = serializeTranscriptForClassifier(d.history, tools, classifierTranscriptBudget(action.length))
    out.maxSerializeMs = Math.max(out.maxSerializeMs, performance.now() - started)
    const blocks = t.userContentBlocks.map(b => b.text)
    out.requests.push({ blocks: [...blocks, action], atMs: d.atMs })
    out.keptChars.push(blocks.reduce((s, b) => s + b.length, 0))
    out.historyChars.push(
      serializeTranscriptForClassifier(d.history, tools, Number.MAX_SAFE_INTEGER).userContentBlocks.reduce(
        (s, b) => s + b.text.length,
        0,
      ),
    )
  }
  return out
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const saved = process.env[KILLSWITCH]
  const seen = new Set<string>()
  const files = transcriptFiles(projectDirs(null), (Date.now() - args.since) / 86_400_000 + 1)
    .filter(f => !basename(dirname(f.path)).startsWith('-tmp') && !f.path.includes('/-tmp'))
    .sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent))

  const rows: string[] = []
  let pastOld = 0
  let pastNew = 0
  let pastCalls = 0
  let pastThreads = 0
  let belowCalls = 0
  let belowDiffering = 0
  let minKeptPast = Infinity
  let maxEntryPast = 0
  let maxSerializeMs = 0
  const total = { old: { writes: 0, reads: 0, calls: 0 }, stable: { writes: 0, reads: 0, calls: 0 } }

  try {
  for (const f of files) {
    if (args.session && !f.path.includes(args.session)) continue
    const thread = readThread(f.path, args.since, seen)
    if (thread.decisions.length === 0) continue
    const tools = identityTools(thread.toolNames)
    const oldArm = replayArm(thread, tools, false)
    const newArm = replayArm(thread, tools, true)
    const o = simulateCache(oldArm.requests)
    const n = simulateCache(newArm.requests)
    for (const [k, v] of [['old', o], ['stable', n]] as const) {
      total[k].writes += v.writes
      total[k].reads += v.reads
      total[k].calls += v.calls
    }
    maxSerializeMs = Math.max(maxSerializeMs, newArm.maxSerializeMs)
    const maxHistory = Math.max(...newArm.historyChars)
    if (maxHistory > MAX_CLASSIFIER_TRANSCRIPT_CHARS) {
      newArm.historyChars.forEach((h, i) => {
        if (h <= MAX_CLASSIFIER_TRANSCRIPT_CHARS) return
        minKeptPast = Math.min(minKeptPast, newArm.keptChars[i]!)
      })
      // The largest entry as the classifier serializes it: a chunk closes on
      // the entry that crosses the chunk size, so a run of small entries stays
      // under two chunks, and a larger entry is a chunk of its own.
      for (const m of thread.decisions.at(-1)!.history) {
        const one = serializeTranscriptForClassifier([m], tools, Number.MAX_SAFE_INTEGER)
        maxEntryPast = Math.max(maxEntryPast, one.promptLengths.toolCalls + one.promptLengths.userPrompts)
      }
      if (newArm.requests.length >= GATE_MIN_DECISIONS) {
        pastOld += o.writes
        pastNew += n.writes
        pastCalls += o.calls
        pastThreads++
      }
    }
    if (maxHistory <= GATE_IDENTICAL_BELOW_CHARS) {
      oldArm.requests.forEach((r, i) => {
        belowCalls++
        if (r.blocks.join('\u0000') !== newArm.requests[i]!.blocks.join('\u0000')) belowDiffering++
      })
    }
    const perCall = (v: CacheTotals) => (v.calls ? v.writes / v.calls / 1000 : 0).toFixed(1)
    rows.push(
      `${pad(thread.id, 18)} ${padLeft(String(o.calls), 5)} ${padLeft(`${(maxHistory / 1000).toFixed(0)}k`, 7)}  ` +
        `old ${padLeft(perCall(o), 5)}k/call miss ${padLeft(String(o.fullMisses), 3)}   ` +
        `stable ${padLeft(perCall(n), 5)}k/call miss ${padLeft(String(n.fullMisses), 3)}`,
    )
  }
  } finally {
    if (saved === undefined) delete process.env[KILLSWITCH]
    else process.env[KILLSWITCH] = saved
  }

  console.log(`=== CLASSIFIER CACHE REPLAY since ${new Date(args.since).toISOString().slice(0, 10)} ===`)
  if (tornLines > 0) console.log(`(${tornLines} unparsable transcript lines skipped)`)
  console.log(`${pad('thread', 18)} ${padLeft('calls', 5)} ${padLeft('history', 7)}  writes per call (tokens) and full misses`)
  for (const r of rows) console.log(r)
  const usd = (t: { writes: number; reads: number }) => (t.writes * 8 + t.reads * 0.2) / 1e6
  console.log(
    `\ntotal  old: ${(total.old.writes / 1e6).toFixed(2)}M written, ${(total.old.reads / 1e6).toFixed(2)}M read, ≈$${usd(total.old).toFixed(2)}` +
      `   stable: ${(total.stable.writes / 1e6).toFixed(2)}M written, ${(total.stable.reads / 1e6).toFixed(2)}M read, ≈$${usd(total.stable).toFixed(2)}` +
      '   (Opus 5.5: 1h write $8, read $0.20 per Mtok)',
  )

  const drop = pastOld > 0 ? 1 - pastNew / pastOld : NaN
  const keptFloor = MAX_CLASSIFIER_TRANSCRIPT_CHARS - Math.max(2 * CLASSIFIER_TRANSCRIPT_CHUNK_CHARS, maxEntryPast)
  const gates: Array<[string, boolean, string]> = [
    [
      `writes per call −${GATE_WRITE_DROP * 100}% in threads past the budget (≥${GATE_MIN_DECISIONS} decisions)`,
      pastThreads > 0 && drop >= GATE_WRITE_DROP,
      `${pastThreads} threads, ${pastCalls} calls: ${(pastOld / Math.max(1, pastCalls) / 1000).toFixed(1)}k → ${(pastNew / Math.max(1, pastCalls) / 1000).toFixed(1)}k (−${(drop * 100).toFixed(0)}%)`,
    ],
    [
      `identical blocks in threads ≤${GATE_IDENTICAL_BELOW_CHARS / 1000}k`,
      belowDiffering === 0,
      `${belowDiffering} of ${belowCalls} calls differ`,
    ],
    [
      'past the budget, kept ≥ budget − max(two chunks, the largest entry)',
      minKeptPast === Infinity || minKeptPast >= keptFloor,
      minKeptPast === Infinity ? 'no call past the budget' : `min kept ${(minKeptPast / 1000).toFixed(1)}k, floor ${(keptFloor / 1000).toFixed(1)}k`,
    ],
    [`serialize under ${GATE_SERIALIZE_MS} ms`, maxSerializeMs < GATE_SERIALIZE_MS, `max ${maxSerializeMs.toFixed(1)} ms`],
  ]
  console.log('\ngate:')
  for (const [name, ok, detail] of gates) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  console.log(gates.every(g => g[1]) ? '\nGATE PASS' : '\nGATE FAIL')
}

if (import.meta.main) main()
