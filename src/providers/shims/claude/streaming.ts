import type {
  BetaContentBlock,
  BetaContextManagementResponse,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolUnion,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { Stream } from "@anthropic-ai/sdk/streaming.mjs";
import { randomUUID } from "crypto";
import {
  activeTransportUsesOpenAiShim,
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from "src/providers/model/providers.js";
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from "src/agent/prompts/system.js";
import { type Tool, type Tools, toolMatchesName } from "src/tools/Tool.js";
import type {
  ConnectorTextBlock,
  ConnectorTextDelta,
} from "src/shared/types/connectorText.js";
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from "src/shared/types/message.js";
import { logAPIPrefix, toolToAPISchema } from "src/providers/transport/api.js";
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
} from "src/providers/transport/betas.js";
import { getGlobalConfig } from "src/platform/config/config.js";
import { getSonnet1mExpTreatmentEnabled } from "src/agent/context/context.js";
import { getThinkingBudgetForEffort, resolveAppliedEffort } from "src/providers/effort/effort.js";
import { isEnvDefinedFalsy, isEnvTruthy } from "src/shared/envUtils.js";
import {
  errorMessage,
  isSdkApiError,
  isSdkApiUserAbortError,
} from "src/shared/errors.js";
import { computeFingerprintFromMessages } from "src/shared/data/fingerprint.js";
import { captureAPIRequest } from "src/shared/log.js";
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripOldNarrationBlocks,
  stripOldThinkingBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from "src/agent/messages/messages.js";
import { isNonCustomOpusModel } from "src/providers/model/model.js";
import {
  asSystemPrompt,
  type SystemPrompt,
} from "src/agent/systemPromptType.js";
import { tokenCountFromLastAPIResponse } from "src/agent/context/tokens.js";
import { getDynamicConfig_BLOCKS_ON_INIT } from "src/platform/analytics/growthbook.js";
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from "src/providers/claudeAiLimits.js";
import { getAPIContextManagement } from "src/agent/cache/anthropic/apiMicrocompact.js";
import {
  applyStableStubs,
  getClipFrontierIndex,
  isClipFrontierEnabled,
} from "src/agent/compact/stableStubState.js";
import { getCacheProfile } from "src/agent/cache/cacheProfile.js";

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature("TRANSCRIPT_CLASSIFIER")
  ? (require("src/permissions/autoModeState.js") as typeof import("src/permissions/autoModeState.js"))
  : null;

import { feature } from "bun:bundle";
import {
  APIConnectionTimeoutError,
  type APIError,
} from "@anthropic-ai/sdk/error";
import {
  getAfkModeHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getThinkingClearLatched,
  isLspDeferLatched,
  latchLspDefer,
  setAfkModeHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setThinkingClearLatched,
} from "src/platform/bootstrap/state.js";
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EXTENDED_CACHE_TTL_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
} from "src/shared/constants/betas.js";
import { addToTotalSessionCost } from "src/agent/cost-tracker.js";
import { getFeatureValue_CACHED_MAY_BE_STALE } from "src/platform/analytics/growthbook.js";
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from "src/platform/doctor/advisor.js";
import { getAgentContext } from "src/agent/coordinator/agentContext.js";
import { isClaudeAISubscriber } from "src/providers/auth/auth.js";
import { createCombinedAbortSignal } from "src/shared/combinedAbortSignal.js";
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from "src/providers/transport/betas.js";
import { logForDebugging } from "src/shared/debug.js";
import { logForDiagnosticsNoPII } from "src/shared/diagLogs.js";
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from "src/providers/fastMode.js";
import { headlessProfilerCheckpoint } from "src/platform/headlessProfiler.js";
import { calculateUSDCost } from "src/providers/usage/modelCost.js";
import { endQueryProfile, queryCheckpoint } from "src/agent/queryProfiler.js";
import {
  isAdaptiveThinkingEnabled,
  modelRequiresAdaptiveThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from "src/agent/context/thinking.js";
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaActive,
  isToolSearchEnabled,
  maybeLatchLegacyDeferredAnnouncement,
} from "src/agent/tools/toolSearch.js";
import { API_MAX_MEDIA_PER_REQUEST } from "src/shared/constants/apiLimits.js";
import { ADVISOR_BETA_HEADER } from "src/shared/constants/betas.js";
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from "src/tools/ToolSearchTool/prompt.js";
import { count } from "src/shared/data/array.js";
import { getInferenceProfileBackingModel } from "src/providers/model/bedrock.js";
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from "src/providers/model/model.js";
import {
  startSessionActivity,
  stopSessionActivity,
} from "src/sessions/sessionActivity.js";
import { jsonStringify } from "src/platform/slowOperations.js";
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from "src/platform/telemetry/sessionTracing.js";
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from "src/platform/analytics/index.js";
import { getInitializationStatus } from "src/platform/lsp/manager.js";
import { withStreamingVCR } from "src/providers/vcr.js";
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from "src/providers/transport/client.js";
import { getCachedAnthropicClient, invalidateClientCache } from "src/providers/transport/clientCache.js";
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from "src/providers/transport/errors.js";
import { extractOpenAICategoryMarker } from "src/providers/shims/openaiErrorClassification.js";
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from "src/providers/transport/logging.js";
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from "src/providers/cache/promptCacheBreakDetection.js";
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from "src/providers/transport/withRetry.js";
import { should1hCacheTTL } from "src/providers/shims/claude/cacheControl.js";
import {
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  configureEffortParams,
  configureTaskBudgetParams,
  getExtraBodyParams,
  getMaxOutputTokensForModel,
  getPromptCachingEnabled,
} from "src/providers/shims/claude/paramBuilders.js";
import { getAPIMetadata } from "src/providers/shims/claude/metadata.js";
import {
  getPreviousRequestIdFromMessages,
  stripExcessMediaItems,
} from "src/providers/shims/claude/messageConverters.js";
import { executeNonStreamingRequest } from "src/providers/shims/claude/nonStreamingRequest.js";
import type { Options, TaskBudgetParam } from "src/providers/shims/claude/types.js";

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[];
  systemPrompt: SystemPrompt;
  thinkingConfig: ThinkingConfig;
  tools: Tools;
  signal: AbortSignal;
  options: Options;
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    );
  });
}

