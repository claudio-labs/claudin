import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import {
  extractCacheMetrics,
  resolveCacheProvider,
} from 'src/providers/cache/cacheMetrics.js'
import {
  recordRequest as recordCacheRequest,
  resetSessionCacheStats,
} from 'src/providers/cache/cacheStatsTracker.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { getAPIProvider, isGithubNativeAnthropicMode } from 'src/providers/model/providers.js'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getModelUsage,
  getSdkBetas,
  getSessionId,
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
} from 'src/platform/bootstrap/state.js'
import type { ModelUsage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type {
  CostStateEntry,
  CostStateModelUsage,
  CostStateProviderUsage,
  CostStateSourceUsage,
} from 'src/shared/types/logs.js'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import { getAdvisorUsage } from 'src/platform/doctor/advisor.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/platform/config/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from 'src/agent/context/context.js'
import { formatDuration, formatNumber } from 'src/shared/text/format.js'
import { logError } from 'src/shared/log.js'
import { resetBytesSaved } from 'src/agent/context/tokensSaved.js'
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js'
import { getCanonicalName } from 'src/providers/model/model.js'
import { calculateUSDCost } from 'src/providers/usage/modelCost.js'
import { addModelUsageTo } from 'src/providers/usage/modelUsage.js'
import { ENV_KEY_PREFIX } from 'src/providers/usage/providerAttribution.js'
import { resolveProviderLabel } from 'src/providers/providerLabel.js'
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

/** When the counters' session started; a restore carries the first one over. */
let sessionStartTime = Date.now()

/** What a resume put back into the counters — the budget counts the rest. */
let restoredCostUSD = 0

/**
 * What a spend was for: the request's `QuerySource`, or a label of the
 * tracker's own for a request that has none.
 */
export type SpendSource = QuerySource | 'cache_keep_alive'

/** A spend recorded without a source still counts, under this name. */
const UNATTRIBUTED = 'unattributed'

/**
 * The session's spend by source, beside the per-model totals, carried by the
 * `cost-state` entry. The 2026-10-16..19 census could not name 6.6% of the
 * spend from the transcripts, and could not see the auto-mode classifier at
 * all; this is what it reads instead.
 */
let sourceUsage: Record<string, CostStateSourceUsage> = {}

/**
 * The session's spend by provider profile, beside the per-model totals — what
 * /usage groups by. Keyed by profile id (`env:<provider>` with no profile),
 * and carried by the `cost-state` entry and the project config like the
 * per-model totals. Spend recorded before it existed is only per model;
 * /usage estimates that part (providerAttribution.ts).
 */
let providerUsage: Record<string, CostStateProviderUsage> = {}

/** Who a spend is billed to: a profile key and the name it has at the time. */
export type SpendProvider = { key: string; name: string }

function activeSpendProvider(): SpendProvider {
  const active = tryGetActiveProvider()
  const tag = getAPIProvider()
  return {
    key: active?.profileId ?? `${ENV_KEY_PREFIX}${tag}`,
    name: resolveProviderLabel(active?.name, tag),
  }
}

/**
 * The session whose WHOLE cost the counters hold — Claude Code's cost-ledger
 * owner, and the only session a `cost-state` entry is stamped for.
 * `undefined` until the process's first stamp claims its session; a reset
 * scopes it to the session current at the reset (/clear resets after its
 * switch, saveCostsAndStartNewSession); a resume through
 * restoreCostStateForResume scopes it to the resumed one; `null` (nobody)
 * after a project-config-only restore. Nothing moves it on a bare
 * switchSession: a session reached without that restore holds only part of
 * its cost, and stamping that part would overwrite the whole one its
 * transcript already carries.
 */
let costStateOwner: string | null | undefined

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
  sessionStartTime = Date.now()
  restoredCostUSD = 0
  sourceUsage = {}
  providerUsage = {}
  costStateOwner = getSessionId()
}

