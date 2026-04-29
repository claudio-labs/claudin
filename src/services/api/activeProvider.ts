/**
 * Central resolver for the active provider profile.
 *
 * Reads the active `ProviderProfile` from `getGlobalConfig()` and maps it into
 * a `ResolvedProvider` shape that downstream consumers (shim, client, cost
 * tracker, startup screen, etc.) can switch on without re-reading provider
 * env vars. Cached in memory and invalidated automatically whenever
 * `saveGlobalConfig` runs.
 */

import { getGlobalConfig, onGlobalConfigChange } from '../../utils/config.js'
import type { ProviderProfile, ProviderProfileExtras } from '../../utils/config.js'
import { getActiveProviderProfile } from '../../utils/providerProfiles.js'
import { getPrimaryModel } from '../../utils/providerModels.js'
import { isOpenAICodexShortcut } from './providerConfig.js'

export type Transport =
  | 'anthropic'
  | 'openai_compat'
  | 'gemini'
  | 'mistral'
  | 'github_copilot'
  | 'codex_responses'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

export type ResolvedProvider = {
  transport: Transport
  baseUrl: string
  model: string
  apiKey?: string
  extras?: ProviderProfileExtras
}

export class ActiveProviderNotConfiguredError extends Error {
  constructor() {
    super('No active provider profile is configured. Run /provider to set one up.')
    this.name = 'ActiveProviderNotConfiguredError'
  }
}

let cachedResolved: ResolvedProvider | null = null
let listenerInstalled = false

function ensureListenerInstalled(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  onGlobalConfigChange(() => {
    cachedResolved = null
  })
}

function resolveTransport(profile: ProviderProfile, primaryModel: string): Transport {
  switch (profile.provider) {
    case 'anthropic':
      return 'anthropic'
    case 'gemini':
      return 'gemini'
    case 'mistral':
      return 'mistral'
    case 'bedrock':
      return 'bedrock'
    case 'vertex':
      return 'vertex'
    case 'foundry':
      return 'foundry'
    case 'openai':
    default: {
      if (profile.extras?.githubToken) {
        return 'github_copilot'
      }
      if (isOpenAICodexShortcut(primaryModel)) {
        return 'codex_responses'
      }
      return 'openai_compat'
    }
  }
}

function resolveFromProfile(profile: ProviderProfile): ResolvedProvider {
  const primaryModel = getPrimaryModel(profile.model)
  const transport = resolveTransport(profile, primaryModel)
  return {
    transport,
    baseUrl: profile.baseUrl,
    model: primaryModel,
    apiKey: profile.apiKey,
    extras: profile.extras,
  }
}

export function getActiveProvider(): ResolvedProvider {
  ensureListenerInstalled()
  if (cachedResolved) {
    return cachedResolved
  }
  const profile = getActiveProviderProfile(getGlobalConfig())
  if (!profile) {
    throw new ActiveProviderNotConfiguredError()
  }
  cachedResolved = resolveFromProfile(profile)
  return cachedResolved
}

/**
 * Like `getActiveProvider`, but returns `null` instead of throwing when no
 * profile is configured. Used by call sites (StartupScreen, preconnect, cost
 * tracker) that run during early startup or one-shot tooling where the user
 * may legitimately have no profile yet.
 */
export function tryGetActiveProvider(): ResolvedProvider | null {
  try {
    return getActiveProvider()
  } catch (err) {
    if (err instanceof ActiveProviderNotConfiguredError) return null
    throw err
  }
}

export function invalidateActiveProviderCache(): void {
  cachedResolved = null
}

/** Test-only: read the cached value without recomputing. Returns null if not cached. */
export function _peekActiveProviderCacheForTesting(): ResolvedProvider | null {
  return cachedResolved
}
