/**
 * The fetch used for every OAuth request, and the authorization-server
 * metadata discovery built on top of it.
 */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import { normalizeOAuthErrorBody } from 'src/mcp/auth/oauthErrors.js'

export const OAUTH_REQUEST_TIMEOUT_MS = 30_000

type DiscoveredMetadata = Awaited<
  ReturnType<typeof discoverAuthorizationServerMetadata>
>

/**
 * An OAuth fetch whose every request gets its own deadline. Only token-style
 * POSTs can carry a 200-with-error body, so only their answers are rewritten.
 */
export function createTimedAuthFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadline])
      : deadline
    const response = await fetch(url, { ...init, signal })
    const isPost = init?.method?.toUpperCase() === 'POST'
    return isPost ? normalizeOAuthErrorBody(response) : response
  }
}

export function createAuthFetch(): FetchLike {
  return createTimedAuthFetch(OAUTH_REQUEST_TIMEOUT_MS)
}

async function fetchConfiguredMetadata(
  metadataUrl: string,
  fetchFn: FetchLike,
): Promise<DiscoveredMetadata> {
  if (!metadataUrl.startsWith('https://')) {
    throw new Error(
      `authServerMetadataUrl must use https:// (got: ${metadataUrl})`,
    )
  }
  const response = await fetchFn(metadataUrl, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} fetching configured auth server metadata from ${metadataUrl}`,
    )
  }
  return OAuthMetadataSchema.parse(await response.json())
}

export async function fetchAuthServerMetadata(
  serverName: string,
  serverUrl: string,
  configuredMetadataUrl: string | undefined,
  fetchFn?: FetchLike,
  resourceMetadataUrl?: URL,
): Promise<Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>> {
  if (configuredMetadataUrl) {
    return fetchConfiguredMetadata(
      configuredMetadataUrl,
      fetchFn ?? createAuthFetch(),
    )
  }

  try {
    const info = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl,
      fetchFn,
    })
    if (info.authorizationServerMetadata) {
      return info.authorizationServerMetadata
    }
  } catch (error) {
    logMCPDebug(
      serverName,
      `Authorization server discovery failed: ${errorMessage(error)}`,
    )
  }

  // Older servers publish RFC 8414 metadata under the MCP endpoint's own path.
  const resource = new URL(serverUrl)
  if (resource.pathname === '/') return undefined
  logMCPDebug(
    serverName,
    'Trying path-aware authorization server metadata at the server URL',
  )
  return discoverAuthorizationServerMetadata(resource, { fetchFn })
}