export type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  providerUsage: Record<string, CostStateProviderUsage>
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

  const modelUsage = projectConfig.lastModelUsage
    ? withModelLimits(projectConfig.lastModelUsage)
    : undefined

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
    providerUsage: copyProviderUsage(projectConfig.lastProviderUsage ?? {}),
  }
}

/**
 * Put a project-config slot back into the counters: the per-model totals and
 * the per-provider split. The slot keeps no per-source totals, so those start
 * over.
 */
export function restoreStoredSessionCosts(data: StoredCostState): void {
  setCostStateForRestore(data)
  sourceUsage = {}
  providerUsage = copyProviderUsage(data.providerUsage)
}

/**
 * Restores cost state from project config when resuming a session.
 * Only restores if the session ID matches the last saved session.
 * @returns true if cost state was restored, false otherwise
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  // restoreCostStateForResume's project-config tier. The slot cannot know
  // whether the transcript holds a newer total (a `-p --resume` does not
  // update it), so on its own this is no proof of the whole cost: no stamp
  // until restoreCostStateForResume, which consults it after the entry.
  costStateOwner = null
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  restoreStoredSessionCosts(data)
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
 *
 * One API response is written as one transcript entry PER CONTENT BLOCK,
 * each carrying the message_start usage and the last one the final output
 * count (content_block_stop / message_delta in
 * src/providers/shims/claude/streaming.ts). So a `message.id` is billed
 * once, at the max of each field over its entries — the rule `collectRows`
 * applies in scripts/bench/ab/session-cache-ab.ts. Summing them read a
 * 25-response session back at 2.1× its cache reads. An entry without an id
 * stands alone, as before.
 */
export function recomputeCostStateFromMessages(
  messages: ReadonlyArray<unknown>,
): void {
  resetCostState()
  const calls: { model: string; usage: Usage }[] = []
  const callById = new Map<string, { model: string; usage: Usage }>()
  for (const raw of messages) {
    const msg = raw as {
      type?: string
      message?: { id?: unknown; model?: string; usage?: Partial<Usage> }
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
    const id = typeof inner.id === 'string' ? inner.id : undefined
    const seen = id === undefined ? undefined : callById.get(id)
    if (seen) {
      seen.usage = maxUsage(seen.usage, normalized)
      continue
    }
    const call = { model, usage: normalized }
    calls.push(call)
    if (id !== undefined) callById.set(id, call)
  }
  for (const { model, usage } of calls) {
    if (
      usage.input_tokens === 0 &&
      usage.output_tokens === 0 &&
      usage.cache_creation_input_tokens === 0 &&
      usage.cache_read_input_tokens === 0
    ) {
      continue
    }
    const cost = calculateUSDCost(model, usage)
    // A transcript does not say which provider answered: the replayed spend
    // stays per model only, and /usage estimates its provider.
    addToTotalSessionCost(cost, usage, model, undefined, null)
  }
}

/** Field-wise max of two sightings of one response's usage. */
function maxUsage(a: Usage, b: Usage): Usage {
  const ttl =
    a.cache_creation || b.cache_creation
      ? {
          ephemeral_5m_input_tokens: Math.max(
            a.cache_creation?.ephemeral_5m_input_tokens ?? 0,
            b.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          ),
          ephemeral_1h_input_tokens: Math.max(
            a.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            b.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          ),
        }
      : a.cache_creation
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_creation_input_tokens: Math.max(
      a.cache_creation_input_tokens ?? 0,
      b.cache_creation_input_tokens ?? 0,
    ),
    cache_read_input_tokens: Math.max(
      a.cache_read_input_tokens ?? 0,
      b.cache_read_input_tokens ?? 0,
    ),
    cache_creation: ttl,
  } as Usage
}

// --- cost-state: the session's running cost across processes -------------
//
// Claude Code (2.1.280) stamps a `cost-state` transcript entry at exit — an
// exit re-stamp, print mode and REPL alike — and wherever it saves costs
// before switching sessions (/clear, /resume). Every resume restores it and
// keeps the restored total apart: `total_cost_usd` reports the session,
// `--max-budget-usd` compares only what this process spent on top.

