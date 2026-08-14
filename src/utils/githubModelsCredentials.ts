import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import { exchangeForCopilotToken } from 'src/services/github/deviceFlow.js'
import { getProviderProfiles, updateProviderProfile } from './providerProfiles.js'

function isGithubCopilotProfileActive(): boolean {
  return tryGetActiveProvider()?.transport === 'github_copilot'
}

/** JSON key in the shared Claudin secure storage blob. */
export const GITHUB_MODELS_STORAGE_KEY = 'githubModels' as const
export const GITHUB_MODELS_HYDRATED_ENV_MARKER =
  'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED' as const

// Single-flight dedup: concurrent callers share the same in-flight refresh
let inFlightGithubRefresh: Promise<boolean> | null = null

export type GithubModelsCredentialBlob = {
  accessToken: string
  oauthAccessToken?: string
  /** GitHub Enterprise domain the OAuth token belongs to; unset = github.com. */
  enterpriseDomain?: string
}

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

function checkGithubTokenStatus(token: string): GithubTokenStatus {
  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  return 'invalid_format'
}

export function readGithubModelsToken(): string | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

export async function readGithubModelsTokenAsync(): Promise<string | undefined> {
  if (isBareMode()) return undefined
  try {
    const data = (await getSecureStorage().readAsync()) as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

/**
 * Backwards-compat shim. The GitHub Copilot transport now reads the access
 * token directly from `profile.extras.githubToken`, so there's no token to
 * "hydrate" — keep the marker bookkeeping so consumers gating on it still see
 * a stable signal that the secure-storage token was visible at startup.
 */
export function hydrateGithubModelsTokenFromSecureStorage(): void {
  if (!isGithubCopilotProfileActive()) return
  if (isBareMode()) return
  if (readGithubModelsToken()) {
    return
  }
}

/**
 * Startup auto-refresh for GitHub Models mode.
 *
 * If a stored Copilot token is expired/invalid and an OAuth token is present,
 * exchange the OAuth token for a fresh Copilot token and persist it.
 */
export async function refreshGithubModelsTokenIfNeeded(): Promise<boolean> {
  if (!isGithubCopilotProfileActive()) {
    return false
  }
  if (isBareMode()) {
    return false
  }

  // Single-flight dedup: if a refresh is already in flight, return the
  // same promise so concurrent callers don't fire duplicate HTTP requests.
  if (inFlightGithubRefresh) {
    return inFlightGithubRefresh
  }

  inFlightGithubRefresh = (async () => {
    try {
      const secureStorage = getSecureStorage()
      const data = secureStorage.read() as
        | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
        | null
      const blob = data?.githubModels
      const accessToken = blob?.accessToken?.trim() || ''
      const oauthToken = blob?.oauthAccessToken?.trim() || ''

      if (!accessToken && !oauthToken) {
        return false
      }

      const status = accessToken ? checkGithubTokenStatus(accessToken) : 'expired'
      if (status === 'valid') {
        return false
      }

      if (!oauthToken) {
        return false
      }

      const enterpriseDomain = blob?.enterpriseDomain?.trim() || undefined
      const refreshed = await exchangeForCopilotToken(oauthToken, {
        domain: enterpriseDomain,
      })
      const saved = saveGithubModelsToken(refreshed.token, oauthToken, enterpriseDomain)
      if (!saved.success) {
        return false
      }

      // Update the active Copilot profile's extras.githubToken so the API shim
      // picks up the fresh token on the next request without requiring a reconnect.
      const copilotProfile = getProviderProfiles().find(
        p => p.provider === 'openai' && p.extras?.githubToken !== undefined,
      )
      if (copilotProfile) {
        updateProviderProfile(copilotProfile.id, {
          provider: 'openai',
          name: copilotProfile.name,
          baseUrl: copilotProfile.baseUrl,
          model: copilotProfile.model,
          apiKey: refreshed.token,
          extras: { ...copilotProfile.extras, githubToken: refreshed.token },
        })
      }

      return true
    } catch {
      return false
    } finally {
      inFlightGithubRefresh = null
    }
  })()

  return inFlightGithubRefresh
}

export function saveGithubModelsToken(
  token: string,
  oauthToken?: string,
  enterpriseDomain?: string,
): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const prevGithubModels = (prev as Record<string, unknown>)[
    GITHUB_MODELS_STORAGE_KEY
  ] as GithubModelsCredentialBlob | undefined
  const oauthTrimmed = oauthToken?.trim()
  const mergedBlob: GithubModelsCredentialBlob = {
    accessToken: trimmed,
  }
  if (oauthTrimmed) {
    mergedBlob.oauthAccessToken = oauthTrimmed
    // The domain travels with the OAuth token it belongs to: set it when a
    // fresh OAuth token is provided (undefined = github.com), preserve it
    // when only the Copilot token is being rotated.
    if (enterpriseDomain?.trim()) {
      mergedBlob.enterpriseDomain = enterpriseDomain.trim()
    }
  } else {
    if (prevGithubModels?.oauthAccessToken?.trim()) {
      mergedBlob.oauthAccessToken = prevGithubModels.oauthAccessToken.trim()
    }
    const preservedDomain =
      enterpriseDomain?.trim() || prevGithubModels?.enterpriseDomain?.trim()
    if (preservedDomain) {
      mergedBlob.enterpriseDomain = preservedDomain
    }
  }
  const merged = {
    ...(prev as Record<string, unknown>),
    [GITHUB_MODELS_STORAGE_KEY]: mergedBlob,
  }
  return secureStorage.update(merged as typeof prev)
}

export function clearGithubModelsToken(): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: true }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const next = { ...(prev as Record<string, unknown>) }
  delete next[GITHUB_MODELS_STORAGE_KEY]
  return secureStorage.update(next as typeof prev)
}
