import { logForDebugging } from 'src/shared/debug.js'
import { isBareMode } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import { getXaiUserAgent } from 'src/services/api/xaiUserAgent.js'
import {
  asTrimmedString,
  decodeJwtPayload,
  getXaiOAuthClientId,
  XAI_OAUTH_TOKEN_URL,
} from 'src/services/api/xaiOAuthShared.js'

export const XAI_STORAGE_KEY = 'xai' as const
// 120s skew mirrors opencode `plugin/xai.ts:45-46` (ACCESS_TOKEN_REFRESH_SKEW_MS).
// Codex uses 60s; xAI's xAI/Grok client refreshes more eagerly.
const XAI_TOKEN_REFRESH_SKEW_MS = 120_000
const XAI_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000

export type XaiCredentialBlob = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  profileId?: string
  /**
   * Absolute epoch-ms when the access token expires. Computed from the
   * token endpoint's `expires_in` (server clock) and persisted on every
   * exchange/refresh so opaque (non-JWT) access tokens still drive
   * proactive refresh — `parseJwtExpiryMs` only works for JWTs.
   */
  expiresAt?: number
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

type XaiTokenRefreshResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

let inFlightXaiRefresh:
  | Promise<{
      refreshed: boolean
      credentials?: XaiCredentialBlob
    }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null

function getXaiSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: true })
}

function parseJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return exp * 1000
  }
  return undefined
}

function normalizeXaiCredentialBlob(
  value: unknown,
): XaiCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const accessToken = asTrimmedString(record.accessToken)
  if (!accessToken) return undefined

  const refreshToken = asTrimmedString(record.refreshToken)
  const idToken = asTrimmedString(record.idToken)
  const profileId = asTrimmedString(record.profileId)

  const lastRefreshAt =
    typeof record.lastRefreshAt === 'number' &&
    Number.isFinite(record.lastRefreshAt)
      ? record.lastRefreshAt
      : undefined
  const lastRefreshFailureAt =
    typeof record.lastRefreshFailureAt === 'number' &&
    Number.isFinite(record.lastRefreshFailureAt)
      ? record.lastRefreshFailureAt
      : undefined
  const expiresAt =
    typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
      ? record.expiresAt
      : undefined

  return {
    accessToken,
    refreshToken,
    idToken,
    profileId,
    expiresAt,
    lastRefreshAt,
    lastRefreshFailureAt,
  }
}

function shouldRefreshXaiToken(blob: XaiCredentialBlob): boolean {
  // Prefer the persisted server-relative expiry (works for opaque tokens);
  // fall back to JWT `exp` claim on access token, then id_token. Mirrors
  // opencode `plugin/xai.ts:603-606`.
  const expiresAt =
    blob.expiresAt ??
    parseJwtExpiryMs(blob.accessToken) ??
    parseJwtExpiryMs(blob.idToken)
  if (expiresAt === undefined) {
    return false
  }
  return expiresAt <= Date.now() + XAI_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: XaiCredentialBlob,
  now = Date.now(),
): boolean {
  const lastRefreshFailureAt = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )

  if (!lastRefreshFailureAt) {
    return false
  }

  return now - lastRefreshFailureAt < XAI_TOKEN_REFRESH_RETRY_COOLDOWN_MS
}

function getRefreshErrorMessage(status: number, bodyText: string): string {
  if (!bodyText.trim()) {
    return `xAI token refresh failed with status ${status}.`
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const nestedError =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : undefined
    const code = asTrimmedString(nestedError?.code ?? parsed.code)
    const message =
      asTrimmedString(nestedError?.message ?? parsed.error_description) ??
      bodyText.trim()
    return code
      ? `xAI token refresh failed (${code}): ${message}`
      : `xAI token refresh failed with status ${status}: ${message}`
  } catch {
    return `xAI token refresh failed with status ${status}: ${bodyText.trim()}`
  }
}

export function readXaiCredentials(): XaiCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = getXaiSecureStorage().read()
    return normalizeXaiCredentialBlob(data?.[XAI_STORAGE_KEY])
  } catch (e) {
    // ENOENT is expected on first-run / when the user has never logged in.
    // Anything else (corrupt JSON, EACCES, keychain unlock failure) is real
    // — surface it via logError so the user has a breadcrumb.
    if (!isENOENT(e)) logError(e)
    return undefined
  }
}