/**
 * The `cost-state` entry for `sessionId`, from the in-memory counters, or
 * undefined when they are not that session's whole cost (costStateOwner).
 * `type` stays the first key: loaders classify a line by its prefix.
 */
export function getCostStateEntryFor(
  sessionId: string,
): CostStateEntry | undefined {
  if (costStateOwner === undefined) costStateOwner = sessionId
  if (costStateOwner !== sessionId) return undefined
  return {
    type: 'cost-state',
    sessionId: sessionId as CostStateEntry['sessionId'],
    totalCostUSD: getTotalCostUSD(),
    totalAPIDuration: getTotalAPIDuration(),
    totalAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    totalToolDuration: getTotalToolDuration(),
    totalLinesAdded: getTotalLinesAdded(),
    totalLinesRemoved: getTotalLinesRemoved(),
    totalDuration: getTotalDuration(),
    startTime: sessionStartTime,
    modelUsage: persistedModelUsage(),
    hasUnknownModelCost: hasUnknownModelCost(),
    sourceUsage: copySourceUsage(sourceUsage),
    providerUsage: copyProviderUsage(providerUsage),
  }
}

/**
 * The cost this process added on top of what a resume restored — what
 * `--max-budget-usd` compares in Claude Code, and what its `budget_usd`
 * reminder reports as used; `total_cost_usd` stays the session's total.
 */
export function getCostSinceRestoreUSD(): number {
  return getTotalCostUSD() - restoredCostUSD
}

/** Back to process start: nothing has claimed the counters yet. */
export function resetCostStateOwnerForTesting(): void {
  costStateOwner = undefined
}

export type CostStateSource = 'cost-state' | 'project-config' | 'messages'

/** The one dependency that reads a process-global file; tests swap it. */
export type CostRestoreDeps = {
  /** The project-config slot — it holds only the most recently saved session. */
  restoreFromProjectConfig: (sessionId: string) => boolean
}

const defaultCostRestoreDeps: CostRestoreDeps = {
  restoreFromProjectConfig: restoreCostStateForSession,
}

/**
 * Restore the counters of a session being resumed, from the best source it
 * has: the transcript's `cost-state` entry (what Claude Code restores); else
 * the project-config slot; else a replay of the loaded messages' usage, for
 * transcripts written before the entry existed — the replay cannot see
 * sub-agents. Every resume path calls it after switchSession: headless
 * (`sessionLoad.ts`), CLI (`sessionRestore.ts`), the startup picker
 * (`ResumeConversation.tsx`) and REPL /resume (`resumeSession.ts`, which
 * hands in the slot as it read it before saving the session it leaves).
 */
export function restoreCostStateForResume(
  sessionId: string,
  resumed: {
    costState?: CostStateEntry
    messages: ReadonlyArray<unknown>
  },
  deps: CostRestoreDeps = defaultCostRestoreDeps,
): CostStateSource {
  let source: CostStateSource
  if (resumed.costState?.sessionId === sessionId) {
    restoreCostStateFromEntry(resumed.costState)
    source = 'cost-state'
  } else if (deps.restoreFromProjectConfig(sessionId)) {
    source = 'project-config'
  } else {
    recomputeCostStateFromMessages(resumed.messages)
    source = 'messages'
  }
  // Whichever source it was, the counters are now this session's whole cost
  // (the config tier disowned them), and all of it predates this process.
  costStateOwner = sessionId
  restoredCostUSD = getTotalCostUSD()
  return source
}

function restoreCostStateFromEntry(entry: CostStateEntry): void {
  resetCostState()
  setCostStateForRestore({
    totalCostUSD: entry.totalCostUSD,
    totalAPIDuration: entry.totalAPIDuration,
    totalAPIDurationWithoutRetries: entry.totalAPIDurationWithoutRetries,
    totalToolDuration: entry.totalToolDuration,
    totalLinesAdded: entry.totalLinesAdded,
    totalLinesRemoved: entry.totalLinesRemoved,
    lastDuration: entry.totalDuration,
    modelUsage: withModelLimits(entry.modelUsage),
  })
  if (entry.hasUnknownModelCost) setHasUnknownModelCost()
  sourceUsage = copySourceUsage(entry.sourceUsage ?? {})
  providerUsage = copyProviderUsage(entry.providerUsage ?? {})
  sessionStartTime = Math.min(entry.startTime, sessionStartTime)
}

