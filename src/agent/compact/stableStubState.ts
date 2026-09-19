/**
 * Stable-stub tool_result compression.
 *
 * Anthropic prompt cache uses prefix matching: any byte change mid-sequence
 * invalidates the cache from that position onward. The earlier tiered
 * compressor recomputed every turn — fine for stateless shims, fatal for
 * cached prefixes.
 *
 * Stable-stub strategy: maintain a per-(session, agent) monotonic Set<string>
 * of clipped tool_use_ids. Once an id is in the set, the corresponding
 * tool_result content is ALWAYS rewritten to the same deterministic stub
 * bytes. After the first turn that adds an id, every subsequent turn produces
 * identical bytes for that block → prefix cache stays warm. Cache breaks ONCE
 * per "clip event", then stabilizes.
 *
 * Per-(session, agent) keying ensures:
 *   - /resume / switchSession gets a fresh, empty set
 *   - /clear (regenerateSessionId) gets a fresh, empty set
 *   - Sub-agents in a swarm have isolated sets from the parent — a sub-agent
 *     post-autocompact reset cannot wipe the parent's mid-flight state.
 *
 * Works on every provider: Anthropic native, Bedrock, Vertex, OpenAI shims,
 * Codex shim.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import type { ReliefCandidate } from 'src/agent/compact/reliefPolicy.js'
import type {
  AnyContentBlock,
  AnyMessage,
  ToolUseBlock,
} from 'src/agent/compact/stableStubState/types.js'
import {
  estimateToolResultTokens,
  getInner,
  indexToolUses,
} from 'src/agent/compact/stableStubState/types.js'
import {
  currentKey,
  getClippedIds,
  perKeyClippedIds,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
import {
  agePinsForCurrent,
  pinShieldsBlock,
} from 'src/agent/compact/stableStubState/pinRegistry.js'
import {
  MIN_STUB_TOKENS,
  arrayContainsImage,
  arrayContainsMedia,
  headStubApplies,
  isClipStubContent,
  isMediaBlockType,
  shouldAgeStub,
  stubOneBlock,
} from 'src/agent/compact/stableStubState/clipStubText.js'

export type { AnyMessage } from 'src/agent/compact/stableStubState/types.js'
export {
  _getClippedIdsMapSizeForTesting,
  _getClippedIdsTotalCountForTesting,
  _resetAllClippedIdsForTesting,
  addClippedIds,
  bumpStandDownEpoch,
  getClippedIds,
  getStandDownEpoch,
  pruneOrphanClippedIds,
  pruneStaleClippedIds,
  resetClippedIds,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
export {
  MAX_PINNED_RESULT_TOKENS,
  MAX_SHIELDED_PASSES,
  _getPinnedToolResultsForTesting,
  _getSpentPinIdsForTesting,
  exceedsPinnedResultCeiling,
  isPinRegistered,
  isPinShielding,
  pinShieldsBlock,
  pinToolResult,
  retirePinAfterUse,
  unpinToolResult,
} from 'src/agent/compact/stableStubState/pinRegistry.js'
export {
  buildClipStub,
  buildClipStubWithHead,
  isClipStubContent,
  stubToolResultForDisplay,
} from 'src/agent/compact/stableStubState/clipStubText.js'

/**
 * Walk messages and rewrite every tool_result whose tool_use_id is in the
 * current (session, agent)'s clipped-ids set. Returns the input array
 * reference (identity-preserving fast path) in two no-op cases:
 *   1. The clipped set is empty.
 *   2. The clipped set is non-empty but no message contains a matching
 *      tool_result, OR every match is already a stub.
 * The QueryEngine.submitMessage substitution (roadmap 5.7) and other hot-path
 * callers rely on this so they can guard reassignment with a `=== input` check.
 *
 * Image-bearing trade-off: tool_results whose content is an array containing
 * an `image` block are SKIPPED — we leave them untouched on this turn so
 * vision context isn't silently dropped. (The id stays in the set; if a
 * subsequent turn replaces the content with text-only, it'll be stubbed
 * normally.)
 */
