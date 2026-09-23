import type {
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { feature } from "bun:bundle";
import {
  getLargeSystemPromptDetected,
  setLargeSystemPromptDetected,
} from "src/platform/bootstrap/state.js";
import {
  EFFORT_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from "src/shared/constants/betas.js";
import type { QuerySource } from "src/agent/prompts/querySource.js";
import { getFeatureValue_CACHED_MAY_BE_STALE } from "src/platform/analytics/growthbook.js";
import { type CacheScope, splitSysPromptPrefix } from "src/providers/transport/api.js";
import { shouldIncludeFirstPartyOnlyBetas } from "src/providers/transport/betas.js";
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
} from "src/agent/context/context.js";
import { type EffortValue, isAdaptiveEffort, modelSupportsEffort } from "src/providers/effort/effort.js";
import { isEnvTruthy } from "src/shared/envUtils.js";
import { validateBoundedIntEnvVar } from "src/shared/envValidation.js";
import { errorMessage } from "src/shared/errors.js";
import { safeParseJSON } from "src/shared/data/json.js";
import { logForDebugging } from "src/shared/debug.js";
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
} from "src/providers/model/model.js";
import {
  getAPIProvider,
  isGithubNativeAnthropicMode,
} from "src/providers/model/providers.js";
import type { SystemPrompt } from "src/agent/systemPromptType.js";
import { roughTokenCountEstimationForMessage } from "src/shared/tokenEstimation.js";
import type { AgentId } from "src/shared/types/ids.js";
import type { AssistantMessage, UserMessage } from "src/shared/types/message.js";
import { recordMarkerAdvance } from "src/providers/cache/promptCacheBreakDetection.js";
import { getCacheTrackingKey } from "src/providers/cache/trackingKey.js";
import { getCacheControl } from "src/providers/shims/claude/cacheControl.js";
import {
  isLagMarkerEnabled,
  resolveLagMarker,
} from "src/providers/shims/claude/lagCacheMarker.js";
import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from "src/providers/shims/claude/messageConverters.js";
import type { Options, TaskBudgetParam } from "src/providers/shims/claude/types.js";

// Define a type that represents valid JSON values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

/**
 * Assemble the extra body parameters for the API request, based on the
 * CLAUDIN_EXTRA_BODY environment variable if present and on any beta
 * headers (primarily for Bedrock requests).
 *
 * @param betaHeaders - An array of beta headers to include in the request.
 * @returns A JSON object representing the extra body parameters.
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // Parse user's extra body parameters first
  const extraBodyStr = process.env.CLAUDIN_EXTRA_BODY;
  let result: JsonObject = {};

  if (extraBodyStr) {
    try {
      // Parse as JSON, which can be null, boolean, number, string, array or object
      const parsed = safeParseJSON(extraBodyStr);
      // We expect an object with key-value pairs to spread into API parameters
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Shallow clone — safeParseJSON is LRU-cached and returns the same
        // object reference for the same string. Mutating `result` below
        // would poison the cache, causing stale values to persist.
        result = { ...(parsed as JsonObject) };
      } else {
        logForDebugging(
          `CLAUDIN_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: "error" },
        );
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDIN_EXTRA_BODY: ${errorMessage(error)}`,
        { level: "error" },
      );
    }
  }

  // Anti-distillation: send fake_tools opt-in for 1P CLI only
  if (
    feature("ANTI_DISTILLATION_CC")
      ? process.env.CLAUDE_CODE_ENTRYPOINT === "cli" &&
        shouldIncludeFirstPartyOnlyBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          "tengu_anti_distill_fake_tool_injection",
          false,
        )
      : false
  ) {
    result.anti_distillation = ["fake_tools"];
  }

  // Handle beta headers if provided
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // Add to existing array, avoiding duplicates
      const existingHeaders = result.anthropic_beta as string[];
      const newHeaders = betaHeaders.filter(
        (header) => !existingHeaders.includes(header),
      );
      result.anthropic_beta = [...existingHeaders, ...newHeaders];
    } else {
      // Create new array with the beta headers
      result.anthropic_beta = betaHeaders;
    }
  }

  return result;
}

export function getPromptCachingEnabled(model: string): boolean {
  // Prompt caching is an Anthropic-specific feature. Third-party providers
  // do not understand cache_control blocks and strict backends (e.g. Azure
  // Foundry) reject or flag requests that contain them.
  //
  // Exception: when the GitHub provider is configured in native Anthropic API
  // mode (CLAUDE_CODE_GITHUB_ANTHROPIC_API=1), requests are sent in Anthropic
  // format, so cache_control blocks are supported.
  const provider = getAPIProvider();
  const isNativeGithub = isGithubNativeAnthropicMode(model);
  if (
    provider !== "firstParty" &&
    provider !== "bedrock" &&
    provider !== "vertex" &&
    !isNativeGithub
  ) {
    return false;
  }

  // Global disable takes precedence
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false;

  // Check if we should disable for small/fast model
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel();
    if (model === smallFastModel) return false;
  }

  // Check if we should disable for default Sonnet
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel();
    if (model === defaultSonnet) return false;
  }

  // Check if we should disable for default Opus
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel();
    if (model === defaultOpus) return false;
  }

  return true;
}

/**
 * Determines if 1h TTL should be used for prompt caching.
 *
 * Default-on for firstParty/vertex when the session's system prompt is
 * detected as large (>8k tokens via chars/4 heuristic, latched once in
 * buildSystemPromptBlocks). The latch keeps the TTL session-stable so the
 * server-side prompt cache isn't busted mid-session (~20K tokens per flip).
 *
 * Bedrock stays opt-in via ENABLE_PROMPT_CACHING_1H_BEDROCK env var because
 * Bedrock surcharges cache writes (+25%); 3P users manage their own billing.
 *
 * Other providers (openai-compat, gemini, etc.) don't reach here — the outer
 * getPromptCachingEnabled gate already filters them out.
 */
