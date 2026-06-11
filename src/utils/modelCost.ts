import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_FABLE_5_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_7_CONFIG,
  CLAUDE_OPUS_4_8_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  // 1h ephemeral cache write price per Mtok. Anthropic-only; when omitted, the
  // 1h TTL bucket falls back to `promptCacheWriteTokens` (5m pricing).
  promptCacheWrite1hTokens?: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheWrite1hTokens: 6,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheWrite1hTokens: 30,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheWrite1hTokens: 10,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Claude Fable 5: $10 input / $50 output per Mtok
export const COST_TIER_10_50 = {
  inputTokens: 10,
  outputTokens: 50,
  promptCacheWriteTokens: 12.5,
  promptCacheWrite1hTokens: 20,
  promptCacheReadTokens: 1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Fast mode pricing for Opus 4.6/4.7: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheWrite1hTokens: 60,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheWrite1hTokens: 1.6,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheWrite1hTokens: 2,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * Public list pricing snapshot for non-Claude models (2026-04). Without this,
 * non-Anthropic providers fell through to `DEFAULT_UNKNOWN_MODEL_COST` ($5/$25
 * Opus tier) — DeepSeek at $0.14/Mtok appeared as $5/Mtok in `/cost`.
 *
 * Cache read rates are populated by `cacheMetrics.ts` for OpenAI/DeepSeek/Codex
 * (mapping `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`),
 * so getting `promptCacheReadTokens` right matters for `/cost`. Cache write is
 * hardcoded 0 in non-Anthropic shims today; values here are kept coherent with
 * each provider's public list pricing for forward-compat.
 *
 * Pattern matching is order-sensitive (more specific first). Refresh manually
 * when providers re-price; sources noted inline.
 */
export const NON_CLAUDE_MODEL_COSTS: ReadonlyArray<{
  pattern: RegExp
  cost: ModelCosts
  label: string
}> = [
  // OpenAI GPT-5 family — 90% cache discount
  { pattern: /gpt-5-nano/i,     label: 'gpt-5-nano',     cost: { inputTokens: 0.05, outputTokens: 0.40, promptCacheWriteTokens: 0.05, promptCacheReadTokens: 0.005, webSearchRequests: 0 } },
  { pattern: /gpt-5-mini/i,     label: 'gpt-5-mini',     cost: { inputTokens: 0.25, outputTokens: 2,    promptCacheWriteTokens: 0.25, promptCacheReadTokens: 0.025, webSearchRequests: 0 } },
  { pattern: /gpt-5/i,          label: 'gpt-5',          cost: { inputTokens: 1.25, outputTokens: 10,   promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.125, webSearchRequests: 0 } },
  // OpenAI 4.x and 4o — 50% cache discount
  { pattern: /gpt-4o-mini/i,    label: 'gpt-4o-mini',    cost: { inputTokens: 0.15, outputTokens: 0.60, promptCacheWriteTokens: 0.15, promptCacheReadTokens: 0.075, webSearchRequests: 0 } },
  { pattern: /gpt-4o/i,         label: 'gpt-4o',         cost: { inputTokens: 2.50, outputTokens: 10,   promptCacheWriteTokens: 2.50, promptCacheReadTokens: 1.25,  webSearchRequests: 0 } },
  { pattern: /gpt-4\.1/i,       label: 'gpt-4.1',        cost: { inputTokens: 2,    outputTokens: 8,    promptCacheWriteTokens: 2,    promptCacheReadTokens: 0.50,  webSearchRequests: 0 } },
  // OpenAI o-series — 50% cache discount
  { pattern: /o4-mini/i,        label: 'o4-mini',        cost: { inputTokens: 0.55, outputTokens: 2.20, promptCacheWriteTokens: 0.55, promptCacheReadTokens: 0.275, webSearchRequests: 0 } },
  { pattern: /\bo3\b/i,         label: 'o3',             cost: { inputTokens: 15,   outputTokens: 60,   promptCacheWriteTokens: 15,   promptCacheReadTokens: 7.50,  webSearchRequests: 0 } },
  { pattern: /\bo1\b/i,         label: 'o1',             cost: { inputTokens: 15,   outputTokens: 60,   promptCacheWriteTokens: 15,   promptCacheReadTokens: 7.50,  webSearchRequests: 0 } },
  // Google Gemini — ~10% cache discount
  { pattern: /gemini.*2\.5.*pro/i,   label: 'gemini-2.5-pro',   cost: { inputTokens: 1.25, outputTokens: 10,   promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.125, webSearchRequests: 0 } },
  { pattern: /gemini.*2\.5.*flash/i, label: 'gemini-2.5-flash', cost: { inputTokens: 0.30, outputTokens: 2.50, promptCacheWriteTokens: 0.30, promptCacheReadTokens: 0.030, webSearchRequests: 0 } },
  { pattern: /gemini.*flash/i,       label: 'gemini-flash',     cost: { inputTokens: 0.10, outputTokens: 0.40, promptCacheWriteTokens: 0.10, promptCacheReadTokens: 0.025, webSearchRequests: 0 } },
  { pattern: /gemini.*pro/i,         label: 'gemini-pro',       cost: { inputTokens: 1.25, outputTokens: 5,    promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.125, webSearchRequests: 0 } },
  { pattern: /gemini/i,              label: 'gemini',           cost: { inputTokens: 0.30, outputTokens: 2.50, promptCacheWriteTokens: 0.30, promptCacheReadTokens: 0.030, webSearchRequests: 0 } },
  // DeepSeek — ~98% cache discount (cache hit $0.0028 vs miss $0.14)
  { pattern: /deepseek/i,            label: 'deepseek',         cost: { inputTokens: 0.14, outputTokens: 0.28, promptCacheWriteTokens: 0.14, promptCacheReadTokens: 0.0028, webSearchRequests: 0 } },
  // Moonshot / Kimi — kimi-for-coding endpoint ~$1/$2; kimi-k2 ~$0.60/$2.50
  { pattern: /kimi-for-coding/i,     label: 'kimi-for-coding',  cost: { inputTokens: 1,    outputTokens: 2,    promptCacheWriteTokens: 1,    promptCacheReadTokens: 0.10, webSearchRequests: 0 } },
  { pattern: /kimi/i,                label: 'kimi',             cost: { inputTokens: 0.60, outputTokens: 2.50, promptCacheWriteTokens: 0.60, promptCacheReadTokens: 0.06, webSearchRequests: 0 } },
  { pattern: /moonshot/i,            label: 'moonshot',         cost: { inputTokens: 0.60, outputTokens: 2.50, promptCacheWriteTokens: 0.60, promptCacheReadTokens: 0.06, webSearchRequests: 0 } },
  // Mistral — sem cache discount publicado
  { pattern: /devstral/i,            label: 'devstral',         cost: { inputTokens: 0.10, outputTokens: 0.30, promptCacheWriteTokens: 0.10, promptCacheReadTokens: 0.10, webSearchRequests: 0 } },
  { pattern: /mistral.*large.*3/i,   label: 'mistral-large-3',  cost: { inputTokens: 0.50, outputTokens: 1.50, promptCacheWriteTokens: 0.50, promptCacheReadTokens: 0.50, webSearchRequests: 0 } },
  { pattern: /mistral.*large/i,      label: 'mistral-large',    cost: { inputTokens: 2,    outputTokens: 6,    promptCacheWriteTokens: 2,    promptCacheReadTokens: 2,    webSearchRequests: 0 } },
  { pattern: /mistral.*medium/i,     label: 'mistral-medium',   cost: { inputTokens: 0.40, outputTokens: 2,    promptCacheWriteTokens: 0.40, promptCacheReadTokens: 0.40, webSearchRequests: 0 } },
  { pattern: /mistral.*small/i,      label: 'mistral-small',    cost: { inputTokens: 0.10, outputTokens: 0.30, promptCacheWriteTokens: 0.10, promptCacheReadTokens: 0.10, webSearchRequests: 0 } },
  { pattern: /ministral.*8b/i,       label: 'ministral-8b',     cost: { inputTokens: 0.10, outputTokens: 0.10, promptCacheWriteTokens: 0.10, promptCacheReadTokens: 0.10, webSearchRequests: 0 } },
  { pattern: /ministral.*3b/i,       label: 'ministral-3b',     cost: { inputTokens: 0.04, outputTokens: 0.04, promptCacheWriteTokens: 0.04, promptCacheReadTokens: 0.04, webSearchRequests: 0 } },
  // Llama — preços médios (Groq tier); host varia
  { pattern: /llama.*405/i,          label: 'llama-405b',       cost: { inputTokens: 3.50, outputTokens: 3.50, promptCacheWriteTokens: 3.50, promptCacheReadTokens: 3.50, webSearchRequests: 0 } },
  { pattern: /llama.*70/i,           label: 'llama-70b',        cost: { inputTokens: 0.59, outputTokens: 0.79, promptCacheWriteTokens: 0.59, promptCacheReadTokens: 0.59, webSearchRequests: 0 } },
  { pattern: /llama.*8b/i,           label: 'llama-8b',         cost: { inputTokens: 0.10, outputTokens: 0.10, promptCacheWriteTokens: 0.10, promptCacheReadTokens: 0.10, webSearchRequests: 0 } },
  // Outros providers OpenAI-compat
  { pattern: /qwen/i,                label: 'qwen',             cost: { inputTokens: 0.50, outputTokens: 1.50, promptCacheWriteTokens: 0.50, promptCacheReadTokens: 0.50, webSearchRequests: 0 } },
  { pattern: /minimax/i,             label: 'minimax',          cost: { inputTokens: 0.20, outputTokens: 1.10, promptCacheWriteTokens: 0.20, promptCacheReadTokens: 0.20, webSearchRequests: 0 } },
  { pattern: /\bglm/i,               label: 'glm',              cost: { inputTokens: 0.50, outputTokens: 1.50, promptCacheWriteTokens: 0.50, promptCacheReadTokens: 0.50, webSearchRequests: 0 } },
  // Grok (xAI) — fast variants 25% of flagship; ~75% cache discount on fast tier
  { pattern: /grok.*4.*fast/i,       label: 'grok-4-fast',      cost: { inputTokens: 0.20, outputTokens: 0.50, promptCacheWriteTokens: 0.20, promptCacheReadTokens: 0.05,  webSearchRequests: 0 } },
  { pattern: /grok.*4\.20/i,         label: 'grok-4.20',        cost: { inputTokens: 2,    outputTokens: 6,    promptCacheWriteTokens: 2,    promptCacheReadTokens: 0.50,  webSearchRequests: 0 } },
  { pattern: /grok.*4/i,             label: 'grok-4',           cost: { inputTokens: 3,    outputTokens: 15,   promptCacheWriteTokens: 3,    promptCacheReadTokens: 0.75,  webSearchRequests: 0 } },
  { pattern: /grok/i,                label: 'grok',             cost: { inputTokens: 2,    outputTokens: 6,    promptCacheWriteTokens: 2,    promptCacheReadTokens: 0.50,  webSearchRequests: 0 } },
  // Cohere Command — sem cache discount publicado
  { pattern: /command-?r-?plus|command-r\+/i, label: 'command-r-plus', cost: { inputTokens: 2.50, outputTokens: 10,   promptCacheWriteTokens: 2.50, promptCacheReadTokens: 2.50, webSearchRequests: 0 } },
  { pattern: /command-?a\b/i,        label: 'command-a',        cost: { inputTokens: 2.50, outputTokens: 10,   promptCacheWriteTokens: 2.50, promptCacheReadTokens: 2.50, webSearchRequests: 0 } },
  { pattern: /command-?r7b/i,        label: 'command-r7b',      cost: { inputTokens: 0.0375, outputTokens: 0.15, promptCacheWriteTokens: 0.0375, promptCacheReadTokens: 0.0375, webSearchRequests: 0 } },
  { pattern: /command-?r/i,          label: 'command-r',        cost: { inputTokens: 0.15, outputTokens: 0.60, promptCacheWriteTokens: 0.15, promptCacheReadTokens: 0.15, webSearchRequests: 0 } },
  // Gemma (Google open) — preços via DeepInfra/AI Studio
  { pattern: /gemma.*27b/i,          label: 'gemma-27b',        cost: { inputTokens: 0.08, outputTokens: 0.16, promptCacheWriteTokens: 0.08, promptCacheReadTokens: 0.08, webSearchRequests: 0 } },
  { pattern: /gemma.*12b/i,          label: 'gemma-12b',        cost: { inputTokens: 0.04, outputTokens: 0.13, promptCacheWriteTokens: 0.04, promptCacheReadTokens: 0.04, webSearchRequests: 0 } },
  { pattern: /gemma/i,               label: 'gemma',            cost: { inputTokens: 0.04, outputTokens: 0.08, promptCacheWriteTokens: 0.04, promptCacheReadTokens: 0.04, webSearchRequests: 0 } },
  // Phi (Microsoft) — Azure direct pricing
  { pattern: /phi-?4-?mini/i,        label: 'phi-4-mini',       cost: { inputTokens: 0.075, outputTokens: 0.30, promptCacheWriteTokens: 0.075, promptCacheReadTokens: 0.075, webSearchRequests: 0 } },
  { pattern: /phi-?4/i,              label: 'phi-4',            cost: { inputTokens: 0.13, outputTokens: 0.50, promptCacheWriteTokens: 0.13, promptCacheReadTokens: 0.13, webSearchRequests: 0 } },
  { pattern: /\bphi\b/i,             label: 'phi',              cost: { inputTokens: 0.13, outputTokens: 0.50, promptCacheWriteTokens: 0.13, promptCacheReadTokens: 0.13, webSearchRequests: 0 } },
]

function lookupNonClaudeCost(model: string): ModelCosts | undefined {
  for (const entry of NON_CLAUDE_MODEL_COSTS) {
    if (entry.pattern.test(model)) return entry.cost
  }
  return undefined
}

/**
 * Get the cost tier for Opus 4.6/4.7 based on fast mode. Both versions share
 * the same pricing as of launch — adjust here if 4.7 prices change.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_8_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_FABLE_5_CONFIG.firstParty)]:
    COST_TIER_10_50,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  const cacheWrite1hPrice =
    modelCosts.promptCacheWrite1hTokens ?? modelCosts.promptCacheWriteTokens

  // Prefer the per-TTL breakdown (`cache_creation`) over the scalar field so
  // sessions that latch into the 1h ephemeral cache get billed at the correct
  // 2× rate instead of the 1.25× 5m rate. Falls back to the scalar for shims
  // (Bedrock/Vertex/OpenAI-compat) and replay paths that don't carry the split.
  const cc = usage.cache_creation
  const cacheWriteCost = cc
    ? ((cc.ephemeral_5m_input_tokens ?? 0) / 1_000_000) *
        modelCosts.promptCacheWriteTokens +
      ((cc.ephemeral_1h_input_tokens ?? 0) / 1_000_000) * cacheWrite1hPrice
    : ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens

  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    cacheWriteCost +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  // Check if this is an Opus 4.6 / 4.7 / 4.8 model with fast mode active.
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty) ||
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty) ||
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_8_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    // Try non-Claude family table before falling back to the unknown default.
    // Avoids reporting DeepSeek/Gemini/etc. at the Opus 4.5 default tier.
    const familyCost = lookupNonClaudeCost(model)
    if (familyCost) return familyCost
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName] ?? lookupNonClaudeCost(model)
  if (!costs) return undefined
  return formatModelPricing(costs)
}