export function applyStableStubs<T extends AnyMessage>(messages: T[]): T[] {
  const clippedIds = perKeyClippedIds.get(currentKey())
  if (!clippedIds || clippedIds.size === 0) return messages

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES).
  // Taken here, before any block is examined, so every pinShieldsBlock call
  // in this pass gets the same answer.
  agePinsForCurrent()
  const toolNames = indexToolUses(messages)
  let anyTouched = false
  // Same head-preserving form as the age prune: the explicit
  // clip path MUST produce identical bytes for a given content, or a block
  // can render as a pure stub on the wire (this per-request path) and as a
  // head-stub in engine state (prune) on the next request — a wire byte
  // flip that breaks the prompt-cache prefix once per affected block.
  const stubKeepHeadChars = getCacheProfile().stubKeepHeadChars

  const out = messages.map(msg => {
    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (
        block?.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string' ||
        !clippedIds.has(block.tool_use_id)
      ) {
        return block
      }
      const stubbed = stubOneBlock(block, toolNames, stubKeepHeadChars)
      if (stubbed === block) return block
      touched = true
      return stubbed
    })

    if (!touched) return msg
    anyTouched = true

    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })

  // Identity-preserving fast path for QueryEngine (roadmap 5.7): when the
  // clipped set has ids but none of them appear in the current messages
  // (or every match is already a stub), return the input ref so callers'
  // identity guards don't reassign on every turn.
  return anyTouched ? out : messages
}

/**
 * Clip-frontier feature flag (CLAUDIN_CLIP_FRONTIER, default ON).
 *
 * The Anthropic renderer caps the message-level cache_control marker at the
 * clip frontier (see getClipFrontierIndex) instead of letting the defer-walk
 * place it anywhere near the tail. Validated by the Phase 4 A/B benches
 * (write −90%, cost −23..−51% vs the per-turn-break baseline; eviction
 * behavior measured equal to Claude Code's). Set CLAUDIN_CLIP_FRONTIER=0
 * to revert to the defer-only placement.
 */
function readClipFrontierEnabled(): boolean {
  const raw = process.env.CLAUDIN_CLIP_FRONTIER?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}
// Memoized at module load; tests that flip the env must call
// _resetClipFrontierForTesting() (matches the defer-cache-marker pattern).
let clipFrontierEnabled = readClipFrontierEnabled()
export function isClipFrontierEnabled(): boolean {
  return clipFrontierEnabled
}
export function _resetClipFrontierForTesting(): void {
  clipFrontierEnabled = readClipFrontierEnabled()
}

/**
 * Which cross-turn history rewriters are active, so the frontier can treat
 * their not-yet-rewritten targets as mutable. Callers pass the corresponding
 * config flags (thinkingHistoryRedactionEnabled / narrationHistoryRedactionEnabled).
 */
export type ClipFrontierMutability = {
  /** stripOldThinkingBlocks is active: assistant messages still carrying a
   * `thinking` block will be rewritten once they age out of its keep window. */
  thinkingIsMutable?: boolean
  /** stripOldNarrationBlocks is active: assistant turns mixing text with a
   * tool_use (and no thinking) will lose their text blocks when they age out. */
  narrationIsMutable?: boolean
  /** Whether the age prune (pruneOldToolResults with finite keepTurns) is
   * running. Under the 'retain' cache profile it is not — full tool_results
   * are then byte-stable (only the rare RSS guard touches them, which is a
   * deliberate break-once clip event) and may be frozen behind the marker.
   * Default true (aggressive profile). */
  agePruneActive?: boolean
  /** The request exceeds the API media cap, so stripExcessMediaItems is
   * dropping the OLDEST media items — which churns image-bearing
   * tool_results deep in the prefix as new media arrives. When set, such
   * blocks are mutable and the frontier must stop before the first one. */
  imagesAreMutable?: boolean
}

/**
 * Decide whether a tool_result block can still change bytes on a future turn.
 *
 * Mirrors the two rewriters that touch tool_results at the API boundary:
 *   - pruneOldToolResults (age prune): stubs non-error, non-image results
 *     at or above MIN_STUB_TOKENS once they cross the keepTurns cutoff.
 *   - applyStableStubs (explicit clip): rewrites any id in clippedIds as soon
 *     as content allows — including the deferred-image case where the stub is
 *     delayed until the image content is replaced.
 *
 * Must stay in sync with shouldAgeStub/stubOneBlock above; the regression
 * tests in stableStubState.test.ts pin the correspondence.
 *
 * ONE deliberate exception: the pin registry. A pinned block will not be
 * rewritten *right now*, but the pin can be dropped later (age, FIFO, orphan
 * prune, the model moving on) and the block clipped then. Reporting it
 * immutable would advertise a freeze we cannot honor — a cache-prefix break
 * instead of an ordinary clip event. So pins are NOT consulted here, on
 * purpose; the "clip frontier ignores pins" test guards the decision.
 *
 * Cost of that choice: under the AGGRESSIVE profile a pinned full result keeps
 * counting as mutable, so the frontier (and with it the cache_control marker)
 * stalls just before it while the pin lasts, and every later turn re-sends the
 * suffix uncached. That is why pins EXPIRE (MAX_SHIELDED_PASSES): the stall is
 * bounded to the passes the pin is actually needed for, instead of growing at
 * O(turns) until autocompact. Do NOT read the profile's readMult 1.0 as "this
 * profile has no cache to lose" — cacheProfile.ts says outright that writeMult
 * and readMult are rationale fields no arithmetic consumes. Breakpoints are
 * still emitted, so the stall costs real money. Under RETAIN the question does
 * not arise: a full tool_result is immutable there anyway (see the
 * agePruneActive branch below).
 */
