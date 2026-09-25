import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import type {
  AnyContentBlock,
  AnyMessage,
  ToolUseBlock,
} from 'src/agent/compact/stableStubState/types.js'
import {
  estimateToolResultTokens,
  getInner,
} from 'src/agent/compact/stableStubState/types.js'
import {
  getClippedIds,
  getStubTextForId,
  recordStubText,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
import { pinShieldsBlock } from 'src/agent/compact/stableStubState/pinRegistry.js'

/** Minimum token count for a tool_result to be immediately stubbed on display. */
const IMMEDIATE_STUB_TOKEN_THRESHOLD = 2000

// Floor below which clipping is a net loss: the stub itself ("[clipped: ~N
// tokens from <tool>]") is ~10 tokens, so anything shorter saves nothing and
// destroys potentially useful context (especially short error messages).
export const MIN_STUB_TOKENS = 100

/**
 * Build the deterministic stub string for a clipped tool_result.
 *
 * Format: `[clipped: ~N tokens from <toolName>]`
 *
 * CRITICAL: This must be byte-stable across turns for the same (id, content)
 * pair. Do NOT include timestamps, random values, or anything dynamic.
 *
 * Token rounding intentionally NOT applied: the CLIP_STUB_PATTERN guard in
 * applyStableStubs ensures we never recompute tokens for an already-stubbed
 * block, so estimator drift between turns is moot. The exact integer is fine.
 */
export function buildClipStub(toolName: string, originalTokens: number): string {
  return `[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens from ${toolName}]`
}

/**
 * Deterministic stub for one clipped tool_use INPUT field — the client-side
 * twin of `clear_tool_inputs`. Same byte-stability contract as buildClipStub.
 *
 * Format: `[clipped: ~N tokens of <field> from <toolName>]`
 */
export function buildInputClipStub(
  toolName: string,
  field: string,
  originalTokens: number,
): string {
  return `[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens of ${field} from ${toolName}]`
}

// Matches only the input form — the result-side CLIP_STUB_PATTERN must not
// accept it, or a stubbed input field pasted back as a result would read as
// already final. Anchored on ` of `, which the result form never carries.
const INPUT_CLIP_STUB_PATTERN = /^\[clipped: ~\d+ tokens of \S+ from .+\]$/

/** An input field value that already is the byte-stable input stub. */
export function isInputClipStubContent(value: string): boolean {
  return INPUT_CLIP_STUB_PATTERN.test(value)
}

/**
 * Immediately stub large tool_result content for the display array.
 *
 * When a tool_result arrives during streaming, its full content is stored
 * in QueryEngine.mutableMessages (API-facing) and the transcript. The
 * display array (React state) only needs the content for rendering, and
 * once the tool_result block is committed the user has already seen the
 * output. This function replaces large tool_result content with a clip
 * stub immediately, preventing mid-turn memory spikes.
 *
 * Only stubs content above IMMEDIATE_STUB_TOKEN_THRESHOLD (~2000 tokens).
 * Small results (errors, short outputs) are left intact for scrollback.
 *
 * @param message A user message containing tool_result blocks
 * @param allMessages Current messages array (used to look up tool names)
 * @returns The same message reference if nothing was stubbed, or a new
 *          message with stubbed content
 */
export function stubToolResultForDisplay<T extends AnyMessage>(
  message: T,
  allMessages: T[],
  thresholdTokens: number = IMMEDIATE_STUB_TOKEN_THRESHOLD,
  stubKeepHeadChars = 0,
): T {
  // Retain profile passes Infinity: the display array seeds the next turn's
  // API view, so stubbing here would clip content out of the model's sight
  // cross-turn. RSS is bounded by the relief policy's rss lane instead.
  if (!Number.isFinite(thresholdTokens)) return message
  const inner = getInner(message)
  const role = inner.role ?? (message as AnyMessage).role
  if (role !== 'user') return message

  const content = inner.content
  if (!Array.isArray(content)) return message

  let anyStubbed = false
  const newContent = (content as AnyContentBlock[]).map(block => {
    if (block?.type !== 'tool_result') return block

    const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
    const existing = (block as { content?: unknown }).content

    // Already stubbed (pure or head-preserving form)
    if (typeof existing === 'string' && isClipStubContent(existing)) return block

    // Skip non-string content
    if (typeof existing !== 'string') return block

    // Skip if already in clippedIds (microcompact will handle it)
    if (getClippedIds().has(toolUseId)) return block

    // Pinned re-delivery — same exemption as stubOneBlock below.
    if (pinShieldsBlock(toolUseId, existing)) return block

    // Estimate tokens and check threshold
    const tokens = roughTokenCountEstimation(existing)
    if (tokens < thresholdTokens) return block

    // Look up the tool name from the preceding assistant message's tool_use block
    const toolName = findToolNameById(allMessages, toolUseId)
    anyStubbed = true
    // Same head-preserving rule as stubOneBlock: the display array seeds the
    // next turn's API view, so keeping the head here is what lets the model
    // keep referencing large outputs cross-turn without a re-read.
    const stubbedContent = headStubApplies(existing, stubKeepHeadChars)
      ? buildClipStubWithHead(toolName, tokens, existing.slice(0, stubKeepHeadChars))
      : buildClipStub(toolName, tokens)
    return {
      ...block,
      content: stubbedContent,
    } as AnyContentBlock
  })

  if (!anyStubbed) return message

  // Preserve the .message wrapper if present (same pattern as
  // applyStableStubs / pruneOldToolResults)
  if ((message as { message?: unknown }).message) {
    return {
      ...message,
      message: { ...inner, content: newContent },
    } as T
  }
  return { ...message, content: newContent } as T
}

/** Find the tool name for a given tool_use_id by scanning assistant messages. */
function findToolNameById<T extends AnyMessage>(
  messages: T[],
  toolUseId: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const inner = getInner(messages[i]!)
    const role = inner.role ?? (messages[i] as AnyMessage).role
    if (role !== 'assistant') continue
    const content = inner.content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyContentBlock[]) {
      if (block?.type === 'tool_use' && (block as ToolUseBlock).id === toolUseId) {
        return (block as ToolUseBlock).name ?? 'tool'
      }
    }
  }
  return 'tool'
}

