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
  arrayContainsImage,
  arrayContainsMedia,
  headStubApplies,
  isClipStubContent,
  isInputClipStubContent,
  isMediaBlockType,
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
      if (inputFieldsByTool.size === 0) continue
      for (const block of content as ToolUseBlock[]) {
        if (block?.type !== 'tool_use' || !block.id) continue
        if (clippedInputs.has(block.id)) continue
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