function isToolResultBlockMutable(
  block: AnyContentBlock,
  clippedIds: ReadonlySet<string>,
  agePruneActive: boolean,
  imagesAreMutable: boolean,
): boolean {
  if (block?.type !== 'tool_result') return false
  const existing = (block as unknown as ToolResultBlockParam).content
  // Already a byte-stable stub (pure or head form) — final bytes forever.
  if (typeof existing === 'string' && isClipStubContent(existing)) return false
  // Empty content is never rewritten.
  if (existing == null || existing === '') return false
  if (Array.isArray(existing) && existing.length === 0) return false
  // Pending explicit clip (checked before the image/error skips: clippedIds
  // membership overrides both in applyStableStubs' stubOneBlock path).
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  if (toolUseId && clippedIds.has(toolUseId)) return true
  // Past the media cap, stripExcessMediaItems rewrites the oldest
  // media-bearing blocks (image OR document) turn by turn — not stable then.
  if (imagesAreMutable && arrayContainsMedia(existing)) return true
  // Retain profile: no age prune → a full tool_result is byte-stable. The
  // RSS guard may still stub it someday, but that's a deliberate
  // break-once clip event, not a per-turn mutation to fence off.
  if (!agePruneActive) return false
  // The age prune skips image-bearing and error results entirely…
  if (arrayContainsImage(existing)) return false
  if ((block as unknown as ToolResultBlockParam).is_error) return false
  // …and only stubs results at or above the floor.
  return estimateToolResultTokens(existing) >= MIN_STUB_TOKENS
}

function isAssistantContentMutable(
  content: AnyContentBlock[],
  opts: ClipFrontierMutability,
): boolean {
  if (!opts.thinkingIsMutable && !opts.narrationIsMutable) return false
  let hasText = false
  let hasToolUse = false
  let hasThinking = false
  let hasRedactedThinking = false
  for (const block of content) {
    if (block?.type === 'text') hasText = true
    else if (block?.type === 'tool_use') hasToolUse = true
    else if (block?.type === 'thinking') hasThinking = true
    else if (block?.type === 'redacted_thinking') hasRedactedThinking = true
  }
  if (opts.thinkingIsMutable && hasThinking) return true
  // Narration selection mirrors stripOldNarrationBlocks: text + tool_use and
  // no (redacted_)thinking — thinking-bearing turns are never text-stripped
  // (doing so breaks the signed-thinking position chain).
  if (
    opts.narrationIsMutable &&
    hasText &&
    hasToolUse &&
    !hasThinking &&
    !hasRedactedThinking
  ) {
    return true
  }
  return false
}

/**
 * Clip frontier: the largest index F such that messages[0..F] are all
 * byte-stable across future turns — no block in the prefix will ever be
 * rewritten by the age prune, the explicit clip set, or the history
 * redactions. Returns messages.length - 1 when nothing is mutable, and -1
 * when the very first message already contains a mutable block.
 *
 * Placing the message-level cache_control marker at (or before) the frontier
 * guarantees that clipping and prefix-freezing are the same atomic event:
 * bytes only ever change in the uncached tail, so the recurring per-turn
 * prefix invalidation (full→stub mutation behind the marker) cannot happen.
 *
 * Must be computed on the exact array handed to addCacheBreakpoints —
 * post ensureToolResultPairing, post applyStableStubs, post history
 * redactions — so the stability judgment matches the wire bytes.
 */