/**
 * Determines if an LSP tool should be deferred (tool appears with defer_loading: true)
 * because LSP initialization is not yet complete.
 *
 * Sticky per session (same pattern as the beta-header latches below): once a
 * tool has been SENT deferred, it keeps being sent deferred even after the
 * LSP becomes ready — flipping defer_loading true→false mid-session adds the
 * schema to the effective tools array (the API strips deferred schemas from
 * the prompt) and busts the entire cached prefix. The tool stays reachable
 * via ToolSearch. The latch clears with clearBetaHeaderLatches() on /clear
 * and /compact (cache-cold moments); an LSP that initializes before the
 * first request never latches.
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!("isLsp" in tool) || !tool.isLsp) {
    return false;
  }
  if (isLspDeferLatched(tool.name)) {
    return true;
  }
  const status = getInitializationStatus();
  // Defer when pending or not started
  const defer = status.status === "pending" || status.status === "not-started";
  if (defer) {
    latchLspDefer(tool.name);
  }
  return defer;
}

export async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // Check cheap conditions first — the off-switch await blocks on GrowthBook
  // init (~10ms). For non-Opus models (haiku, sonnet) this skips the await
  // entirely. Subscribers don't hit this path at all.
  if (
    !isClaudeAISubscriber() &&
    isNonCustomOpusModel(options.model) &&
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        "tengu-off-switch",
        {
          activated: false,
        },
      )
    ).activated
  ) {
    logEvent("tengu_off_switch_query", {});
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    );
    return;
  }

  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages);

  const resolvedModel =
    getAPIProvider() === "bedrock" &&
    options.model.includes("application-inference-profile")
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model;

  queryCheckpoint("query_tool_schema_build_start");
  const isAgenticQuery =
    options.querySource.startsWith("repl_main_thread") ||
    options.querySource.startsWith("agent:") ||
    options.querySource === "sdk" ||
    options.querySource === "hook_agent";
  let betas = getMergedBetas(options.model, { isAgenticQuery });

  // Always send the advisor beta header when advisor is enabled, so
  // non-agentic queries (compact, side_question, extract_memories, etc.)
  // can parse advisor server_tool_use blocks already in the conversation history.
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER);
  }

  let advisorModel: string | undefined;
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel;

    const advisorExperiment = getExperimentAdvisorModels();
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // Override the advisor model if the base model matches. We
        // should only have experiment models if the user cannot
        // configure it themselves.
        advisorOption = advisorExperiment.advisorModel;
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      );
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        );
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        );
      } else {
        advisorModel = normalizedAdvisorModel;
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        );
      }
    }
  }

  // Settle the deferred-tools announcement format BEFORE tool schemas are
  // built: the ToolSearchTool location hint (rendered during schema build)
  // and the announcement mechanism (prepend vs delta attachment, further
  // down) must agree within the request. Latches sessions resumed with a
  // potentially-warm legacy-format cache to the legacy prepend. Sidechain
  // queries (agent:* / hook_agent) scan THEIR history, which must never
  // settle the process-wide latch — see LegacyLatchScanOptions.
  maybeLatchLegacyDeferredAnnouncement(messages, {
    subagent:
      options.querySource.startsWith("agent:") ||
      options.querySource === "hook_agent",
  });

  // Check if tool search is enabled (checks mode, model support, and threshold for auto mode)
  // This is async because it may need to calculate MCP tool description sizes for TstAuto mode
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    "query",
  );

  // Precompute once — isDeferredTool does 2 GrowthBook lookups per call
  const deferredToolNames = new Set<string>();
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name);
    }
  }

  // Even if tool search mode is enabled, skip if there are no deferred tools
  // AND no MCP servers are still connecting. When servers are pending, keep
  // ToolSearch available so the model can discover tools after they connect.
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      "Tool search disabled: no deferred tools available to search",
    );
    useToolSearch = false;
  }

  // Filter out ToolSearchTool if tool search is not enabled for this model
  // ToolSearchTool returns tool_reference blocks which unsupported models can't handle
  let filteredTools: Tools;

  if (useToolSearch) {
    // Dynamic tool loading: Only include deferred tools that have been discovered
    // via tool_reference blocks in the message history. This eliminates the need
    // to predeclare all deferred tools upfront and removes limits on tool quantity.
    const discoveredToolNames = extractDiscoveredToolNames(messages);

    filteredTools = tools.filter((tool) => {
      // Always include non-deferred tools
      if (!deferredToolNames.has(tool.name)) return true;
      // Always include ToolSearchTool (so it can discover more tools)
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true;
      // Only include deferred tools that have been discovered
      return discoveredToolNames.has(tool.name);
    });
  } else {
    filteredTools = tools.filter(
      (t) => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    );
  }

  // Add tool search beta header if enabled - required for defer_loading to be accepted
  // Header differs by provider: 1P/Foundry use advanced-tool-use, Vertex/Bedrock use tool-search-tool
  // For Bedrock, this header must go in extraBodyParams, not the betas array
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null;
  if (toolSearchHeader && getAPIProvider() !== "bedrock") {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader);
    }
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope();
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t));
  // MCP tools are per-user → dynamic tool section → can't globally cache.
  // Only gate when an MCP tool will actually render (not defer_loading).
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some((t) => t.isMcp === true && !willDefer(t));

  // Ensure prompt_caching_scope beta header is present when global cache is enabled.
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER);
  }

  // Determine global cache strategy for logging
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? "none"
      : "system_prompt"
    : "none";

  // Build tool schemas, adding defer_loading for MCP tools when tool search is enabled
  // Note: We pass the full `tools` list (not filteredTools) to toolToAPISchema so that
  // ToolSearchTool's prompt can list ALL available MCP tools. The filtering only affects
  // which tools are actually sent to the API, not what the model sees in tool descriptions.
  const toolSchemas = await Promise.all(
    filteredTools.map((tool) =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  );

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, (t) =>
      deferredToolNames.has(t.name),
    );
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    );
  }

  queryCheckpoint("query_tool_schema_build_end");

  // Normalize messages before building system prompt (needed for fingerprinting)
  // Instrumentation: Track message count before normalization
  logEvent("tengu_api_before_normalize", {
    preNormalizedMessageCount: messages.length,
  });

  queryCheckpoint("query_message_normalization_start");
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools);
  queryCheckpoint("query_message_normalization_end");

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
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map((msg) => {
      switch (msg.type) {
        case "user":
          // Strip tool_reference blocks from tool_result content
          return stripToolReferenceBlocksFromUserMessage(msg);
        case "assistant":
          // Strip 'caller' field from tool_use blocks
          return stripCallerFieldFromAssistantMessage(msg);
        default:
          return msg;
      }
    });
  }

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // remote/teleport sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
  messagesForAPI = ensureToolResultPairing(messagesForAPI);

  // Apply stable stubs to tool_result blocks whose ids are in the per-session
  // clipped set. No-op when the set is empty. Bytes are deterministic across
  // turns so the prompt cache prefix stays stable after the first clip.
  //
  // Invariant: applyStableStubs MUST run after ensureToolResultPairing
  // (so tool_use_ids are valid) and BEFORE addCacheBreakpoints places
  // the cache_control marker. The stable bytes need to live inside the
  // cached prefix.
  messagesForAPI = applyStableStubs(messagesForAPI);

  // Strip advisor blocks — the API rejects them without the beta header.
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI);
  }

  // Client-side thinking/narration history redactions. Profile-gated: under
  // the retain cache profile they are skipped entirely — their keep windows
  // hold the last 2 assistant turns permanently mutable, pinning the clip
  // frontier behind them and re-billing every big tool_result at 1.0× for 2
  // turns before it can freeze, to save only ~50-200 tokens of text. Old
  // thinking/narration is byte-stable when never stripped, so it freezes
  // into the cached prefix and costs 0.1× thereafter.
  const historyRedactionActive = getCacheProfile().historyRedactionEnabled;
  if (historyRedactionActive && getGlobalConfig().thinkingHistoryRedactionEnabled) {
    messagesForAPI = stripOldThinkingBlocks(messagesForAPI, 2);
  }
  if (historyRedactionActive && getGlobalConfig().narrationHistoryRedactionEnabled) {
    messagesForAPI = stripOldNarrationBlocks(messagesForAPI, 2);
  }

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  const beforeMediaStrip = messagesForAPI;
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  );
  // Past the media cap, the strip rewrites the OLDEST media-bearing blocks
  // turn by turn as new media arrives — image-bearing tool_results stop
  // being byte-stable, and the clip frontier must treat them as mutable.
  const mediaCapActive = messagesForAPI !== beforeMediaStrip;

  // Instrumentation: Track message count after normalization
  logEvent("tengu_api_after_normalize", {
    postNormalizedMessageCount: messagesForAPI.length,
  });

  // Compute fingerprint from first user message for attribution.
  // Must run BEFORE injecting synthetic messages (e.g. deferred tool names)
  // so the fingerprint reflects the actual user input.
  const fingerprint = computeFingerprintFromMessages(messagesForAPI);

  // When the delta attachment is active, deferred tools are announced
  // via persisted deferred_tools_delta attachments instead of this
  // ephemeral prepend (which busts cache whenever the pool changes).
  // "Active" = flag on AND not latched to the legacy format by
  // maybeLatchLegacyDeferredAnnouncement above.
  if (useToolSearch && !isDeferredToolsDeltaActive()) {
    const deferredToolList = tools
      .filter((t) => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join("\n");
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ];
    }
  }

  // filter(Boolean) works by converting each element to a boolean - empty strings become false and are filtered out.
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ].filter(Boolean),
  );

  // Prepend system prompt block for easy API identification
  logAPIPrefix(systemPrompt);

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model);
  let system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  });
  const useBetas = betas.length > 0;

  // Build minimal context for detailed tracing (when beta tracing is enabled)
  // Note: The actual new_context message extraction is done in sessionTracing.ts using
  // hash-based tracking per querySource (agent) from the messagesForAPI array
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])];
  if (advisorModel) {
    // Server tools must be in the tools array by API contract. Appended after
    // toolSchemas (which carries the cache_control marker) so toggling /advisor
    // only churns the small suffix, not the cached prefix.
    extraToolSchemas.push({
      type: "advisor_20260301",
      name: "advisor",
      model: advisorModel,
    } as unknown as BetaToolUnion);
  }
  let allTools = [...toolSchemas, ...extraToolSchemas];

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode;

  // Sticky-on latches for dynamic beta headers. Each header, once first
  // sent, keeps being sent for the rest of the session so mid-session
  // toggles don't change the server-side cache key and bust ~50-70K tokens.
  // Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
  // Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
  // per-call so non-agentic queries keep their own stable header set.

  let afkHeaderLatched = getAfkModeHeaderLatched() === true;
  if (feature("TRANSCRIPT_CLASSIFIER")) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true;
      setAfkModeHeaderLatched(true);
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true;
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true;
    setFastModeHeaderLatched(true);
  }

  // Only latch from agentic queries so a classifier call doesn't flip the
  // main thread's context_management mid-turn.
  let thinkingClearLatched = getThinkingClearLatched() === true;
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp();
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true;
      setThinkingClearLatched(true);
    }
  }

  // Latch Sonnet 1M experiment at query start so mid-retry GB refreshes
  // don't flip the beta header and bust the cache key.
  const sonnet1mExpLatched = getSonnet1mExpTreatmentEnabled(options.model);

  const effort = resolveAppliedEffort(options.model, options.effortValue);

  // `effortValue` is a shim-only param consumed by openaiShim's messages client;
  // the native Anthropic SDK (anthropic/bedrock/vertex/foundry, and
  // github_copilot running a Claude model) forwards unknown body fields to the
  // API, which 400s with "Extra inputs are not permitted". Only attach it when
  // this request actually routes through the shim (model-aware for Copilot).
  const includeShimEffortValue = activeTransportUsesOpenAiShim(options.model);

  if (feature("PROMPT_CACHE_BREAK_DETECTION")) {
    // Exclude defer_loading tools from the hash -- the API strips them from the
    // prompt, so they never affect the actual cache key. Including them creates
    // false-positive "tool schemas changed" breaks when tools are discovered or
    // MCP servers reconnect.
    const toolsForCacheDetection = allTools.filter(
      (t) => !("defer_loading" in t && t.defer_loading),
    );
    // Capture everything that could affect the server-side cache key.
    // Pass latched header values (not live state) so break detection
    // reflects what we actually send, not what the user toggled.
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    });
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join("\n\n"),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined;

  // Capture the span so we can pass it to endLLMRequestSpan later
  // This ensures responses are matched to the correct request when multiple requests run in parallel
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  );

  const startIncludingRetries = Date.now();
  let start = Date.now();
  let attemptNumber = 0;
  const attemptStartTimes: number[] = [];
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined;
  let streamRequestId: string | null | undefined = undefined;
  let clientRequestId: string | undefined = undefined;
  // Precomputed inside finally before heavy captures (system, messagesForAPI,
  // allTools, betas) are nulled out, so the post-finally logger doesn't pin
  // the full conversation array.
  let logMessageCount = 0;
  let logMessageTokens = 0;
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined;

  // Release all stream resources to prevent native memory leaks.
  // The Response object holds native TLS/socket buffers that live outside the
  // V8 heap (observed on the Node.js/npm path; see GH #32920), so we must
  // explicitly cancel and release it regardless of how the generator exits.
  function releaseStreamResources(): void {
    cleanupStream(stream);
    stream = undefined;
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {});
      streamResponse = undefined;
    }
  }

  // Capture the betas sent in the last API request, including the ones that
  // were dynamically added, so we can log and send it to telemetry.
  let lastRequestBetas: string[] | undefined;

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas];

    // Append 1M beta from the latched experiment state (computed once before
    // the closure to avoid mid-retry GB flips changing the cache key).
    if (!betasParams.includes(CONTEXT_1M_BETA_HEADER) && sonnet1mExpLatched) {
      betasParams.push(CONTEXT_1M_BETA_HEADER);
    }

    // When the request emits cache_control ttl:'1h' (large-prompt path, see
    // getCacheControl), the API only honors it with this beta header — without
    // it the TTL silently downgrades to 5m and the ~47K cached prefix gets
    // re-written on any pause >5m. The decision rides the session-stable
    // large-prompt latch, so the header stays put across retries/turns.
    // Bedrock carries its 1h opt-in via extraBodyParams, not the betas array.
    if (
      should1hCacheTTL(options.querySource) &&
      getAPIProvider() !== "bedrock" &&
      !betasParams.includes(EXTENDED_CACHE_TTL_BETA_HEADER)
    ) {
      betasParams.push(EXTENDED_CACHE_TTL_BETA_HEADER);
    }

    // For Bedrock, include both model-based betas and dynamically-added tool search header
    const bedrockBetas =
      getAPIProvider() === "bedrock"
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : [];
    const extraBodyParams = getExtraBodyParams(bedrockBetas);

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    };

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    );

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    );

    // Merge outputFormat into extraBodyParams.output_config alongside effort
    // Requires structured-outputs beta header per SDK (see parse() in messages.mjs)
    if (options.outputFormat && !("format" in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat;
      // Add beta header if not already present and provider supports it
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER);
      }
    }

    // Retry context gets preference because it tries to course correct if we exceed the context window limit
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model);

    const hasThinking =
      thinkingConfig.type !== "disabled" &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING);
    let thinking: BetaMessageStreamParams["thinking"] | undefined = undefined;

    // When redact-thinking is active the server already resolves the thinking
    // display to "omitted"; set it explicitly so the thinking-token-count beta
    // reliably emits per-frame `estimated_tokens` (whose precondition is an
    // omitted display) and the live token counter keeps moving during a long
    // redacted thinking phase. Gated strictly on redact-thinking being active,
    // so the showThinkingSummaries / non-first-party / non-interactive paths
    // (where the user wants the thinking text) are never affected.
    const thinkingDisplay: "omitted" | undefined = betasParams.includes(
      REDACT_THINKING_BETA_HEADER,
    )
      ? "omitted"
      : undefined;

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        // Fable-class models reject budget-mode thinking (400) — adaptive is
        // the only accepted configuration, so it wins over the opt-out too.
        modelRequiresAdaptiveThinking(options.model) ||
        // Adaptive is the default for models that support it; opt out with
        // CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING=0 to use /effort budget mode.
        (isAdaptiveThinkingEnabled() &&
          modelSupportsAdaptiveThinking(options.model))
      ) {
        // For models that support adaptive thinking, always use adaptive
        // thinking without a budget.
        thinking = {
          type: "adaptive",
          ...(thinkingDisplay ? { display: thinkingDisplay } : {}),
        } satisfies BetaMessageStreamParams["thinking"];
      } else {
        // Derive the thinking budget from /effort so the user has direct
        // control over first-token latency. Explicit budgetTokens (set via
        // settings or MAX_THINKING_TOKENS) still wins.
        let thinkingBudget = getThinkingBudgetForEffort(options.effortValue);
        if (
          thinkingConfig.type === "enabled" &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens;
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget);
        thinking = {
          budget_tokens: thinkingBudget,
          type: "enabled",
          ...(thinkingDisplay ? { display: thinkingDisplay } : {}),
        } satisfies BetaMessageStreamParams["thinking"];
      }
    }

    // Get API context management strategies if enabled
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    });

    const enablePromptCaching =
      options.enablePromptCaching ??
      getPromptCachingEnabled(retryContext.model);

    // Fast mode: header is latched session-stable (cache-safe), but
    // `speed='fast'` stays dynamic so cooldown still suppresses the actual
    // fast-mode request without changing the cache key.
    let speed: BetaMessageStreamParams["speed"];
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode;
    if (isFastModeForRetry) {
      speed = "fast";
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER);
    }

    // AFK mode beta: latched once auto mode is first activated. Still gated
    // by isAgenticQuery per-call so classifiers/compaction don't get it.
    if (feature("TRANSCRIPT_CLASSIFIER")) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER);
      }
    }

    // Only send temperature when thinking is disabled — the API requires
    // temperature: 1 when thinking is enabled, which is already the default.
    // Fable-class models reject the temperature param outright (400), even
    // with thinking off — never send it there.
    const temperature =
      !hasThinking && !modelRequiresAdaptiveThinking(options.model)
        ? (options.temperatureOverride ?? 1)
        : undefined;

    lastRequestBetas = betasParams;

    // Clip-frontier breakpoint cap (CLAUDIN_CLIP_FRONTIER=1, experimental).
    // Computed on the exact array handed to addCacheBreakpoints — including
    // the retry-path re-strip below — so the stability judgment matches the
    // wire bytes. The frontier marks where "everything behind is byte-stable
    // across turns" ends; capping the marker there means the age prune /
    // clip set / history redactions only ever rewrite the uncached tail,
    // eliminating the per-turn prefix invalidation. See getClipFrontierIndex.
    const messagesForRequest = retryContext.stripThinkingFromHistory
      ? stripOldThinkingBlocks(messagesForAPI, 0)
      : messagesForAPI;
    let clipFrontierIndex: number | undefined;
    if (isClipFrontierEnabled() && !options.skipCacheWrite) {
      const cfg = getGlobalConfig();
      const cacheProfile = getCacheProfile();
      // When the profile disables the history redactions, thinking/narration
      // blocks never mutate — they are stable and may be frozen.
      const redactionsActive = cacheProfile.historyRedactionEnabled;
      clipFrontierIndex = getClipFrontierIndex(messagesForRequest, {
        thinkingIsMutable:
          redactionsActive && cfg.thinkingHistoryRedactionEnabled,
        narrationIsMutable:
          redactionsActive && cfg.narrationHistoryRedactionEnabled,
        // Retain profile disables the age prune → full tool_results are
        // byte-stable and may be frozen behind the marker.
        agePruneActive: Number.isFinite(cacheProfile.keepTurns),
        imagesAreMutable: mediaCapActive,
      });
    }

    // Single render shared by the wire request and the opt-in annotation
    // dump below — rendering twice would double the O(n) walk and the
    // tengu_api_cache_breakpoints event, and any drift between the two
    // renders would make the diagnostic lie about the wire bytes.
    const renderedMessages = addCacheBreakpoints(
      messagesForRequest,
      enablePromptCaching,
      options.querySource,
      options.skipCacheWrite,
      clipFrontierIndex,
    );

    // Opt-in wire-annotation dump (CLAUDIN_DUMP_CACHE_ANNOTATIONS=1): logs
    // where every cache_control landed and with which TTL. Diagnostic for
    // mixed 5m/1h TTL chains (server-side resets at ~5min of session age).
    if (process.env.CLAUDIN_DUMP_CACHE_ANNOTATIONS === '1') {
      try {
        type CCAnnotation = { ttl?: string; scope?: string };
        const ann: string[] = [];
        for (let si = 0; si < system.length; si++) {
          const cc = (system[si] as { cache_control?: CCAnnotation }).cache_control;
          if (cc) ann.push(`system[${si}]:ttl=${cc.ttl ?? '5m-default'}${cc.scope ? `,scope=${cc.scope}` : ''}`);
        }
        const toolsWithCC = (allTools as Array<{ cache_control?: CCAnnotation }>).filter(t => t.cache_control);
        for (const t of toolsWithCC) {
          ann.push(`tool:${(t as { name?: string }).name}:ttl=${t.cache_control?.ttl ?? '5m-default'}`);
        }
        renderedMessages.forEach((m, mi) => {
          if (!Array.isArray(m.content)) return;
          m.content.forEach((b, bi) => {
            const cc = (b as { cache_control?: CCAnnotation }).cache_control;
            if (cc) ann.push(`msg[${mi}].block[${bi}](${(b as { type?: string }).type}):ttl=${cc.ttl ?? '5m-default'}`);
          });
        });
        process.stderr.write(`[CACHE-ANNOTATIONS] ${ann.join(' | ')}\n`);
      } catch { /* diagnostic only */ }
    }

    return {
      model: normalizeModelStringForAPI(options.model),
      // IMPORTANT: `system` must appear before `messages` in the object literal.
      // JSON.stringify preserves insertion order. The native Bun attestation
      // (Attestation.zig) overwrites the FIRST `cch=00000` sentinel in the
      // serialized body. If `messages` is serialized first and conversation
      // history contains this literal string, the wrong occurrence is replaced,
      // producing a different system prompt on each request and breaking cache.
      system,
      messages: renderedMessages,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
      // Pass through the user-selected effort level so OpenAI-compatible shims
      // (OpenAI/Codex reasoning_effort, DeepSeek reasoning_effort, Kimi
      // thinking.effort) can apply it per-request. Gated to shim transports —
      // native Anthropic rejects it as an unknown body field.
      ...(includeShimEffortValue && { effortValue: options.effortValue }),
    };
  };

  // Compute log scalars synchronously so the fire-and-forget .then() closure
  // captures only primitives instead of paramsFromContext's full closure scope
  // (messagesForAPI, system, allTools, betas — the entire request-building
  // context), which would otherwise be pinned until the promise resolves.
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    });
    const logMessagesLength = queryParams.messages.length;
    const logBetas = useBetas ? (queryParams.betas ?? []) : [];
    const logThinkingType = queryParams.thinking?.type ?? "disabled";
    const logEffortValue = queryParams.output_config?.effort;
    // Observability for the reasoning-channel: if Anthropic-native requests
    // ever stop opting into the `thinking` block, CoT can leak into visible
    // text. Mirroring the [OpenAIShim] log style so regressions show up in
    // CLAUDE_DEBUG output without ad-hoc instrumentation.
    logForDebugging(
      `[Claude] thinking=${logThinkingType} model=${options.model}`,
    );
    void options.getToolPermissionContext().then((permissionContext) => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      });
    });
  }

  const newMessages: AssistantMessage[] = [];
  let ttftMs = 0;
  let partialMessage: BetaMessage | undefined = undefined;
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = [];
  let usage: NonNullableUsage = EMPTY_USAGE;
  let costUSD = 0;
  let stopReason: BetaStopReason | null = null;
  let didFallBackToNonStreaming = false;
  let fallbackMessage: AssistantMessage | undefined;
  let maxOutputTokens = 0;
  let responseHeaders: globalThis.Headers | undefined = undefined;
  let isFastModeRequest = isFastMode; // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false;

  // Wrap external signal with a per-query combined signal so SDK abort listeners
  // are isolated to a controller we throw away after the query. The Anthropic
  // SDK's fetchWithTimeout (client.mjs:332) registers
  // `signal.addEventListener('abort', abort, { once: true })` but only
  // auto-removes on abort — successful requests leak the listener on the
  // parent (session-lifetime) signal, pinning the request's AbortController,
  // Response, and stack frames. Routing the SDK through `sdkSignal` confines
  // those leaks to a controller that's GC'd as soon as `cleanupSdkSignal`
  // runs in `finally`.
  const { signal: sdkSignal, cleanup: cleanupSdkSignal } =
    createCombinedAbortSignal(signal);

  try {
    queryCheckpoint("query_client_creation_start");
    const generator = withRetry(
      () =>
        getCachedAnthropicClient(getAnthropicClient, {
          maxRetries: 0, // Disabled auto-retry in favor of manual implementation
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt;
        isFastModeRequest = context.fastMode ?? false;
        start = Date.now();
        attemptStartTimes.push(start);
        // Client has been created by withRetry's getClient() call. This fires
        // once per attempt; on retries the client is usually cached (withRetry
        // only calls getClient() again after auth errors), so the delta from
        // client_creation_start is meaningful on attempt 1.
        queryCheckpoint("query_client_creation_end");

        const params = paramsFromContext(context);
        captureAPIRequest(params, options.querySource); // Capture for bug reports

        maxOutputTokens = params.max_tokens;

        // Fire immediately before the fetch is dispatched. .withResponse() below
        // awaits until response headers arrive, so this MUST be before the await
        // or the "Network TTFB" phase measurement is wrong.
        queryCheckpoint("query_api_request_sent");
        if (!options.agentId) {
          headlessProfilerCheckpoint("api_request_sent");
        }

        // Generate and track client request ID so timeouts (which return no
        // server request ID) can still be correlated with server logs.
        // First-party only — 3P providers don't log it (inc-4029 class).
        clientRequestId =
          getAPIProvider() === "firstParty" && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined;

        // Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
        // BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
        // since we handle tool input accumulation ourselves
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal: sdkSignal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse();
        queryCheckpoint("query_response_headers_received");
        streamRequestId = result.request_id;
        streamResponse = result.response;
        return result.data;
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal: sdkSignal,
        querySource: options.querySource,
      },
    );

    let e: Awaited<ReturnType<typeof generator.next>>;
    do {
      e = await generator.next();

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      if (!("controller" in e.value)) {
        yield e.value;
      }
    } while (!e.done);
    stream = e.value as Stream<BetaRawMessageStreamEvent>;

    // reset state
    newMessages.length = 0;
    ttftMs = 0;
    partialMessage = undefined;
    contentBlocks.length = 0;
    usage = EMPTY_USAGE;
    stopReason = null;
    isAdvisorInProgress = false;

    // Streaming idle timeout watchdog: abort the stream if no chunks arrive
    // for STREAM_IDLE_TIMEOUT_MS. Unlike the stall detection below (which only
    // fires when the *next* chunk arrives), this uses setTimeout to actively
    // kill hung streams. Without this, a silently dropped connection can hang
    // the session indefinitely since the SDK's request timeout only covers the
    // initial fetch(), not the streaming body.
    // On by default; set CLAUDE_ENABLE_STREAM_WATCHDOG=0 to opt out.
    const streamWatchdogEnabled = !isEnvDefinedFalsy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    );
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || "", 10) || 65_000;
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2;
    let streamIdleAborted = false;
    // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
    let streamWatchdogFiredAt: number | null = null;
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null;
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null;
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer);
        streamIdleWarningTimer = null;
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer);
        streamIdleTimer = null;
      }
    }
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers();
      if (!streamWatchdogEnabled) {
        return;
      }
      streamIdleWarningTimer = setTimeout(
        (warnMs) => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: "warn" },
          );
          logForDiagnosticsNoPII("warn", "cli_streaming_idle_warning");
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      );
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true;
        streamWatchdogFiredAt = performance.now();
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: "error" },
        );
        logForDiagnosticsNoPII("error", "cli_streaming_idle_timeout");
        logEvent("tengu_streaming_idle_timeout", {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        });
        releaseStreamResources();
      }, STREAM_IDLE_TIMEOUT_MS);
    }
    resetStreamIdleTimer();

    startSessionActivity("api_call");
    try {
      // stream in and accumulate state
      let isFirstChunk = true;
      let lastEventTime: number | null = null; // Set after first chunk to avoid measuring TTFB as a stall
      const STALL_THRESHOLD_MS = 30_000; // 30 seconds
      let totalStallTime = 0;
      let stallCount = 0;

      for await (const part of stream) {
        resetStreamIdleTimer();
        const now = Date.now();

        // Detect and log streaming stalls (only after first event to avoid counting TTFB)
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime;
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++;
            totalStallTime += timeSinceLastEvent;
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: "warn" },
            );
            logEvent("tengu_streaming_stall", {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
          }
        }
        lastEventTime = now;

        if (isFirstChunk) {
          logForDebugging("Stream started - received first chunk");
          queryCheckpoint("query_first_chunk_received");
          if (!options.agentId) {
            headlessProfilerCheckpoint("first_chunk");
          }
          endQueryProfile();
          isFirstChunk = false;
        }

        switch (part.type) {
          case "message_start": {
            partialMessage = part.message;
            ttftMs = Date.now() - start;
            usage = updateUsage(usage, part.message?.usage);
            break;
          }
          case "content_block_start":
            switch (part.content_block.type) {
              case "tool_use":
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: "",
                };
                break;
              case "server_tool_use":
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: "" as unknown as { [key: string]: unknown },
                };
                if ((part.content_block.name as string) === "advisor") {
                  isAdvisorInProgress = true;
                  logForDebugging(`[AdvisorTool] Advisor tool called`);
                  logEvent("tengu_advisor_tool_call", {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  });
                }
                break;
              case "text":
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // awkwardly, the sdk sometimes returns text as part of a
                  // content_block_start message, then returns the same text
                  // again in a content_block_delta message. we ignore it here
                  // since there doesn't seem to be a way to detect when a
                  // content_block_delta message duplicates the text.
                  text: "",
                };
                break;
              case "thinking":
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // also awkward
                  thinking: "",
                  // initialize signature to ensure field exists even if signature_delta never arrives
                  signature: "",
                };
                break;
              default:
                // even more awkwardly, the sdk mutates the contents of text blocks
                // as it works. we want the blocks to be immutable, so that we can
                // accumulate state ourselves.
                contentBlocks[part.index] = { ...part.content_block };
                if (
                  (part.content_block.type as string) === "advisor_tool_result"
                ) {
                  isAdvisorInProgress = false;
                  logForDebugging(`[AdvisorTool] Advisor tool result received`);
                }
                break;
            }
            break;
          case "content_block_delta": {
            const contentBlock = contentBlocks[part.index];
            const delta = part.delta as typeof part.delta | ConnectorTextDelta;
            if (!contentBlock) {
              logEvent("tengu_streaming_error", {
                error_type:
                  "content_block_not_found_delta" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              });
              throw new RangeError("Content block not found");
            }
            if (
              feature("CONNECTOR_TEXT") &&
              delta.type === "connector_text_delta"
            ) {
              if (contentBlock.type !== "connector_text") {
                logEvent("tengu_streaming_error", {
                  error_type:
                    "content_block_type_mismatch_connector_text" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    "connector_text" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
                throw new Error("Content block is not a connector_text block");
              }
              contentBlock.connector_text += delta.connector_text;
            } else {
              switch (delta.type) {
                case "citations_delta":
                  // TODO: handle citations
                  break;
                case "input_json_delta":
                  if (
                    contentBlock.type !== "tool_use" &&
                    contentBlock.type !== "server_tool_use"
                  ) {
                    logEvent("tengu_streaming_error", {
                      error_type:
                        "content_block_type_mismatch_input_json" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        "tool_use" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    });
                    throw new Error("Content block is not a input_json block");
                  }
                  if (typeof contentBlock.input !== "string") {
                    logEvent("tengu_streaming_error", {
                      error_type:
                        "content_block_input_not_string" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    });
                    throw new Error("Content block input is not a string");
                  }
                  contentBlock.input += delta.partial_json;
                  break;
                case "text_delta":
                  if (contentBlock.type !== "text") {
                    logEvent("tengu_streaming_error", {
                      error_type:
                        "content_block_type_mismatch_text" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        "text" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    });
                    throw new Error("Content block is not a text block");
                  }
                  contentBlock.text += delta.text;
                  break;
                case "signature_delta":
                  if (
                    feature("CONNECTOR_TEXT") &&
                    contentBlock.type === "connector_text"
                  ) {
                    // ConnectorTextBlock (src/shared/types/connectorText.ts) doesn't
                    // declare `signature` — bolt it on locally, same pattern
                    // used elsewhere for a field the base type is missing.
                    (contentBlock as ConnectorTextBlock & { signature?: string }).signature = delta.signature;
                    break;
                  }
                  if (contentBlock.type !== "thinking") {
                    logEvent("tengu_streaming_error", {
                      error_type:
                        "content_block_type_mismatch_thinking_signature" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        "thinking" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    });
                    throw new Error("Content block is not a thinking block");
                  }
                  contentBlock.signature = delta.signature;
                  break;
                case "thinking_delta":
                  if (contentBlock.type !== "thinking") {
                    logEvent("tengu_streaming_error", {
                      error_type:
                        "content_block_type_mismatch_thinking_delta" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        "thinking" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    });
                    throw new Error("Content block is not a thinking block");
                  }
                  contentBlock.thinking += delta.thinking;
                  break;
              }
            }
            break;
          }
          case "content_block_stop": {
            const contentBlock = contentBlocks[part.index];
            if (!contentBlock) {
              logEvent("tengu_streaming_error", {
                error_type:
                  "content_block_not_found_stop" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              });
              throw new RangeError("Content block not found");
            }
            if (!partialMessage) {
              logEvent("tengu_streaming_error", {
                error_type:
                  "partial_message_not_found" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
              throw new Error("Message not found");
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: "assistant",
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(advisorModel && { advisorModel }),
            };
            newMessages.push(m);
            yield m;
            break;
          }
          case "message_delta": {
            usage = updateUsage(usage, part.usage);
            // NonNullableUsage deliberately omits `fallback_credit`
            // (src/platform/entrypoints/sdk/sdkUtilityTypes.ts) but the SDK's
            // BetaUsage — what these downstream sinks are typed against —
            // now requires it; null is the honest "not applicable" value.
            const usageForSdk: BetaUsage = { ...usage, fallback_credit: null };

            stopReason = part.delta.stop_reason;
            applyMessageDeltaToLastMessage(
              newMessages.at(-1),
              usageForSdk,
              stopReason,
              part.context_management,
            );

            // Update cost
            const costUSDForPart = calculateUSDCost(resolvedModel, usageForSdk);
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usageForSdk,
              options.model,
            );

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
              part.delta.stop_details,
            );
            if (refusalMessage) {
              yield refusalMessage;
            }

            if (stopReason === "max_tokens") {
              logEvent("tengu_max_tokens_reached", {
                max_tokens: maxOutputTokens,
              });
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                error: "max_output_tokens",
              });
            }

            if (stopReason === "model_context_window_exceeded") {
              logEvent("tengu_context_window_exceeded", {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              });
              // Reuse the max_output_tokens recovery path — from the model's
              // perspective, both mean "response was cut off, continue from
              // where you left off."
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                error: "max_output_tokens",
              });
            }
            break;
          }
          case "message_stop":
            break;
        }

        yield {
          type: "stream_event",
          event: part,
          ...(part.type === "message_start" ? { ttftMs } : undefined),
        };
      }
      // Clear the idle timeout watchdog now that the stream loop has exited
      clearStreamIdleTimers();

      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1;
        logForDiagnosticsNoPII(
          "info",
          "cli_stream_loop_exited_after_watchdog_clean",
        );
        logEvent("tengu_stream_loop_exited_after_watchdog", {
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            "clean" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        // Prevent double-emit: this throw lands in the catch block below,
        // whose exit_path='error' probe guards on streamWatchdogFiredAt.
        streamWatchdogFiredAt = null;
        throw new Error("Stream idle timeout - no chunks received");
      }

      // Detect when the stream completed without producing any assistant messages.
      // This covers two proxy failure modes:
      // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
      // 2. Partial events (partialMessage set but no content blocks completed AND
      //    no stop_reason received): proxy returned message_start but stream ended
      //    before content_block_stop and before message_delta with stop_reason
      // BetaMessageStream had the first check in _endRequest() but the raw Stream
      // does not - without it the generator silently returns no assistant messages,
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? "Stream completed without receiving message_start event - triggering non-streaming fallback"
            : "Stream completed with message_start but no content blocks completed - triggering non-streaming fallback",
          { level: "error" },
        );
        logEvent("tengu_stream_no_events", {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        throw new Error("Stream ended without receiving any events");
      }

      // Log summary if any stalls occurred during streaming
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: "warn" },
        );
        logEvent("tengu_streaming_stall_summary", {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }

      // Check if the cache actually broke based on response tokens
      if (feature("PROMPT_CACHE_BREAK_DETECTION")) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        );
      }

      // Process fallback percentage header and quota status if available
      // streamResponse is set when the stream is created in the withRetry callback above
      // TypeScript's control flow analysis can't track that streamResponse is set in the callback
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined;
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers);
        // Store headers for gateway detection
        responseHeaders = resp.headers;
      }
    } catch (streamingError) {
      // Clear the idle timeout watchdog on error path too
      clearStreamIdleTimers();

      // Instrumentation: if the watchdog had already fired and the for-await
      // threw (rather than exiting cleanly), record that the loop DID exit and
      // how long after the watchdog. Distinguishes true hangs from error exits.
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        );
        logForDiagnosticsNoPII(
          "info",
          "cli_stream_loop_exited_after_watchdog_error",
        );
        logEvent("tengu_stream_loop_exited_after_watchdog", {
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            "error" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ("unknown" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }

      if (isSdkApiUserAbortError(streamingError)) {
        // Check if the abort signal was triggered by the user (ESC key)
        // If the signal is aborted, it's a user-initiated abort
        // If not, it's likely a timeout from the SDK
        if (signal.aborted) {
          // This is a real user abort (ESC key was pressed)
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          );
          if (isAdvisorInProgress) {
            logEvent("tengu_advisor_tool_interrupted", {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
          }
          throw streamingError;
        } else {
          // The SDK threw APIUserAbortError but our signal wasn't aborted
          // This means it's a timeout from the SDK's internal timeout
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: "error" },
          );
          // Throw a more specific error for timeout
          throw new APIConnectionTimeoutError({ message: "Request timed out" });
        }
      }

      // When the flag is enabled, skip the non-streaming fallback and let the
      // error propagate to withRetry. The mid-stream fallback causes double tool
      // execution when streaming tool execution is active: the partial stream
      // starts a tool, then the non-streaming retry produces the same tool_use
      // and runs it again. See inc-4258.
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          "tengu_disable_streaming_to_non_streaming_fallback",
          false,
        );

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: "error" },
        );
        logEvent("tengu_streaming_fallback_to_non_streaming", {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? "watchdog"
            : "other") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        throw streamingError;
      }

      // One streaming re-request before escalating to the non-streaming
      // fallback. Mid-stream failures are usually transient (dropped
      // connection, idle-watchdog abort, gateway reset); retrying in
      // streaming mode preserves progressive output and avoids the
      // non-streaming hazards on long generations (gateway/request
      // timeouts, providers that reject large max_tokens without stream).
      // Duplicate-yield semantics are identical to the non-streaming
      // fallback: partial blocks already yielded from the failed stream are
      // re-produced by the retry (see the inc-4258 note above — users who
      // need to avoid that entirely should disable the fallback flag, which
      // also skips this path). Bounded to one attempt via midStreamRetryCount;
      // opt out with CLAUDIN_STREAMING_RETRY=0.
      const midStreamRetryCount = options.midStreamRetryCount ?? 0;
      if (
        midStreamRetryCount < 1 &&
        !signal.aborted &&
        !isEnvDefinedFalsy(process.env.CLAUDIN_STREAMING_RETRY)
      ) {
        logForDebugging(
          `Error streaming, retrying once in streaming mode: ${errorMessage(streamingError)}`,
          { level: "error" },
        );
        logForDiagnosticsNoPII("info", "cli_streaming_midstream_retry_started");
        logEvent("tengu_streaming_midstream_retry_started", {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          request_id: (streamRequestId ??
            "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          retry_cause: (streamIdleAborted
            ? "watchdog"
            : "other") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        if (options.onStreamingFallback) {
          options.onStreamingFallback();
        }
        yield* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, {
          ...options,
          midStreamRetryCount: midStreamRetryCount + 1,
        });
        return;
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: "error" },
      );
      didFallBackToNonStreaming = true;
      if (options.onStreamingFallback) {
        options.onStreamingFallback();
      }

      logEvent("tengu_streaming_fallback_to_non_streaming", {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? "watchdog"
          : "other") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      // Fall back to non-streaming mode with retries.
      // If the streaming failure was itself a 529, count it toward the
      // consecutive-529 budget so total 529s-before-model-fallback is the
      // same whether the overload was hit in streaming or non-streaming mode.
      // This is a speculative fix for https://github.com/anthropics/claude-code/issues/1513
      // Instrumentation: proves executeNonStreamingRequest was entered (vs. the
      // fallback event firing but the call itself hanging at dispatch).
      logForDiagnosticsNoPII("info", "cli_nonstreaming_fallback_started");
      logEvent("tengu_nonstreaming_fallback_started", {
        request_id: (streamRequestId ??
          "unknown") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? "watchdog"
          : "other") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal: sdkSignal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt;
          maxOutputTokens = tokens;
        },
        (params) => captureAPIRequest(params, options.querySource),
        streamRequestId,
      );

      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: "assistant",
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(advisorModel && {
          advisorModel,
        }),
      };
      newMessages.push(m);
      fallbackMessage = m;
      yield m;
    } finally {
      clearStreamIdleTimers();
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError must propagate to query.ts, which performs the
    // actual model switch. Swallowing it here would turn the fallback into a
    // no-op — the user would just see "Model fallback triggered: X -> Y" as
    // an error message with no actual retry on the fallback model.
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry;
    }

    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
    // Exclude model_not_found: the model is unavailable, not the streaming
    // endpoint — non-streaming would fail the same way.
    const originalError404 =
      errorFromRetry instanceof CannotRetryError &&
      isSdkApiError(errorFromRetry.originalError) &&
      errorFromRetry.originalError.status === 404
        ? (errorFromRetry.originalError as APIError)
        : null;
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      originalError404 !== null &&
      extractOpenAICategoryMarker(originalError404.message ?? "") !==
        "model_not_found";

    if (is404StreamCreationError) {
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId = originalError404?.requestID ?? "unknown";
      logForDebugging(
        "Streaming endpoint returned 404, falling back to non-streaming mode",
        { level: "warn" },
      );
      didFallBackToNonStreaming = true;
      if (options.onStreamingFallback) {
        options.onStreamingFallback();
      }

      logEvent("tengu_streaming_fallback_to_non_streaming", {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          "404_stream_creation" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          "404_stream_creation" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      try {
        // Fall back to non-streaming mode
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal: sdkSignal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt;
            maxOutputTokens = tokens;
          },
          (params) => captureAPIRequest(params, options.querySource),
          failedRequestId,
        );

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: "assistant",
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(advisorModel && { advisorModel }),
        };
        newMessages.push(m);
        fallbackMessage = m;
        yield m;

        // Continue to success logging below
      } catch (fallbackError) {
        // Propagate model-fallback signal to query.ts (see comment above).
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError;
        }

        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: "error" },
        );

        let error = fallbackError;
        let errorModel = options.model;
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError;
          errorModel = fallbackError.retryContext.model;
        }

        if (isSdkApiError(error)) {
          extractQuotaStatusFromError(error);
        }

        const requestId =
          streamRequestId ||
          (isSdkApiError(error) ? error.requestID : undefined) ||
          (isSdkApiError(error)
            ? (error.error as { request_id?: string })?.request_id
            : undefined);

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        });

        if (isSdkApiUserAbortError(error)) {
          releaseStreamResources();
          return;
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        });
        releaseStreamResources();
        return;
      }
    } else {
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: "error",
      });

      let error = errorFromRetry;
      let errorModel = options.model;
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError;
        errorModel = errorFromRetry.retryContext.model;
      }

      // Extract quota status from error headers if it's a rate limit error
      if (isSdkApiError(error)) {
        extractQuotaStatusFromError(error);
      }

      // Extract requestId from stream, error header, or error body
      const requestId =
        streamRequestId ||
        (isSdkApiError(error) ? error.requestID : undefined) ||
        (isSdkApiError(error)
          ? (error.error as { request_id?: string })?.request_id
          : undefined);

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      });

      // Don't yield an assistant error message for user aborts
      // The interruption message is handled in query.ts
      if (isSdkApiUserAbortError(error)) {
        releaseStreamResources();
        return;
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      });
      releaseStreamResources();
      return;
    }
  } finally {
    stopSessionActivity("api_call");
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    releaseStreamResources();

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage;
      usage = updateUsage(EMPTY_USAGE, fallbackUsage);
      // AssistantMessage['message']['stop_reason'] is `string | null` (widened
      // in types/message.ts to cover non-Anthropic providers); this path is
      // Anthropic-only, so it is genuinely a BetaStopReason.
      stopReason = fallbackMessage.message.stop_reason as BetaStopReason | null;
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage);
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      );
    }

    // Precompute log scalars before releasing the heavy captures so the
    // post-finally logger doesn't need messagesForAPI.
    logMessageCount = messagesForAPI.length;
    logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI);

    // Free heavy captures so the request-building context (system prompt,
    // full conversation history, tool schemas, betas) can be GC'd even when
    // the async generator frame stays pinned. The frame can survive long
    // past finally if any Error created here ends up in an AbortSignal.reason
    // anywhere up the chain — V8's stack trace pins the lexical scope of every
    // frame on the stack at throw time. Nulling the let-bindings breaks that
    // chain so paramsFromContext / willDefer / releaseStreamResources / etc.
    // (which we cannot un-pin) hold onto null instead of multi-MB arrays.
    // Safe because no caller of this generator function uses these vars after
    // finally, and paramsFromContext is never invoked again post-finally.
    messagesForAPI = null as never;
    system = null as never;
    allTools = null as never;
    betas = null as never;
    // responseHeaders gets pinned via the same closure-stack-trace path
    // (releaseStreamResources / willDefer capture it). Drop it explicitly so
    // _Headers/_HeadersList aren't retained even if the closure stays alive.
    responseHeaders = undefined;

    // Detach our combined-signal listener from the parent so the SDK's leaked
    // listener (Anthropic SDK client.mjs:332) is anchored to a controller we
    // are about to drop, not to the session-lifetime signal.
    cleanupSdkSignal();
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith("repl_main_thread") ||
      options.querySource === "sdk")
  ) {
    setLastMainRequestId(streamRequestId);
  }

  // logMessageCount/logMessageTokens were precomputed in finally before
  // messagesForAPI was nulled out — see the heavy-capture release there.
  void options.getToolPermissionContext().then((permissionContext) => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // Pass newMessages for beta tracing - extraction happens in logging.ts
      // only when beta tracing is enabled
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    });
  });

  // Defensive: also release on normal completion (no-op if finally already ran).
  releaseStreamResources();
}

