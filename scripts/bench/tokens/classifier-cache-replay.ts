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
 * Since 2026-11-11 it also replays the two levers of that week's census, as
 * the `window+lag` arm against `stable` (the default until 2026-11-12):
 *   - the budget sized by the model's window (`CLAUDIN_CLASSIFIER_WINDOW_BUDGET`,
 *     `--window-tokens=` picks the window, 1M by default), so the cut stops
 *     moving;
 *   - the lag marker (`CLAUDIN_CLASSIFIER_LAG_MARKER`, lagMarker.ts), placed
 *     by the production function and modelled as a second breakpoint.
 * Every full miss is filed under why the prefix was not found: `lookback`
 * (a live entry sits more than 20 blocks back), `front` (the transcript's
 * start changed: a chunk move) or `idle` (the entry expired).
 *
 * Gate for the levers (pre-registered 2026-11-11, printed after the first):
 *   1. threads past the base budget with ≥30 decisions: `window+lag` writes
 *      at most 0.6 × `stable`;
 *   2. sized for a 200k-token window, the window budget sends the blocks
 *      `stable` sends on every call of every thread;
 *   3. writes and reads together, at Opus 5.5 prices, `window+lag` costs at
 *      most 0.8 × `stable`;
 *   4. a synthetic thread that outgrows the 800k cap writes no more per call
 *      than `stable` does on it;
 *   5. serializing and marking the largest decision takes under 10 ms: the
 *      decision with the longest kept transcript, run nine times, the median.
 *      Until 2026-11-11 this was the slowest single call of the whole replay,
 *      which a GC pause decides: 4.9 to 13.5 ms over four runs of one build.
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
import { placeLagMarker, type RememberedPrefixes } from 'src/permissions/yoloClassifier/lagMarker.js'
import {
  buildToolLookup,
  CLASSIFIER_TRANSCRIPT_CHUNK_CHARS,
  classifierTranscriptBudget,
  MAX_CLASSIFIER_TRANSCRIPT_CHARS,
  MAX_WINDOW_TRANSCRIPT_CHARS,
  serializeTranscriptForClassifier,
  toCompact,
} from 'src/permissions/yoloClassifier/transcript.js'
import { pad, padLeft, projectDirs, transcriptFiles } from './transcriptCorpus.js'

const KILLSWITCH = 'CLAUDIN_CLASSIFIER_STABLE_CUT'
const WINDOW_BUDGET = 'CLAUDIN_CLASSIFIER_WINDOW_BUDGET'
const CHARS_PER_TOKEN = 4
const LOOKBACK_BLOCKS = 20
const TTL_MS = 60 * 60 * 1000
const GATE_MIN_DECISIONS = 30
const GATE_WRITE_DROP = 0.6
const GATE_IDENTICAL_BELOW_CHARS = 150_000
const GATE_SERIALIZE_MS = 50
const LEVER_GATE_WRITES = 0.6
const LEVER_GATE_COST = 0.8
const LEVER_GATE_MARK_MS = 10
const BASE_WINDOW_TOKENS = 200_000
const DEFAULT_WINDOW_TOKENS = 1_000_000
/** $ per Mtok: 1h cache write and cache read. */
const OPUS_5_5 = { write: 8, read: 0.2 }
const FABLE_5_2 = { write: 16, read: 0.2 }

// ---------------------------------------------------------------------------
// Cache model (pure; tested in classifier-cache-replay.test.ts)
// ---------------------------------------------------------------------------

export type CacheRequest = {
  /** Block texts in order; the breakpoint is after the last one. */
  readonly blocks: readonly string[]
  readonly atMs: number
  /** How many leading blocks a second breakpoint closes (the lag marker), if any. */
  readonly lagBlocks?: number
}

/** Why a request found nothing of its prefix in the cache. */
export type MissCause = 'lookback' | 'front' | 'idle'

export type CacheTotals = {
  writes: number
  reads: number
  calls: number
  fullMisses: number
  /** Full misses by cause, and the tokens each cause wrote. */
  misses: Record<MissCause, number>
  written: Record<MissCause, number>
}

