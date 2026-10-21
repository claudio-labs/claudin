import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
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
  getClippedIds,
  getClippedInputFields,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import {
  agePinsForCurrent,
  pinShieldsBlock,
} from 'src/agent/compact/stableStubState/pinRegistry.js'
import {
  MIN_STUB_TOKENS,
  headStubApplies,
  isInputClipStubContent,
  isStubbableResult,
  shouldAgeStub,
  stubOneBlock,
} from 'src/agent/compact/stableStubState/clipStubText.js'

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
}

/** Which rewriter the clip frontier stopped for. */
export type ClipFrontierReason =
  | 'pending clip'
  | 'age prune'
  | 'thinking redaction'
  | 'narration redaction'

export type ClipFrontier = {
  index: number
  /** Null when the whole array is stable (index is its last message). */
  reason: ClipFrontierReason | null
}

/**
 * Decide whether a tool_result block can still change bytes on a future turn.
 *
 * Mirrors the two rewriters that touch tool_results at the API boundary:
 *   - pruneOldToolResults (age prune): stubs non-error, non-image results
 *     at or above MIN_STUB_TOKENS once they cross the keepTurns cutoff.
 *   - applyStableStubs (explicit clip): rewrites any id in clippedIds whose
 *     content stubOneBlock can rewrite at all (isStubbableResult).
 *
 * Both go through stubOneBlock, so both share its refusal: a stub, empty
 * content or an image is never rewritten, by anything. An image-bearing
 * result in the clipped set used to count as a stub still to come — the
 * "deferred image" this comment promised would be stubbed once its image was
 * replaced. Nothing replaces it (the media cap strips before the stubs run,
 * and its result is stubbed in that same request), so the marker waited in
 * front of it for the rest of the session (72c401aa, 2026-10-14: 2h, 38 calls,
 * read frozen at 314,693, everything after it uncached).
 *
 * Must stay in sync with shouldAgeStub/stubOneBlock; the regression tests in
 * stableStubState.test.ts pin the correspondence.
 *
 * The API's 100-media cap is deliberately NOT a reason to call a block
 * mutable. Past it, stripExcessMediaItems drops the oldest image as each new
 * one arrives: one message changes per new image, an announced rewrite
 * (`media cap` on the `[Cache:]` line). Calling every media block mutable
 * instead held the marker before the oldest image for the rest of the
 * session, and the tail went out uncached on every request (81744358,
 * 2026-10-13: 230 calls at ~470k uncached each).
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
): ClipFrontierReason | null {
  if (block?.type !== 'tool_result') return null
  const existing = (block as unknown as ToolResultBlockParam).content
  // A stub already (final bytes forever), empty, or an image: no rewriter
  // will touch it.
  if (!isStubbableResult(existing)) return null
  // Pending explicit clip (checked before the error skip: clippedIds
  // membership overrides it in applyStableStubs' stubOneBlock path).
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  if (toolUseId && clippedIds.has(toolUseId)) return 'pending clip'
  // Retain profile: no age prune → a full tool_result is byte-stable. The
  // RSS guard may still stub it someday, but that's a deliberate
  // break-once clip event, not a per-turn mutation to fence off.
  if (!agePruneActive) return null
  // The age prune skips error results entirely…
  if ((block as unknown as ToolResultBlockParam).is_error) return null
  // …and only stubs results at or above the floor.
  return estimateToolResultTokens(existing) >= MIN_STUB_TOKENS ? 'age prune' : null
}

function isAssistantContentMutable(
  content: AnyContentBlock[],
  opts: ClipFrontierMutability,
): ClipFrontierReason | null {
  if (!opts.thinkingIsMutable && !opts.narrationIsMutable) return null
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
  if (opts.thinkingIsMutable && hasThinking) return 'thinking redaction'
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
    return 'narration redaction'
  }
  return null
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
  return findClipFrontier(messages, opts).index
}

/**
 * `getClipFrontierIndex` with the rewriter it stopped for. Everything after
 * the frontier is billed as uncached input on every request while it stays
 * there, so the reason is what the `[Cache:]` line names when that tail grows
 * large (`uncached tail …`).
 */
export function findClipFrontier(
  messages: readonly AnyMessage[],
  opts: ClipFrontierMutability = {},
): ClipFrontier {
  const clippedIds = getClippedIds()
  const agePruneActive = opts.agePruneActive ?? true
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const inner = getInner(msg)
    const role = inner.role ?? msg.role
    const content = inner.content
    if (!Array.isArray(content)) continue
    if (role === 'assistant') {
      const reason = isAssistantContentMutable(content as AnyContentBlock[], opts)
      if (reason) return { index: i - 1, reason }
      continue
    }
    if (role !== 'user') continue
    for (const block of content as AnyContentBlock[]) {
      const reason = isToolResultBlockMutable(block, clippedIds, agePruneActive)
      if (reason) return { index: i - 1, reason }
    }
  }
  return { index: messages.length - 1, reason: null }
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
 * A call's INPUT stays whole while its result is among this many newest user
 * messages, whatever window the caller keeps results in. Every tool_result is
 * a user message of its own, so this counts results: 10 sequential calls, or
 * fewer round trips when calls run in parallel. With the result window alone
 * (2), a call's input went one message before its result: a relief clip on
 * 2026-10-16 stubbed the patchText of calls 30 s to 2.5 min old, and the
 * model's next Patch carried the placeholder it had been looking at as its
 * patchText. The rewrite starts at the oldest clipped block either way, so
 * keeping the tail costs no cache.
 */
