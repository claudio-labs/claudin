import type { ProviderProfile } from 'src/platform/config/config.js'
import { DEFAULT_XAI_BASE_URL } from 'src/providers/presets/providerConfig.js'
import type {
  AtomicChatReadiness,
  OllamaGenerationReadiness,
} from 'src/providers/presets/providerDiscovery.js'
import { KIMI_OAUTH_BASE_URL } from 'src/providers/ui/providerManagerConstants.js'
import { redactUrlForDisplay } from 'src/shared/urlRedaction.js'

export function describeAtomicChatSelectionIssue(
  readiness: AtomicChatReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Atomic Chat at ${redactUrlForDisplay(baseUrl)}. Start the Atomic Chat app first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Atomic Chat is running, but no models are loaded. Download and load a model inside the Atomic Chat app first, or enter details manually.'
  }

  return ''
}

export function describeOllamaSelectionIssue(
  readiness: OllamaGenerationReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Ollama at ${redactUrlForDisplay(baseUrl)}. Start Ollama first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Ollama is running, but no installed models were found. Pull a chat model such as qwen2.5-coder:7b or llama3.1:8b first, or enter details manually.'
  }

  if (readiness.state === 'generation_failed') {
    const modelHint = readiness.probeModel ?? 'the selected model'
    const detailSuffix = readiness.detail
      ? ` Details: ${readiness.detail}.`
      : ''
    return `Ollama is reachable and models are installed, but a generation probe failed for ${modelHint}.${detailSuffix} Run "ollama run ${modelHint}" once and retry, or enter details manually.`
  }

  return ''
}

export function findCodexOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (!profileId) {
    return undefined
  }

  return profiles.find(profile => profile.id === profileId)
}

export function isCodexOAuthProfile(
  profile: ProviderProfile | null | undefined,
  profileId?: string,
): boolean {
  return Boolean(profile && profileId && profile.id === profileId)
}

/**
 * Locate the existing Kimi Code OAuth profile so a re-login UPDATES it (refreshing
 * the model list, etc.) instead of appending a duplicate. Prefers the profileId
 * stored with the credentials; falls back to the OAuth-profile signature (coding
 * host + no static key), mirroring the deletion heuristic below.
 */
export function findKimiOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (profileId) {
    const byId = profiles.find(profile => profile.id === profileId)
    if (byId) return byId
  }
  return profiles.find(
    profile =>
      profile.provider === 'openai' &&
      profile.baseUrl === KIMI_OAUTH_BASE_URL &&
      !profile.apiKey,
  )
}

/**
 * Locate the existing xAI / Grok OAuth profile so a re-login UPDATES it instead
 * of appending a duplicate. Prefers the profileId stored with the credentials;
 * falls back to the OAuth-profile signature (xAI base URL + no static key).
 */
export function findXaiOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (profileId) {
    const byId = profiles.find(profile => profile.id === profileId)
    if (byId) return byId
  }
  return profiles.find(
    profile =>
      profile.provider === 'openai' &&
      profile.baseUrl === DEFAULT_XAI_BASE_URL &&
      !profile.apiKey,
  )
}

/**
 * Locate the existing Anthropic OAuth profile so a re-login UPDATES it instead of
 * appending a duplicate. Anthropic OAuth stores its tokens in the credentials file
 * (no per-profile id), so match the keyless anthropic profile by signature.
 */
export function findAnthropicOAuthProfile(
  profiles: ProviderProfile[],
  baseUrl: string,
): ProviderProfile | undefined {
  return profiles.find(
    profile =>
      profile.provider === 'anthropic' &&
      profile.baseUrl === baseUrl &&
      !profile.apiKey,
  )
}
