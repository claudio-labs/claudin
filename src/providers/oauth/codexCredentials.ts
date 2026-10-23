import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { CodexCredentialProfile } from 'src/providers/presets/providerConfig.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isBareMode } from 'src/shared/envUtils.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import { refreshCodexAuthFileIfNeeded } from 'src/providers/oauth/codexCliAuth.js'
import {
  asTrimmedString,
  exchangeCodexIdTokenForApiKey,
  parseChatgptAccountId,
  parseJwtExpiryMs,
  requestCodexTokenRefresh,
} from 'src/providers/oauth/codexOAuthShared.js'

export const CODEX_STORAGE_KEY = 'codex' as const
const CODEX_TOKEN_REFRESH_SKEW_MS = 60_000
const CODEX_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000

export type CodexCredentialBlob = {
  apiKey?: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  profileId?: string
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

let inFlightCodexRefresh:
  | Promise<{
      refreshed: boolean
      credentials?: CodexCredentialBlob
    }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null

function getCodexSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: true })
}

function normalizeCodexCredentialBlob(
  value: unknown,
): CodexCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const apiKey = asTrimmedString(record.apiKey)
  const accessToken = asTrimmedString(record.accessToken)
  if (!accessToken) return undefined

  const refreshToken = asTrimmedString(record.refreshToken)
  const idToken = asTrimmedString(record.idToken)
  const accountId =
    asTrimmedString(record.accountId) ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
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

  return {
    apiKey,
    accessToken,
    refreshToken,
    idToken,
    accountId,
    profileId,
    lastRefreshAt,
    lastRefreshFailureAt,
  }
}

function shouldRefreshCodexToken(blob: CodexCredentialBlob): boolean {
  const expiresAt =
    parseJwtExpiryMs(blob.accessToken) ?? parseJwtExpiryMs(blob.idToken)
  if (expiresAt === undefined) {
    return false
  }
  return expiresAt <= Date.now() + CODEX_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: CodexCredentialBlob,
  now = Date.now(),
): boolean {
  const lastRefreshFailureAt = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )

  if (!lastRefreshFailureAt) {
    return false
  }

  return (
    now - lastRefreshFailureAt < CODEX_TOKEN_REFRESH_RETRY_COOLDOWN_MS
  )
}

export function readCodexCredentials(): CodexCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = getCodexSecureStorage().read()
    return normalizeCodexCredentialBlob(data?.codex)
  } catch {
    return undefined
  }
}

export async function readCodexCredentialsAsync(): Promise<
  CodexCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await getCodexSecureStorage().readAsync()
    return normalizeCodexCredentialBlob(data?.codex)
  } catch {
    return undefined
  }
}

export function isCodexRefreshFailureCoolingDown(
  blob: Pick<CodexCredentialBlob, 'lastRefreshFailureAt'>,
  now = Date.now(),
): boolean {
  return isWithinRefreshFailureCooldown(
    blob as CodexCredentialBlob,
    now,
  )
}

export function saveCodexCredentials(
  credentials: CodexCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeCodexCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Codex credentials are incomplete.' }
  }

  const secureStorage = getCodexSecureStorage()
  const previous = secureStorage.read() || {}
  const previousCodex = normalizeCodexCredentialBlob(previous[CODEX_STORAGE_KEY])
  const next = {
    ...(previous as Record<string, unknown>),
    [CODEX_STORAGE_KEY]: {
      ...normalized,
      profileId: normalized.profileId ?? previousCodex?.profileId,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    const storedCodex = normalizeCodexCredentialBlob(next[CODEX_STORAGE_KEY])
    inMemoryLastRefreshFailureAt = storedCodex?.lastRefreshFailureAt ?? null
  }
  return result
}

export function attachCodexProfileIdToStoredCredentials(profileId: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const current = readCodexCredentials()
  if (!current) {
    return {
      success: false,
      warning: 'Codex credentials are not stored securely yet.',
    }
  }

  return saveCodexCredentials({
    ...current,
    profileId,
  })
}

