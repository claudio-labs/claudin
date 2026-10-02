// Adapted from opencode (MIT, Copyright (c) 2025 opencode):
// packages/opencode/src/mcp/oauth-callback.ts
// packages/opencode/src/mcp/index.ts

/**
 * The interactive sign-in to a remote MCP server: a loopback server that
 * catches the authorization redirect (or a callback URL the user pastes by
 * hand), the two SDK auth() calls around it, and the step-up detection that
 * rides on the transport's fetch.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { auth as sdkAuth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import { errorMessage, getErrnoCode } from 'src/shared/errors.js'
import { logMCPDebug } from 'src/shared/log.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { createAuthFetch, fetchAuthServerMetadata } from 'src/mcp/auth/authFetch.js'
import { validateOAuthCallbackParams } from 'src/mcp/auth/callbackParams.js'
import { ClaudeAuthProvider } from 'src/mcp/auth/claudeAuthProvider.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import { clearServerTokensFromSecureStorage } from 'src/mcp/auth/tokenRevocation.js'

type RemoteServerConfig = McpSSEServerConfig | McpHTTPServerConfig

type OAuthFlowOptions = {
  /** Report the authorization URL without launching a browser. */
  skipBrowserOpen?: boolean
  /** Receives a function that completes the sign-in from a callback URL pasted by hand. */
  onWaitingForCallback?: (submit: (callbackUrl: string) => void) => void
}

export class AuthenticationCancelledError extends Error {
  constructor() {
    super('Authentication was cancelled')
    this.name = 'AuthenticationCancelledError'
  }
}

const CALLBACK_PATH = '/callback'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PORT = 65535

const HTML_SPECIALS_RE = /[&<>"']/g
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIALS_RE, ch => HTML_ENTITIES[ch] ?? ch)
}

function callbackPage(title: string, message: string): string {
  return `<h1>${title}</h1><p>${message}</p><p>You can close this window.</p>`
}

const SUCCESS_PAGE = callbackPage('Authentication Successful', 'Return to Claudin.')
const retryPage = (reason: string): string =>
  callbackPage('Authentication Error', `${reason} Please try again.`)

function readCallbackParams(params: URLSearchParams): Parameters<typeof validateOAuthCallbackParams>[0] {
  return {
    code: params.getAll('code'),
    state: params.getAll('state'),
    error: params.getAll('error'),
    error_description: params.getAll('error_description'),
    error_uri: params.getAll('error_uri'),
  }
}

type Waiter = { state: string; resolve: (code: string) => void; reject: (error: Error) => void }

/**
 * One loopback listener per sign-in, closed when the sign-in ends. It hands
 * back the authorization code for one expected state; visits with another
 * state, or with no result, get an error page and the wait goes on.
 */
class CallbackServer {
  #waiter: Waiter | undefined

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly serverName: string,
  ) {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => this.#handle(req, res))
  }

  static async listen(serverName: string, requestedPort: number): Promise<CallbackServer> {
    const server = createServer()
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(requestedPort, CALLBACK_HOST, () => {
          server.off('error', reject)
          resolve((server.address() as AddressInfo).port)
        })
      })
      return new CallbackServer(server, port, serverName)
    } catch (error) {
      if (getErrnoCode(error) === 'EADDRINUSE') {
        throw new Error(
          `OAuth callback port ${requestedPort} is already in use — another process may be holding it. Run \`lsof -ti:${requestedPort} -sTCP:LISTEN\` to find it.`,
        )
      }
      throw new Error(`OAuth callback server failed: ${errorMessage(error)}`)
    }
  }

  waitFor(state: string): Promise<string> {
    const code = new Promise<string>((resolve, reject) => {
      this.#waiter = { state, resolve, reject }
    })
    // The outcome can land before the flow awaits it (a paste during the
    // redirect); this keeps an early rejection from counting as unhandled.
    code.catch(() => undefined)
    return code
  }

  /** A callback URL the user pasted. Anything that is not a valid result for this sign-in is ignored. */
  submit(callbackUrl: string): void {
    let url: URL
    try {
      url = new URL(callbackUrl.trim())
    } catch {
      logMCPDebug(this.serverName, 'Ignored a pasted callback that is not a URL')
      return
    }
    const waiter = this.#waiter
    if (!waiter) return
    const result = validateOAuthCallbackParams(readCallbackParams(url.searchParams), waiter.state)
    if (result.type === 'code') {
      this.#waiter = undefined
      waiter.resolve(result.code)
    } else if (result.type === 'error') {
      this.#waiter = undefined
      waiter.reject(new Error(result.message))
    } else {
      logMCPDebug(this.serverName, `Ignored a pasted callback: ${result.type}`)
    }
  }

  fail(error: Error): void {
    const waiter = this.#waiter
    this.#waiter = undefined
    waiter?.reject(error)
  }

  close(): void {
    this.server.close()
    this.server.closeAllConnections()
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    const waiter = this.#waiter
    const result = validateOAuthCallbackParams(readCallbackParams(url.searchParams), waiter?.state ?? '')
    if (!waiter || result.type === 'state_mismatch') {
      respond(res, 400, retryPage('Invalid state parameter.'))
      return
    }
    if (result.type === 'missing_result') {
      respond(res, 400, retryPage('Missing OAuth result.'))
      return
    }
    this.#waiter = undefined
    if (result.type === 'error') {
      const detail = result.errorDescription
        ? `${escapeHtml(result.error)}: ${escapeHtml(result.errorDescription)}`
        : escapeHtml(result.error)
      respond(res, 200, callbackPage('Authentication Error', detail), () =>
        waiter.reject(new Error(result.message)),
      )
      return
    }
    respond(res, 200, SUCCESS_PAGE, () => waiter.resolve(result.code))
  }
}