export async function readXaiCredentialsAsync(): Promise<
  XaiCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await getXaiSecureStorage().readAsync()
    return normalizeXaiCredentialBlob(data?.[XAI_STORAGE_KEY])
  } catch (e) {
    if (!isENOENT(e)) logError(e)
    return undefined
  }
}

export function saveXaiCredentials(
  credentials: XaiCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeXaiCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'xAI credentials are incomplete.' }
  }

  const secureStorage = getXaiSecureStorage()
  const previous = secureStorage.read() || {}
  const previousXai = normalizeXaiCredentialBlob(previous[XAI_STORAGE_KEY])
  const next = {
    ...(previous as Record<string, unknown>),
    [XAI_STORAGE_KEY]: {
      ...normalized,
      profileId: normalized.profileId ?? previousXai?.profileId,
      expiresAt: normalized.expiresAt ?? previousXai?.expiresAt,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    const storedXai = normalizeXaiCredentialBlob(next[XAI_STORAGE_KEY])
    inMemoryLastRefreshFailureAt = storedXai?.lastRefreshFailureAt ?? null
  }
  return result
}

function persistXaiRefreshFailure(
  credentials: XaiCredentialBlob,
  occurredAt: number,
): void {
  const result = saveXaiCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) {
    inMemoryLastRefreshFailureAt = occurredAt
  }
}

export function clearXaiCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  const secureStorage = getXaiSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[XAI_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    inMemoryLastRefreshFailureAt = null
  } else {
    // Surface the underlying cause: callers (e.g. ProviderManager) only
    // display `result.warning`, which the secure-storage layer may leave
    // empty on some failure modes.
    const cause = result.warning ?? 'secure storage update failed'
    logError(`clearXaiCredentials: failed to remove xAI entry (${cause})`)
    return { success: false, warning: cause }
  }
  return result
}

export async function refreshXaiAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<{
  refreshed: boolean
  credentials?: XaiCredentialBlob
}> {
  if (isBareMode()) {
    return { refreshed: false }
  }

  const current = await readXaiCredentialsAsync()
  if (!current) {
    return { refreshed: false }
  }

  if (!current.refreshToken) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && !shouldRefreshXaiToken(current)) {
    return { refreshed: false, credentials: current }
  }

  // Deliberate divergence from `codexCredentials.ts:298-302`: when callers
  // pass `{ force: true }` (notably `withRetry.ts`'s 401-recovery branch),
  // bypass the cooldown — a server-side 401 means our stored token is dead
  // regardless of how recently a refresh failed, and we owe the user one
  // fresh attempt before they have to re-login.
  if (!options?.force && isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }

  if (inFlightXaiRefresh) {
    return inFlightXaiRefresh
  }

  inFlightXaiRefresh = (async () => {
    const refreshAttemptedAt = Date.now()

    try {
      const body = new URLSearchParams({
        client_id: getXaiOAuthClientId(),
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken!,
      })

      const response = await fetch(XAI_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': getXaiUserAgent(),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw new Error(getRefreshErrorMessage(response.status, bodyText))
      }

      const payload = (await response.json()) as XaiTokenRefreshResponse
      const accessToken = asTrimmedString(payload.access_token)
      if (!accessToken) {
        throw new Error(
          'xAI token refresh succeeded without a new access token.',
        )
      }

      const expiresInSec =
        typeof payload.expires_in === 'number' &&
        Number.isFinite(payload.expires_in) &&
        payload.expires_in > 0
          ? payload.expires_in
          : 3600
      const next: XaiCredentialBlob = {
        accessToken,
        refreshToken:
          asTrimmedString(payload.refresh_token) ?? current.refreshToken,
        idToken: asTrimmedString(payload.id_token) ?? current.idToken,
        profileId: current.profileId,
        expiresAt: Date.now() + expiresInSec * 1000,
        lastRefreshAt: Date.now(),
      }

      const saveResult = saveXaiCredentials(next)
      if (!saveResult.success) {
        // Persist-failure on refresh is non-fatal (matches opencode
        // `plugin/xai.ts:614,620-630`). The runtime keeps using the new
        // tokens in memory; the next session may need to re-login.
        logForDebugging(
          `[xai] token refresh succeeded but credentials could not be saved: ${saveResult.warning ?? 'unknown error'}`,
          { level: 'warn' },
        )
      }

      return {
        refreshed: true,
        credentials: next,
      }
    } catch (error) {
      persistXaiRefreshFailure(current, refreshAttemptedAt)
      throw error
    } finally {
      inFlightXaiRefresh = null
    }
  })()

  return inFlightXaiRefresh
}