function persistCodexRefreshFailure(
  credentials: CodexCredentialBlob,
  occurredAt: number,
): void {
  const result = saveCodexCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) {
    inMemoryLastRefreshFailureAt = occurredAt
  }
}

export function clearCodexCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  const secureStorage = getCodexSecureStorage()
  const previous = secureStorage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[CODEX_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) {
    inMemoryLastRefreshFailureAt = null
  }
  return result
}

export async function refreshCodexAccessTokenIfNeeded(options?: {
  force?: boolean
  /** The profile to refresh for; the active one when unnamed. */
  profile?: CodexCredentialProfile
}): Promise<{
  refreshed: boolean
  credentials?: CodexCredentialBlob
}> {
  if (isBareMode()) {
    return { refreshed: false }
  }

  const profile = options?.profile ?? tryGetActiveProvider()
  // If the profile already pins a Codex API key, skip the refresh.
  if (profile?.apiKey?.trim()) {
    return { refreshed: false }
  }

  // A profile linked to a Codex CLI auth.json is served from that file
  // (resolveRuntimeCodexCredentials), so that file is what gets refreshed.
  const linkedAuthPath = asTrimmedString(profile?.extras?.codexAuthPath)
  if (linkedAuthPath) {
    return {
      refreshed: await refreshCodexAuthFileIfNeeded(linkedAuthPath, options),
    }
  }

  const current = await readCodexCredentialsAsync()
  if (!current) {
    return { refreshed: false }
  }

  const refreshToken = current.refreshToken
  if (!refreshToken) {
    return { refreshed: false, credentials: current }
  }

  if (!options?.force && !shouldRefreshCodexToken(current)) {
    return { refreshed: false, credentials: current }
  }

  // Cooldown applies to BOTH the pre-flight (lazy) and the force-refresh paths.
  // Bypassing the cooldown on force would let a 401 retry-loop hammer a
  // degraded /oauth/token endpoint, burning the entire withRetry budget on
  // every request. If the user genuinely needs to recover sooner they can
  // re-login via /provider.
  if (isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }

  if (inFlightCodexRefresh) {
    return inFlightCodexRefresh
  }

  inFlightCodexRefresh = (async () => {
    const refreshAttemptedAt = Date.now()

    try {
      const payload = await requestCodexTokenRefresh(refreshToken)

      const next: CodexCredentialBlob = {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? current.refreshToken,
        idToken: payload.id_token ?? current.idToken,
        accountId:
          parseChatgptAccountId(payload.id_token) ??
          parseChatgptAccountId(payload.access_token) ??
          current.accountId,
        lastRefreshAt: Date.now(),
      }

      const idTokenForExchange = next.idToken ?? current.idToken
      if (idTokenForExchange) {
        // The id-token → API-key exchange is best-effort: when it fails the
        // request path falls back to using `accessToken` as the bearer (see
        // resolveStoredCodexCredentials in providerConfig.ts). We MUST NOT
        // silently swallow the error though — observability matters when a
        // user reports "requests are 401ing" and the real culprit is a 5xx
        // on the exchange endpoint.
        next.apiKey = await exchangeCodexIdTokenForApiKey(
          idTokenForExchange,
        ).catch(error => {
          logForDebugging(
            `[codex] id-token → API-key exchange failed; falling back to access_token bearer: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'warn' },
          )
          return undefined
        })
      }

      const saveResult = saveCodexCredentials(next)
      if (!saveResult.success) {
        throw new Error(
          saveResult.warning ??
            'Codex token refresh succeeded but credentials could not be saved.',
        )
      }

      return {
        refreshed: true,
        credentials: next,
      }
    } catch (error) {
      persistCodexRefreshFailure(current, refreshAttemptedAt)
      throw error
    } finally {
      inFlightCodexRefresh = null
    }
  })()

  return inFlightCodexRefresh
}