/**
 * Writes a page. A final page closes its connection and settles the sign-in
 * only once it is flushed, so closing the server cannot cut it short.
 */
function respond(res: ServerResponse, status: number, html: string, settle?: () => void): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    ...(settle ? { Connection: 'close' } : {}),
  })
  res.end(html, settle)
}

function callbackPortFor(serverConfig: RemoteServerConfig): number {
  const configured = serverConfig.oauth?.callbackPort
  if (configured) return configured
  const fromEnv = Number(process.env.MCP_OAUTH_CALLBACK_PORT)
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= MAX_PORT) return fromEnv
  return 0
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * A sign-in starts from nothing: a client registered for another redirect
 * URI, or a dead token, would otherwise be reused. Only a step-up request
 * the transport recorded carries over, as the scope to ask for.
 */
function takeCarriedState(
  serverName: string,
  serverConfig: RemoteServerConfig,
): { stepUpScope?: string; resourceMetadataUrl?: URL } {
  const entry = getSecureStorage().read()?.mcpOAuth?.[getServerKey(serverName, serverConfig)]
  clearServerTokensFromSecureStorage(serverName, serverConfig)
  return {
    stepUpScope: entry?.stepUpScope,
    resourceMetadataUrl: parseUrl(entry?.discoveryState?.resourceMetadataUrl),
  }
}

/** The authorization server's metadata, read up front for the scope it names. */
async function metadataForScope(
  serverName: string,
  serverConfig: RemoteServerConfig,
  resourceMetadataUrl: URL | undefined,
): Promise<AuthorizationServerMetadata | undefined> {
  try {
    return await fetchAuthServerMetadata(
      serverName,
      serverConfig.url,
      serverConfig.oauth?.authServerMetadataUrl,
      createAuthFetch(),
      resourceMetadataUrl,
    )
  } catch (error) {
    logMCPDebug(serverName, `Metadata discovery before sign-in failed: ${errorMessage(error)}`)
    return undefined
  }
}

export async function performMCPOAuthFlow(
  serverName: string,
  serverConfig: RemoteServerConfig,
  onAuthorizationUrl: (url: string) => void,
  abortSignal?: AbortSignal,
  options?: OAuthFlowOptions,
): Promise<void> {
  if (abortSignal?.aborted) throw new AuthenticationCancelledError()

  const callback = await CallbackServer.listen(serverName, callbackPortFor(serverConfig))
  const cancel = (): void => callback.fail(new AuthenticationCancelledError())
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const carried = takeCarriedState(serverName, serverConfig)
    const metadata = await metadataForScope(serverName, serverConfig, carried.resourceMetadataUrl)
    const provider = new ClaudeAuthProvider(
      serverName,
      serverConfig,
      `http://localhost:${callback.port}${CALLBACK_PATH}`,
      true,
      onAuthorizationUrl,
      options?.skipBrowserOpen,
    )
    if (metadata) provider.setMetadata(metadata)

    const code = callback.waitFor(await provider.state())
    abortSignal?.addEventListener('abort', cancel, { once: true })
    timeout = setTimeout(
      () => callback.fail(new Error('OAuth callback timeout - authorization took too long')),
      CALLBACK_TIMEOUT_MS,
    )
    // Checked before auth(), which would register a client and open the browser.
    if (abortSignal?.aborted) throw new AuthenticationCancelledError()
    options?.onWaitingForCallback?.(url => callback.submit(url))

    const authOptions = {
      serverUrl: serverConfig.url,
      resourceMetadataUrl: carried.resourceMetadataUrl,
      fetchFn: createAuthFetch(),
    }
    let started: Awaited<ReturnType<typeof sdkAuth>>
    try {
      started = await sdkAuth(provider, { ...authOptions, scope: carried.stepUpScope })
    } catch (error) {
      if (abortSignal?.aborted) throw new AuthenticationCancelledError()
      throw new Error(`SDK auth failed: ${errorMessage(error)}`, { cause: error })
    }
    if (started === 'AUTHORIZED') return

    const authorizationCode = await code
    await sdkAuth(provider, { ...authOptions, authorizationCode })
    logMCPDebug(serverName, 'Signed in')
  } finally {
    clearTimeout(timeout)
    abortSignal?.removeEventListener('abort', cancel)
    callback.close()
  }
}

/**
 * Watches the transport's responses for RFC 6750 insufficient_scope. The
 * provider then withholds its refresh token, so the SDK's next auth() asks
 * for the wider scope instead of refreshing the narrow one.
 */
export function wrapFetchWithStepUpDetection(
  fetchFn: FetchLike,
  provider: ClaudeAuthProvider,
): FetchLike {
  return async (url, init) => {
    const response = await fetchFn(url, init)
    if (response.status === 403) {
      const { error, scope } = extractWWWAuthenticateParams(response)
      if (error === 'insufficient_scope' && scope) provider.markStepUpPending(scope)
    }
    return response
  }
}
