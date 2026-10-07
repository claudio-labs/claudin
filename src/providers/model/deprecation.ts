/**
 * Model deprecation utilities
 *
 * Contains information about deprecated models and their retirement dates.
 */

import { type APIProvider, getAPIProvider } from 'src/providers/model/providers.js'

type DeprecatedModelInfo = {
  isDeprecated: true
  modelName: string
  retirementDate: string
}

type NotDeprecatedInfo = {
  isDeprecated: false
}

type DeprecationInfo = DeprecatedModelInfo | NotDeprecatedInfo

type DeprecationEntry = {
  /** Human-readable model name */
  modelName: string
  /**
   * Retirement dates by provider (null = not deprecated for that provider,
   * absent = the model was never offered there).
   */
  retirementDates: Partial<Record<APIProvider, string | null>>
}

/**
 * Deprecated models and their retirement dates by provider.
 * Keys are substrings to match in model IDs (case-insensitive).
 * To add a new deprecated model, add an entry to this object.
 */
const DEPRECATED_MODELS: Record<string, DeprecationEntry> = {
  'claude-3-opus': {
    modelName: 'Claude 3 Opus',
    retirementDates: {
      firstParty: 'January 5, 2026',
      bedrock: 'January 15, 2026',
      vertex: 'January 5, 2026',
      foundry: 'January 5, 2026',
    },
  },
  'claude-3-7-sonnet': {
    modelName: 'Claude 3.7 Sonnet',
    retirementDates: {
      firstParty: 'February 19, 2026',
      bedrock: 'April 28, 2026',
      vertex: 'May 11, 2026',
      foundry: 'February 19, 2026',
    },
  },
  'claude-3-5-haiku': {
    modelName: 'Claude 3.5 Haiku',
    retirementDates: {
      firstParty: 'February 19, 2026',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  },
  // Anthropic's date covers the platforms it operates (Claude API, Foundry);
  // Bedrock and Vertex are partner-operated and set their own schedules.
  'claude-sonnet-4-5': {
    modelName: 'Claude Sonnet 4.5',
    retirementDates: {
      firstParty: 'November 30, 2026',
      bedrock: null,
      vertex: null,
      foundry: 'November 30, 2026',
    },
  },
}

/**
 * Check if a model is deprecated and get its deprecation info
 */
function getDeprecatedModelInfo(
  modelId: string,
  provider: APIProvider,
): DeprecationInfo {
  const lowercaseModelId = modelId.toLowerCase()

  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    const retirementDate = value.retirementDates[provider]
    if (!lowercaseModelId.includes(key) || !retirementDate) {
      continue
    }
    return {
      isDeprecated: true,
      modelName: value.modelName,
      retirementDate,
    }
  }

  return { isDeprecated: false }
}

/**
 * Get a deprecation warning message for a model, or null if not deprecated
 */
export function getModelDeprecationWarning(
  modelId: string | null,
  provider: APIProvider = getAPIProvider(),
): string | null {
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId, provider)
  if (!info.isDeprecated) {
    return null
  }

  return `⚠ ${info.modelName} will be retired on ${info.retirementDate}. Consider switching to a newer model.`
}
