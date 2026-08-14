import { logForDebugging } from 'src/utils/debug.js'
import { isBareMode } from 'src/utils/envUtils.js'
import { isENOENT } from 'src/utils/errors.js'
import { getKimiDeviceHeaders } from './kimiDeviceHeaders.js'
import { logError } from 'src/utils/log.js'
import { getSecureStorage } from 'src/services/secureStorage/index.js'
import {
  asTrimmedString,
  decodeJwtPayload,
  getKimiOAuthClientId,
  KIMI_AUTH_HOST_USER_AGENT,
  KIMI_OAUTH_TOKEN_URL,
} from 'src/services/api/kimiOAuthShared.js'

export const KIMI_STORAGE_KEY = 'kimiCode' as const
// Access tokens live only ~900s; refresh 60s ahead of expiry.
const KIMI_TOKEN_REFRESH_SKEW_MS = 60_000
const KIMI_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000

export type KimiCredentialBlob = {
  accessToken: string
  refreshToken?: string
  profileId?: string
  /** Absolute epoch-ms when the access token expires (persisted from `expires_in`). */
  expiresAt?: number
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

type KimiTokenRefreshResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

let inFlightKimiRefresh:
  | Promise<{ refreshed: boolean; credentials?: KimiCredentialBlob }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null

// Every Kimi request preflights the credential blob (freshness check) before the
// in-memory expiry test, and on Linux/libsecret each `readAsync()` is a blocking
// `secret-tool` subprocess spawn with no cache of its own. Cache the parsed blob
// in-process for a short TTL so a steady stream of requests doesn't spawn a
// subprocess per request; invalidated on every write (save/clear/refresh).
const KIMI_CREDENTIAL_CACHE_TTL_MS = 30_000
let cachedKimiCredentials: {
  blob: KimiCredentialBlob | undefined
  expiresAt: number
} | null = null

/** Drop the in-process credential cache. Exported for tests + explicit resets. */
export function invalidateKimiCredentialCache(): void {
  cachedKimiCredentials = null
}

function getKimiSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: true })
}

function parseJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

function normalizeKimiCredentialBlob(
  value: unknown,
): KimiCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const accessToken = asTrimmedString(record.accessToken)
  if (!accessToken) return undefined

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined

  return {
    accessToken,
    refreshToken: asTrimmedString(record.refreshToken),
    profileId: asTrimmedString(record.profileId),
    expiresAt: num(record.expiresAt),
    lastRefreshAt: num(record.lastRefreshAt),
    lastRefreshFailureAt: num(record.lastRefreshFailureAt),
  }
}

function shouldRefreshKimiToken(blob: KimiCredentialBlob): boolean {
  const expiresAt = blob.expiresAt ?? parseJwtExpiryMs(blob.accessToken)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now() + KIMI_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: KimiCredentialBlob,
  now = Date.now(),
): boolean {
  const lastRefreshFailureAt = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )
  if (!lastRefreshFailureAt) return false
  return now - lastRefreshFailureAt < KIMI_TOKEN_REFRESH_RETRY_COOLDOWN_MS
}

function getRefreshErrorMessage(status: number, bodyText: string): string {
  if (!bodyText.trim()) {
    return `Kimi token refresh failed with status ${status}.`
  }
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const message =
      asTrimmedString(parsed.error_description) ??
      asTrimmedString(parsed.error) ??
      bodyText.trim()
    return `Kimi token refresh failed with status ${status}: ${message}`
  } catch {
    return `Kimi token refresh failed with status ${status}: ${bodyText.trim()}`
  }
}

export function readKimiCredentials(): KimiCredentialBlob | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getKimiSecureStorage().read()
    return normalizeKimiCredentialBlob(data?.[KIMI_STORAGE_KEY])
  } catch (e) {
    if (!isENOENT(e)) logError(e)
    return undefined
  }
}

export async function readKimiCredentialsAsync(): Promise<
  KimiCredentialBlob | undefined
> {
  if (isBareMode()) return undefined
  const now = Date.now()
  if (cachedKimiCredentials && cachedKimiCredentials.expiresAt > now) {
    return cachedKimiCredentials.blob
  }
  try {
    const data = await getKimiSecureStorage().readAsync()
    const blob = normalizeKimiCredentialBlob(data?.[KIMI_STORAGE_KEY])
    cachedKimiCredentials = { blob, expiresAt: now + KIMI_CREDENTIAL_CACHE_TTL_MS }
    return blob
  } catch (e) {
    if (!isENOENT(e)) logError(e)
    return undefined
  }
}