export function emptyTotals(): CacheTotals {
  return {
    writes: 0,
    reads: 0,
    calls: 0,
    fullMisses: 0,
    misses: { lookback: 0, front: 0, idle: 0 },
    written: { lookback: 0, front: 0, idle: 0 },
  }
}

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
  const totals = emptyTotals()
  for (const req of requests) {
    const keys = prefixKeys(req.blocks)
    const lens = [0]
    for (const block of req.blocks) lens.push(lens[lens.length - 1]! + block.length)
    const bp = req.blocks.length
    const alive = (k: number): boolean => {
      const lastUse = live.get(keys[k]!)
      return lastUse !== undefined && req.atMs - lastUse <= TTL_MS
    }
    // Each breakpoint looks back 20 blocks from where it sits; the request
    // reads the longest prefix either of them finds.
    const lookBackFrom = (from: number): number => {
      for (let k = from; k >= Math.max(1, from - LOOKBACK_BLOCKS); k--) if (alive(k)) return k
      return 0
    }
    const lag = req.lagBlocks !== undefined && req.lagBlocks >= 1 && req.lagBlocks < bp ? req.lagBlocks : 0
    const hit = Math.max(lookBackFrom(bp), lag > 0 ? lookBackFrom(lag) : 0)
    const written = (lens[bp]! - lens[hit]!) / CHARS_PER_TOKEN
    if (hit === 0 && totals.calls > 0) {
      totals.fullMisses++
      // A live entry further back than the lookback; else one that was written
      // and has expired; else the prefix was never written: its front changed.
      let cause: MissCause = 'front'
      for (let k = bp; k >= 1; k--) {
        if (alive(k)) {
          cause = 'lookback'
          break
        }
        if (cause === 'front' && live.has(keys[k]!)) cause = 'idle'
      }
      totals.misses[cause]++
      totals.written[cause] += written
    }
    totals.reads += lens[hit]! / CHARS_PER_TOKEN
    totals.writes += written
    totals.calls++
    if (hit > 0) live.set(keys[hit]!, req.atMs)
    if (lag > 0) live.set(keys[lag]!, req.atMs)
    live.set(keys[bp]!, req.atMs)
  }
  return totals
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

type Args = { since: number; session: string | null; windowTokens: number }

function parseArgs(argv: string[]): Args {
  const a: Args = { since: Date.now() - 7 * 24 * 60 * 60 * 1000, session: null, windowTokens: DEFAULT_WINDOW_TOKENS }
  for (const s of argv) {
    if (s.startsWith('--since=')) a.since = Date.parse(`${s.slice(8)}T00:00:00Z`)
    else if (s.startsWith('--session=')) a.session = s.slice(10)
    else if (s.startsWith('--window-tokens=')) a.windowTokens = Number(s.slice(16))
  }
  if (Number.isNaN(a.since)) throw new Error('--since must be YYYY-MM-DD')
  if (!(a.windowTokens > 0)) throw new Error('--window-tokens must be a positive number')
  return a
}

export type Decision = { atMs: number; history: Message[]; action: Message }
export type Thread = { id: string; decisions: Decision[]; toolNames: Set<string> }

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
  /** The decision that kept the longest transcript, and a way to build its request again. */
  largest: { keptChars: number; rerun: () => void } | null
}

/** One way of building the classifier's request: which cut, which budget, the lag marker or not. */
export type Arm = {
  stableCut: boolean
  /** The window the budget is sized for; absent for the fixed base budget. */
  windowTokens?: number
  lag: boolean
}

function useArm(arm: Arm): void {
  if (arm.stableCut) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = '0'
  process.env[WINDOW_BUDGET] = arm.windowTokens === undefined ? '0' : '1'
}

/** The median wall time of `runs` calls of `fn`, in ms: one call's time is at the mercy of a GC pause. */
export function medianMs(fn: () => void, runs = 9, now: () => number = () => performance.now()): number {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = now()
    fn()
    samples.push(now() - started)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0
}

