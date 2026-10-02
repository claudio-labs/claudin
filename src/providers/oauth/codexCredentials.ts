// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/plugin/openai/codex.ts
import {
  getSecureStorage,
  type SecureStorage,
  type SecureStorageData,
} from 'src/platform/secureStorage/index.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { isBareMode } from 'src/shared/envUtils.js'
import {
  asTrimmedString,
  decodeJwtPayload,
  getCodexOAuthClientId,
  isRecord,
  mintCodexApiKey,
  parseChatgptAccountId,
  parseJson,
  postCodexTokenForm,
} from 'src/providers/oauth/codexOAuthShared.js'

export const CODEX_STORAGE_KEY = 'codex' as const

export type CodexCredentialBlob = NonNullable<SecureStorageData['codex']>

export type CodexRefreshResult = {
  refreshed: boolean
  credentials?: CodexCredentialBlob
}

type StoreResult = { success: boolean; warning?: string }

const BARE_MODE_RESULT: StoreResult = {
  success: false,
  warning: 'Bare mode: secure storage is disabled.',
}
const REFRESH_FAILURE_COOLDOWN_MS = 60_000
/** Refresh this long before the token's `exp`, so a request never leaves with a dying token. */
const EXPIRY_SKEW_MS = 60_000
const UNSAVED_REFRESH_MESSAGE =
  'Codex token refresh succeeded but credentials could not be saved.'

/**
 * A refresh failure that could not be stamped on disk. It still has to stop
 * the next attempts, or a read-only store would retry on every request.
 */
let unrecordedRefreshFailureAt: number | undefined
let refreshInFlight: Promise<CodexRefreshResult> | undefined

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** Drops keys whose value is undefined, so the stored entry has no empty slots. */
function compact(blob: CodexCredentialBlob): CodexCredentialBlob {
  return Object.fromEntries(
    Object.entries(blob).filter(([, value]) => value !== undefined),
  ) as CodexCredentialBlob
}

function normalizeEntry(raw: unknown): CodexCredentialBlob | undefined {
  if (!isRecord(raw)) return undefined
  const accessToken = asTrimmedString(raw.accessToken)
  if (!accessToken) return undefined
  const idToken = asTrimmedString(raw.idToken)
  return compact({
    apiKey: asTrimmedString(raw.apiKey),
    accessToken,
    refreshToken: asTrimmedString(raw.refreshToken),
    idToken,
    accountId:
      asTrimmedString(raw.accountId) ??
      parseChatgptAccountId(idToken) ??
      parseChatgptAccountId(accessToken),
    profileId: asTrimmedString(raw.profileId),
    lastRefreshAt: optionalNumber(raw.lastRefreshAt),
    lastRefreshFailureAt: optionalNumber(raw.lastRefreshFailureAt),
  })
}

function writeEntry(
  storage: SecureStorage,
  entry: CodexCredentialBlob | undefined,
): StoreResult {
  const data: SecureStorageData = { ...storage.read() }
  if (entry) data.codex = entry
  else delete data.codex
  return storage.update(data)
}

export function readCodexCredentials(): CodexCredentialBlob | undefined {
  if (isBareMode()) return undefined
  return normalizeEntry(getSecureStorage().read()?.codex)
}

export async function readCodexCredentialsAsync(): Promise<
  CodexCredentialBlob | undefined
> {
  if (isBareMode()) return undefined
  const data = await getSecureStorage().readAsync()
  return normalizeEntry(data?.codex)
}

/** Stores a login or a refresh. A profile link already on disk survives a blob without one. */
export function saveCodexCredentials(
  credentials: CodexCredentialBlob,
): StoreResult {
  if (isBareMode()) return BARE_MODE_RESULT
  const accessToken = asTrimmedString(credentials.accessToken)
  if (!accessToken) {
    return { success: false, warning: 'Codex credentials are incomplete.' }
  }
  const storage = getSecureStorage()
  const previous = normalizeEntry(storage.read()?.codex)
  const result = writeEntry(
    storage,
    compact({
      ...credentials,
      accessToken,
      profileId: credentials.profileId ?? previous?.profileId,
      lastRefreshAt: credentials.lastRefreshAt ?? Date.now(),
    }),
  )
  if (result.success) unrecordedRefreshFailureAt = undefined
  return result
}

export function clearCodexCredentials(): StoreResult {
  unrecordedRefreshFailureAt = undefined
  if (isBareMode()) return { success: true }
  const storage = getSecureStorage()
  if (storage.read()?.codex === undefined) return { success: true }
  return writeEntry(storage, undefined)
}

export function attachCodexProfileIdToStoredCredentials(
  profileId: string,
): StoreResult {
  if (isBareMode()) return BARE_MODE_RESULT
  const storage = getSecureStorage()
  const current = normalizeEntry(storage.read()?.codex)
  if (!current) {
    return {
      success: false,
      warning: 'Codex credentials are not stored securely yet.',
    }
  }
  return writeEntry(storage, { ...current, profileId })
}