const LARGE_SYSTEM_PROMPT_TOKEN_THRESHOLD = 8000;

/**
 * Defer-cache-marker threshold (in estimated tokens). The default, 0, puts the
 * message marker on the last message, where Claude Code puts it.
 *
 * With a threshold N > 0 the marker walks back to the earliest message whose
 * suffix reaches N tokens, leaving the tail uncached until it has grown. That
 * was the default (2048) from 2026-06-07, on the premise that the API discards
 * writes smaller than ~1024 tokens. The premise did not hold up:
 *   - its evidence came from scripts/bench/ab/cache-ab-bench.ts, whose rows
 *     were later found cumulative, with a ~5× run-to-run swing;
 *   - on 2026-09-23 (scripts/bench/ab/session-cache-ab.ts, N=3 per arm) Claude
 *     Code's 555–774-token writes were read back on the next turn, while the
 *     deferred tail was billed as uncached input turn after turn and then
 *     written anyway. Session cost, 0 against 2048: Opus 5.5 −4% and Sonnet 5
 *     −15% (both with non-overlapping ranges), Opus 5.5 at 5m TTL −17%
 *     (overlapping); cache writes moved by at most 3% in any of them.
 *
 * Override at runtime: CLAUDIN_DEFER_CACHE_MARKER=<N tokens> (2048 restores
 * the old placement).
 *
 * See addCacheBreakpoints() for the placement logic and the comment block
 * about the marker count (one deferred marker plus the lagging one that keeps
 * it reachable — see lagCacheMarker.ts).
 *
 * Related: CLAUDIN_DEFER_HIGHLIGHT (similar runtime perf toggle precedent).
 */
const DEFAULT_DEFER_CACHE_MARKER_TOKENS = 0;
function readDeferCacheMarkerTokens(): number {
  const raw = process.env.CLAUDIN_DEFER_CACHE_MARKER;
  if (raw === undefined) return DEFAULT_DEFER_CACHE_MARKER_TOKENS;
  const parsed = Number(raw);
  // Garbage input (e.g. "abc" → NaN) silently falls back to the default.
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_DEFER_CACHE_MARKER_TOKENS;
}
// Memoized once at module load. Tests that flip the env must call
// _resetDeferCacheMarkerForTesting() to re-read (matches the
// _resetAllClippedIdsForTesting pattern used elsewhere).
let DEFER_CACHE_MARKER_TOKENS = readDeferCacheMarkerTokens();
export function _resetDeferCacheMarkerForTesting(): void {
  DEFER_CACHE_MARKER_TOKENS = readDeferCacheMarkerTokens();
}

/**
 * Latches whether the session has ever seen a system prompt large enough
 * (>8k tokens via chars/4 heuristic) to justify 1h cache TTL on
 * firstParty/vertex. High-water mark: once latched `true`, stays `true` for
 * the session so the cache_control TTL is stable and the server-side prompt
 * cache isn't busted mid-run.
 *
 * High-water rather than first-call-wins because `buildSystemPromptBlocks`
 * is shared between the main agent and `queryHaiku`. Haiku queries
 * (sessionTitle, generateSessionName, shell prefix, etc.) often fire first
 * with tiny system prompts; latching first-only would freeze the decision
 * to `false` and disable 1h TTL for the rest of the session. It also
 * handles late prompt growth (MCP servers connecting, /memory edits).
 *
 * Exported so tests can drive it directly without the splitSysPromptPrefix
 * dependency tree of buildSystemPromptBlocks.
 */