/** Persisted per-model usage, plus the limits the live counters carry. */
function withModelLimits(usage: Record<string, CostStateModelUsage>): {
  [modelName: string]: ModelUsage
} {
  return Object.fromEntries(
    Object.entries(usage).map(([model, u]) => [
      model,
      {
        ...u,
        contextWindow: getContextWindowForModel(model, getSdkBetas()),
        maxOutputTokens: getModelMaxOutputTokens(model).default,
      },
    ]),
  )
}

/**
 * Stamp the current session's `cost-state`, as Claude Code's saver does
 * beside the project-config slot. Sync: useCostSummary saves from process
 * 'exit'. Required lazily because project.ts already reaches this module
 * (through messages.ts); a failed stamp must not fail the /clear or /resume
 * that is saving.
 */
function recordCostState(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProject } = require('src/sessions/persistence/project.js') as typeof import('src/sessions/persistence/project.js')
    getProject().reAppendCostState()
  } catch (e) {
    logError(e)
  }
}

/** The per-model usage both persisted cost records carry (config and transcript). */
function persistedModelUsage(): Record<string, CostStateModelUsage> {
  return Object.fromEntries(
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
  )
}

function copySourceUsage(
  usage: Readonly<Record<string, CostStateSourceUsage>>,
): Record<string, CostStateSourceUsage> {
  return Object.fromEntries(
    Object.entries(usage).map(([source, u]) => [source, { ...u }]),
  )
}

/** The session's spend by source, as the `cost-state` entry would carry it. */
export function getSourceUsage(): Record<string, CostStateSourceUsage> {
  return copySourceUsage(sourceUsage)
}

function copyModelUsageMap(
  usage: Readonly<Record<string, CostStateModelUsage>>,
): Record<string, CostStateModelUsage> {
  return Object.fromEntries(
    Object.entries(usage).map(([model, u]) => [model, { ...u }]),
  )
}

function copyProviderUsage(
  usage: Readonly<Record<string, CostStateProviderUsage>>,
): Record<string, CostStateProviderUsage> {
  return Object.fromEntries(
    Object.entries(usage).map(([key, bucket]) => [
      key,
      { name: bucket.name, models: copyModelUsageMap(bucket.models) },
    ]),
  )
}

/** Adds `source` into `target` (which it mutates); a later name wins. */
function mergeProviderUsageInto(
  target: Record<string, CostStateProviderUsage>,
  source: Readonly<Record<string, CostStateProviderUsage>>,
): void {
  for (const [key, bucket] of Object.entries(source)) {
    const into = (target[key] ??= { name: bucket.name, models: {} })
    into.name = bucket.name
    for (const [model, usage] of Object.entries(bucket.models)) {
      addModelUsageTo(into.models, model, usage)
    }
  }
}

/** The session's spend by provider profile, as the `cost-state` entry would carry it. */
export function getProviderUsage(): Record<string, CostStateProviderUsage> {
  return copyProviderUsage(providerUsage)
}

function addToSourceUsage(cost: number, usage: Usage, source: string): void {
  const entry = (sourceUsage[source] ??= {
    calls: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
  entry.calls++
  entry.costUSD += cost
  entry.inputTokens += usage.input_tokens
  entry.outputTokens += usage.output_tokens
  entry.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  entry.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
}

function addToProviderUsage(
  cost: number,
  usage: Usage,
  model: string,
  provider: SpendProvider,
): void {
  const bucket = (providerUsage[provider.key] ??= {
    name: provider.name,
    models: {},
  })
  bucket.name = provider.name
  addModelUsageTo(bucket.models, model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
    costUSD: cost,
  })
}

/**
 * The accounting every spend goes through: per model, session total, per
 * source, and per provider unless nobody can say which one answered.
 */
function recordSpend(
  cost: number,
  usage: Usage,
  model: string,
  source: SpendSource | undefined,
  provider: SpendProvider | null,
): void {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)
  addToSourceUsage(cost, usage, source ?? UNATTRIBUTED)
  if (provider) addToProviderUsage(cost, usage, model, provider)
}

