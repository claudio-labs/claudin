/**
 * The interactive authorization flow: a loopback callback server, the browser
 * redirect, and the step-up detection that runs on the transport's fetch.
 */

import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createServer, type Server } from 'http'
import { parse } from 'url'
import xss from 'xss'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import { buildRedirectUri, findAvailablePort } from 'src/mcp/oauthPort.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'
import { validateOAuthCallbackParams } from 'src/mcp/auth/callbackParams.js'
import {
  ClaudeAuthProvider,
  getScopeFromMetadata,
} from 'src/mcp/auth/claudeAuthProvider.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import { clearServerTokensFromSecureStorage } from 'src/mcp/auth/tokenRevocation.js'

export class AuthenticationCancelledError extends Error {
  constructor() {
    super('Authentication was cancelled')
    this.name = 'AuthenticationCancelledError'
  }
}

type WWWAuthenticateParams = {
  scope?: string
  resourceMetadataUrl?: URL
}

export async function performMCPOAuthFlow(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  onAuthorizationUrl: (url: string) => void,
  abortSignal?: AbortSignal,
  options?: {
    skipBrowserOpen?: boolean
    onWaitingForCallback?: (submit: (callbackUrl: string) => void) => void
  },
): Promise<void> {
  // Check for cached step-up scope and resource metadata URL before clearing
  // tokens. The transport-attached auth provider persists scope when it receives
  // a step-up 401, so we can use it here instead of making an extra probe request.
  const storage = getSecureStorage()
  const serverKey = getServerKey(serverName, serverConfig)
  const cachedEntry = storage.read()?.mcpOAuth?.[serverKey]
  const cachedStepUpScope = cachedEntry?.stepUpScope
  const cachedResourceMetadataUrl =
    cachedEntry?.discoveryState?.resourceMetadataUrl

  // Clear any existing stored credentials to ensure fresh client registration.
  // Note: this deletes the entire entry (including discoveryState/stepUpScope),
  // but we already read the cached values above.
  clearServerTokensFromSecureStorage(serverName, serverConfig)

  // Use cached step-up scope and resource metadata URL if available.
  // The transport-attached auth provider caches these when it receives a
  // step-up 401, so we don't need to probe the server again.
  let resourceMetadataUrl: URL | undefined
  if (cachedResourceMetadataUrl) {
    try {
      resourceMetadataUrl = new URL(cachedResourceMetadataUrl)
    } catch {
      logMCPDebug(
        serverName,
        `Invalid cached resourceMetadataUrl: ${cachedResourceMetadataUrl}`,
      )
    }
  }
  const wwwAuthParams: WWWAuthenticateParams = {
    scope: cachedStepUpScope,
    resourceMetadataUrl,
  }

  try {
    // Use configured callback port for pre-configured OAuth, otherwise find an available port
    const configuredCallbackPort = serverConfig.oauth?.callbackPort
    const port = configuredCallbackPort ?? (await findAvailablePort())
    const redirectUri = buildRedirectUri(port)
    logMCPDebug(
      serverName,
      `Using redirect port: ${port}${configuredCallbackPort ? ' (from config)' : ''}`,
    )

    const provider = new ClaudeAuthProvider(
      serverName,
      serverConfig,
      redirectUri,
      true,
      onAuthorizationUrl,
      options?.skipBrowserOpen,
    )

    // Fetch and store OAuth metadata for scope information
    try {
      const metadata = await fetchAuthServerMetadata(
        serverName,
        serverConfig.url,
        serverConfig.oauth?.authServerMetadataUrl,
        undefined,
        wwwAuthParams.resourceMetadataUrl,
      )
      if (metadata) {
        // Store metadata in provider for scope information
        provider.setMetadata(metadata)
        logMCPDebug(
          serverName,
          `Fetched OAuth metadata with scope: ${getScopeFromMetadata(metadata) || 'NONE'}`,
        )
      }
    } catch (error) {
      logMCPDebug(
        serverName,
        `Failed to fetch OAuth metadata: ${errorMessage(error)}`,
      )
    }

    // Get the OAuth state from the provider for validation
    const oauthState = await provider.state()

    // Store the server, timeout, and abort listener references for cleanup
    let server: Server | null = null
    let timeoutId: NodeJS.Timeout | null = null
    let abortHandler: (() => void) | null = null

    const cleanup = () => {
      if (server) {
        server.removeAllListeners()
        // Defensive: removeAllListeners() strips the error handler, so swallow any late error during close
        server.on('error', () => {})
        server.close()
        server = null
      }
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler)
        abortHandler = null
      }
      logMCPDebug(serverName, `MCP OAuth server cleaned up`)
    }

    // Setup a server to receive the callback
    const authorizationCode = await new Promise<string>((resolve, reject) => {
      let resolved = false
      const resolveOnce = (code: string) => {
        if (resolved) return
        resolved = true
        resolve(code)
      }
      const rejectOnce = (error: Error) => {
        if (resolved) return
        resolved = true
        reject(error)
      }

      if (abortSignal) {
        abortHandler = () => {
          cleanup()
          rejectOnce(new AuthenticationCancelledError())
        }
        if (abortSignal.aborted) {
          abortHandler()
          return
        }
        abortSignal.addEventListener('abort', abortHandler)
      }

      // Allow manual callback URL paste for remote/browser-based environments
      // where localhost is not reachable from the user's browser.
      if (options?.onWaitingForCallback) {
        options.onWaitingForCallback((callbackUrl: string) => {
          try {
            const parsed = new URL(callbackUrl)
            const result = validateOAuthCallbackParams(
              {
                code: parsed.searchParams.get('code'),
                state: parsed.searchParams.get('state'),
                error: parsed.searchParams.get('error'),
                error_description:
                  parsed.searchParams.get('error_description'),
                error_uri: parsed.searchParams.get('error_uri'),
              },
              oauthState,
            )

            if (result.type === 'state_mismatch') {
              // Ignore so a stray or malicious URL cannot cancel an active flow.
              return
            }

            if (result.type === 'missing_result') {
              // Not a valid callback URL, ignore so the user can try again.
              return
            }

            if (result.type === 'error') {
              cleanup()
              rejectOnce(new Error(result.message))
              return
            }

            logMCPDebug(
              serverName,
              `Received auth code via manual callback URL`,
            )
            cleanup()
            resolveOnce(result.code)
          } catch {
            // Invalid URL, ignore so the user can try again
          }
        })
      }

      server = createServer((req, res) => {
        const parsedUrl = parse(req.url || '', true)

        if (parsedUrl.pathname === '/callback') {
          const result = validateOAuthCallbackParams(
            parsedUrl.query,
            oauthState,
          )

          // Validate OAuth state to prevent CSRF attacks
          if (result.type === 'state_mismatch') {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end(
              `<h1>Authentication Error</h1><p>Invalid state parameter. Please try again.</p><p>You can close this window.</p>`,
            )
            return
          }

          if (result.type === 'missing_result') {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end(
              `<h1>Authentication Error</h1><p>Missing OAuth result. Please try again.</p><p>You can close this window.</p>`,
            )
            return
          }

          if (result.type === 'error') {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            // Sanitize error messages to prevent XSS
            const sanitizedError = xss(result.error)
            const sanitizedErrorDescription = result.errorDescription
              ? xss(result.errorDescription)
              : ''
            res.end(
              `<h1>Authentication Error</h1><p>${sanitizedError}: ${sanitizedErrorDescription}</p><p>You can close this window.</p>`,
            )
            cleanup()
            rejectOnce(new Error(result.message))
            return
          }

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            `<h1>Authentication Successful</h1><p>You can close this window. Return to Claudin.</p>`,
          )
          cleanup()
          resolveOnce(result.code)
        }
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        cleanup()
        if (err.code === 'EADDRINUSE') {
          const findCmd =
            getPlatform() === 'windows'
              ? `netstat -ano | findstr :${port}`
              : `lsof -ti:${port} -sTCP:LISTEN`
          rejectOnce(
            new Error(
              `OAuth callback port ${port} is already in use — another process may be holding it. ` +
                `Run \`${findCmd}\` to find it.`,
            ),
          )
        } else {
          rejectOnce(new Error(`OAuth callback server failed: ${err.message}`))
        }
      })

      server.listen(port, '127.0.0.1', async () => {
        try {
          logMCPDebug(serverName, `Starting SDK auth`)
          logMCPDebug(serverName, `Server URL: ${serverConfig.url}`)

          // First call to start the auth flow - should redirect
          // Pass the scope and resource_metadata from WWW-Authenticate header if available
          const result = await sdkAuth(provider, {
            serverUrl: serverConfig.url,
            scope: wwwAuthParams.scope,
            resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
          })
          logMCPDebug(serverName, `Initial auth result: ${result}`)

          if (result !== 'REDIRECT') {
            logMCPDebug(
              serverName,
              `Unexpected auth result, expected REDIRECT: ${result}`,
            )
          }
        } catch (error) {
          logMCPDebug(serverName, `SDK auth error: ${error}`)
          cleanup()
          rejectOnce(new Error(`SDK auth failed: ${errorMessage(error)}`))
        }
      })

      // Don't let the callback server or timeout pin the event loop — if the UI
      // component unmounts without aborting (e.g. parent intercepts Esc), we'd
      // rather let the process exit than stay alive for 5 minutes holding the
      // port. The abortSignal is the intended lifecycle management.
      server.unref()

      timeoutId = setTimeout(
        (cleanup, rejectOnce) => {
          cleanup()
          rejectOnce(new Error('Authentication timeout'))
        },
        5 * 60 * 1000, // 5 minutes
        cleanup,
        rejectOnce,
      )
      timeoutId.unref()
    })

    // Now complete the auth flow with the received code
    logMCPDebug(serverName, `Completing auth flow with authorization code`)
    const result = await sdkAuth(provider, {
      serverUrl: serverConfig.url,
      authorizationCode,
      resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
    })

    logMCPDebug(serverName, `Auth result: ${result}`)

    if (result === 'AUTHORIZED') {
      // Debug: Check if tokens were properly saved
      const savedTokens = await provider.tokens()
      logMCPDebug(
        serverName,
        `Tokens after auth: ${savedTokens ? 'Present' : 'Missing'}`,
      )
      if (savedTokens) {
        logMCPDebug(
          serverName,
          `Token access_token length: ${savedTokens.access_token?.length}`,
        )
        logMCPDebug(serverName, `Token expires_in: ${savedTokens.expires_in}`)
      }

    } else {
      throw new Error('Unexpected auth result: ' + result)
    }
  } catch (error) {
    logMCPDebug(serverName, `Error during auth completion: ${error}`)

    // sdkAuth uses native fetch and throws OAuthError subclasses (InvalidGrantError,
    // ServerError, InvalidClientError, etc.) via parseErrorResponse.
    // If client not found, clear the stored client ID and suggest retry
    if (
      error instanceof OAuthError &&
      error.errorCode === 'invalid_client' &&
      error.message.includes('Client not found')
    ) {
      const storage = getSecureStorage()
      const existingData = storage.read() || {}
      const serverKey = getServerKey(serverName, serverConfig)
      if (existingData.mcpOAuth?.[serverKey]) {
        delete existingData.mcpOAuth[serverKey].clientId
        delete existingData.mcpOAuth[serverKey].clientSecret
        storage.update(existingData)
      }
    }

    throw error
  }
}