export const KEEP_RECENT_INPUT_RESULTS = 10

/** The tool_use ids answered at or after `fromIdx`. */
function toolResultIdsFrom(messages: readonly AnyMessage[], fromIdx: number): Set<string> {
  const ids = new Set<string>()
  for (let i = fromIdx; i < messages.length; i++) {
    const content = getInner(messages[i]!).content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyContentBlock[]) {
      const id = (block as { tool_use_id?: string }).tool_use_id
      if (block?.type === 'tool_result' && id) ids.add(id)
    }
  }
  return ids
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

const EMPTY_FIELDS: ReadonlyMap<string, readonly string[]> = new Map()

/** Tokens applyStableInputStubs would remove from this input: every declared
 * field still holding a string at or above MIN_STUB_TOKENS. */
function clearableInputTokens(
  input: Record<string, unknown>,
  fields: readonly string[],
): number {
  let total = 0
  for (const field of fields) {
    const value = input[field]
    if (typeof value !== 'string' || isInputClipStubContent(value)) continue
    const tokens = roughTokenCountEstimation(value)
    if (tokens >= MIN_STUB_TOKENS) total += tokens
  }
  return total
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
 *
 * `inputFieldsByTool` (tool name → its `clearableInputFields`) adds the
 * tool_use INPUT side: an assistant call whose tool declares clearable
 * fields is a candidate too, its savings being the fields still holding a
 * string at or above MIN_STUB_TOKENS (mirrors applyStableInputStubs). A
 * call that is clearable on both sides — Write, Edit — is ONE candidate
 * with the two savings summed, so one clip event covers both; ids whose
 * inputs were already clipped contribute only their result side.
 * A call's input is protected while its result sits in the last
 * `max(keepRecentTurns, KEEP_RECENT_INPUT_RESULTS)` user messages.
 */
export function collectClearableCandidates(
  messages: readonly AnyMessage[],
  keepRecentTurns: number,
  stubKeepHeadChars: number,
  isClearableTool: (toolName: string) => boolean = () => true,
  inputFieldsByTool: ReadonlyMap<string, readonly string[]> = EMPTY_FIELDS,
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
  const clippedInputs = getClippedInputFields()
  const toolNames = indexToolUses(messages)
  // Judged by where the RESULT sits: the call itself is one message earlier,
  // and with parallel calls several.
  const inputCutoffIdx = findTurnCutoffIndex(
    messages,
    Math.max(keepRecentTurns, KEEP_RECENT_INPUT_RESULTS),
  )
  const recentCalls =
    inputCutoffIdx > 0 ? toolResultIdsFrom(messages, inputCutoffIdx) : null
  const headTokensEstimate =
    stubKeepHeadChars > 0 ? Math.ceil(stubKeepHeadChars / 4) : 0
  const candidates: ReliefCandidate[] = []
  const byId = new Map<string, ReliefCandidate>()
  let clearableTokens = 0
  for (let i = 0; i < cutoffIdx; i++) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    const content = inner.content
    if (!Array.isArray(content)) continue
    if (role === 'assistant') {
      if (inputFieldsByTool.size === 0 || recentCalls === null) continue
      for (const block of content as ToolUseBlock[]) {
        if (block?.type !== 'tool_use' || !block.id) continue
        if (clippedInputs.has(block.id) || recentCalls.has(block.id)) continue
        const fields = inputFieldsByTool.get(block.name ?? '')
        if (!fields || !block.input || typeof block.input !== 'object') continue
        const savings = clearableInputTokens(
          block.input as Record<string, unknown>,
          fields,
        )
        if (savings <= 0) continue
        const candidate: ReliefCandidate = {
          toolUseId: block.id,
          savings,
          inputFields: fields,
          inputOnly: true,
        }
        byId.set(block.id, candidate)
        candidates.push(candidate)
      }
      continue
    }
    if (role !== 'user') continue
    for (const block of content as AnyContentBlock[]) {
      if (block?.type !== 'tool_result') continue
      const existing = (block as unknown as ToolResultBlockParam).content
      if (!isStubbableResult(existing)) continue
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
      const withInput = byId.get(toolUseId)
      if (withInput) {
        withInput.savings += savings
        delete withInput.inputOnly
      } else {
        candidates.push({ toolUseId, savings })
      }
    }
  }
  return { candidates, clearableTokens }
}