export function saveKimiCredentials(
  credentials: KimiCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const normalized = normalizeKimiCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Kimi credentials are incomplete.' }
  }
  const secureStorage = getKimiSecureStorage()
  const previous = secureStorage.read() || {}
  const previousKimi = normalizeKimiCredentialBlob(previous[KIMI_STORAGE_KEY])
  const next = {
    ...(previous as Record<string, unknown>),
    [KIMI_STORAGE_KEY]: {
      ...normalized,
      profileId: normalized.profileId ?? previousKimi?.profileId,
      expiresAt: normalized.expiresAt ?? previousKimi?.expiresAt,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = secureStorage.update(next as typeof previous)
  invalidateKimiCredentialCache()
  if (result.success) {
    const stored = normalizeKimiCredentialBlob(next[KIMI_STORAGE_KEY])
    inMemoryLastRefreshFailureAt = stored?.lastRefreshFailureAt ?? null
  }
  return result
}

function persistKimiRefreshFailure(
  credentials: KimiCredentialBlob,
  occurredAt: number,
): void {
  const result = saveKimiCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) {
    inMemoryLastRefreshFailureAt = occurredAt
  }
}

export function clearKimiCredentials(): { success: boolean; warning?: string } {
  if (isBareMode()) return { success: true }
  const secureStorage = getKimiSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[KIMI_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  invalidateKimiCredentialCache()
  if (result.success) {
    inMemoryLastRefreshFailureAt = null
  } else {
    const cause = result.warning ?? 'secure storage update failed'
    logError(`clearKimiCredentials: failed to remove Kimi entry (${cause})`)
    return { success: false, warning: cause }
  }
  return result
}

export async function refreshKimiAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<{ refreshed: boolean; credentials?: KimiCredentialBlob }> {
  if (isBareMode()) return { refreshed: false }

  const current = await readKimiCredentialsAsync()
  if (!current) return { refreshed: false }
  if (!current.refreshToken) return { refreshed: false, credentials: current }

  if (!options?.force && !shouldRefreshKimiToken(current)) {
    return { refreshed: false, credentials: current }
  }
  // On a forced refresh (withRetry's 401 recovery) bypass the cooldown — a
  // server-side 401 means the stored token is dead regardless of a recent
  // failure, and we owe the user one fresh attempt before a re-login.
  if (!options?.force && isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }

  if (inFlightKimiRefresh) return inFlightKimiRefresh

  inFlightKimiRefresh = (async () => {
    const refreshAttemptedAt = Date.now()
    try {
      const response = await fetch(KIMI_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': KIMI_AUTH_HOST_USER_AGENT,
          ...(await getKimiDeviceHeaders()),
        },
        body: new URLSearchParams({
          client_id: getKimiOAuthClientId(),
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken!,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new Error(getRefreshErrorMessage(response.status, bodyText))
      }

      const payload = (await response.json()) as KimiTokenRefreshResponse
      const accessToken = asTrimmedString(payload.access_token)
      if (!accessToken) {
        throw new Error('Kimi token refresh succeeded without a new access token.')
      }
      const expiresInSec =
        typeof payload.expires_in === 'number' &&
        Number.isFinite(payload.expires_in) &&
        payload.expires_in > 0
          ? payload.expires_in
          : 900
      const next: KimiCredentialBlob = {
        accessToken,
        refreshToken:
          asTrimmedString(payload.refresh_token) ?? current.refreshToken,
        profileId: current.profileId,
        expiresAt: Date.now() + expiresInSec * 1000,
        lastRefreshAt: Date.now(),
      }

      const saveResult = saveKimiCredentials(next)
      if (!saveResult.success) {
        logForDebugging(
          `[kimi] token refresh succeeded but credentials could not be saved: ${saveResult.warning ?? 'unknown error'}`,
          { level: 'warn' },
        )
      }
      return { refreshed: true, credentials: next }
    } catch (error) {
      persistKimiRefreshFailure(current, refreshAttemptedAt)
      throw error
    } finally {
      inFlightKimiRefresh = null
    }
  })()

  return inFlightKimiRefresh
}
