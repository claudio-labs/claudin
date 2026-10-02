// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/mcp/oauth-provider.ts

/**
 * The MCP SDK's OAuthClientProvider for one remote MCP server. Credentials
 * live in secure storage under the server key; the PKCE verifier and the
 * OAuth state only ever live in memory. On top of what the SDK asks for, it
 * refreshes a token that is about to expire (once per process at a time, and
 * once across processes thanks to a lock file), and it tracks step-up: a
 * request for a scope the held token does not cover.
 */

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  discoverAuthorizationServerMetadata,
  refreshAuthorization as requestTokenRefresh,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidGrantError,
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import type { SecureStorageData } from 'src/platform/secureStorage/index.js'
import { clearKeychainCache } from 'src/platform/secureStorage/macOsKeychainHelpers.js'
import { openBrowser } from 'src/shared/browser.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { errorMessage, getErrnoCode } from 'src/shared/errors.js'
import * as lockfile from 'src/shared/fs/lockfile.js'
import { logMCPDebug } from 'src/shared/log.js'
import { sleep } from 'src/shared/sleep.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { createAuthFetch, fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'
import { redactSensitiveUrlParams } from 'src/mcp/auth/callbackParams.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import { clearServerTokensFromSecureStorage } from 'src/mcp/auth/tokenRevocation.js'

type RemoteServerConfig = McpSSEServerConfig | McpHTTPServerConfig
type StoredCredentials = NonNullable<SecureStorageData['mcpOAuth']>[string]
type CredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'

/** Where the SDK is told to send the browser when no callback server was started. */
const FALLBACK_REDIRECT_URL = 'http://localhost:3118/callback'

/**
 * The client-id metadata document (SEP-991) offered to authorization servers
 * that accept a URL as client_id. Still the inherited product value; which
 * document this client should advertise is an open decision.
 */
const CLIENT_ID_METADATA_DOCUMENT_URL = 'https://claude.ai/oauth/claude-code-client-metadata'

/** A token this close to expiry is refreshed before it is handed out. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
/** RFC 6749 leaves expires_in optional; an hour is the common default. */
const DEFAULT_TOKEN_LIFETIME_S = 3600
const REFRESH_ATTEMPTS = 3
const REFRESH_BACKOFF_MS = 1000
/** Long enough to outlast another process's refresh, short enough not to stall a connect. */
const REFRESH_LOCK_ATTEMPTS = 50
const REFRESH_LOCK_RETRY_MS = 100

const SCOPE_SEPARATOR_RE = /\s+/
const LOCK_NAME_UNSAFE_RE = /[^a-zA-Z0-9]/g

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The scope to ask for, read from authorization-server metadata. `scope` and
 * `default_scope` are not in RFC 8414 but some servers publish them, and they
 * name what the server expects better than the full `scopes_supported` list.
 */
export function getScopeFromMetadata(
  metadata: AuthorizationServerMetadata | undefined,
): string | undefined {
  if (!metadata) return undefined
  const fields: Record<string, unknown> = { ...metadata }
  const named = nonEmptyString(fields.scope) ?? nonEmptyString(fields.default_scope)
  if (named) return named
  const supported = fields.scopes_supported
  if (!Array.isArray(supported)) return undefined
  return nonEmptyString(supported.join(' '))
}

function scopeSet(scope: string | undefined): Set<string> {
  return new Set((scope ?? '').split(SCOPE_SEPARATOR_RE).filter(Boolean))
}

function scopeCovers(held: string | undefined, wanted: string): boolean {
  const granted = scopeSet(held)
  return [...scopeSet(wanted)].every(scope => granted.has(scope))
}

function isFresh(entry: StoredCredentials): boolean {
  return entry.accessToken.length > 0 && entry.expiresAt - Date.now() > REFRESH_MARGIN_MS
}

function asTokenSet(entry: StoredCredentials, withRefreshToken: boolean): OAuthTokens {
  return {
    access_token: entry.accessToken,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)),
    ...(entry.scope ? { scope: entry.scope } : {}),
    refresh_token: withRefreshToken ? entry.refreshToken : undefined,
  }
}

/** Worth another try: the server said so, or the request never got an OAuth answer. */
function isTransientRefreshFailure(error: unknown): boolean {
  return (
    error instanceof TemporarilyUnavailableError ||
    error instanceof ServerError ||
    !(error instanceof OAuthError)
  )
}

