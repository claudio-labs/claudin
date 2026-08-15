import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import {
  extractCacheMetrics,
  resolveCacheProvider,
} from 'src/services/api/cacheMetrics.js'
import {
  recordRequest as recordCacheRequest,
  resetSessionCacheStats,
} from 'src/services/api/cacheStatsTracker.js'
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { getAPIProvider, isGithubNativeAnthropicMode } from 'src/utils/model/providers.js'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState as baseResetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from 'src/bootstrap/state.js'
import type { ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getAdvisorUsage } from 'src/utils/advisor.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/services/config/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from 'src/services/context/context.js'
import { isFastModeEnabled } from 'src/utils/fastMode.js'
import { formatDuration, formatNumber } from 'src/shared/text/format.js'
import { resetBytesSaved } from 'src/services/context/tokensSaved.js'
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js'
import { getCanonicalName } from 'src/utils/model/model.js'
import { calculateUSDCost } from 'src/services/api/modelCost.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  setHasUnknownModelCost,
  getModelUsage,
  getUsageForModel,
}

/**
 * Wraps bootstrap's resetCostState() so /clear, /compact and session
 * switches zero the cache-stats tracker alongside the cost counters.
 * Exported under the same name so existing callers pick up the cache
 * reset without any call-site changes.
 */
export function resetCostState(): void {
  baseResetCostState()
  resetSessionCacheStats()
  resetBytesSaved()
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

/**
 * Gets stored cost state from project config for a specific session.
 * Returns the cost data if the session ID matches, or undefined otherwise.
 * Use this to read costs BEFORE overwriting the config with saveCurrentSessionCosts().
 */
export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // Only return costs if this is the same session that was last saved
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  // Build model usage with context windows
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * Restores cost state from project config when resuming a session.
 * Only restores if the session ID matches the last saved session.
 * @returns true if cost state was restored, false otherwise
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * Walk a list of resumed messages and replay each assistant turn's `usage`
 * through `addToTotalSessionCost`, so the in-memory totals (input/output/
 * cache tokens, cost) reflect the full conversation. Used as a fallback
 * when `restoreCostStateForSession` returns false — that path only restores
 * the most-recently-saved session (project config has a single slot keyed
 * by `lastSessionId`), but per-turn usage is preserved in every session's
 * .jsonl, so older sessions can be reconstructed.
 *
 * Tolerates messages with missing/partial usage fields (compaction zeroes
 * stale entries; older transcripts predate cache fields). Resets state
 * first so callers don't have to.
 */
export function recomputeCostStateFromMessages(
  messages: ReadonlyArray<unknown>,
): void {
  resetCostState()
  for (const raw of messages) {
    const msg = raw as {
      type?: string
      message?: { model?: string; usage?: Partial<Usage> }
    } | null
    if (!msg || msg.type !== 'assistant') continue
    const inner = msg.message
    if (!inner) continue
    const usage = inner.usage
    const model = inner.model
    if (!usage || !model) continue
    const normalized: Usage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      // Preserve TTL breakdown so `calculateUSDCost` can bill the 1h ephemeral
      // bucket at the correct 2× rate instead of the 1.25× 5m fallback.
      cache_creation: usage.cache_creation,
    } as Usage
    if (
      normalized.input_tokens === 0 &&
      normalized.output_tokens === 0 &&
      normalized.cache_creation_input_tokens === 0 &&
      normalized.cache_read_input_tokens === 0
    ) {
      continue
    }
    const cost = calculateUSDCost(model, normalized)
    addToTotalSessionCost(cost, normalized, model)
  }
}

