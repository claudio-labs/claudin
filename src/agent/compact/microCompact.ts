import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import type { Message } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { estimateImageTokens } from 'src/agent/context/imageTokenEstimator.js'
import { SHELL_TOOL_NAMES } from 'src/platform/shell/shellToolUtils.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { logEvent } from 'src/platform/analytics/index.js'
import { notifyCacheDeletion } from 'src/providers/cache/promptCacheBreakDetection.js'
import { recordPrefixRewrite } from 'src/providers/cache/cacheStatsTracker.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import { tokenCountWithEstimation } from 'src/agent/context/tokens.js'
import { getAutoCompactThreshold, getEffectiveContextWindowSize, isAutoCompactEnabled } from 'src/agent/compact/autoCompact.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from 'src/agent/compact/compactWarningState.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  addClippedIds,
  applyStableStubs,
  collectClearableCandidates,
  getClippedIds,
  resetClippedIds,
} from 'src/agent/compact/stableStubState.js'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import {
  decideRelief,
  isReliefWindowLaneEnabled,
  selectReliefIds,
} from 'src/agent/compact/reliefPolicy.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from 'src/agent/compact/timeBasedMCConfig.js'

// Per-provider image sizing lives in utils/imageTokenEstimator.ts. Document
// (PDF) blocks still fall back to this conservative cap since page-accurate
// sizing is out of scope.
const DOCUMENT_TOKEN_FALLBACK = 2000

// Only compact these built-in tools (MCP tools are also compactable via prefix match)
export const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

const MCP_TOOL_PREFIX = 'mcp__'

export function isCompactableTool(name: string): boolean {
  return COMPACTABLE_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX)
}

export function resetMicrocompactState(): void {
  // The stable-stub set is per-session monotonic — clearing it on /clear,
  // swarm cleanup, postCompactCleanup, etc. is correct because the message
  // history those callers wipe is the same one that referenced the ids.
  resetClippedIds()
}

// Helper to calculate tool result tokens
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // Array of TextBlockParam | ImageBlockParam | DocumentBlockParam
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + roughTokenCountEstimation(item.text)
    } else if (item.type === 'image') {
      return sum + estimateImageTokens(item.source)
    } else if (item.type === 'document') {
      return sum + DOCUMENT_TOKEN_FALLBACK
    }
    return sum
  }, 0)
}

