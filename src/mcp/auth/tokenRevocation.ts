/**
 * Giving credentials back: RFC 7009 revocation against the authorization
 * server (best-effort, with a Bearer fallback for non-compliant ones) and the
 * local clearing that happens either way.
 */

import axios from 'axios'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import type { SecureStorageData } from 'src/platform/secureStorage/index.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'

/**
 * Revokes a single token on the OAuth server.
 *
 * Per RFC 7009, public clients (like Claude Code) should authenticate by including
 * client_id in the request body, NOT via an Authorization header. The Bearer token
 * in an Authorization header is meant for resource owner authentication, not client
 * authentication.
 *
 * However, the MCP spec doesn't explicitly define token revocation behavior, so some
 * servers may not be RFC 7009 compliant. As defensive programming, we:
 * 1. First try the RFC 7009 compliant approach (client_id in body, no Authorization header)
 * 2. If we get a 401, retry with Bearer auth as a fallback for non-compliant servers
 *
 * This fallback should rarely be needed - most servers either accept the compliant
 * approach or ignore unexpected headers.
 */
async function revokeToken({
  serverName,
  endpoint,
  token,
  tokenTypeHint,
  clientId,
  clientSecret,
  accessToken,
  authMethod = 'client_secret_basic',
}: {
  serverName: string
  endpoint: string
  token: string
  tokenTypeHint: 'access_token' | 'refresh_token'
  clientId?: string
  clientSecret?: string
  accessToken?: string
  authMethod?: 'client_secret_basic' | 'client_secret_post'
}): Promise<void> {
  const params = new URLSearchParams()
  params.set('token', token)
  params.set('token_type_hint', tokenTypeHint)

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  // RFC 7009 §2.1 requires client auth per RFC 6749 §2.3. Strict ASes
  // (Okta/Stytch) reject public-client revocation of confidential-client
  // tokens, so send client auth whenever we have it.
  if (clientId && clientSecret) {
    if (authMethod === 'client_secret_post') {
      params.set('client_id', clientId)
      params.set('client_secret', clientSecret)
    } else {
      const basic = Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
      ).toString('base64')
      headers.Authorization = `Basic ${basic}`
    }
  } else if (clientId) {
    params.set('client_id', clientId)
  } else {
    logMCPDebug(
      serverName,
      `No client_id available for ${tokenTypeHint} revocation - server may reject`,
    )
  }

  try {
    await axios.post(endpoint, params, { headers })
    logMCPDebug(serverName, `Successfully revoked ${tokenTypeHint}`)
  } catch (error: unknown) {
    // Fallback for non-RFC-7009-compliant servers that require Bearer auth
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      accessToken
    ) {
      logMCPDebug(
        serverName,
        `Got 401, retrying ${tokenTypeHint} revocation with Bearer auth`,
      )
      // RFC 6749 §2.3.1: must not send more than one auth method. The retry
      // switches to Bearer — clear any client creds from the body.
      params.delete('client_id')
      params.delete('client_secret')
      await axios.post(endpoint, params, {
        headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      })
      logMCPDebug(
        serverName,
        `Successfully revoked ${tokenTypeHint} with Bearer auth`,
      )
    } else {
      throw error
    }
  }
}

/**
 * Revokes tokens on the OAuth server if a revocation endpoint is available.
 * Per RFC 7009, we revoke the refresh token first (the long-lived credential),
 * then the access token. Revoking the refresh token prevents generation of new
 * access tokens and many servers implicitly invalidate associated access tokens.
 */
