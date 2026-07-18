/**
 * Provider-mode detectors used by the openaiShim modules.
 *
 * Two flavours:
 *  - Resolver-driven (consult `tryGetActiveProvider`): `isGithubModelsMode`,
 *    `isMistralMode`, `isGeminiMode`. Used where the shim needs to know
 *    the active session's transport.
 *  - URL-driven (pure on `baseUrl`): `hasGeminiApiHost`,
 *    `isMoonshotCompatibleBaseUrl`, `isDeepSeekBaseUrl`. Used in branches
 *    that have the explicit baseUrl in scope and don't want a resolver
 *    round-trip.
 *
 * `normalizeDeepSeekReasoningEffort` is a small enum mapper that lives here
 * because it's only consumed by DeepSeek-mode branches.
 */

import { tryGetActiveProvider } from '../activeProvider.js'
import {
  DEEPSEEK_API_HOSTS,
  GEMINI_API_HOST,
  GLM_API_HOSTS,
  KIMI_CODE_API_HOST,
  MOONSHOT_API_HOSTS,
} from './constants.js'

export function isGithubModelsMode(): boolean {
  return tryGetActiveProvider()?.transport === 'github_copilot'
}

export function isMistralMode(): boolean {
  return tryGetActiveProvider()?.transport === 'mistral'
}

export function hasGeminiApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === GEMINI_API_HOST
  } catch {
    return false
  }
}

export function isGeminiMode(): boolean {
  const provider = tryGetActiveProvider()
  if (provider?.transport === 'gemini') return true
  return hasGeminiApiHost(provider?.baseUrl)
}

export function isMoonshotCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    return (
      MOONSHOT_API_HOSTS.has(hostname) ||
      (hostname === KIMI_CODE_API_HOST &&
        parsed.pathname.toLowerCase().startsWith('/coding'))
    )
  } catch {
    return false
  }
}

export function isGlmCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return GLM_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return DEEPSEEK_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function normalizeDeepSeekReasoningEffort(
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): 'high' | 'max' {
  return effort === 'xhigh' || effort === 'max' ? 'max' : 'high'
}
