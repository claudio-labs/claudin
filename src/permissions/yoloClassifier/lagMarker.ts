/**
 * A second cache breakpoint for the classifier's transcript, where the previous
 * call's prompt ended — on by default since 2026-11-12, after a live A/B
 * (`scripts/bench/ab/classifier-cache-ab.ts`). Killswitch:
 * `CLAUDIN_CLASSIFIER_LAG_MARKER=0`.
 *
 * The classifier caches its prompt up to the action it judges, and each
 * transcript entry is a block of its own. The API resolves a breakpoint by
 * checking at most 20 blocks behind it; past that it resumes at the next
 * explicit breakpoint, which here is the CLAUDE.md message, and the whole
 * transcript is written again. Tools the mode accepts on its own (Read, Grep,
 * Glob) add entries without a classifier call, so a turn of twenty-odd reads
 * between two judged calls is enough: in the 2026-11-04..11 census that was
 * 13% of what the classifier wrote under the 200k budget, and 53% once the
 * transcript is allowed to stay whole (`CLAUDIN_CLASSIFIER_WINDOW_BUDGET`),
 * which is why the two ship together.
 *
 * The previous call's last block is still in this call's transcript, byte for
 * byte, unless the stable cut moved or the entry was serialized differently.
 * So each call remembers the key of the prefix its own breakpoint closed, and
 * the next one marks the block that ends the longest prefix it remembers. A
 * breakpoint on bytes already cached costs nothing, and one that finds nothing
 * only writes what the action's breakpoint was writing anyway. Budget: system
 * (1) + CLAUDE.md (0–1) + this (0–1) + action (1), the API's four.
 *
 * Prefixes are told apart by content, never by thread: the main thread and
 * every sub-agent share the one map, and a prefix one of them wrote cannot be
 * a prefix of another's unless the bytes are the same — which is a hit.
 *
 * A key is a fingerprint, not a proof: a block longer than two edges counts by
 * its length and its two ends (`KEY_EDGE_CHARS`). Walking every char of a
 * transcript near the 800k cap took 8.6 ms a call under Bun and 2 ms under
 * node; this way it is about a quarter of that. A wrong match is harmless for
 * the same reason a miss is: the marked block is then not a cached prefix, and
 * the request writes what it would have written without the marker.
 */
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

/** The classifier's cache TTL: a breakpoint older than this is not worth marking. */
export const LAG_MARKER_TTL_MS = 60 * 60 * 1000
/** Main thread plus a few sub-agents, each with its last breakpoint or two. */
const MAX_REMEMBERED_PREFIXES = 64

const DJB2_SEED = 5381
/** How much of each end of a long block goes into its key. */
export const KEY_EDGE_CHARS = 64

export function isLagMarkerEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_CLASSIFIER_LAG_MARKER)
}

/** Prefix key → when a breakpoint last closed that prefix (ms). */
export type RememberedPrefixes = Map<string, number>

/**
 * `keys[k]` names the prefix made of the first `k + 1` blocks: its block
 * count, its chars and a chained djb2 of each block's length and text (both
 * ends of it, for a block longer than two edges), so two prefixes share a key
 * only when all three agree.
 */
export function prefixKeys(blocks: readonly string[]): string[] {
  const keys: string[] = []
  let hash = DJB2_SEED
  let chars = 0
  for (const block of blocks) {
    const length = block.length
    const headEnd = length <= 2 * KEY_EDGE_CHARS ? length : KEY_EDGE_CHARS
    for (let i = 0; i < headEnd; i++) hash = ((hash * 33) ^ block.charCodeAt(i)) >>> 0
    for (let i = Math.max(headEnd, length - KEY_EDGE_CHARS); i < length; i++) {
      hash = ((hash * 33) ^ block.charCodeAt(i)) >>> 0
    }
    // The length closes the block: where one ends is part of the key.
    hash = ((hash * 33) ^ length) >>> 0
    chars += length
    keys.push(`${keys.length + 1}:${chars}:${hash}`)
  }
  return keys
}

/**
 * The index of the block to mark: the end of the longest prefix a call left a
 * breakpoint on within the TTL. Null when none is remembered.
 */
export function pickLagMarker(
  keys: readonly string[],
  remembered: RememberedPrefixes,
  nowMs: number,
): number | null {
  for (let i = keys.length - 1; i >= 0; i--) {
    const at = remembered.get(keys[i]!)
    if (at !== undefined && nowMs - at <= LAG_MARKER_TTL_MS) return i
  }
  return null
}

/** Remember that a breakpoint closes `key` now; the stale and the excess go. */
export function rememberBreakpoint(
  remembered: RememberedPrefixes,
  key: string,
  nowMs: number,
): void {
  // Re-inserted so the map's order is recency: the excess dropped is the oldest.
  remembered.delete(key)
  remembered.set(key, nowMs)
  for (const [k, at] of remembered) {
    if (nowMs - at > LAG_MARKER_TTL_MS || remembered.size > MAX_REMEMBERED_PREFIXES) {
      remembered.delete(k)
    } else {
      break
    }
  }
}

const rememberedPrefixes: RememberedPrefixes = new Map()

/**
 * For one classifier call: which transcript block gets the lag breakpoint
 * (null for none), remembering where this call's own breakpoints are.
 * `transcript` is the blocks before the action, `action` the block that
 * carries the call's breakpoint.
 */
export function placeLagMarker(
  transcript: readonly string[],
  action: string,
  nowMs: number,
  remembered: RememberedPrefixes = rememberedPrefixes,
): number | null {
  const keys = prefixKeys([...transcript, action])
  const transcriptKeys = keys.slice(0, transcript.length)
  const at = pickLagMarker(transcriptKeys, remembered, nowMs)
  // A read refreshes the entry it hits, so the marked prefix stays worth marking.
  if (at !== null) rememberBreakpoint(remembered, transcriptKeys[at]!, nowMs)
  rememberBreakpoint(remembered, keys[keys.length - 1]!, nowMs)
  return at
}

export function _resetLagMarkerForTesting(): void {
  rememberedPrefixes.clear()
}