export function detectLargeSystemPromptOnce(
  systemPrompt: ReadonlyArray<string>,
): void {
  if (getLargeSystemPromptDetected() === true) return;
  let totalChars = 0;
  for (const s of systemPrompt) totalChars += s.length;
  // chars/4 ≈ tokens (BPE heuristic, ~10-15% error vs real tokenizer).
  // 8k threshold ≈ ~32k chars: comfortably above Anthropic's 1024-token
  // minimum cacheable size, and roughly the break-even where 1h's 2× write
  // surcharge pays back vs 5m's 1.25× across a typical pause-heavy session.
  setLargeSystemPromptDetected(
    totalChars >> 2 > LARGE_SYSTEM_PROMPT_TOKEN_THRESHOLD,
  );
}

/**
 * Configure effort parameters for API request.
 *
 */
export function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  _extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || "effort" in outputConfig) {
    return;
  }

  if (effortValue === undefined || isAdaptiveEffort(effortValue)) {
    // 'adaptive' (and unset) send no effort field — the server scales per
    // request. resolveAppliedEffort already maps adaptive→undefined upstream,
    // so this is belt-and-suspenders for direct callers.
    betas.push(EFFORT_BETA_HEADER);
  } else if (typeof effortValue === "string") {
    // Send string effort level as is
    outputConfig.effort = effortValue;
    betas.push(EFFORT_BETA_HEADER);
  }
  // Numeric effort overrides are Anthropic-internal only and are dropped here.
}

export function configureTaskBudgetParams(
  taskBudget: Options["taskBudget"],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    "task_budget" in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return;
  }
  outputConfig.task_budget = {
    type: "tokens",
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  };
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER);
  }
}