/**
 * Cleans up stream resources to prevent memory leaks.
 * @internal Exported for testing
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return;
  }
  try {
    // Abort the stream via its controller if not already aborted
    if (!stream.controller.signal.aborted) {
      stream.controller.abort();
    }
  } catch {
    // Ignore - stream may already be closed
  }
}

/**
 * Writes message_delta fields back onto the last yielded assistant message.
 * Messages are created at content_block_stop from partialMessage, which was
 * set at message_start before any tokens were generated (output_tokens: 0,
 * stop_reason: null). message_delta arrives after content_block_stop with
 * the real values.
 *
 * context_management (server-side applied edits, e.g. clear_tool_uses under
 * the retain cache profile) is only delivered on message_delta — without
 * this copy the evidence never reaches message history, and Read's dedup
 * cannot tell that an earlier tool_result was cleared server-side (see
 * FileReadTool/serverClearingDetection.ts).
 *
 * IMPORTANT: Use direct property mutation, not object replacement.
 * The transcript write queue holds a reference to message.message
 * and serializes it lazily (100ms flush interval). Object
 * replacement ({ ...lastMsg.message, usage }) would disconnect
 * the queued reference; direct mutation ensures the transcript
 * captures the final values.
 */
export function applyMessageDeltaToLastMessage(
  lastMsg: AssistantMessage | undefined,
  usage: BetaUsage,
  stopReason: BetaStopReason | null,
  contextManagement: BetaContextManagementResponse | null | undefined,
): void {
  if (!lastMsg) return;
  lastMsg.message.usage = usage;
  lastMsg.message.stop_reason = stopReason;
  if (contextManagement) {
    lastMsg.message.context_management = contextManagement;
  }
}

/**
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage };
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    output_tokens_details: {
      thinking_tokens:
        partUsage.output_tokens_details?.thinking_tokens ??
        usage.output_tokens_details.thinking_tokens,
    },
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK type BetaMessageDeltaUsage is missing cache_creation, but it's real!
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  };
}

/**
 * Accumulates usage from one message into a total usage object.
 * Used to track cumulative usage across multiple assistant turns.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    output_tokens_details: {
      thinking_tokens:
        totalUsage.output_tokens_details.thinking_tokens +
        messageUsage.output_tokens_details.thinking_tokens,
    },
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // Use the most recent service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: messageUsage.inference_geo, // Use the most recent
    iterations: messageUsage.iterations, // Use the most recent
    speed: messageUsage.speed, // Use the most recent
  };
}
