// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { getInitialMainLoopModel } from 'src/bootstrap/state.js'
import { getAdditionalModelOptionsCacheScope, isDirectOpenAIProvider } from 'src/services/api/providerConfig.js'
import {
  isClaudeAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from 'src/services/auth/auth.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import {
  COST_TIER_3_15,
  COST_TIER_10_50,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
} from 'src/services/api/modelCost.js'
import { getInitialSettings } from 'src/services/settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from 'src/utils/model/check1mAccess.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { isModelAllowed } from 'src/utils/model/modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  getOpus46PricingSuffix,
  getOpus5PricingSuffix,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  type ModelSetting,
} from 'src/utils/model/model.js'
import { has1mContext } from 'src/services/context/context.js'
import { getFilteredCodexCatalog } from 'src/utils/model/codexModelCatalog.js'
import { getGlobalConfig } from 'src/services/config/config.js'
import {
  getActiveOpenAIModelOptionsCache,
  getActiveProviderProfile,
  getProfileModelOptions,
} from 'src/services/api/providerProfiles.js'
import { getCachedOllamaModelOptions, isOllamaProvider } from 'src/utils/model/ollamaModels.js'
import { getCachedNvidiaNimModelOptions, isNvidiaNimProvider } from 'src/utils/model/nvidiaNimModels.js'
import { getCachedMiniMaxModelOptions, isMiniMaxProvider } from 'src/utils/model/minimaxModels.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

function getScopedAdditionalModelOptions(): ModelOption[] {
  const config = getGlobalConfig()
  const activeScope = getAdditionalModelOptionsCacheScope()

  if (!activeScope) {
    return []
  }

  if (config.additionalModelOptionsCacheScope !== undefined) {
    return config.additionalModelOptionsCacheScope === activeScope
      ? (config.additionalModelOptionsCache ?? [])
      : []
  }

  return activeScope === 'firstParty'
    ? (config.additionalModelOptionsCache ?? [])
    : []
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
// Sonnet 5 — 1M context by default (single entry, no [1m] pair, like Fable 5).
// On 1P the 'sonnet' alias resolves to Sonnet 5, so pin to the alias; on 3P the
// alias still resolves to Sonnet 4.5, so pin the explicit model string.
function getSonnet5Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet5 : 'sonnet',
    label: 'Sonnet 5',
    description: `Sonnet 5 · Best for everyday tasks, 1M context${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 5 - best for everyday tasks. 1M context by default. Generally recommended for most coding tasks',
  }
}

// Sonnet 4.6 — legacy / opt-in entry. Pinned to the explicit model string on both
// providers since the 'sonnet' alias on 1P now resolves to Sonnet 5.
function getSonnet46Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().sonnet46,
    label: 'Sonnet 4.6',
    description: `Sonnet 4.6 · Previous Sonnet${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.6 - previous Sonnet version',
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

// Claude Opus 5 — new default Opus tier. 1M context by default (single entry,
// no [1m] pair, like Sonnet 5 / Fable 5). On 1P the 'opus' alias resolves to
// Opus 5, so pin to the alias; on 3P the alias still resolves to Opus 4.6, so
// pin the explicit model string.
function getOpus5Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus5 : 'opus',
    label: 'Opus',
    description: `Opus 5 · Most capable for complex work · 1M context${getOpus5PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 5 - most capable for complex work. 1M context by default.',
  }
}

// Opus 4.8 — pinned to the explicit model string on both providers since the
// 'opus' alias on 1P now resolves to Opus 5. Legacy / opt-in option.
function getOpus48Option(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus48,
    label: 'Opus 4.8',
    description: `Opus 4.8 · Previous Opus${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.8 - previous Opus version',
  }
}

// Claude Fable 5 — frontier tier above Opus. Pinned to the explicit model
// string (no alias). 1M context is the default, so there is no [1m] variant.
function getFable5Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().fable5,
    label: 'Fable 5',
    description: `Fable 5 · Frontier reasoning, 1M context${is3P ? '' : ` · ${formatModelPricing(COST_TIER_10_50)}`}`,
    descriptionForModel:
      'Fable 5 - most capable frontier model for the hardest long-horizon work. 1M context by default. Higher cost than Opus.',
  }
}