// Exported for testing cache_control placement constraints
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  skipCacheWrite = false,
  clipFrontierIndex?: number,
  agentId?: AgentId,
): MessageParam[] {

  // One ADVANCING message-level cache_control marker per request. Mycro's
  // turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
  // local-attention KV pages at any cached prefix position NOT in
  // cache_store_int_token_boundaries. With two markers the second-to-last
  // position is protected and its locals survive an extra turn even though
  // nothing will ever resume from there — with one marker they're freed
  // immediately. For fire-and-forget forks (skipCacheWrite) we shift the
  // marker to the second-to-last message: that's the last shared-prefix
  // point, so the write is a no-op merge on mycro (entry already exists)
  // and the fork doesn't leave its own tail in the KVCC. Dense pages are
  // refcounted and survive via the new hash either way.
  // The lagging marker below is the one deliberate exception: it sits on
  // the previous request's marker, which IS the position the next lookup
  // resumes from when this one misses (lagCacheMarker.ts).
  const baseMarkerIndex = skipCacheWrite
    ? messages.length - 2
    : messages.length - 1;
  // Deferred placement — only when CLAUDIN_DEFER_CACHE_MARKER opts in; the
  // default of 0 skips it (see DEFAULT_DEFER_CACHE_MARKER_TOKENS above).
  //
  // Walk backward from the end summing estimated tokens; place the marker at
  // the earliest index whose suffix sums to >= the threshold. If the suffix
  // never reaches the threshold (short / early conversation), PIN the marker
  // at messages[0] — a stable head anchor.
  //
  // NOTE: an earlier draft of the deferral "fell back to baseline (length-1)
  // when threshold not met"; on the bench of the time that regressed r:w to
  // 0.78. Keep the head anchor for as long as the walk exists.
  let markerIndex = baseMarkerIndex;
  if (
    DEFER_CACHE_MARKER_TOKENS > 0 &&
    !skipCacheWrite &&
    messages.length > 1
  ) {
    let acc = 0;
    let i = messages.length - 1;
    for (; i >= 0; i -= 1) {
      acc += roughTokenCountEstimationForMessage(messages[i]!);
      if (acc >= DEFER_CACHE_MARKER_TOKENS) break;
    }
    // i >= 0 → threshold met; place marker at that index.
    // i < 0  → loop exhausted; pin to head (index 0) as documented above.
    markerIndex = Math.max(i, 0);
  }
  // Clip-frontier cap (CLAUDIN_CLIP_FRONTIER, experimental). The caller
  // passes the largest index whose prefix is byte-stable across turns (see
  // getClipFrontierIndex in stableStubState.ts). A marker placed past the
  // frontier protects a block that a future turn rewrites — an aging
  // tool_result the prune will stub, a pending clipped id, or thinking/
  // narration text the history redaction will strip — and that mutation
  // invalidates the whole cached prefix every turn. Capping at the frontier
  // confines all byte churn to the uncached tail: the prefix behind the
  // marker only ever grows, never changes.
  //   - undefined → flag off / fork path: existing placement untouched.
  //   - -1 (no stable prefix at all) → no cap; defer/head-pin behavior kept.
  //   - frontier ≥ deferred index → defer wins (min): the marker keeps
  //     lingering until enough trailing tokens accumulate to register a
  //     usable entry server-side, just never past the frontier.
  if (
    clipFrontierIndex !== undefined &&
    clipFrontierIndex >= 0 &&
    !skipCacheWrite &&
    clipFrontierIndex < markerIndex
  ) {
    markerIndex = clipFrontierIndex;
  }
  // Lagging marker (lagCacheMarker.ts): a second marker on the message that
  // carried the PREVIOUS request's marker. The API resolves a breakpoint by
  // checking at most 20 positions behind it; a deferred marker that lingers
  // through a run of tiny tool calls and then jumps to the end lands further
  // than that from the last write, the lookup misses, and the whole history
  // is re-billed from the system breakpoint (session ab1e69e8: 7 rewrites,
  // 3.06M tokens). The lag marker is where the lookup resumes; it sits on
  // cached bytes, so it costs nothing. With the default placement the marker
  // advances every request and the lag marker is usually redundant; it still
  // covers the opt-in deferral and a single request that appends 20+
  // positions. Skipped for skipCacheWrite forks (own key, marker already at
  // the shared frontier). With the system prompt's 2 blocks this is the
  // 4-breakpoint cap: never add a third message marker.
  let lagIndex: number | undefined;
  const trackingKey =
    enablePromptCaching &&
    !skipCacheWrite &&
    querySource !== undefined &&
    isLagMarkerEnabled()
      ? getCacheTrackingKey(querySource, agentId)
      : null;
  if (trackingKey && querySource) {
    const lag = resolveLagMarker(trackingKey, messages, markerIndex);
    lagIndex = lag.lagIndex;
    if (feature("PROMPT_CACHE_BREAK_DETECTION")) {
      recordMarkerAdvance(
        querySource,
        agentId,
        lag.advancedPositions === undefined
          ? null
          : { positions: lag.advancedPositions, lagPlaced: lagIndex !== undefined },
      );
    }
  }
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex || index === lagIndex;
    if (msg.type === "user") {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      );
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    );
  });

  return result;
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean;
    querySource?: QuerySource;
  },
): TextBlockParam[] {
  detectLargeSystemPromptOnce(systemPrompt);

  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map((block) => {
    return {
      type: "text" as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    };
  });
}

// Non-streaming requests have a 10min max per the docs:
// https://platform.claude.com/docs/en/api/errors#long-requests
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
export const MAX_NON_STREAMING_TOKENS = 64_000;

/**
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number;
    thinking?: BetaMessageStreamParams["thinking"];
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap);

  // Adjust thinking budget if it would exceed capped max_tokens
  // to maintain the constraint: max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params };
  if (
    adjustedParams.thinking?.type === "enabled" &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // Must be at least 1 less than max_tokens
      ),
    };
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  };
}

function isMaxTokensCapEnabled(): boolean {
  // 3P default: false (not validated on Bedrock/Vertex)
  return getFeatureValue_CACHED_MAY_BE_STALE("tengu_otk_slot_v1", false);
}

export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model);

  // Slot-reservation cap: drop default to 8k for all models. BQ p99 output
  // = 4,911 tokens; 32k/64k defaults over-reserve 8-16× slot capacity.
  // Requests hitting the cap get one clean retry at 64k (query.ts
  // max_output_tokens_escalate). Math.min keeps models with lower native
  // defaults (e.g. claude-3-opus at 4k) at their native value. Applied
  // before the env-var override so CLAUDIN_MAX_OUTPUT_TOKENS still wins.
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default;

  const result = validateBoundedIntEnvVar(
    "CLAUDIN_MAX_OUTPUT_TOKENS",
    process.env.CLAUDIN_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  );
  return result.effective;
}