function readCredentials(key: string): StoredCredentials | undefined {
  return getSecureStorage().read()?.mcpOAuth?.[key]
}

/** Another process may have written since our last read; the macOS keychain read is cached. */
function readCredentialsUncached(key: string): StoredCredentials | undefined {
  clearKeychainCache()
  return readCredentials(key)
}

function writeCredentials(serverName: string, key: string, entry: StoredCredentials): void {
  const storage = getSecureStorage()
  const data = storage.read() ?? {}
  const result = storage.update({ ...data, mcpOAuth: { ...data.mcpOAuth, [key]: entry } })
  if (!result.success) {
    logMCPDebug(serverName, `Could not store OAuth credentials: ${result.warning ?? 'unknown failure'}`)
  }
}

function resourceIndicator(serverUrl: string): URL {
  const url = new URL(serverUrl)
  url.hash = ''
  return url
}

/**
 * Serialises refreshes across processes: the refresh token rotates, so two
 * processes presenting the same one would leave one of them signed out. A
 * lock that cannot be taken is not worth failing the refresh over.
 */
async function acquireRefreshLock(
  serverName: string,
  key: string,
): Promise<(() => Promise<void>) | undefined> {
  const dir = getClaudinConfigHomeDir()
  const path = join(dir, `mcp-refresh-${key.replace(LOCK_NAME_UNSAFE_RE, '_')}.lock`)
  // Only a held lock is waited for; proper-lockfile's own retries would also
  // wait out a lock that can never be created.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mkdir(dir, { recursive: true })
      return await lockfile.lock(path, {
        realpath: false,
        onCompromised: error => logMCPDebug(serverName, `Refresh lock compromised: ${errorMessage(error)}`),
      })
    } catch (error) {
      if (getErrnoCode(error) === 'ELOCKED' && attempt < REFRESH_LOCK_ATTEMPTS) {
        await sleep(REFRESH_LOCK_RETRY_MS)
        continue
      }
      logMCPDebug(serverName, `Refreshing without the cross-process lock: ${errorMessage(error)}`)
      return undefined
    }
  }
}

async function releaseRefreshLock(
  serverName: string,
  release: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!release) return
  try {
    await release()
  } catch (error) {
    logMCPDebug(serverName, `Could not release the refresh lock: ${errorMessage(error)}`)
  }
}

export class ClaudeAuthProvider implements OAuthClientProvider {
  readonly #key: string
  #state: string | undefined
  #codeVerifier: string | undefined
  #metadata: AuthorizationServerMetadata | undefined
  #authorizationUrl: string | undefined
  /** Scope a 403 insufficient_scope asked for; held until new tokens arrive. */
  #stepUpScope: string | undefined
  #refreshing: Promise<OAuthTokens | undefined> | undefined

