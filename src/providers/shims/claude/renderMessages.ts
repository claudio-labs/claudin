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
  type ClipFrontier,
  findClipFrontier,
} from 'src/agent/compact/stableStubState.js'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import type { MarkerCap } from 'src/providers/cache/promptCacheBreakDetection.js'
import { API_MAX_MEDIA_PER_REQUEST } from 'src/shared/constants/apiLimits.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import type { Tools } from 'src/tools/Tool.js'
import {
  countMediaItems,
  stripExcessMediaItems,
} from 'src/providers/shims/claude/messageConverters.js'
import { activeSessionUsesCodexBackend } from 'src/providers/shims/codex/backend.js'
import { stripCodexItems } from 'src/providers/shims/codex/items.js'

export type RenderMessagesOptions = {
  /** The model-aware tool-search decision (isToolSearchEnabled). */
  useToolSearch: boolean
  /** Whether the advisor beta goes out; without it advisor blocks are 400s. */
  advisor: boolean
  /** The cache profile's history redactions, each AND its config switch. */
  stripOldThinking: boolean
  stripOldNarration: boolean
  /** Remove Codex item state (codex/items.ts): every provider but the Codex backend. */
  redactCodexItems: boolean
}

/** The redactions half of RenderMessagesOptions: the cache profile's history
 *  redactions, each AND its config switch, and the Codex item redaction. */
export type HistoryRedactions = Pick<
  RenderMessagesOptions,
  'stripOldThinking' | 'stripOldNarration' | 'redactCodexItems'
>

export function historyRedactions(): HistoryRedactions {
  const config = getGlobalConfig()
  const enabled = getCacheProfile().historyRedactionEnabled
  return {
    stripOldThinking: enabled && !!config.thinkingHistoryRedactionEnabled,
    stripOldNarration: enabled && !!config.narrationHistoryRedactionEnabled,
    redactCodexItems: !activeSessionUsesCodexBackend(),
  }
}

/**
 * The messages one request sends, from the conversation the caller holds:
 * every stage between the history and `addCacheBreakpoints`, in the order the
 * wire needs. queryModel (streaming.ts) renders each request with it, and the
 * prompt-cache invariant suites (src/agent/cache/) render with it too, so what
 * they compare is what goes out, not a copy of the pipeline that can drift.
 *
 * `mediaStripped` is how many media items the API's cap dropped. Each new
 * image past the cap drops one more, which rewrites the message that held the
 * oldest one: the caller announces that rewrite when the count grows.
 */
export function renderMessagesForAPI(
  messages: Message[],
  tools: Tools,
  options: RenderMessagesOptions,
): { messages: (UserMessage | AssistantMessage)[]; mediaStripped: number } {
  let messagesForAPI = normalizeMessagesForAPI(messages, tools)

  // Codex item state (reasoning payloads, the backend's item ids) belongs on
  // the Codex backend's wire only. Any other provider renders the history
  // without it: the same bytes on every request of that provider, so nothing
  // here becomes a mutation the clip frontier has to wait for.
  if (options.redactCodexItems) {
    messagesForAPI = stripCodexItems(messagesForAPI)
  }

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

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  //
  // Before the stable stubs, so the stubs and the clip frontier judge the same
  // content: a clipped result whose image the cap dropped is text-only now,
  // and it is stubbed in this request — not left looking like a clip still to
  // come, which held the cache marker in front of it for good. A stub never
  // removes media (isStubbableResult refuses images and documents alike), so
  // the count is the same on either side.
  const mediaStripped = Math.max(0, countMediaItems(messagesForAPI) - API_MAX_MEDIA_PER_REQUEST)
  messagesForAPI = stripExcessMediaItems(messagesForAPI, API_MAX_MEDIA_PER_REQUEST)

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

  return { messages: messagesForAPI, mediaStripped }
}

/**
 * The clip frontier of one request: the marker goes no further than this.
 * Computed on the exact array handed to addCacheBreakpoints (after a retry's
 * thinking strip), with the redactions the render applied, so the stability
 * judgment matches the wire bytes.
 */
export function requestClipFrontier(
  messages: readonly (UserMessage | AssistantMessage)[],
  redactions: HistoryRedactions,
): ClipFrontier {
  return findClipFrontier(messages, {
    // A history the render does not redact never mutates there — thinking and
    // narration are stable and may be frozen.
    thinkingIsMutable: redactions.stripOldThinking,
    narrationIsMutable: redactions.stripOldNarration,
    // Retain profile disables the age prune → full tool_results are
    // byte-stable and may be frozen behind the marker.
    agePruneActive: Number.isFinite(getCacheProfile().keepTurns),
  })
}

/** The message carrying the last message-level cache_control marker, or -1. */
export function messageMarkerIndex(
  rendered: ReadonlyArray<{ content: unknown }>,
): number {
  return rendered.findLastIndex(
    m =>
      Array.isArray(m.content) &&
      m.content.some(
        (b: unknown) => typeof b === 'object' && b !== null && 'cache_control' in b && !!b.cache_control,
      ),
  )
}

/**
 * Where the clip frontier held the marker short of the request's last
 * message, read from the request as rendered: a marker the opt-in deferral
 * placed, or none at all with prompt caching off, is not the frontier's.
 * Null when nothing was held.
 */
export function heldMarker(
  rendered: ReadonlyArray<{ content: unknown }>,
  frontier: ClipFrontier | undefined,
): MarkerCap | null {
  if (!frontier?.reason) return null
  const marker = messageMarkerIndex(rendered)
  if (marker !== frontier.index || marker >= rendered.length - 1) return null
  return { index: marker, total: rendered.length, reason: frontier.reason }
}
