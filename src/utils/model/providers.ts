import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/platform/analytics/index.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { Transport } from 'src/providers/presets/activeProvider.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'github'
  | 'codex'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'

export function getAPIProvider(): APIProvider {
  const profile = tryGetActiveProvider()
  if (!profile) return 'firstParty'

  switch (profile.transport) {
    case 'anthropic':
      return 'firstParty'
    case 'gemini':
      return 'gemini'
    case 'mistral':
      return 'mistral'
    case 'github_copilot':
      return 'github'
    case 'codex_responses':
      return 'codex'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      return 'vertex'
    case 'foundry':
      return 'foundry'
    case 'openai_compat': {
      const baseUrl = profile.baseUrl?.toLowerCase() ?? ''
      if (baseUrl.includes('nvidia')) return 'nvidia-nim'
      if (baseUrl.includes('minimax')) return 'minimax'
      return 'openai'
    }
    default:
      return 'firstParty'
  }
}

export function usesAnthropicAccountFlow(): boolean {
  return getAPIProvider() === 'firstParty'
}

/**
 * Returns true when the GitHub provider should use Anthropic's native API
 * format instead of the OpenAI-compatible shim.
 *
 * Enabled when the active profile transports through GitHub Copilot and the
 * model string contains "claude-" anywhere (handles bare names like
 * "claude-sonnet-4" and compound formats like "github:copilot:claude-sonnet-4"
 * or any future provider-prefixed variants).
 *
 * api.githubcopilot.com supports Anthropic native format for Claude models,
 * enabling prompt caching via cache_control blocks which significantly reduces
 * per-turn token costs by caching the system prompt and tool definitions.
 */
export function isGithubNativeAnthropicMode(resolvedModel?: string): boolean {
  const profile = tryGetActiveProvider()
  if (profile?.transport !== 'github_copilot') return false
  const model = resolvedModel?.trim() || profile.model?.trim() || ''
  // Claude models only: downstream consumers of the native mode (image token
  // estimation, cache profile) assume Anthropic semantics, so a non-Claude
  // model advertising /v1/messages must still take the OpenAI shim.
  if (!model.toLowerCase().includes('claude-')) return false
  // The live account catalog can veto: a Claude model the account serves only
  // via /chat/completions must not take the native route. Lazy require to
  // keep this module leaf-light.
  try {
    const { copilotModelSupportsAnthropicMessages } =
      require('src/utils/model/copilotModelCatalog.js') as typeof import('src/utils/model/copilotModelCatalog.js')
    const supported = copilotModelSupportsAnthropicMessages(model)
    if (supported !== null) return supported
  } catch {
    // catalog unavailable — keep the name heuristic's answer
  }
  return true
}

/**
 * Transports whose requests are translated by the OpenAI-compatible shim
 * (`openaiShim.ts`) rather than sent through the native Anthropic SDK. Kept in
 * sync with the client factory in `client.ts`.
 */
const OPENAI_SHIM_TRANSPORTS: ReadonlySet<Transport> = new Set([
  'openai_compat',
  'gemini',
  'mistral',
  'github_copilot',
  'codex_responses',
])

/**
 * True when the active provider's request for `resolvedModel` flows through the
 * OpenAI shim rather than the native Anthropic SDK. The native Anthropic-format
 * transports (anthropic/bedrock/vertex/foundry) reject unknown request-body
 * fields, so shim-only params (e.g. `effortValue`) must be gated on this to
 * avoid a 400 "Extra inputs are not permitted".
 *
 * Mirrors the shim-vs-native decision in `client.ts` exactly, including the
 * github_copilot + Claude-model carve-out: that combination is routed through
 * the native Anthropic SDK (`isGithubNativeAnthropicMode`), so it is NOT a shim
 * request even though the transport is in the shim set.
 */
export function activeTransportUsesOpenAiShim(resolvedModel?: string): boolean {
  const transport = tryGetActiveProvider()?.transport ?? 'anthropic'
  if (!OPENAI_SHIM_TRANSPORTS.has(transport)) return false
  if (
    transport === 'github_copilot' &&
    isGithubNativeAnthropicMode(resolvedModel)
  ) {
    return false
  }
  return true
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if the active profile points at the first-party Anthropic API.
 * Returns true when transport is `anthropic` and the base URL resolves to
 * api.anthropic.com (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const profile = tryGetActiveProvider()
  if (!profile) {
    return true
  }
  if (profile.transport !== 'anthropic') {
    return false
  }
  const baseUrl = profile.baseUrl
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