  /**
   * `handleRedirection` is true for an interactive sign-in, where the
   * authorization URL is reported and opened. On the transport it is false:
   * the URL is only remembered, since nobody is there to approve it.
   */
  constructor(
    private readonly serverName: string,
    private readonly serverConfig: RemoteServerConfig,
    private readonly redirectUri: string = FALLBACK_REDIRECT_URL,
    private readonly handleRedirection: boolean = false,
    private readonly onAuthorizationUrl?: (url: string) => void,
    private readonly skipBrowserOpen: boolean = false,
  ) {
    this.#key = getServerKey(serverName, serverConfig)
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get authorizationUrl(): string | undefined {
    return this.#authorizationUrl
  }

  get clientMetadataUrl(): string {
    return process.env.MCP_OAUTH_CLIENT_METADATA_URL || CLIENT_ID_METADATA_DOCUMENT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = getScopeFromMetadata(this.#metadata)
    return {
      client_name: `Claudin (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }
  }

  setMetadata(metadata: AuthorizationServerMetadata): void {
    this.#metadata = metadata
  }

  markStepUpPending(scope: string): void {
    this.#stepUpScope = scope
    logMCPDebug(this.serverName, `Step-up pending for scope: ${scope}`)
  }

  async state(): Promise<string> {
    this.#state ??= randomBytes(32).toString('base64url')
    return this.#state
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const presetClientId = this.serverConfig.oauth?.clientId
    if (presetClientId) {
      const secret = getSecureStorage().read()?.mcpOAuthClientConfig?.[this.#key]?.clientSecret
      return { client_id: presetClientId, client_secret: secret }
    }
    const entry = readCredentials(this.#key)
    if (!entry?.clientId) return undefined
    return { client_id: entry.clientId, client_secret: entry.clientSecret }
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const existing = readCredentials(this.#key)
    this.#write({
      ...this.#baseEntry(existing),
      clientId: info.client_id,
      clientSecret: info.client_secret,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = readCredentials(this.#key)
    if (!entry) return undefined
    const usable = entry.accessToken.length > 0 && entry.expiresAt > Date.now()
    if (!usable && !entry.refreshToken) return undefined

    // A refresh cannot widen the grant, so while a step-up is pending the
    // refresh token is withheld: the SDK then goes straight to a new sign-in.
    const pending = this.#stepUpScope
    const offerRefresh = pending === undefined || scopeCovers(entry.scope, pending)
    if (offerRefresh && entry.refreshToken && !isFresh(entry)) {
      const refreshed = await this.refreshAuthorization(entry.refreshToken)
      if (refreshed) return refreshed
    }
    return asTokenSet(entry, offerRefresh)
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#stepUpScope = undefined
    const existing = readCredentials(this.#key)
    this.#write({
      ...this.#baseEntry(existing),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
      // RFC 6749 §5.1: an omitted scope means the one already granted.
      scope: tokens.scope ?? existing?.scope,
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.handleRedirection) {
      this.#authorizationUrl = authorizationUrl.toString()
      this.#rememberStepUpScope(authorizationUrl)
      return
    }
    if (authorizationUrl.protocol !== 'http:' && authorizationUrl.protocol !== 'https:') {
      throw new Error('Invalid authorization URL: must use http:// or https:// scheme')
    }
    const url = authorizationUrl.toString()
    this.#authorizationUrl = url
    logMCPDebug(this.serverName, `Authorization URL: ${redactSensitiveUrlParams(url)}`)
    this.onAuthorizationUrl?.(url)
    if (this.skipBrowserOpen) return
    if (!(await openBrowser(url))) {
      logMCPDebug(this.serverName, 'Could not open a browser; the authorization URL has to be opened by hand')
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.#codeVerifier = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this.#codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`)
    }
    return this.#codeVerifier
  }

  async invalidateCredentials(scope: CredentialScope): Promise<void> {
    // The verifier is in memory, so it is dropped whether or not anything is stored.
    if (scope === 'verifier') {
      this.#codeVerifier = undefined
      return
    }
    const entry = readCredentials(this.#key)
    if (!entry) return
    switch (scope) {
      case 'all':
        clearServerTokensFromSecureStorage(this.serverName, this.serverConfig)
        return
      case 'client': {
        const { clientId: _clientId, clientSecret: _clientSecret, ...rest } = entry
        this.#write(rest)
        return
      }
      case 'tokens': {
        const { refreshToken: _refreshToken, scope: _scope, ...rest } = entry
        this.#write({ ...rest, accessToken: '', expiresAt: 0 })
        return
      }
      case 'discovery': {
        const { discoveryState: _discoveryState, stepUpScope: _stepUpScope, ...rest } = entry
        this.#write(rest)
        return
      }
    }
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // Only the two URLs: the metadata documents can be large enough to
    // overflow an OS credential vault, and they are cheap to fetch again.
    const existing = readCredentials(this.#key)
    this.#write({
      ...this.#baseEntry(existing),
      discoveryState: {
        authorizationServerUrl: state.authorizationServerUrl,
        ...(state.resourceMetadataUrl ? { resourceMetadataUrl: state.resourceMetadataUrl } : {}),
      },
    })
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const cached = readCredentials(this.#key)?.discoveryState
    const configuredUrl = this.serverConfig.oauth?.authServerMetadataUrl
    if (!cached && !configuredUrl) return undefined

    let metadata: AuthorizationServerMetadata | undefined
    if (configuredUrl) {
      try {
        metadata = await fetchAuthServerMetadata(this.serverName, this.serverConfig.url, configuredUrl)
      } catch (error) {
        logMCPDebug(this.serverName, `Configured auth server metadata unusable: ${errorMessage(error)}`)
      }
    }
    if (cached) {
      return {
        authorizationServerUrl: cached.authorizationServerUrl,
        resourceMetadataUrl: cached.resourceMetadataUrl,
        ...(metadata ? { authorizationServerMetadata: metadata } : {}),
      }
    }
    if (!metadata) return undefined
    return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata }
  }

  /** Concurrent callers in this process share one refresh. */
  async refreshAuthorization(refreshToken: string): Promise<OAuthTokens | undefined> {
    this.#refreshing ??= this._doRefresh(refreshToken).finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  private async _doRefresh(refreshToken: string): Promise<OAuthTokens | undefined> {
    const release = await acquireRefreshLock(this.serverName, this.#key)
    try {
      const current = readCredentialsUncached(this.#key)
      if (current && isFresh(current)) {
        logMCPDebug(this.serverName, 'Tokens were refreshed elsewhere meanwhile; using those')
        return asTokenSet(current, true)
      }
      const client = await this.clientInformation()
      if (!client) {
        logMCPDebug(this.serverName, 'No client information; cannot refresh')
        return undefined
      }
      const metadata = await this.#tokenServerMetadata(current)
      if (!metadata) {
        logMCPDebug(this.serverName, 'No authorization server metadata; cannot refresh')
        return undefined
      }
      // The stored token beats the caller's: it may have rotated since the caller read it.
      return await this.#exchangeRefreshToken(current?.refreshToken ?? refreshToken, client, metadata)
    } finally {
      await releaseRefreshLock(this.serverName, release)
    }
  }

  async #tokenServerMetadata(
    current: StoredCredentials | undefined,
  ): Promise<AuthorizationServerMetadata | undefined> {
    const configuredUrl = this.serverConfig.oauth?.authServerMetadataUrl
    const knownServer = current?.discoveryState?.authorizationServerUrl
    const fetchFn = createAuthFetch()
    try {
      if (!configuredUrl && knownServer) {
        return await discoverAuthorizationServerMetadata(knownServer, { fetchFn })
      }
      return await fetchAuthServerMetadata(this.serverName, this.serverConfig.url, configuredUrl, fetchFn)
    } catch (error) {
      logMCPDebug(this.serverName, `Metadata discovery for refresh failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  async #exchangeRefreshToken(
    refreshToken: string,
    clientInformation: OAuthClientInformationMixed,
    metadata: AuthorizationServerMetadata,
  ): Promise<OAuthTokens | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const tokens = await requestTokenRefresh(metadata.issuer, {
          metadata,
          clientInformation,
          refreshToken,
          resource: resourceIndicator(this.serverConfig.url),
          fetchFn: createAuthFetch(),
        })
        await this.saveTokens(tokens)
        logMCPDebug(this.serverName, 'Refreshed the access token')
        return tokens
      } catch (error) {
        if (error instanceof InvalidGrantError) return this.#afterRejectedRefresh()
        if (attempt < REFRESH_ATTEMPTS && isTransientRefreshFailure(error)) {
          logMCPDebug(this.serverName, `Refresh attempt ${attempt} failed, retrying: ${errorMessage(error)}`)
          await sleep(REFRESH_BACKOFF_MS * 2 ** (attempt - 1))
          continue
        }
        logMCPDebug(this.serverName, `Refresh failed: ${errorMessage(error)}`)
        return undefined
      }
    }
  }

  async #afterRejectedRefresh(): Promise<OAuthTokens | undefined> {
    // A process that refreshed first rotated the token we presented; its result stands.
    const latest = readCredentialsUncached(this.#key)
    if (latest && isFresh(latest)) return asTokenSet(latest, true)
    logMCPDebug(this.serverName, 'Refresh token rejected; clearing the stored tokens')
    await this.invalidateCredentials('tokens')
    return undefined
  }

  #rememberStepUpScope(authorizationUrl: URL): void {
    const scope = authorizationUrl.searchParams.get('scope') || getScopeFromMetadata(this.#metadata)
    const entry = readCredentials(this.#key)
    if (!scope || !entry) return
    this.#write({ ...entry, stepUpScope: scope })
    logMCPDebug(this.serverName, `Remembered scope ${scope} for the next sign-in`)
  }

  #baseEntry(existing: StoredCredentials | undefined): StoredCredentials {
    return {
      ...existing,
      serverName: this.serverName,
      serverUrl: this.serverConfig.url,
      accessToken: existing?.accessToken ?? '',
      expiresAt: existing?.expiresAt ?? 0,
    }
  }

  #write(entry: StoredCredentials): void {
    writeCredentials(this.serverName, this.#key, entry)
  }
}
