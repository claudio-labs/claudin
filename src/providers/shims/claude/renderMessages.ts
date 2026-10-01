import {
  ensureToolResultPairing,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripOldNarrationBlocks,
  stripOldThinkingBlocks,
  stripToolReferenceBlocksFromUserMessage,
} from 'src/agent/messages/messages.js'
import {
  applyStableInputStubs,
  applyStableStubs,
} from 'src/agent/compact/stableStubState.js'
import { API_MAX_MEDIA_PER_REQUEST } from 'src/shared/constants/apiLimits.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import type { Tools } from 'src/tools/Tool.js'
import { stripExcessMediaItems } from 'src/providers/shims/claude/messageConverters.js'

export type RenderMessagesOptions = {
  /** The model-aware tool-search decision (isToolSearchEnabled). */
  useToolSearch: boolean
  /** Whether the advisor beta goes out; without it advisor blocks are 400s. */
  advisor: boolean
  /** The cache profile's history redactions, each AND its config switch. */
  stripOldThinking: boolean
  stripOldNarration: boolean
}

/**
 * The messages one request sends, from the conversation the caller holds:
 * every stage between the history and `addCacheBreakpoints`, in the order the
 * wire needs. queryModel (streaming.ts) renders each request with it, and the
 * prompt-cache invariant suites (src/agent/cache/) render with it too, so what
 * they compare is what goes out, not a copy of the pipeline that can drift.
 *
 * `mediaCapActive` reports that the media cap rewrote the oldest media-bearing
 * blocks — they stop being byte-stable, and the clip frontier must know.
 */
export function renderMessagesForAPI(
  messages: Message[],
  tools: Tools,
  options: RenderMessagesOptions,
): { messages: (UserMessage | AssistantMessage)[]; mediaCapActive: boolean } {
  let messagesForAPI = normalizeMessagesForAPI(messages, tools)

  // Model-specific post-processing: strip tool-search-specific fields if the
  // selected model doesn't support tool search.
  //
  // Why is this needed in addition to normalizeMessagesForAPI?
  // - normalizeMessagesForAPI uses isToolSearchEnabledNoModelCheck() because it's
  //   called from ~20 places (analytics, feedback, sharing, etc.), many of which
  //   don't have model context. Adding model to its signature would be a large refactor.
  // - This post-processing uses the model-aware isToolSearchEnabled() check
  // - This handles mid-conversation model switching (e.g., Sonnet → Haiku) where
  //   stale tool-search fields from the previous model would cause 400 errors
  //
  // Note: For assistant messages, normalizeMessagesForAPI already normalized the
  // tool inputs, so stripCallerFieldFromAssistantMessage only needs to remove the
  // 'caller' field (not re-normalize inputs).
  if (!options.useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // Strip tool_reference blocks from tool_result content
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // Strip 'caller' field from tool_use blocks
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // remote/teleport sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // Apply stable stubs to tool_result blocks whose ids are in the per-session
  // clipped set. No-op when the set is empty. Bytes are deterministic across
  // turns so the prompt cache prefix stays stable after the first clip.
  //
  // Invariant: applyStableStubs MUST run after ensureToolResultPairing
  // (so tool_use_ids are valid) and BEFORE addCacheBreakpoints places
  // the cache_control marker. The stable bytes need to live inside the
  // cached prefix.
  messagesForAPI = applyStableStubs(messagesForAPI)
  // Same contract for the tool_use INPUT side (Patch bodies, Write
  // content, Agent briefs the relief policy clipped): wire-only, byte-stable,
  // and before the frontier for the same reason.
  messagesForAPI = applyStableInputStubs(messagesForAPI)

  // Strip advisor blocks — the API rejects them without the beta header.
  if (!options.advisor) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // Client-side thinking/narration history redactions. Profile-gated: under
  // the retain cache profile they are skipped entirely — their keep windows
  // hold the last 2 assistant turns permanently mutable, pinning the clip
  // frontier behind them and re-billing every big tool_result at 1.0× for 2
  // turns before it can freeze, to save only ~50-200 tokens of text. Old
  // thinking/narration is byte-stable when never stripped, so it freezes
  // into the cached prefix and costs 0.1× thereafter.
  if (options.stripOldThinking) {
    messagesForAPI = stripOldThinkingBlocks(messagesForAPI, 2)
  }
  if (options.stripOldNarration) {
    messagesForAPI = stripOldNarrationBlocks(messagesForAPI, 2)
  }

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  const beforeMediaStrip = messagesForAPI
  messagesForAPI = stripExcessMediaItems(messagesForAPI, API_MAX_MEDIA_PER_REQUEST)
  // Past the media cap, the strip rewrites the OLDEST media-bearing blocks
  // turn by turn as new media arrives — image-bearing tool_results stop
  // being byte-stable, and the clip frontier must treat them as mutable.
  return { messages: messagesForAPI, mediaCapActive: messagesForAPI !== beforeMediaStrip }
}