/**
 * Estimate token count for messages by extracting text content
 * Used for rough token estimation when we don't have accurate API counts
 * Pads estimate by 4/3 to be conservative since we're approximating
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    // String content (the common shape for a plain user turn) was previously
    // skipped entirely, counting as 0 tokens and delaying micro-compaction.
    if (typeof message.message.content === 'string') {
      totalTokens += roughTokenCountEstimation(message.message.content)
      continue
    }

    if (!Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image') {
        totalTokens += estimateImageTokens(block.source)
      } else if (block.type === 'document') {
        totalTokens += DOCUMENT_TOKEN_FALLBACK
      } else if (block.type === 'thinking') {
        // Match roughTokenCountEstimationForBlock: count only the thinking
        // text, not the JSON wrapper or signature (signature is metadata,
        // not model-tokenized content).
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_use') {
        // Match roughTokenCountEstimationForBlock: count name + input,
        // not the JSON wrapper or id field.
        totalTokens += roughTokenCountEstimation(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        // server_tool_use, web_search_tool_result, etc.
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  // Pad estimate by 4/3 to be conservative since we're approximating
  return Math.ceil(totalTokens * (4 / 3))
}

export type MicrocompactResult = {
  messages: Message[]
}

/**
 * Walk messages and collect tool_use IDs whose tool name is in
 * COMPACTABLE_TOOLS, in encounter order. Shared by both microcompact paths.
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && isCompactableTool(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// Prefix-match because promptCategory.ts sets the querySource to
// 'repl_main_thread:outputStyle:<style>' when a non-default output style
// is active. The bare 'repl_main_thread' is only used for the default style.
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

// The relief candidate walk protects the last N user-role messages (turn
// boundaries). In a tool loop each tool_result is its own user-role message,
// so 2 keeps the most recent two results untouched — the tail the
// cache_control marker typically sits on, so the clip never invalidates the
// marker placement.
const RELIEF_KEEP_RECENT_TURNS = 2

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // Clear suppression flag at start of new microcompact attempt
  clearCompactWarningSuppression()

  // Time-based trigger: if the gap since the last assistant message exceeds
  // the threshold, the server cache has expired and the full prefix will be
  // rewritten regardless — so clip old tool results into the stable-stub
  // set now, before the request, to shrink what gets rewritten.
  const timeBasedResult = maybeTimeBasedMicrocompact(
    messages,
    toolUseContext,
    querySource,
  )
  if (timeBasedResult) {
    return timeBasedResult
  }

  // Relief policy (reliefPolicy.ts): one decision on REAL usage, one action —
  // freeze the oldest clearable tool_result ids into the per-session clipped
  // set. From that point on every request rewrites those blocks to the same
  // deterministic stub bytes, so the cache breaks once and stays warm.
  //
  // Gated on a querySource: /context, /compact and analyzeContext call this
  // for analysis only and must not mutate the clipped set (the previous
  // estimate-driven trigger did, so an analysis command could clip).
  if (querySource) {
    maybeReliefClip(messages, toolUseContext, querySource)
  }

  // applyStableStubs is NOT called here. The native (claude.ts) and shim
  // (openaiShim.ts / codexShim.ts) request paths each call it themselves
  // right before the wire — that's the boundary that actually needs the
  // stubs. Calling it here as well would be an idempotent walk over every
  // message on every turn for no behavioral change. Other consumers of
  // microcompactMessages (analyzeContext, /context, /compact) operate on
  // stub-free messages for analysis and don't need the rewrite.
  return { messages }
}

function maybeReliefClip(
  messages: Message[],
  toolUseContext: ToolUseContext | undefined,
  querySource: QuerySource,
): void {
  const profile = getCacheProfile()
  const { candidates, clearableTokens } = collectClearableCandidates(
    messages,
    RELIEF_KEEP_RECENT_TURNS,
    profile.stubKeepHeadChars,
    isCompactableTool,
  )
  // Nothing clearable: the decision would be moot, and deciding anyway
  // would only log a clip that frees nothing.
  if (candidates.length === 0) return

  const model = getMainLoopModel()
  const decision = decideRelief({
    // Real usage: the previous response's counted tokens plus an estimate
    // of what was appended since — the same unit autocompact anchors on.
    // The clip decided here is applied at the wire on THIS request, so the
    // next response's usage already reflects it; no latch needed. Measured
    // over the stubbed view so the estimated part (the tail, or the whole
    // history before any response has usage) also reflects the clipped
    // set — otherwise a request between a clip and its response would
    // count content the wire no longer sends and clip again.
    usedTokens: tokenCountWithEstimation(applyStableStubs(messages)),
    effectiveWindow: getEffectiveContextWindowSize(model),
    autocompactThreshold: isAutoCompactEnabled()
      ? getAutoCompactThreshold(model)
      : null,
    retainedFullResultTokens: clearableTokens,
    profile,
    windowLaneEnabled: isReliefWindowLaneEnabled(),
  })
  if (decision.kind === 'none') return

  const { ids, savings } = selectReliefIds(candidates, decision.tokensToFree)
  if (ids.length === 0) return

  addClippedIds(ids)
  // Release preview strings from ContentReplacementState.replacements for
  // ids that are now clipped. The stable stub supersedes the preview; keep
  // seenIds intact to prevent re-processing in enforceToolResultBudget.
  const crs = toolUseContext?.contentReplacementState
  if (crs) {
    for (const id of ids) {
      crs.replacements.delete(id)
    }
  }

  logEvent('tengu_stable_stub_clip', {
    rssLane: decision.lane === 'rss',
    added: ids.length,
    totalClipped: getClippedIds().size,
    tokensToFree: Math.round(decision.tokensToFree),
    tokensFreed: savings,
    trigger: Math.round(decision.trigger),
    target: Math.round(decision.target),
  })
  const reason = `relief clip (${ids.length} tool results, ~${Math.round(savings / 1000)}k tokens, ${decision.lane} lane)`
  logForDebugging(
    `[RELIEF] ${reason}: trigger ${Math.round(decision.trigger)} → target ${Math.round(decision.target)}`,
  )

  // Announce the rewrite ONCE per clip event: this request's bytes diverge
  // from the cached prefix at the clipped ids, which would otherwise be
  // flagged as a regression. Gated to first-party transports (anthropic /
  // bedrock / vertex) — the OpenAI/Codex shim paths don't feed the same
  // detector state, so calling it there is a no-op write we'd rather skip.
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && isFirstPartyTransport()) {
    notifyCacheDeletion(querySource, undefined, reason)
  }
  // The `[Cache: …]` line names the knob that fired; sub-agents keep their
  // clips out of the main thread's line.
  if (isMainThreadSource(querySource)) {
    recordPrefixRewrite(reason)
  }
}

function isFirstPartyTransport(): boolean {
  try {
    const provider = tryGetActiveProvider()
    if (!provider) return false
    return (
      provider.transport === 'anthropic' ||
      provider.transport === 'bedrock' ||
      provider.transport === 'vertex'
    )
  } catch {
    return false
  }
}

/**
 * Time-based microcompact: when the gap since the last main-loop assistant
 * message exceeds the configured threshold, content-clear all but the most
 * recent N compactable tool results.
 *
 * Returns null when the trigger doesn't fire (disabled, wrong source, gap
 * under threshold, nothing to clear) — caller falls through to other paths.
 *
 * Mutates message content directly: the cache is cold by definition when this
 * fires, so there's no cached prefix to preserve.
 */