export function getClipFrontierIndex(
  messages: readonly AnyMessage[],
  opts: ClipFrontierMutability = {},
): number {
  const clippedIds = getClippedIds()
  const agePruneActive = opts.agePruneActive ?? true
  const imagesAreMutable = opts.imagesAreMutable ?? false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    const content = inner.content
    if (!Array.isArray(content)) continue
    if (role === 'assistant') {
      if (isAssistantContentMutable(content as AnyContentBlock[], opts)) {
        return i - 1
      }
      continue
    }
    if (role !== 'user') continue
    for (const block of content as AnyContentBlock[]) {
      // Top-level media blocks (pasted screenshots, PDF attachments) are
      // also stripped by stripExcessMediaItems past the cap.
      if (imagesAreMutable && isMediaBlockType(block?.type)) return i - 1
      if (
        isToolResultBlockMutable(
          block,
          clippedIds,
          agePruneActive,
          imagesAreMutable,
        )
      ) {
        return i - 1
      }
    }
  }
  return messages.length - 1
}

/**
 * Walk backwards to find the index of the (keepTurns)th-from-last user
 * message. "Turn boundary" = role: 'user'. Returns -1 when fewer turns
 * exist. Shared by the age prune and the relief candidate walk so both
 * protect the same window.
 */
function findTurnCutoffIndex(
  messages: readonly AnyMessage[],
  keepTurns: number,
): number {
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role === 'user') {
      turnsFound++
      if (turnsFound >= keepTurns) return i
    }
  }
  return -1
}

/**
 * Prune tool_result content that is older than `keepTurns` turns.
 *
 * Complements applyStableStubs: that mechanism only fires at ≥50% context
 * window (~400 turns for 200k-token models), so RSS grows unboundedly before
 * it triggers. This runs every turn, keeping only the last `keepTurns` turns'
 * tool results in full.
 *
 * "Turn boundary" = a `role: 'user'` message. Image-bearing blocks are skipped
 * to preserve vision context. Identity-preserving when nothing changes.
 */
export function pruneOldToolResults<T extends AnyMessage>(
  messages: T[],
  keepTurns = 1,
  stubKeepHeadChars = 0,
): T[] {
  if (messages.length === 0) return messages
  // Retain profile passes Infinity (age clipping disabled): skip the
  // guaranteed-no-op O(n) walk on the per-append hot path.
  if (!Number.isFinite(keepTurns)) return messages

  const cutoffIdx = findTurnCutoffIndex(messages, keepTurns)
  if (cutoffIdx === -1) return messages  // fewer turns than keepTurns
  if (cutoffIdx === 0) return messages   // nothing before the cutoff to prune

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES).
  // Taken before any block is examined so the shielding answer is constant
  // for this whole pass.
  agePinsForCurrent()
  const toolNames = indexToolUses(messages)
  let anyTouched = false

  const out = messages.map((msg, idx) => {
    if (idx >= cutoffIdx) return msg

    const inner = getInner(msg)
    const content = inner.content
    if (!Array.isArray(content)) return msg

    let touched = false
    const newContent = (content as AnyContentBlock[]).map(block => {
      if (!shouldAgeStub(block)) return block
      const stubbed = stubOneBlock(block, toolNames, stubKeepHeadChars)
      if (stubbed === block) return block
      touched = true
      return stubbed
    })

    if (!touched) return msg
    anyTouched = true

    if (msg.message) {
      return { ...msg, message: { ...msg.message, content: newContent } } as T
    }
    return { ...msg, content: newContent } as T
  })

  return anyTouched ? out : messages
}

/**
 * The clearable-candidate walk shared by the relief policy's two lanes
 * (`reliefPolicy.ts`). Returns every full, stubable tool_result older than
 * the protected `keepRecentTurns` window, OLDEST FIRST, with what stubbing
 * each one frees, plus their total — the "retained full result tokens" the
 * rss lane triggers on.
 *
 * Only CLEARABLE pressure is counted: tokens inside the protected window
 * cannot be reclaimed here, so counting them would let a couple of huge
 * recent results trip the rss lane and mass-clip the ENTIRE older prefix
 * without ever reaching its target — wiping the retained context the lane
 * exists to protect, for negligible relief.
 *
 * Skipped (and not counted): stubs, empty/error/image-bearing results,
 * blocks under `MIN_STUB_TOKENS`, pinned blocks (stubOneBlock would leave
 * them intact, so counting them corrupts the accounting), ids already in the
 * clipped set (pre-request the array still holds their full content — the
 * wire rewrites them; counting them would re-fire the lane on the very next
 * request), and tools the caller's `isClearableTool` rejects.
 *
 * `savings` mirrors stubOneBlock's branch exactly: head-stubs retain
 * ~stubKeepHeadChars worth of tokens, but only for string content long
 * enough to take the head form — array content and shorter strings get the
 * pure stub (full savings).
 */