export function isCodexRefreshFailureCoolingDown(
  credentials: Pick<CodexCredentialBlob, 'lastRefreshFailureAt'>,
  now: number = Date.now(),
): boolean {
  const failedAt = credentials.lastRefreshFailureAt
  return failedAt !== undefined && now - failedAt < REFRESH_FAILURE_COOLDOWN_MS
}

function tokenExpiresAt(token: string | undefined): number | undefined {
  const exp = token ? decodeJwtPayload(token)?.exp : undefined
  return typeof exp === 'number' ? exp * 1000 : undefined
}

/** A token with no readable `exp` is treated as live: only the server can say otherwise. */
function isExpiring(credentials: CodexCredentialBlob, now: number): boolean {
  const expiresAt =
    tokenExpiresAt(credentials.accessToken) ?? tokenExpiresAt(credentials.idToken)
  return expiresAt !== undefined && expiresAt - now <= EXPIRY_SKEW_MS
}

/** A profile carrying its own API key does not use the OAuth tokens at all. */
function activeProfilePinsApiKey(): boolean {
  return asTrimmedString(tryGetActiveProvider()?.apiKey) !== undefined
}

function describeRefreshFailure(status: number, text: string): string {
  const detail = text.trim()
  if (!detail) return `Codex token refresh failed with status ${status}.`
  const parsed = parseJson(detail)
  const body = isRecord(parsed) ? parsed : {}
  const nested = isRecord(body.error) ? body.error : {}
  const code = asTrimmedString(nested.code) ?? asTrimmedString(body.code)
  const message =
    asTrimmedString(nested.message) ??
    asTrimmedString(body.error_description) ??
    asTrimmedString(body.message) ??
    detail
  return code
    ? `Codex token refresh failed (${code}): ${message}`
    : `Codex token refresh failed with status ${status}: ${message}`
}

async function requestRefresh(
  current: CodexCredentialBlob,
  refreshToken: string,
): Promise<CodexCredentialBlob> {
  const response = await postCodexTokenForm({
    client_id: getCodexOAuthClientId(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(describeRefreshFailure(response.status, text))
  const parsed = parseJson(text)
  const body = isRecord(parsed) ? parsed : {}
  const accessToken = asTrimmedString(body.access_token)
  if (!accessToken) {
    throw new Error('Codex token refresh succeeded without a new access token.')
  }
  // The issuer may rotate the refresh and id tokens or leave them out; absent ones carry over.
  const idToken = asTrimmedString(body.id_token) ?? current.idToken
  return compact({
    apiKey: idToken ? await mintCodexApiKey(idToken) : undefined,
    accessToken,
    refreshToken: asTrimmedString(body.refresh_token) ?? refreshToken,
    idToken,
    accountId:
      parseChatgptAccountId(idToken) ??
      parseChatgptAccountId(accessToken) ??
      current.accountId,
    profileId: current.profileId,
    lastRefreshAt: Date.now(),
  })
}

function recordRefreshFailure(): void {
  const failedAt = Date.now()
  const storage = getSecureStorage()
  const current = normalizeEntry(storage.read()?.codex)
  const stamped = current
    ? writeEntry(storage, { ...current, lastRefreshFailureAt: failedAt })
    : { success: false }
  if (!stamped.success) unrecordedRefreshFailureAt = failedAt
}

async function runRefresh(force: boolean): Promise<CodexRefreshResult> {
  if (activeProfilePinsApiKey()) return { refreshed: false }
  const credentials = await readCodexCredentialsAsync()
  if (!credentials) return { refreshed: false }

  const now = Date.now()
  const coolingDown =
    isCodexRefreshFailureCoolingDown(credentials, now) ||
    isCodexRefreshFailureCoolingDown(
      { lastRefreshFailureAt: unrecordedRefreshFailureAt },
      now,
    )
  const refreshToken = credentials.refreshToken
  if (coolingDown || !refreshToken || (!force && !isExpiring(credentials, now))) {
    return { refreshed: false, credentials }
  }

  let next: CodexCredentialBlob
  try {
    next = await requestRefresh(credentials, refreshToken)
  } catch (error) {
    recordRefreshFailure()
    throw error
  }
  if (!saveCodexCredentials(next).success) {
    recordRefreshFailure()
    throw new Error(UNSAVED_REFRESH_MESSAGE)
  }
  return { refreshed: true, credentials: next }
}

/**
 * Refreshes the stored tokens when they are about to expire (or when
 * `force` is set). Concurrent callers share one request and one result.
 */
export function refreshCodexAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<CodexRefreshResult> {
  refreshInFlight ??= runRefresh(options?.force === true).finally(() => {
    refreshInFlight = undefined
  })
  return refreshInFlight
}