export function replayArm(thread: Thread, tools: Tools, arm: Arm, withHistory = false): ArmResult {
  useArm(arm)
  const lookup = buildToolLookup(tools)
  const remembered: RememberedPrefixes = new Map()
  const out: ArmResult = { requests: [], keptChars: [], historyChars: [], maxSerializeMs: 0, largest: null }
  for (const d of thread.decisions) {
    const action = toCompact(
      { role: 'assistant', content: (d.action.message.content as Array<{ name: string; input: unknown }>).map(u => ({ type: 'tool_use' as const, name: u.name, input: u.input })) },
      lookup,
    )
    if (action === '') continue
    const started = performance.now()
    const t = serializeTranscriptForClassifier(d.history, tools, classifierTranscriptBudget(action.length, arm.windowTokens))
    const blocks = t.userContentBlocks.map(b => b.text)
    const lagAt = arm.lag ? placeLagMarker(blocks, action, d.atMs, remembered) : null
    out.maxSerializeMs = Math.max(out.maxSerializeMs, performance.now() - started)
    out.requests.push({
      blocks: [...blocks, action],
      atMs: d.atMs,
      ...(lagAt !== null && { lagBlocks: lagAt + 1 }),
    })
    const kept = blocks.reduce((s, b) => s + b.length, 0)
    out.keptChars.push(kept)
    if (kept > (out.largest?.keptChars ?? -1)) {
      out.largest = {
        keptChars: kept,
        rerun: () => {
          useArm(arm)
          const again = serializeTranscriptForClassifier(d.history, tools, classifierTranscriptBudget(action.length, arm.windowTokens))
          if (arm.lag) placeLagMarker(again.userContentBlocks.map(b => b.text), action, d.atMs, new Map())
        },
      }
    }
    if (withHistory) {
      out.historyChars.push(
        serializeTranscriptForClassifier(d.history, tools, Number.MAX_SAFE_INTEGER).userContentBlocks.reduce(
          (s, b) => s + b.text.length,
          0,
        ),
      )
    }
  }
  return out
}

/**
 * A thread that outgrows any budget: one 10k-char call judged per step, each
 * with every earlier one as its history. What a move costs past the cap.
 */
export function syntheticThread(decisions: number, entryChars: number): Thread {
  const use = (i: number) => ({ type: 'tool_use', id: `syn-${i}`, name: 'Bash', input: { command: `e${i}:`.padEnd(entryChars, 'x') } })
  const message = (i: number) => ({ type: 'assistant', message: { role: 'assistant', content: [use(i)] } }) as unknown as Message
  const all = Array.from({ length: decisions }, (_, i) => message(i))
  return {
    id: 'synthetic',
    toolNames: new Set(['Bash']),
    decisions: all.map((action, i) => ({ atMs: i * 1000, history: all.slice(0, i), action })),
  }
}