/**
 * Saves the current session's costs to project config.
 * Call this before switching sessions to avoid losing accumulated costs.
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => {
    const currentSessionId = getSessionId()
    // On a session boundary, the previously-saved `last*` belongs to a session
    // that is now closed — fold it into the cumulative project totals before
    // overwriting it with the current session's data.
    const isNewSession = current.lastSessionId !== currentSessionId
    const baseCumulativeCost = current.cumulativeCost ?? 0
    const baseCumulativeAPIDuration = current.cumulativeAPIDuration ?? 0
    const baseCumulativeDuration = current.cumulativeDuration ?? 0
    const baseCumulativeLinesAdded = current.cumulativeLinesAdded ?? 0
    const baseCumulativeLinesRemoved = current.cumulativeLinesRemoved ?? 0
    const baseCumulativeModelUsage = current.cumulativeModelUsage ?? {}

    const cumulativeCost = isNewSession
      ? baseCumulativeCost + (current.lastCost ?? 0)
      : baseCumulativeCost
    const cumulativeAPIDuration = isNewSession
      ? baseCumulativeAPIDuration + (current.lastAPIDuration ?? 0)
      : baseCumulativeAPIDuration
    const cumulativeDuration = isNewSession
      ? baseCumulativeDuration + (current.lastDuration ?? 0)
      : baseCumulativeDuration
    const cumulativeLinesAdded = isNewSession
      ? baseCumulativeLinesAdded + (current.lastLinesAdded ?? 0)
      : baseCumulativeLinesAdded
    const cumulativeLinesRemoved = isNewSession
      ? baseCumulativeLinesRemoved + (current.lastLinesRemoved ?? 0)
      : baseCumulativeLinesRemoved

    let cumulativeModelUsage = baseCumulativeModelUsage
    if (isNewSession && current.lastModelUsage) {
      cumulativeModelUsage = { ...baseCumulativeModelUsage }
      for (const [model, usage] of Object.entries(current.lastModelUsage)) {
        const prev = cumulativeModelUsage[model]
        cumulativeModelUsage[model] = prev
          ? {
              inputTokens: prev.inputTokens + usage.inputTokens,
              outputTokens: prev.outputTokens + usage.outputTokens,
              cacheReadInputTokens:
                prev.cacheReadInputTokens + usage.cacheReadInputTokens,
              cacheCreationInputTokens:
                prev.cacheCreationInputTokens + usage.cacheCreationInputTokens,
              webSearchRequests:
                prev.webSearchRequests + usage.webSearchRequests,
              costUSD: prev.costUSD + usage.costUSD,
            }
          : { ...usage }
      }
    }

    return {
      ...current,
      lastCost: getTotalCostUSD(),
      lastAPIDuration: getTotalAPIDuration(),
      lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
      lastToolDuration: getTotalToolDuration(),
      lastDuration: getTotalDuration(),
      lastLinesAdded: getTotalLinesAdded(),
      lastLinesRemoved: getTotalLinesRemoved(),
      lastTotalInputTokens: getTotalInputTokens(),
      lastTotalOutputTokens: getTotalOutputTokens(),
      lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
      lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
      lastTotalWebSearchRequests: getTotalWebSearchRequests(),
      lastFpsAverage: fpsMetrics?.averageFps,
      lastFpsLow1Pct: fpsMetrics?.low1PctFps,
      lastModelUsage: Object.fromEntries(
        Object.entries(getModelUsage()).map(([model, usage]) => [
          model,
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            webSearchRequests: usage.webSearchRequests,
            costUSD: usage.costUSD,
          },
        ]),
      ),
      lastSessionId: currentSessionId,
      cumulativeCost,
      cumulativeAPIDuration,
      cumulativeDuration,
      cumulativeLinesAdded,
      cumulativeLinesRemoved,
      cumulativeModelUsage,
    }
  })
}

/**
 * Project-level cumulative totals: completed sessions + current in-memory
 * session. The `cumulative*` fields on disk exclude the active session
 * (they are advanced at the session boundary), so we sum the in-memory
 * counters into them here for live display.
 */
export type ProjectTotals = {
  totalCost: number
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  modelUsage: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
}

