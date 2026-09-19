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

/**
 * Timeout for individual OAuth requests (metadata discovery, token refresh, etc.)
 */
const AUTH_REQUEST_TIMEOUT_MS = 30000

/**
 * Creates a fetch function with a fresh 30-second timeout for each OAuth request.
 * Used by ClaudeAuthProvider for metadata discovery and token refresh.
 * Prevents stale timeout signals from affecting auth operations.
 */
export function createAuthFetch(): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
    const isPost = init?.method?.toUpperCase() === 'POST'

    // No existing signal - just use timeout
    if (!init?.signal) {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(url, { ...init, signal: timeoutSignal })
      return isPost ? normalizeOAuthErrorBody(response) : response
    }

    // Combine signals: abort when either fires
    const controller = new AbortController()
    const abort = () => controller.abort()

    init.signal.addEventListener('abort', abort)
    timeoutSignal.addEventListener('abort', abort)

    // Cleanup to prevent event listener leaks after fetch completes
    const cleanup = () => {
      init.signal?.removeEventListener('abort', abort)
      timeoutSignal.removeEventListener('abort', abort)
    }

    if (init.signal.aborted) {
      controller.abort()
    }

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(url, { ...init, signal: controller.signal })
      cleanup()
      return isPost ? normalizeOAuthErrorBody(response) : response
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

/**
 * Fetches authorization server metadata, using a configured metadata URL if available,
 * otherwise performing RFC 9728 → RFC 8414 discovery via the SDK.
 *
 * Discovery order when no configured URL:
 * 1. RFC 9728: probe /.well-known/oauth-protected-resource on the MCP server,
 *    read authorization_servers[0], then RFC 8414 against that URL.
 * 2. Fallback: RFC 8414 directly against the MCP server URL (path-aware). Covers
 *    legacy servers that co-host auth metadata at /.well-known/oauth-authorization-server/{path}
 *    without implementing RFC 9728. The SDK's own fallback strips the path, so this
 *    preserves the pre-existing path-aware probe for backward compatibility.
 *
 * Note: configuredMetadataUrl is user-controlled via .mcp.json. Project-scoped MCP
 * servers require user approval before connecting (same trust level as the MCP server
 * URL itself). The HTTPS requirement here is defense-in-depth beyond schema validation
 * — RFC 8414 mandates OAuth metadata retrieval over TLS.
 */
export async function fetchAuthServerMetadata(
  serverName: string,
  serverUrl: string,
  configuredMetadataUrl: string | undefined,
  fetchFn?: FetchLike,
  resourceMetadataUrl?: URL,
): Promise<Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>> {
  if (configuredMetadataUrl) {
    if (!configuredMetadataUrl.startsWith('https://')) {
      throw new Error(
        `authServerMetadataUrl must use https:// (got: ${configuredMetadataUrl})`,
      )
    }
    const authFetch = fetchFn ?? createAuthFetch()
    const response = await authFetch(configuredMetadataUrl, {
      headers: { Accept: 'application/json' },
    })
    if (response.ok) {
      return OAuthMetadataSchema.parse(await response.json())
    }
    throw new Error(
      `HTTP ${response.status} fetching configured auth server metadata from ${configuredMetadataUrl}`,
    )
  }

  try {
    const { authorizationServerMetadata } = await discoverOAuthServerInfo(
      serverUrl,
      {
        ...(fetchFn && { fetchFn }),
        ...(resourceMetadataUrl && { resourceMetadataUrl }),
      },
    )
    if (authorizationServerMetadata) {
      return authorizationServerMetadata
    }
  } catch (err) {
    // Any error from the RFC 9728 → RFC 8414 chain (5xx from the root or
    // resolved-AS probe, schema parse failure, network error) — fall through
    // to the legacy path-aware retry.
    logMCPDebug(
      serverName,
      `RFC 9728 discovery failed, falling back: ${errorMessage(err)}`,
    )
  }

  // Fallback only when the URL has a path component; for root URLs the SDK's
  // own fallback already probed the same endpoints.
  const url = new URL(serverUrl)
  if (url.pathname === '/') {
    return undefined
  }
  return discoverAuthorizationServerMetadata(url, {
    ...(fetchFn && { fetchFn }),
  })
}