/**
 * Wraps fetch to detect 403 insufficient_scope responses and mark step-up
 * pending on the provider BEFORE the SDK's 403 handler calls auth(). Without
 * this, the SDK's authInternal sees refresh_token → refreshes (uselessly, since
 * RFC 6749 §6 forbids scope elevation via refresh) → returns 'AUTHORIZED' →
 * retry → 403 again → aborts with "Server returned 403 after trying upscoping",
 * never reaching redirectToAuthorization where step-up scope is persisted.
 * With this flag set, tokens() omits refresh_token so the SDK falls through
 * to the PKCE flow. See github.com/anthropics/claude-code/issues/28258.
 */
export function wrapFetchWithStepUpDetection(
  baseFetch: FetchLike,
  provider: ClaudeAuthProvider,
): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init)
    if (response.status === 403) {
      const wwwAuth = response.headers.get('WWW-Authenticate')
      if (wwwAuth?.includes('insufficient_scope')) {
        // Match both quoted and unquoted values (RFC 6750 §3 allows either).
        // Same pattern as the SDK's extractFieldFromWwwAuth.
        const match = wwwAuth.match(/scope=(?:"([^"]+)"|([^\s,]+))/)
        const scope = match?.[1] ?? match?.[2]
        if (scope) {
          provider.markStepUpPending(scope)
        }
      }
    }
    return response
  }
}
