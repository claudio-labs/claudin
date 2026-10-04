/**
 * Signing out of one MCP server: RFC 7009 revocation at its authorization
 * server, best-effort, then the local clearing that happens whatever the
 * server said.
 */

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import {
  createTimedAuthFetch,
  fetchAuthServerMetadata,
  OAUTH_REQUEST_TIMEOUT_MS,
} from 'src/mcp/auth/authFetch.js'
import {
  getOAuthEntry,
  putOAuthEntry,
  removeOAuthEntry,
  type StoredMcpOAuthEntry,
} from 'src/mcp/auth/credentialMaps.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import {
  applyClientAuth,
  chooseClientAuth,
  type ClientAuthMetadata,
  type RevocationClientAuth,
} from 'src/mcp/auth/revocation/clientAuth.js'

export type RevocationDeps = {
  /** Deadline of each request: metadata discovery and every revocation POST. */
  requestTimeoutMs: number
}

export const DEFAULT_REVOCATION_DEPS: RevocationDeps = {
  requestTimeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
}

type RemoteConfig = McpSSEServerConfig | McpHTTPServerConfig
type TokenTypeHint = 'refresh_token' | 'access_token'

type RevocationMetadata = ClientAuthMetadata & { revocation_endpoint?: string }

async function postRevocation(
  fetchFn: FetchLike,
  endpoint: string,
  token: string,
  hint: TokenTypeHint,
  auth: RevocationClientAuth,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  const form = new URLSearchParams({ token, token_type_hint: hint })
  applyClientAuth(auth, headers, form)
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: form.toString(),
  })
  await response.body?.cancel()
  return response
}

async function revokeToken(
  fetchFn: FetchLike,
  endpoint: string,
  token: string,
  hint: TokenTypeHint,
  auth: RevocationClientAuth,
  accessToken: string,
): Promise<void> {
  let response = await postRevocation(fetchFn, endpoint, token, hint, auth)
  // Some servers want the access token itself as proof instead of client
  // credentials; the retry carries it alone, so one auth form is ever sent.
  if (response.status === 401 && accessToken) {
    response = await postRevocation(
      fetchFn,
      endpoint,
      token,
      hint,
      { kind: 'none' },
      accessToken,
    )
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

async function revokeAtServer(
  serverName: string,
  config: RemoteConfig,
  entry: StoredMcpOAuthEntry,
  fetchFn: FetchLike,
): Promise<void> {
  const issuer =
    entry.discoveryState?.authorizationServerUrl ?? config.url
  const found = await fetchAuthServerMetadata(
    serverName,
    issuer,
    config.oauth?.authServerMetadataUrl,
    fetchFn,
  )
  if (!found) {
    logMCPDebug(serverName, 'No authorization server metadata; skipping revocation')
    return
  }
  const metadata: RevocationMetadata = found
  const endpoint = metadata.revocation_endpoint
  if (!endpoint) {
    logMCPDebug(serverName, 'Authorization server has no revocation endpoint')
    return
  }

  const auth = chooseClientAuth(entry, metadata)
  const tokens: [string | undefined, TokenTypeHint][] = [
    [entry.refreshToken, 'refresh_token'],
    [entry.accessToken, 'access_token'],
  ]
  for (const [token, hint] of tokens) {
    if (!token) continue
    try {
      await revokeToken(fetchFn, endpoint, token, hint, auth, entry.accessToken)
      logMCPDebug(serverName, `Revoked ${hint}`)
    } catch (error) {
      logMCPDebug(serverName, `Revoking ${hint} failed: ${errorMessage(error)}`)
    }
  }
}

/** What a re-authentication needs to find again: the step-up scope and where the server was found. */
function stepUpRemnant(
  entry: StoredMcpOAuthEntry,
): StoredMcpOAuthEntry | undefined {
  const { stepUpScope, discoveryState } = entry
  if (!stepUpScope && !discoveryState) return undefined
  const remnant: StoredMcpOAuthEntry = {
    serverName: entry.serverName,
    serverUrl: entry.serverUrl,
    accessToken: '',
    expiresAt: 0,
  }
  if (stepUpScope) remnant.stepUpScope = stepUpScope
  if (discoveryState) {
    remnant.discoveryState = {
      authorizationServerUrl: discoveryState.authorizationServerUrl,
    }
    if (discoveryState.resourceMetadataUrl) {
      remnant.discoveryState.resourceMetadataUrl =
        discoveryState.resourceMetadataUrl
    }
  }
  return remnant
}

export async function signOutServer(
  serverName: string,
  config: RemoteConfig,
  preserveStepUpState: boolean,
  deps: RevocationDeps,
): Promise<void> {
  const key = getServerKey(serverName, config)
  const entry = getOAuthEntry(key)

  if (entry && (entry.accessToken || entry.refreshToken)) {
    try {
      await revokeAtServer(
        serverName,
        config,
        entry,
        createTimedAuthFetch(deps.requestTimeoutMs),
      )
    } catch (error) {
      logMCPDebug(serverName, `Token revocation skipped: ${errorMessage(error)}`)
    }
  }

  const remnant =
    preserveStepUpState && entry ? stepUpRemnant(entry) : undefined
  if (remnant) putOAuthEntry(key, remnant)
  else removeOAuthEntry(key)
}