export function collectClearableCandidates(
  messages: readonly AnyMessage[],
  keepRecentTurns: number,
  stubKeepHeadChars: number,
  isClearableTool: (toolName: string) => boolean = () => true,
): { candidates: ReliefCandidate[]; clearableTokens: number } {
  const none = { candidates: [], clearableTokens: 0 }
  if (messages.length === 0) return none
  const cutoffIdx = findTurnCutoffIndex(messages, keepRecentTurns)
  if (cutoffIdx <= 0) return none

  // One tick of the pin clock per real clip pass (see MAX_SHIELDED_PASSES),
  // taken before the candidate walk so pinShieldsBlock gives the same answer
  // here and to stubOneBlock when the clip is applied.
  //
  // This tick is what makes expiry work AT ALL under the retain profile: retain
  // sets keepTurns to Infinity, so pruneOldToolResults returns before its tick,
  // and applyStableStubs returns early while the clipped set is empty. Without
  // this line a pin placed under retain never aged — and retain is the one
  // profile where the rss lane the expiry protects actually runs, so up to
  // MAX_PINNED_TOOL_RESULTS × MAX_PINNED_RESULT_TOKENS would sit permanently
  // exempt from the RSS bound (and, because pinned blocks `continue` before
  // `clearableTokens += tokens` below, invisible to the trigger too).
  agePinsForCurrent()

  const clipped = getClippedIds()
  const toolNames = indexToolUses(messages)
  const headTokensEstimate =
    stubKeepHeadChars > 0 ? Math.ceil(stubKeepHeadChars / 4) : 0
  const candidates: ReliefCandidate[] = []
  let clearableTokens = 0
  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'user') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyContentBlock[]) {
      if (block?.type !== 'tool_result') continue
      const existing = (block as unknown as ToolResultBlockParam).content
      if (typeof existing === 'string' && isClipStubContent(existing)) continue
      if (existing == null || existing === '') continue
      if (Array.isArray(existing) && existing.length === 0) continue
      if (arrayContainsImage(existing)) continue
      if ((block as unknown as ToolResultBlockParam).is_error) continue
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id
      if (!toolUseId || clipped.has(toolUseId)) continue
      if (!isClearableTool(toolNames.get(toolUseId) ?? '')) continue
      if (pinShieldsBlock(toolUseId, existing)) continue
      const tokens = estimateToolResultTokens(existing)
      if (tokens < MIN_STUB_TOKENS) continue
      const savings = headStubApplies(existing, stubKeepHeadChars)
        ? Math.max(0, tokens - headTokensEstimate)
        : tokens
      clearableTokens += tokens
      candidates.push({ toolUseId, savings })
    }
  }
  return { candidates, clearableTokens }
}

/**
 * Remove contentReplacementState entries for tool_use_ids that no longer
 * exist in the current messages array. After /compact, a rewind or a resume
 * drop messages from the display array, the corresponding seenIds and
 * replacements entries become orphans — they hold references to preview
 * strings (up to ~2KB each) that will never be looked up again. This
 * function prunes them in-place, preserving the object reference held by
 * REPL's contentReplacementStateRef.
 */
export function pruneContentReplacementState(
  messages: AnyMessage[],
  state: { seenIds: Set<string>; replacements: Map<string, unknown> },
): void {
  // Collect all tool_use_ids still present in the messages
  const liveIds = new Set<string>()
  for (const msg of messages) {
    const inner = getInner(msg)
    const role = inner.role ?? msg.role

    // Collect from assistant tool_use blocks
    if (role === 'assistant') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as ToolUseBlock[]) {
          if (block?.type === 'tool_use' && block.id) {
            liveIds.add(block.id)
          }
        }
      }
    }

    // Collect from user tool_result blocks
    if (role === 'user') {
      const content = inner.content
      if (Array.isArray(content)) {
        for (const block of content as AnyContentBlock[]) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            liveIds.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Remove entries for IDs no longer in the message array
  for (const id of state.seenIds) {
    if (!liveIds.has(id)) state.seenIds.delete(id)
  }
  for (const id of state.replacements.keys()) {
    if (!liveIds.has(id)) state.replacements.delete(id)
  }
}