export function getProjectTotals(): ProjectTotals {
  const config = getCurrentProjectConfig()
  const cumulativeModelUsage = config.cumulativeModelUsage ?? {}
  const liveModelUsage = getModelUsage()

  // The `last*` slot on disk holds the most recent completed session that has
  // not yet been folded into `cumulative*` (the fold happens on the next save
  // when the session ID changes). For a live read, fold it in here when the
  // saved session is different from the current one — otherwise the user sees
  // the previous session's cost stuck at "Session" $0 and "Project total" $0
  // until the REPL exits.
  const currentSessionId = getSessionId()
  const includeLastAsPending =
    config.lastSessionId !== undefined &&
    config.lastSessionId !== currentSessionId

  const merged: ProjectTotals['modelUsage'] = {}
  const addUsage = (
    model: string,
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    },
  ): void => {
    const prev = merged[model]
    merged[model] = prev
      ? {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          cacheReadInputTokens:
            prev.cacheReadInputTokens + usage.cacheReadInputTokens,
          cacheCreationInputTokens:
            prev.cacheCreationInputTokens + usage.cacheCreationInputTokens,
          webSearchRequests: prev.webSearchRequests + usage.webSearchRequests,
          costUSD: prev.costUSD + usage.costUSD,
        }
      : { ...usage }
  }

  for (const [model, usage] of Object.entries(cumulativeModelUsage)) {
    addUsage(model, usage)
  }
  if (includeLastAsPending && config.lastModelUsage) {
    for (const [model, usage] of Object.entries(config.lastModelUsage)) {
      addUsage(model, usage)
    }
  }
  for (const [model, usage] of Object.entries(liveModelUsage)) {
    addUsage(model, usage)
  }

  const pendingCost = includeLastAsPending ? (config.lastCost ?? 0) : 0
  const pendingAPIDuration = includeLastAsPending
    ? (config.lastAPIDuration ?? 0)
    : 0
  const pendingDuration = includeLastAsPending
    ? (config.lastDuration ?? 0)
    : 0
  const pendingLinesAdded = includeLastAsPending
    ? (config.lastLinesAdded ?? 0)
    : 0
  const pendingLinesRemoved = includeLastAsPending
    ? (config.lastLinesRemoved ?? 0)
    : 0

  return {
    totalCost:
      (config.cumulativeCost ?? 0) + pendingCost + getTotalCostUSD(),
    totalAPIDuration:
      (config.cumulativeAPIDuration ?? 0) +
      pendingAPIDuration +
      getTotalAPIDuration(),
    totalDuration:
      (config.cumulativeDuration ?? 0) +
      pendingDuration +
      getTotalDuration(),
    totalLinesAdded:
      (config.cumulativeLinesAdded ?? 0) +
      pendingLinesAdded +
      getTotalLinesAdded(),
    totalLinesRemoved:
      (config.cumulativeLinesRemoved ?? 0) +
      pendingLinesRemoved +
      getTotalLinesRemoved(),
    modelUsage: merged,
  }
}

function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output'
  }

  // Accumulate usage by short name
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    let usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output`
    if (usage.cacheReadInputTokens > 0) {
      usageString += `, ${formatNumber(usage.cacheReadInputTokens)} cache read`
    }
    if (usage.cacheCreationInputTokens > 0) {
      usageString += `, ${formatNumber(usage.cacheCreationInputTokens)} cache write`
    }
    if (usage.webSearchRequests > 0) {
      usageString += `, ${formatNumber(usage.webSearchRequests)} web search`
    }
    usageString += ` (${formatCost(usage.costUSD)})`
    result += `\n` + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()

  return chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed
${modelUsageDisplay}`,
  )
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

// Env-gated verbose token usage log. Treated as a boolean regardless of
// value specifics — any truthy-ish string switches it on. `verbose` is the
// documented keyword but we accept `1`/`true` for ergonomic parity with
// other CLAUDIN_* flags.
function shouldLogTokenUsageVerbose(): boolean {
  const v = (process.env.CLAUDIN_LOG_TOKEN_USAGE ?? '').trim().toLowerCase()
  if (!v) return false
  return v !== '0' && v !== 'false' && v !== 'off'
}

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  // Record normalized cache metrics for REPL display + /cache-stats.
  // Resolved from the current process provider — at this point `usage` has
  // already been Anthropic-shaped by the shim layer, so we feed the
  // corresponding bucket (anthropic / copilot-claude / openai-like) to the
  // extractor. For providers that genuinely don't report cache data
  // (vanilla Copilot, Ollama), resolveCacheProvider steers us to
  // supported:false so the UI shows "N/A" instead of lying with "0%".
  const cacheProvider = resolveCacheProvider(getAPIProvider(), {
    githubNativeAnthropic: isGithubNativeAnthropicMode(model),
    openAiBaseUrl: tryGetActiveProvider()?.baseUrl,
  })
  const cacheMetrics = extractCacheMetrics(
    usage as unknown as Record<string, unknown>,
    cacheProvider,
  )
  recordCacheRequest(cacheMetrics, model)

  // Opt-in structured per-request debug log on stderr. Power-user knob, not
  // shown in the REPL — complements CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT
  // (which is model-facing). Any truthy value except "0"/"false" enables it.
  if (shouldLogTokenUsageVerbose()) {
    process.stderr.write(
      JSON.stringify({
        tag: 'claudin.tokenUsage',
        model,
        provider: cacheProvider,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_supported: cacheMetrics.supported,
        cache_hit_rate: cacheMetrics.hitRate,
        cost_usd: cost,
      }) + '\n',
    )
  }

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
    )
  }
  return totalCost
}
