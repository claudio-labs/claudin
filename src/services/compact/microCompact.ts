import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from 'src/constants/querySource.js'
import type { ToolUseContext } from 'src/Tool.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { estimateImageTokens } from 'src/services/context/imageTokenEstimator.js'
import { SHELL_TOOL_NAMES } from 'src/platform/shell/shellToolUtils.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import { logEvent } from 'src/platform/analytics/index.js'
import { notifyCacheDeletion } from 'src/services/api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from 'src/services/tokenEstimation.js'
import { getAutoCompactThreshold, getEffectiveContextWindowSize, isAutoCompactEnabled } from 'src/services/compact/autoCompact.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from 'src/services/compact/compactWarningState.js'
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import {
  addClippedIds,
  getClippedIds,
  resetClippedIds,
} from 'src/services/compact/stableStubState.js'
import { getCacheProfile } from 'src/services/cache/cacheProfile.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from 'src/services/compact/timeBasedMCConfig.js'

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

// Mirrors the time-based path's keepRecent default: keep the most recent two
// compactable tool results untouched. The cache_control marker tail typically
// sits on the last user message, so leaving the tail alone also avoids
// invalidating the marker placement.
const SIZE_BASED_KEEP_RECENT = 2

// Fire the size-driven stable-stub trigger when estimated message tokens
// exceed the profile's fraction of the effective context window
// (cacheProfile.ts sizeStubThresholdFraction — aggressive 0.5, retain 0.75;
// see the rationale there, including why retain's 0.85 was abandoned).
// The trigger is additionally capped just below the autocompact threshold:
// the fraction is relative while autocompact subtracts an ABSOLUTE 13k
// buffer, so for effective windows ≤ ~52k (or CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
// < the fraction) the uncapped fraction would sit ABOVE autocompact and the
// cheap stub-clip could never pre-empt the expensive wipe-plus-re-reads.
const STUB_TRIGGER_PREEMPT_MARGIN_TOKENS = 5_000

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

  // Size-driven stable-stub trigger. Once the conversation crosses the
  // threshold, freeze old compactable tool_result ids into the per-session
  // clipped set. From that point on every turn rewrites those blocks to the
  // same deterministic stub bytes — prefix cache stays warm.
  const estimatedTokens = estimateMessageTokens(messages)
  const model = getMainLoopModel()
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const fractionTrigger =
    getCacheProfile().sizeStubThresholdFraction * effectiveWindow
  // Cap only when meaningful: (a) with autocompact disabled there is
  // nothing to pre-empt and capping would just clip earlier for no reason;
  // (b) in degenerate tiny windows the autocompact threshold goes ≤ margin
  // (or negative) and capping would disable the stub trigger entirely.
  // Note the margin is heuristic: the trigger compares message-content
  // estimates while autocompact anchors on real API usage that includes
  // system+tools overhead, so the cap narrows but cannot fully close the
  // race on small windows.
  const preemptCap = isAutoCompactEnabled()
    ? getAutoCompactThreshold(model) - STUB_TRIGGER_PREEMPT_MARGIN_TOKENS
    : 0
  const sizeTrigger =
    preemptCap > 0 ? Math.min(fractionTrigger, preemptCap) : fractionTrigger
  if (effectiveWindow > 0 && estimatedTokens > sizeTrigger) {
    const compactableIds = collectCompactableToolIds(messages)
    // Small-history dead zone fix: when threshold is breached but
    // compactableIds.length <= SIZE_BASED_KEEP_RECENT, we'd otherwise leave
    // candidateIds empty and sit on hands until autoCompact's hard 92% gate.
    // Always leave at least one most-recent block intact, but allow clipping
    // when there are >= 2 candidates total.
    let candidateIds: string[] = []
    if (compactableIds.length >= 2) {
      const keepRecent = Math.max(
        1,
        Math.min(SIZE_BASED_KEEP_RECENT, compactableIds.length - 1),
      )
      candidateIds = compactableIds.slice(0, -keepRecent)
    }
    const clipped = getClippedIds()
    const newOnes = candidateIds.filter(id => !clipped.has(id))

    if (newOnes.length > 0) {
      addClippedIds(newOnes)
      // Release preview strings from ContentReplacementState.replacements
      // for IDs that are now clipped. The stable stub has already replaced
      // the content in the message array, so the replacement preview is no
      // longer needed. Keep seenIds intact to prevent re-processing in
      // enforceToolResultBudget.
      const crs = toolUseContext?.contentReplacementState
      if (crs) {
        for (const id of newOnes) {
          crs.replacements.delete(id)
        }
      }
      logEvent('tengu_stable_stub_clip', {
        added: newOnes.length,
        totalClipped: getClippedIds().size,
        estimatedTokens,
        effectiveWindow,
      })
      // Notify the cache-break detector ONCE per clip event: the next
      // turn's bytes diverge from the cached prefix at the clipped ids,
      // which would otherwise be flagged as a regression. Gated to
      // first-party transports (anthropic / bedrock / vertex) — the
      // OpenAI/Codex shim paths don't feed the same detector state, so
      // calling it there is a no-op write we'd rather skip.
      if (
        feature('PROMPT_CACHE_BREAK_DETECTION') &&
        querySource &&
        isFirstPartyTransport()
      ) {
        notifyCacheDeletion(querySource)
      }
    }
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
    notifyCacheDeletion(querySource)
  }

  // The view is returned unchanged — applyStableStubs at the request
  // boundary rewrites the clipped blocks. Returning here (instead of
  // falling through) keeps the old contract: the size-based path does not
  // also run on a time-trigger turn.
  return { messages }
}