/**
 * Check whether the time-based trigger should fire for this request.
 *
 * Returns the measured gap (minutes since last assistant message) when the
 * trigger fires, or null when it doesn't (disabled, wrong source, under
 * threshold, no prior assistant, unparseable timestamp).
 *
 * Extracted so other pre-request paths (e.g. snip force-apply) can consult
 * the same predicate without coupling to the tool-result clearing action.
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // Require an explicit main-thread querySource. isMainThreadSource treats
  // undefined as main-thread, but several callers (/context, /compact,
  // analyzeContext) invoke microcompactMessages without a source for
  // analysis-only purposes — they should not trigger.
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  toolUseContext: ToolUseContext | undefined,
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // Floor at 1: slice(-0) returns the full array (paradoxically keeps
  // everything), and clearing ALL results leaves the model with zero working
  // context. Neither degenerate is sensible — always keep at least the last.
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  // Persist the clear through the stable-stub mechanism instead of
  // rewriting the per-request view: ids added to the clipped set are
  // stubbed by applyStableStubs at the wire boundary with deterministic
  // bytes — on this turn AND every following turn — so the post-idle
  // "cleaned" prefix keeps getting cache hits afterwards. The previous
  // view-only rewrite flipped back to the original bytes on the next turn,
  // paying a second full prefix write for the same idle gap.
  const clipped = getClippedIds()
  const newOnes = [...clearSet].filter(id => !clipped.has(id))
  if (newOnes.length === 0) {
    return null
  }

  // Measure what the clear saves on the content as it stands in this view.
  // Zero means every candidate is already empty/cleared — nothing to do.
  const newSet = new Set(newOnes)
  let tokensSaved = 0
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type === 'tool_result' && newSet.has(block.tool_use_id)) {
        tokensSaved += calculateToolResultTokens(block)
      }
    }
  }
  if (tokensSaved === 0) {
    return null
  }

  addClippedIds(newOnes)
  // Release preview strings from ContentReplacementState.replacements for
  // IDs that are now clipped, mirroring the size-based path: the stable
  // stub supersedes the preview, and keeping seenIds intact prevents
  // re-processing in enforceToolResultBudget.
  const crs = toolUseContext?.contentReplacementState
  if (crs) {
    for (const id of newOnes) {
      crs.replacements.delete(id)
    }
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: newOnes.length,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, clipped ${newOnes.length} tool results (~${tokensSaved} tokens), kept last ${keepSet.size}`,
  )

  suppressCompactWarning()
  // Deliberately NOT resetMicrocompactState() here: the idle gap does not
  // wipe any history (unlike /clear, swarm cleanup, postCompactCleanup —
  // see the resetMicrocompactState docstring). Resetting would drop ids
  // already frozen behind the cache marker by the size-based trigger,
  // reverting those blocks to full bytes on the next turn — a second,
  // independent prefix break for the same idle gap.
  //
  // We just changed the prompt content — the next response's cache read will
  // be low, but that's us, not a break. Tell the detector to expect a drop.
  // notifyCacheDeletion (not notifyCompaction) because it's already imported
  // here and achieves the same false-positive suppression — adding the second
  // symbol to the import was flagged by the circular-deps check.
  // Pass the actual querySource: getTrackingKey returns the full source string
  // (e.g. 'repl_main_thread:outputStyle:custom'), not just the prefix.
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(
      querySource,
      undefined,
      `idle-gap clip (${newOnes.length} tool results after ${Math.round(gapMinutes)}min)`,
    )
  }

  // The view is returned unchanged — applyStableStubs at the request
  // boundary rewrites the clipped blocks. Returning here (instead of
  // falling through) keeps the old contract: the size-based path does not
  // also run on a time-trigger turn.
  return { messages }
}