// Used to detect blocks already rewritten on a previous turn so applyStableStubs
// doesn't recompute the token count from the short stub itself (which would
// drift to a smaller number and break byte-stability).
const CLIP_STUB_PATTERN = /^\[clipped: ~\d+ tokens from .+\]$/

// Head-preserving variant (a mid-tier stub, in single-mutation form):
// the first N chars of the original output survive above a marker line. Same
// byte-stability contract as the pure stub — built once, never recomputed.
const CLIP_STUB_HEAD_PATTERN = /\n\[clipped: ~\d+ tokens from .+ — head preserved\]$/

// Head-stubbing is only worth the mutation when it actually truncates a
// meaningful amount; below this margin the pure stub is used instead.
const HEAD_STUB_MIN_SAVINGS_CHARS = 500

// Upper bound on a plausible head-stub's total size. The head is at most a
// few thousand chars (profile stubKeepHeadChars), so any content far larger
// that merely ENDS with a marker line (e.g. the model cat-ing a transcript or
// test fixture from this repo) must NOT be classified as an already-final
// stub — that would exempt a huge result from every pruning path forever.
const HEAD_STUB_MAX_PLAUSIBLE_CHARS = 32_000

/** A tool_result content string that is already in one of the two stable
 * stub forms (pure or head-preserving). Such bytes are final: every rewriter
 * in this module returns them unchanged forever. Exported for Read's dedup
 * stand-down (clientClippingDetection.ts), which must recognize the exact
 * same forms — a drift between the two would re-point the model at clipped
 * content. */
export function isClipStubContent(content: string): boolean {
  return (
    CLIP_STUB_PATTERN.test(content) ||
    (content.length <= HEAD_STUB_MAX_PLAUSIBLE_CHARS &&
      CLIP_STUB_HEAD_PATTERN.test(content))
  )
}

/** Whether `content` takes the head-preserving stub form for the given
 * headChars. Single source of truth — stubOneBlock, the display stub and
 * the relief candidate walk's savings accounting must agree byte-for-byte, or the
 * same content could render different stub forms across paths (a wire
 * byte flip that breaks the prompt-cache prefix). */
export function headStubApplies(content: unknown, headChars: number): content is string {
  return (
    headChars > 0 &&
    typeof content === 'string' &&
    content.length > headChars + HEAD_STUB_MIN_SAVINGS_CHARS
  )
}