// Opus 4.7 — pinned to the explicit model string on both providers since
// 'opus' alias on 1P now resolves to 4.8. Used as a legacy / opt-in option.
function getOpus47Option(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus47,
    label: 'Opus 4.7',
    description: `Opus 4.7 · Previous Opus${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.7 - previous Opus version',
  }
}

// 4.6 entry — pinned to the explicit model string on both providers since
// 'opus' alias on 1P now resolves to 4.8. Used as a legacy / opt-in option.
function getOpus46Option(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus46,
    label: 'Opus 4.6',
    description: `Opus 4.6 · Previous Opus${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.6 - previous Opus version',
  }
}

// Sonnet 4.6 1M — legacy / opt-in entry. Pinned to the explicit model string on
// both providers since the 'sonnet[1m]' alias on 1P now resolves to Sonnet 5.
export function getSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: getModelStrings().sonnet46 + '[1m]',
    label: 'Sonnet 4.6 (1M context)',
    description: `Sonnet 4.6 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  return {
    value: getModelStrings().opus46 + '[1m]',
    label: 'Opus 4.6 (1M context)',
    description: `Opus 4.6 with 1M context · Previous Opus${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.6 with 1M context - previous Opus version',
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a 3P user has a custom haiku model string, show it directly
  if (is3P && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 5 · Most capable for complex work · 1M context${fastMode ? getOpus5PricingSuffix(true) : ''}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  // On 1P this entry is the 'opus[1m]' alias, so its name must follow whatever
  // the alias currently resolves to (Opus 5) rather than a pinned version — on
  // 3P the value is the explicit 4.8 string, so name that instead.
  const model = is3P ? getModelStrings().opus48 : getDefaultOpusModel()
  const label = getMarketingNameForModel(model) ?? 'Opus'
  return {
    value: is3P ? getModelStrings().opus48 + '[1m]' : 'opus[1m]',
    label,
    description: `${label} · Most capable for complex work${!is3P && fastMode ? getOpus5PricingSuffix(fastMode) : ''}`,
    descriptionForModel: `${label} - most capable for complex work`,
  }
}

// Explicit 200k + 1M entries for every current Claude generation, using full
// model strings (not the 'opus'/'sonnet' aliases) so each entry's context
// window is unambiguous and selectable per session. The 1M variant is listed
// when the account can use 1M, otherwise the API rejects it. The Opus 1M merge
// being enabled means the account already runs 1M by default (the "Default"
// entry resolves to opus[1m]), so it's a stronger signal than checkOpus1mAccess
// — which reads isExtraUsageEnabled() and returns a false negative whenever the
// extra-usage reason hasn't been cached yet, hiding the variants even though 1M
// works. Fall back to the per-model access check when the merge is off.
function getClaudeDualContextOptions(fastMode = false): ModelOption[] {
  const ms = getModelStrings()
  const billing = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  const opusPrice = getOpus46PricingSuffix(fastMode)
  const opts: ModelOption[] = []
  // Sonnet 5 is 1M by default — single entry, no [1m] pair (like Fable 5).
  opts.push({
    value: ms.sonnet5,
    label: 'Sonnet 5',
    description: `Sonnet 5 · Best for everyday tasks · 1M context${billing}${getAPIProvider() !== 'firstParty' ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  })
  // Fable 5 is 1M by default — single entry, no [1m] pair.
  opts.push({
    value: ms.fable5,
    label: 'Fable 5',
    description: `Fable 5 · Frontier reasoning · 1M context${billing}${getAPIProvider() !== 'firstParty' ? '' : ` · ${formatModelPricing(COST_TIER_10_50)}`}`,
  })
  // Opus 5 is 1M by default — single entry, no [1m] pair (like Sonnet/Fable 5).
  // On 1P the 'opus' alias resolves to Opus 5; on 3P (where the default still
  // lags at Opus 4.6) pin the explicit Opus 5 string so it stays selectable.
  // Legacy generations (Opus 4.6/4.7/4.8, Sonnet 4.5/4.6) stay resolvable by
  // explicit string, unlisted.
  opts.push({
    value: getAPIProvider() !== 'firstParty' ? ms.opus5 : 'opus',
    label: 'Opus 5',
    description: `Opus 5 · Most capable for complex work · 1M context${billing}${opusPrice}`,
  })
  return opts
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 5 in plan mode, Sonnet 5 otherwise',
  }
}

function getCodexPlanOption(): ModelOption {
  return {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'GPT-5.5 on the Codex backend with high reasoning',
  }
}

function getCodexSparkOption(): ModelOption {
  return {
    value: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'GPT-5.3 Codex Spark on the Codex backend for fast tool loops',
  }
}

// Picker list for Codex models. Sourced from the curated catalog and passed
// through the opencode-style predicate (getFilteredCodexCatalog) so `pro`
// variants are hidden by rule and future `gpt-X.Y > 5.4` models appear without
// editing an enumeration. See src/utils/model/codexModelCatalog.ts.
function getCodexModelOptions(): ModelOption[] {
  return getFilteredCodexCatalog().map(entry => ({
    value: entry.id as ModelSetting,
    label: entry.label,
    description: entry.description,
  }))
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.

import { getEffectiveCopilotModels } from 'src/utils/model/copilotModelCatalog.js'

function getCopilotModelOptions(): ModelOption[] {
  return getEffectiveCopilotModels().map(m => ({
    value: m.id,
    label: m.name,
    description: `${m.family}${m.reasoning ? ' · Reasoning' : ''}${m.tool_call ? ' · Tool call' : ''} · ${Math.round(m.limit.context / 1000)}K context`,
  }))
}

function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (getAPIProvider() === 'github') {
    return [getDefaultOptionForUser(fastMode), ...getCopilotModelOptions()]
  }

  // When using Ollama, show models from the Ollama server instead of Claude models
  if (getAPIProvider() === 'openai' && isOllamaProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const ollamaModels = getCachedOllamaModelOptions()
    if (ollamaModels.length > 0) {
      return [defaultOption, ...ollamaModels]
    }
    // Fallback: if models not yet fetched, show current model instead of Claude models
    const currentModel = getUserSpecifiedModelSetting() ?? getInitialMainLoopModel()
    if (currentModel != null) {
      return [
        defaultOption,
        {
          value: currentModel,
          label: currentModel,
          description: 'Currently configured Ollama model',
        },
      ]
    }
    return [defaultOption]
  }

  // When using NVIDIA NIM, show models from the NVIDIA catalog
  if (isNvidiaNimProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const nvidiaModels = getCachedNvidiaNimModelOptions()
    if (nvidiaModels.length > 0) {
      return [defaultOption, ...nvidiaModels]
    }
    return [defaultOption]
  }

  // When using MiniMax, show models from the MiniMax catalog
  if (isMiniMaxProvider()) {
    const defaultOption = getDefaultOptionForUser(fastMode)
    const minimaxModels = getCachedMiniMaxModelOptions()
    if (minimaxModels.length > 0) {
      return [defaultOption, ...minimaxModels]
    }
    return [defaultOption]
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus is default. List every Claude
      // generation in both 200k and 1M flavors so the window is selectable.
      return [
        getDefaultOptionForUser(fastMode),
        ...getClaudeDualContextOptions(fastMode),
        MaxHaiku45Option,
      ]
    }

    // Pro/Team Standard/Enterprise users: Sonnet is default. List every Claude
    // generation in both 200k and 1M flavors so the window is selectable.
    return [
      getDefaultOptionForUser(fastMode),
      ...getClaudeDualContextOptions(fastMode),
      MaxHaiku45Option,
    ]
  }

  if (getAdditionalModelOptionsCacheScope()?.startsWith('openai:')) {
    const activeOpenAIOptions = getActiveOpenAIModelOptionsCache()
    return [
      getDefaultOptionForUser(fastMode),
      ...(activeOpenAIOptions.length > 0
        ? activeOpenAIOptions
        : getScopedAdditionalModelOptions()),
    ]
  }

  // For OpenAI-compat aggregators (OpenRouter, NovitaAI, Groq, etc.) with a
  // profile that defines models: show only those. The generic PAYG 3P list maps
  // Claude aliases to gpt-4o fallbacks which is wrong for these providers.
  if (getAPIProvider() === 'openai' && !isDirectOpenAIProvider()) {
    const activeProfile = getActiveProviderProfile()
    if (activeProfile) {
      const models = getProfileModelOptions(activeProfile)
      if (models.length > 0) {
        return filterModelOptionsByAllowlist([getDefaultOptionForUser(fastMode), ...models])
      }
    }
  }

  // When a provider profile is active, collect its models so they can be
  // appended to the standard picker options below.
  const profileModelOptions: ModelOption[] = []
  {
    const activeProfile = getActiveProviderProfile()
    if (activeProfile) {
      const models = getProfileModelOptions(activeProfile)
      profileModelOptions.push(...models)
    }
  }

  // PAYG 1P API: Default (Sonnet 5) + Sonnet 5 + Fable 5 + Opus 5 + Haiku.
  // Opus 5 is 1M-native (no [1m] variant). Only the newest of each family is
  // listed; legacy generations (Opus 4.6/4.7/4.8, Sonnet 4.5/4.6) remain
  // resolvable by explicit string but are hidden here.
  if (getAPIProvider() === 'firstParty') {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    payg1POptions.push(getSonnet5Option())
    payg1POptions.push(getFable5Option())
    payg1POptions.push(getOpus5Option(fastMode))
    payg1POptions.push(getHaiku45Option())
    payg1POptions.push(...profileModelOptions)
    return payg1POptions
  }

  // PAYG 3P: Default (Sonnet 4.5) + Sonnet (3P custom) or Sonnet 4.6/1M + Opus (3P custom) or Opus 4.1/Opus 4.6/Opus1M + Haiku + Opus 4.1
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  // Add Codex models only for direct OpenAI API or the codex provider.
  // OpenAI-compat aggregators (OpenRouter, NovitaAI, Groq, etc.) use the
  // openai transport but don't host GPT-Codex models.
  if (isDirectOpenAIProvider() || getAPIProvider() === 'codex') {
    payg3pOptions.push(...getCodexModelOptions())
  }

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  } else {
    // Add Sonnet 5 (new) + Sonnet 4.6 (200k + 1M) since Sonnet 4.5 is the default.
    // Sonnet 5 may not be available on all 3P providers yet — added as opt-in.
    payg3pOptions.push(getSonnet5Option())
    payg3pOptions.push(getSonnet46Option())
    if (checkSonnet1mAccess()) {
      payg3pOptions.push(getSonnet46_1MOption())
    }
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 4.1, Opus 4.6 (current 3P default), Opus 4.7, Opus 4.8, Opus 5
    // (new, 1M-native), and Opus 4.6 1M. Opus 5 may not be available on all 3P
    // providers yet — added as opt-in.
    payg3pOptions.push(getOpus41Option()) // legacy
    payg3pOptions.push(getOpus46Option(fastMode))
    payg3pOptions.push(getOpus47Option(fastMode))
    payg3pOptions.push(getOpus48Option(fastMode))
    payg3pOptions.push(getOpus5Option(fastMode))
    if (checkOpus1mAccess()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode))
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  payg3pOptions.push(...profileModelOptions)
  return payg3pOptions
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-opus-4')
  ) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  if (getAPIProvider() === 'github') {
    return filterModelOptionsByAllowlist(getModelOptionsBase(fastMode))
  }

  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getScopedAdditionalModelOptions()) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => {
    if (opt.value === customModel) return true
    if (opt.value === null) return false
    try {
      return (
        getCanonicalName(parseUserSpecifiedModel(String(opt.value))) ===
        getCanonicalName(parseUserSpecifiedModel(customModel))
      )
    } catch {
      return false
    }
  })) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'gpt-5.5') {
    return filterModelOptionsByAllowlist([...options, getCodexPlanOption()])
  } else if (customModel === 'gpt-5.3-codex-spark') {
    return filterModelOptionsByAllowlist([...options, getCodexSparkOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getInitialSettings() || {}
  const filtered = !settings.availableModels
    ? options // No restrictions
    : options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )

  // Select state uses option values as identity keys. If two entries share the
  // same value (e.g. provider-specific aliases collapsing to one model ID),
  // navigation/focus can become inconsistent and appear as duplicate rendering.
  const seen = new Set<string>()
  return filtered.filter(opt => {
    const key = String(opt.value)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