const sameBlocks = (a: CacheRequest, b: CacheRequest): boolean => a.blocks.join('\u0000') === b.blocks.join('\u0000')

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const saved = { [KILLSWITCH]: process.env[KILLSWITCH], [WINDOW_BUDGET]: process.env[WINDOW_BUDGET] }
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
  const ARMS: Record<string, Arm> = {
    old: { stableCut: false, lag: false },
    stable: { stableCut: true, lag: false },
    'stable+lag': { stableCut: true, lag: true },
    window: { stableCut: true, windowTokens: args.windowTokens, lag: false },
    'window+lag': { stableCut: true, windowTokens: args.windowTokens, lag: true },
  }
  const total: Record<string, CacheTotals> = Object.fromEntries(Object.keys(ARMS).map(name => [name, emptyTotals()]))
  const leverPast = { stable: 0, candidate: 0, calls: 0, threads: 0 }
  let baseWindowCalls = 0
  let baseWindowDiffering = 0
  let maxMarkMs = 0
  let largest: ArmResult['largest'] = null
  let synthetic = { stable: 0, candidate: 0 }

  try {
  for (const f of files) {
    if (args.session && !f.path.includes(args.session)) continue
    const thread = readThread(f.path, args.since, seen)
    if (thread.decisions.length === 0) continue
    const tools = identityTools(thread.toolNames)
    const oldArm = replayArm(thread, tools, ARMS.old!)
    const newArm = replayArm(thread, tools, ARMS.stable!, true)
    const candidateArm = replayArm(thread, tools, ARMS['window+lag']!)
    const o = simulateCache(oldArm.requests)
    const n = simulateCache(newArm.requests)
    const c = simulateCache(candidateArm.requests)
    const sims: Record<string, CacheTotals> = {
      old: o,
      stable: n,
      'stable+lag': simulateCache(replayArm(thread, tools, ARMS['stable+lag']!).requests),
      window: simulateCache(replayArm(thread, tools, ARMS.window!).requests),
      'window+lag': c,
    }
    for (const [name, v] of Object.entries(sims)) {
      const t = total[name]!
      for (const k of ['writes', 'reads', 'calls', 'fullMisses'] as const) t[k] += v[k]
      for (const cause of ['lookback', 'front', 'idle'] as const) {
        t.misses[cause] += v.misses[cause]
        t.written[cause] += v.written[cause]
      }
    }
    maxSerializeMs = Math.max(maxSerializeMs, newArm.maxSerializeMs)
    maxMarkMs = Math.max(maxMarkMs, candidateArm.maxSerializeMs)
    if (candidateArm.largest && candidateArm.largest.keptChars > (largest?.keptChars ?? -1)) largest = candidateArm.largest
    // Sized for a 200k-token window the budget is the base one: same bytes.
    replayArm(thread, tools, { stableCut: true, windowTokens: BASE_WINDOW_TOKENS, lag: false }).requests.forEach((r, i) => {
      baseWindowCalls++
      if (!sameBlocks(r, newArm.requests[i]!)) baseWindowDiffering++
    })
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
        leverPast.stable += n.writes
        leverPast.candidate += c.writes
        leverPast.calls += n.calls
        leverPast.threads++
      }
    }
    if (maxHistory <= GATE_IDENTICAL_BELOW_CHARS) {
      oldArm.requests.forEach((r, i) => {
        belowCalls++
        if (!sameBlocks(r, newArm.requests[i]!)) belowDiffering++
      })
    }
    const perCall = (v: CacheTotals) => (v.calls ? v.writes / v.calls / 1000 : 0).toFixed(1)
    rows.push(
      `${pad(thread.id, 18)} ${padLeft(String(o.calls), 5)} ${padLeft(`${(maxHistory / 1000).toFixed(0)}k`, 7)}  ` +
        `old ${padLeft(perCall(o), 5)}k/call miss ${padLeft(String(o.fullMisses), 3)}   ` +
        `stable ${padLeft(perCall(n), 5)}k/call miss ${padLeft(String(n.fullMisses), 3)}   ` +
        `window+lag ${padLeft(perCall(c), 5)}k/call miss ${padLeft(String(c.fullMisses), 3)}`,
    )
  }
  // Past the cap: 160 judged calls of 10k chars, 1.6M in all.
  const longThread = syntheticThread(160, 10_000)
  const longTools = identityTools(longThread.toolNames)
  const pastCap = (arm: Arm): number => {
    const requests = replayArm(longThread, longTools, arm).requests
    const from = requests.findIndex(r => r.blocks.reduce((s, b) => s + b.length, 0) > MAX_WINDOW_TRANSCRIPT_CHARS - 20_000)
    const tail = simulateCache(requests)
    const head = simulateCache(requests.slice(0, Math.max(0, from)))
    return (tail.writes - head.writes) / Math.max(1, requests.length - Math.max(0, from))
  }
  synthetic = { stable: pastCap(ARMS.stable!), candidate: pastCap(ARMS['window+lag']!) }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  console.log(`=== CLASSIFIER CACHE REPLAY since ${new Date(args.since).toISOString().slice(0, 10)} ===`)
  if (tornLines > 0) console.log(`(${tornLines} unparsable transcript lines skipped)`)
  console.log(`${pad('thread', 18)} ${padLeft('calls', 5)} ${padLeft('history', 7)}  writes per call (tokens) and full misses`)
  for (const r of rows) console.log(r)
  const usd = (t: { writes: number; reads: number }, price: { write: number; read: number }) =>
    (t.writes * price.write + t.reads * price.read) / 1e6
  const m = (tokens: number) => `${(tokens / 1e6).toFixed(2)}M`
  console.log(`\n${pad('arm', 11)} ${padLeft('written', 8)} ${padLeft('read', 8)} ${padLeft('Opus 5.5', 9)} ${padLeft('Fable 5.2', 10)}   written by full misses: lookback / front moved / idle>1h`)
  for (const [name, t] of Object.entries(total)) {
    const cause = (c: MissCause) => `${m(t.written[c])} in ${t.misses[c]}`
    console.log(
      `${pad(name, 11)} ${padLeft(m(t.writes), 8)} ${padLeft(m(t.reads), 8)} ${padLeft(`$${usd(t, OPUS_5_5).toFixed(2)}`, 9)} ${padLeft(`$${usd(t, FABLE_5_2).toFixed(2)}`, 10)}   ${cause('lookback')} / ${cause('front')} / ${cause('idle')}`,
    )
  }
  console.log(`(window = budget sized for ${(args.windowTokens / 1000).toFixed(0)}k tokens; $ per Mtok: Opus 5.5 write $8 read $0.20, Fable 5.2 write $16 read $0.20)`)

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

  const stable = total.stable!
  const candidate = total['window+lag']!
  const writeRatio = leverPast.stable > 0 ? leverPast.candidate / leverPast.stable : NaN
  const costRatio = usd(candidate, OPUS_5_5) / usd(stable, OPUS_5_5)
  const largestMs = largest ? medianMs(largest.rerun) : 0
  const leverGates: Array<[string, boolean, string]> = [
    [
      `window+lag writes ≤ ${LEVER_GATE_WRITES} × stable in threads past the base budget (≥${GATE_MIN_DECISIONS} decisions)`,
      leverPast.threads > 0 && writeRatio <= LEVER_GATE_WRITES,
      `${leverPast.threads} threads, ${leverPast.calls} calls: ${(leverPast.stable / Math.max(1, leverPast.calls) / 1000).toFixed(1)}k → ${(leverPast.candidate / Math.max(1, leverPast.calls) / 1000).toFixed(1)}k per call (× ${writeRatio.toFixed(2)})`,
    ],
    [
      `sized for a ${BASE_WINDOW_TOKENS / 1000}k-token window, the blocks are stable's`,
      baseWindowDiffering === 0,
      `${baseWindowDiffering} of ${baseWindowCalls} calls differ`,
    ],
    [
      `window+lag costs ≤ ${LEVER_GATE_COST} × stable at Opus 5.5 prices`,
      costRatio <= LEVER_GATE_COST,
      `$${usd(stable, OPUS_5_5).toFixed(2)} → $${usd(candidate, OPUS_5_5).toFixed(2)} (× ${costRatio.toFixed(2)}); Fable 5.2 $${usd(stable, FABLE_5_2).toFixed(2)} → $${usd(candidate, FABLE_5_2).toFixed(2)} (× ${(usd(candidate, FABLE_5_2) / usd(stable, FABLE_5_2)).toFixed(2)})`,
    ],
    [
      'past the 800k cap, no more written per call than stable',
      synthetic.candidate <= synthetic.stable,
      `synthetic 1.6M thread: ${(synthetic.stable / 1000).toFixed(1)}k → ${(synthetic.candidate / 1000).toFixed(1)}k per call`,
    ],
    [
      `serialize and mark the largest decision under ${LEVER_GATE_MARK_MS} ms`,
      largestMs < LEVER_GATE_MARK_MS,
      `${((largest?.keptChars ?? 0) / 1000).toFixed(0)}k chars kept: median ${largestMs.toFixed(1)} ms of 9 (slowest single call of the replay ${maxMarkMs.toFixed(1)} ms)`,
    ],
  ]
  console.log('\nlever gate (window+lag against stable):')
  for (const [name, ok, detail] of leverGates) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  console.log(leverGates.every(g => g[1]) ? '\nLEVER GATE PASS' : '\nLEVER GATE FAIL')
}

if (import.meta.main) main()