/** Deterministic head-preserving stub: first `headChars` of the original
 * content + a marker line. CRITICAL: byte-stable for the same inputs — no
 * timestamps, no recomputation (guarded by CLIP_STUB_HEAD_PATTERN). */
export function buildClipStubWithHead(
  toolName: string,
  originalTokens: number,
  head: string,
): string {
  return `${head}\n[clipped: ~${Math.max(0, Math.round(originalTokens))} tokens from ${toolName} — head preserved]`
}

export function arrayContainsImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const item of content as Array<{ type?: string }>) {
    if (item && typeof item === 'object' && item.type === 'image') return true
  }
  return false
}

// Mirrors stripExcessMediaItems' isMedia: it strips image AND document
// blocks, nested in tool_results or top-level in user messages — the
// frontier's media-churn rule must cover the same set.
export function isMediaBlockType(type: string | undefined): boolean {
  return type === 'image' || type === 'document'
}

export function arrayContainsMedia(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const item of content as Array<{ type?: string }>) {
    if (item && typeof item === 'object' && isMediaBlockType(item.type)) return true
  }
  return false
}

/**
 * Decide whether an age-based prune pass should clip this block.
 * Distinct from the explicit clip path (applyStableStubs), which honors
 * QueryEngine's decision to clip regardless of size or error flag.
 *
 * Skip cases:
 *   - is_error: short error bodies (e.g. interrupted Agent) carry the only
 *     user-visible context for the failure; clipping destroys them.
 *   - content under MIN_STUB_TOKENS: the stub itself (~10 tokens) saves
 *     nothing here and just replaces real text with "[clipped: ~N tokens…]".
 */
export function shouldAgeStub(block: AnyContentBlock): boolean {
  if (block?.type !== 'tool_result') return true
  const tr = block as ToolResultBlockParam
  if (tr.is_error) return false
  const existing = tr.content
  if (existing == null || existing === '') return true
  if (typeof existing === 'string' && isClipStubContent(existing)) return true
  return estimateToolResultTokens(existing) >= MIN_STUB_TOKENS
}

/**
 * Attempt to rewrite a single tool_result block as a clip stub.
 * Returns the original block unchanged when: already a stub, empty, or
 * image-bearing. Callers are responsible for any additional pre-filters
 * (e.g. clippedIds membership check in applyStableStubs).
 */
export function stubOneBlock(
  block: AnyContentBlock,
  toolNames: Map<string, string>,
  stubKeepHeadChars = 0,
): AnyContentBlock {
  if (block?.type !== 'tool_result') return block
  const existing = (block as ToolResultBlockParam).content
  if (typeof existing === 'string' && isClipStubContent(existing)) return block
  if (existing == null || existing === '') return block
  if (Array.isArray(existing) && existing.length === 0) return block
  if (arrayContainsImage(existing)) return block
  const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? ''
  // Pinned: the model already lost this content once and asked for it back.
  // Clipping it again is exactly what the pin exists to prevent — every clip
  // path (age prune, explicit clip) lands here, so this single
  // check covers all of them.
  if (pinShieldsBlock(toolUseId, existing)) return block
  // First-write-wins replay: if this id was already stubbed in this session
  // (by any rewriter, over any content view), reproduce those exact bytes.
  // Different views can hold different content for the same id (budget
  // preview vs full original) — recomputing would embed a different token
  // count / head and flip the wire bytes, breaking the cached prefix.
  if (toolUseId) {
    const recorded = getStubTextForId(toolUseId)
    if (recorded !== undefined) {
      return { ...block, content: recorded }
    }
  }
  const toolName = toolNames.get(toolUseId) ?? 'tool'
  const tokens = estimateToolResultTokens(existing)
  // Head-preserving form: one mutation, same break cost as the pure stub,
  // but the model keeps the useful head of the output (file headers, top
  // grep hits) — fewer re-reads. Only when it meaningfully truncates.
  const stub = headStubApplies(existing, stubKeepHeadChars)
    ? buildClipStubWithHead(
        toolName,
        tokens,
        existing.slice(0, stubKeepHeadChars),
      )
    : buildClipStub(toolName, tokens)
  if (toolUseId) {
    recordStubText(toolUseId, stub)
  }
  return {
    ...block,
    content: stub,
  }
}
