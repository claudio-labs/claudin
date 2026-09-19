import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import type {
  AnyContentBlock,
  AnyMessage,
} from 'src/agent/compact/stableStubState/types.js'
import {
  getInner,
  indexToolUses,
} from 'src/agent/compact/stableStubState/types.js'
import {
  currentKey,
  perKeyClippedIds,
} from 'src/agent/compact/stableStubState/clippedIdRegistry.js'
import { agePinsForCurrent } from 'src/agent/compact/stableStubState/pinRegistry.js'
import { stubOneBlock } from 'src/agent/compact/stableStubState/clipStubText.js'

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
