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
import { notifyCacheDeletion } from 'src/providers/cache/promptCacheBreakDetection.js'
import { recordPrefixRewrite } from 'src/providers/cache/cacheStatsTracker.js'
import {
  getActiveModelBytesPerToken,
  getToolOutputBytesPerToken,
  roughTokenCountEstimation,
} from 'src/shared/tokenEstimation.js'
import { getTokenUsage, tokenCountWithEstimation } from 'src/agent/context/tokens.js'
import { getAutoCompactThreshold, getEffectiveContextWindowSize, isAutoCompactEnabled } from 'src/agent/compact/autoCompact.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from 'src/agent/compact/compactWarningState.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { modelSupportsThinkingBlockBinding } from 'src/providers/transport/betas.js'
import {
  addClippedIds,
  addClippedInputs,
  applyStableInputStubs,
  applyStableStubs,
  collectClearableCandidates,
  getClippedInputFields,
  getClippedIds,
  resetClippedIds,
} from 'src/agent/compact/stableStubState.js'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import {
  decideRelief,
  isReliefWindowLaneEnabled,
  reliefEventFloor,
  selectReliefIds,
  subagentReliefTriggerCap,
  type ReliefCandidate,
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

/**
 * tool name → `clearableInputFields`, derived from the tools actually in the
 * pool (the same way apiMicrocompact derives `clear_tool_inputs`), so a tool
 * opts in on its own definition rather than in a constant kept here. Empty
 * when the caller has no pool — the analysis paths (/context, /compact).
 */
function clearableInputFieldsFromPool(
  tools: ReadonlyArray<{ name: string; clearableInputFields?: readonly string[] }> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  for (const tool of tools ?? []) {
    if (tool.clearableInputFields && tool.clearableInputFields.length > 0) {
      out.set(tool.name, tool.clearableInputFields)
    }
  }
  return out
}

/** Record the input side of a clip: every selected candidate carrying
 * fields goes into the clipped-inputs registry beside its id. */
function addClippedInputsFor(selected: readonly ReliefCandidate[]): number {
  let n = 0
  for (const c of selected) {
    if (!c.inputFields) continue
    addClippedInputs(c.toolUseId, c.inputFields)
    n++
  }
  return n
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
  /** The window lane is over its trigger and no clip can reach its floor:
   * what is left to relieve is compaction's job (`shouldAutoCompact`). */
  reliefStarved?: true
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

// A relief clip rewrites the prefix of the thread that runs it, so only the
// thread that owns its prefix may clip: the main thread, a headless SDK
// session, a fresh sub-agent. A fork — an Agent fork or a runForkedAgent
// utility (extract_memories, auto_dream, speculation …) — replays the
// parent's history to READ its cached prefix byte for byte, and its tool_use
// ids are the parent's. The clipped-id registry cannot tell a fork from its
// parent (currentKey(), the caveat in pinRegistry.ts), so a fork's clip landed
// in the main thread's set unannounced: main's next request stubbed those ids
// and fell to the floor — three ~700k rewrites in one 2026-10 session, each
// right after extract_memories ran at the end of a turn.
function ownsItsPrefix(querySource: QuerySource): boolean {
  return (
    isMainThreadSource(querySource) ||
    querySource === 'sdk' ||
    (querySource.startsWith('agent:') && querySource !== 'agent:builtin:fork')
  )
}

// The relief candidate walk protects the last N user-role messages (turn
// boundaries). In a tool loop each tool_result is its own user-role message,
// so 2 keeps the most recent two results untouched — the tail the
// cache_control marker typically sits on, so the clip never invalidates the
// marker placement.
const RELIEF_KEEP_RECENT_TURNS = 2

// One `relief starved` entry per microcompact pass on the `[Cache:]` line;
// the debug log still gets every occurrence.
let starvedReportedThisTurn = false

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // Clear suppression flag at start of new microcompact attempt
  clearCompactWarningSuppression()
  starvedReportedThisTurn = false

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
  if (querySource && ownsItsPrefix(querySource)) {
    if (maybeReliefClip(messages, toolUseContext, querySource)) {
      return { messages, reliefStarved: true }
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

/** Returns true when the window lane is starved. */
function maybeReliefClip(
  messages: Message[],
  toolUseContext: ToolUseContext | undefined,
  querySource: QuerySource,
): boolean {
  const profile = getCacheProfile()
  const { candidates, clearableTokens } = collectClearableCandidates(
    messages,
    RELIEF_KEEP_RECENT_TURNS,
    profile.stubKeepHeadChars,
    isCompactableTool,
    clearableInputFieldsFromPool(toolUseContext?.options?.tools),
  )

  const model = getMainLoopModel()
  const view = applyStableInputStubs(applyStableStubs(messages))
  const decision = decideRelief({
    // Real usage: the previous response's counted tokens plus an estimate
    // of what was appended since — the same unit autocompact anchors on.
    // The clip decided here is applied at the wire on THIS request, so the
    // next response's usage already reflects it; no latch needed. Measured
    // over the stubbed view so the estimated part (the tail, or the whole
    // history before any response has usage) also reflects the clipped
    // set — otherwise a request between a clip and its response would
    // count content the wire no longer sends and clip again.
    usedTokens: tokenCountWithEstimation(view),
    effectiveWindow: getEffectiveContextWindowSize(model),
    autocompactThreshold: isAutoCompactEnabled()
      ? getAutoCompactThreshold(model)
      : null,
    retainedFullResultTokens: clearableTokens,
    profile,
    windowLaneEnabled: isReliefWindowLaneEnabled(),
    triggerCap: toolUseContext?.agentId ? subagentReliefTriggerCap() : undefined,
  })
  if (decision.kind === 'none') return false

  // Units. Once a response carried usage, the window lane asks for REAL
  // tokens, while each candidate's savings is a rough estimate at the family
  // ratio (3.5 chars/token for Claude). Tool output tokenizes denser — ~2.4
  // from Opus 4.7 on — so selecting in estimate units freed ~3× what the lane
  // asked: a sub-agent at 263k asked to free 73k lost 204k and re-read it
  // (A/B 2026-09-29). Before any usage both sides are estimates, and the rss
  // lane compares estimates with estimates.
  const realUnits =
    decision.lane === 'window' && view.some(m => getTokenUsage(m) !== undefined)
  const scale = realUnits
      ? getActiveModelBytesPerToken() / getToolOutputBytesPerToken(model)
      : 1
  // The other part of that 204k was thinking. On a preserved-thinking model
  // the request binds each replayed thinking block to its prefix with
  // `drop_block` (streaming.ts), so clipping the oldest result drops every
  // thinking block after it, server-side: ~50k in that sub-agent. It is
  // counted on a thread's FIRST clip only — after one, the thinking produced
  // before it is already gone, and which of it came after is not recorded.
  const firstCandidate = candidates.find(c => c.savings > 0)
  const thinkingDropped =
    realUnits &&
    firstCandidate &&
    modelSupportsThinkingBlockBinding(model) &&
    !holdsClippedResult(view)
      ? thinkingTokensAfter(view, firstCandidate.toolUseId)
      : 0
  const { ids, savings, selected } = selectReliefIds(
    scale === 1
      ? candidates
      : candidates.map(c => ({ ...c, savings: c.savings * scale })),
    // At least the first candidate: its clip is what drops the thinking.
    Math.max(1, decision.tokensToFree - thinkingDropped),
  )
  const freed = savings + thinkingDropped

  // Starved: over the trigger, and the candidates left — none at all, once
  // every old result is a stub and the rest sit in the protected window —
  // cannot free one band (`reliefEventFloor`). The session's floor sits
  // above the target and no clip changes that. Record it once per turn
  // instead of clipping (the `[Cache:]` line is where the next census sees
  // it) and, on the window lane, hand the session to autocompact.
  if (ids.length === 0 || freed < reliefEventFloor(decision)) {
    const short = Math.round((decision.tokensToFree - freed) / 1000)
    logForDebugging(
      `[RELIEF] starved: ${ids.length} candidates free ~${freed} tokens, ~${short}k short of target ${Math.round(decision.target)} (${decision.lane} lane)`,
    )
    if (isMainThreadSource(querySource) && !starvedReportedThisTurn) {
      starvedReportedThisTurn = true
      recordPrefixRewrite(`relief starved (~${short}k short, ${decision.lane} lane)`)
    }
    return decision.lane === 'window'
  }

  // Result side: only ids with a clearable result enter the stub set — its
  // explicit-clip contract stubs whatever it is given, and an input-only id
  // (Patch) would trade a one-line "Success" for a stub of the same
  // size. Input side: every selected id that carries fields.
  const resultIds = selected.filter(c => !c.inputOnly).map(c => c.toolUseId)
  if (resultIds.length > 0) addClippedIds(resultIds)
  const inputsClipped = addClippedInputsFor(selected)

  // Label format is parsed by collapsePrefixRewrites (cacheMetrics.ts) and
  // by the lookback census — keep the shape when changing the words.
  const reason = `relief clip (${resultIds.length} tool results${inputsClipped > 0 ? ` + ${inputsClipped} inputs` : ''}, ~${Math.round(freed / 1000)}k tokens, ${decision.lane} lane)`
  logForDebugging(
    `[RELIEF] ${reason}: trigger ${Math.round(decision.trigger)} → target ${Math.round(decision.target)}`,
  )

  // Announce the rewrite ONCE per clip event: this request's bytes diverge
  // from the cached prefix at the clipped ids, which would otherwise be
  // flagged as a regression. Gated to first-party transports (anthropic /
  // bedrock / vertex) — the OpenAI/Codex shim paths don't feed the same
  // detector state, so calling it there is a no-op write we'd rather skip.
  // The agentId is the tracking key of a sub-agent: without it the flag lands
  // on the querySource's key, which no sub-agent state lives under, and the
  // agent's own clip is reported as a break.
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && isFirstPartyTransport()) {
    notifyCacheDeletion(querySource, toolUseContext?.agentId, reason)
  }
  // The `[Cache: …]` line names the knob that fired; sub-agents keep their
  // clips out of the main thread's line.
  if (isMainThreadSource(querySource)) {
    recordPrefixRewrite(reason)
  }
  return false
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

/** Whether an earlier relief event already clipped anything in this thread. */
function holdsClippedResult(messages: readonly Message[]): boolean {
  const clipped = getClippedIds()
  const clippedInputs = getClippedInputFields()
  if (clipped.size === 0 && clippedInputs.size === 0) return false
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue
    const content = m.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && clipped.has(block.tool_use_id)) return true
      if (block.type === 'tool_use' && clippedInputs.has(block.id)) return true
    }
  }
  return false
}

/**
 * Thinking tokens of the responses recorded AFTER the message holding
 * `toolUseId` (its result, or its call for an input-only candidate) — the
 * thinking whose bound prefix a clip there changes. A response split into
 * several records is counted once, at the largest figure its records carry
 * (a streamed record can hold the usage of an earlier event).
 */
function thinkingTokensAfter(messages: readonly Message[], toolUseId: string): number {
  const at = messages.findIndex(m => {
    if (m.type !== 'user' && m.type !== 'assistant') return false
    const content = m.message.content
    return (
      Array.isArray(content) &&
      content.some(
        b =>
          (b.type === 'tool_result' && b.tool_use_id === toolUseId) ||
          (b.type === 'tool_use' && b.id === toolUseId),
      )
    )
  })
  if (at < 0) return 0
  const byResponse = new Map<string, number>()
  for (const m of messages.slice(at + 1)) {
    if (m.type !== 'assistant') continue
    const usage = getTokenUsage(m) as
      | { output_tokens_details?: { thinking_tokens?: number } }
      | undefined
    const thinking = usage?.output_tokens_details?.thinking_tokens ?? 0
    byResponse.set(m.message.id, Math.max(byResponse.get(m.message.id) ?? 0, thinking))
  }
  let total = 0
  for (const thinking of byResponse.values()) total += thinking
  return total
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

  // Persist the clear through the stable-stub mechanism instead of
  // rewriting the per-request view: ids added to the clipped set are
  // stubbed by applyStableStubs at the wire boundary with deterministic
  // bytes — on this turn AND every following turn — so the post-idle
  // "cleaned" prefix keeps getting cache hits afterwards. The previous
  // view-only rewrite flipped back to the original bytes on the next turn,
  // paying a second full prefix write for the same idle gap.
  const clipped = getClippedIds()
  const newOnes = [...clearSet].filter(id => !clipped.has(id))

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
  const resultsToClip = tokensSaved > 0 ? newOnes : []

  // The prefix is being rewritten regardless, so clipping the INPUTS of the
  // calls older than the kept tail costs nothing here — same registry, same
  // wire rewriter as the relief path. Independent of the result side: a
  // stretch of Patch calls has nothing compactable and still carries
  // the patches.
  const inputFieldsByTool = clearableInputFieldsFromPool(
    toolUseContext?.options?.tools,
  )
  const inputsToClip =
    inputFieldsByTool.size > 0
      ? collectClearableCandidates(
          messages,
          keepRecent,
          getCacheProfile().stubKeepHeadChars,
          isCompactableTool,
          inputFieldsByTool,
        ).candidates.filter(c => c.inputFields !== undefined)
      : []

  if (resultsToClip.length === 0 && inputsToClip.length === 0) {
    return null
  }

  if (resultsToClip.length > 0) addClippedIds(resultsToClip)
  const inputsClipped = addClippedInputsFor(inputsToClip)

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, clipped ${resultsToClip.length} tool results (~${tokensSaved} tokens) and ${inputsClipped} inputs, kept last ${keepSet.size}`,
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
      `idle-gap clip (${resultsToClip.length} tool results${inputsClipped > 0 ? ` + ${inputsClipped} inputs` : ''} after ${Math.round(gapMinutes)}min)`,
    )
  }

  // The view is returned unchanged — applyStableStubs at the request
  // boundary rewrites the clipped blocks. Returning here (instead of
  // falling through) keeps the old contract: the size-based path does not
  // also run on a time-trigger turn.
  return { messages }
}