export async function revokeServerTokens(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  { preserveStepUpState = false }: { preserveStepUpState?: boolean } = {},
): Promise<void> {
  const storage = getSecureStorage()
  const existingData = storage.read()
  if (!existingData?.mcpOAuth) return

  const serverKey = getServerKey(serverName, serverConfig)
  const tokenData = existingData.mcpOAuth[serverKey]

  // Attempt server-side revocation if there are tokens to revoke (best-effort)
  if (tokenData?.accessToken || tokenData?.refreshToken) {
    try {
      // For PRM-discovered auth the AS is at a different host than the MCP
      // URL — use the persisted discoveryState if we have it.
      const asUrl =
        tokenData.discoveryState?.authorizationServerUrl ?? serverConfig.url
      const metadata = await fetchAuthServerMetadata(
        serverName,
        asUrl,
        serverConfig.oauth?.authServerMetadataUrl,
      )

      if (!metadata) {
        logMCPDebug(serverName, 'No OAuth metadata found')
      } else {
        const revocationEndpoint =
          'revocation_endpoint' in metadata
            ? metadata.revocation_endpoint
            : null
        if (!revocationEndpoint) {
          logMCPDebug(serverName, 'Server does not support token revocation')
        } else {
          const revocationEndpointStr = String(revocationEndpoint)
          // RFC 7009 defines revocation_endpoint_auth_methods_supported
          // separately from the token endpoint's list; prefer it if present.
          const authMethods =
            ('revocation_endpoint_auth_methods_supported' in metadata
              ? metadata.revocation_endpoint_auth_methods_supported
              : undefined) ??
            ('token_endpoint_auth_methods_supported' in metadata
              ? metadata.token_endpoint_auth_methods_supported
              : undefined)
          const authMethod: 'client_secret_basic' | 'client_secret_post' =
            authMethods &&
            !authMethods.includes('client_secret_basic') &&
            authMethods.includes('client_secret_post')
              ? 'client_secret_post'
              : 'client_secret_basic'
          logMCPDebug(
            serverName,
            `Revoking tokens via ${revocationEndpointStr} (${authMethod})`,
          )

          // Revoke refresh token first (more important - prevents future access token generation)
          if (tokenData.refreshToken) {
            try {
              await revokeToken({
                serverName,
                endpoint: revocationEndpointStr,
                token: tokenData.refreshToken,
                tokenTypeHint: 'refresh_token',
                clientId: tokenData.clientId,
                clientSecret: tokenData.clientSecret,
                accessToken: tokenData.accessToken,
                authMethod,
              })
            } catch (error: unknown) {
              // Log but continue
              logMCPDebug(
                serverName,
                `Failed to revoke refresh token: ${errorMessage(error)}`,
              )
            }
          }

          // Then revoke access token (may already be invalidated by refresh token revocation)
          if (tokenData.accessToken) {
            try {
              await revokeToken({
                serverName,
                endpoint: revocationEndpointStr,
                token: tokenData.accessToken,
                tokenTypeHint: 'access_token',
                clientId: tokenData.clientId,
                clientSecret: tokenData.clientSecret,
                accessToken: tokenData.accessToken,
                authMethod,
              })
            } catch (error: unknown) {
              logMCPDebug(
                serverName,
                `Failed to revoke access token: ${errorMessage(error)}`,
              )
            }
          }
        }
      }
    } catch (error: unknown) {
      // Log error but don't throw - revocation is best-effort
      logMCPDebug(serverName, `Failed to revoke tokens: ${errorMessage(error)}`)
    }
  } else {
    logMCPDebug(serverName, 'No tokens to revoke')
  }

  // Always clear local tokens, regardless of server-side revocation result.
  clearServerTokensFromSecureStorage(serverName, serverConfig)

  // When re-authenticating, preserve step-up auth state (scope + discovery)
  // so the next performMCPOAuthFlow can use cached scope instead of
  // re-probing. For "Clear Auth" (default), wipe everything.
  if (
    preserveStepUpState &&
    tokenData &&
    (tokenData.stepUpScope || tokenData.discoveryState)
  ) {
    const freshData = storage.read() || {}
    const updatedData: SecureStorageData = {
      ...freshData,
      mcpOAuth: {
        ...freshData.mcpOAuth,
        [serverKey]: {
          ...freshData.mcpOAuth?.[serverKey],
          serverName,
          serverUrl: serverConfig.url,
          accessToken: freshData.mcpOAuth?.[serverKey]?.accessToken ?? '',
          expiresAt: freshData.mcpOAuth?.[serverKey]?.expiresAt ?? 0,
          ...(tokenData.stepUpScope
            ? { stepUpScope: tokenData.stepUpScope }
            : {}),
          ...(tokenData.discoveryState
            ? {
                // Strip legacy bulky metadata fields here too so users with
                // existing overflowed blobs recover on next re-auth (#30337).
                discoveryState: {
                  authorizationServerUrl:
                    tokenData.discoveryState.authorizationServerUrl,
                  resourceMetadataUrl:
                    tokenData.discoveryState.resourceMetadataUrl,
                },
              }
            : {}),
        },
      },
    }
    storage.update(updatedData)
    logMCPDebug(serverName, 'Preserved step-up auth state across revocation')
  }
}

// Utilizing platform-specific secure storage to protect sensitive tokens
export function clearServerTokensFromSecureStorage(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  const storage = getSecureStorage()
  const existingData = storage.read()
  if (!existingData?.mcpOAuth) return

  const serverKey = getServerKey(serverName, serverConfig)
  if (existingData.mcpOAuth[serverKey]) {
    delete existingData.mcpOAuth[serverKey]
    storage.update(existingData)
    logMCPDebug(serverName, 'Cleared stored tokens from secure storage')
  }
}