/**
 * A side query's spend (`sideQuery()`: the auto-mode classifier, the bash
 * classifier, the permission explainer, model validation). It counts in the
 * session cost, the budget and the `cost-state`, but not in the cache
 * metrics: the hit rate and the `[Cache:]` line describe the conversation's
 * own prefix, and a classifier prompt is not part of it.
 */
export function addSideQueryCost(
  cost: number,
  usage: Usage,
  model: string,
  querySource: QuerySource,
): void {
  recordSpend(cost, usage, model, querySource, activeSpendProvider())
}

/**
 * Saves the current session's costs to project config.
 * Call this before switching sessions to avoid losing accumulated costs.
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  recordCostState()
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
      cumulativeModelUsage = copyModelUsageMap(baseCumulativeModelUsage)
      for (const [model, usage] of Object.entries(current.lastModelUsage)) {
        addModelUsageTo(cumulativeModelUsage, model, usage)
      }
    }

    let cumulativeProviderUsage = current.cumulativeProviderUsage ?? {}
    if (isNewSession && current.lastProviderUsage) {
      cumulativeProviderUsage = copyProviderUsage(cumulativeProviderUsage)
      mergeProviderUsageInto(cumulativeProviderUsage, current.lastProviderUsage)
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
      lastModelUsage: persistedModelUsage(),
      lastProviderUsage: copyProviderUsage(providerUsage),
      lastSessionId: currentSessionId,
      cumulativeCost,
      cumulativeAPIDuration,
      cumulativeDuration,
      cumulativeLinesAdded,
      cumulativeLinesRemoved,
      cumulativeModelUsage,
      cumulativeProviderUsage,
    }
  })
}

/**
 * The cost side of /clear — and of plan mode's "clear context", which runs
 * the same clearConversation. The session being left is saved while it is
 * still current (its project-config slot and its `cost-state` stamp), then
 * `startNewSession` switches to a fresh id, and only then are the counters
 * zeroed: a reset hands them to the session current at the reset, so zeroing
 * before the switch left them owned by the session just left, and the new
 * session's exit stamped no entry. A fresh id has spent nothing anywhere, so
 * zero is its whole cost — unlike a /resume target, whose counters stay
 * unowned until restoreCostStateForResume puts its cost back.
 */
export function saveCostsAndStartNewSession(startNewSession: () => void): void {
  saveCurrentSessionCosts()
  startNewSession()
  resetCostState()
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
  /** Spend by provider profile; models spent before it was recorded are absent. */
  providerUsage: Record<string, CostStateProviderUsage>
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
  for (const [model, usage] of Object.entries(cumulativeModelUsage)) {
    addModelUsageTo(merged, model, usage)
  }
  if (includeLastAsPending && config.lastModelUsage) {
    for (const [model, usage] of Object.entries(config.lastModelUsage)) {
      addModelUsageTo(merged, model, usage)
    }
  }
  for (const [model, usage] of Object.entries(liveModelUsage)) {
    addModelUsageTo(merged, model, usage)
  }

  const mergedProviders = copyProviderUsage(config.cumulativeProviderUsage ?? {})
  if (includeLastAsPending && config.lastProviderUsage) {
    mergeProviderUsageInto(mergedProviders, config.lastProviderUsage)
  }
  mergeProviderUsageInto(mergedProviders, providerUsage)

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
    providerUsage: mergedProviders,
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
  source?: SpendSource,
  /** Who answered; null when nobody can say (a transcript replay). */
  provider: SpendProvider | null = activeSpendProvider(),
): number {
  recordSpend(cost, usage, model, source, provider)

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
  // shown in the REPL — complements CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT
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

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
      source,
      provider,
    )
  }
  return totalCost
}
