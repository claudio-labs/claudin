import { feature } from 'bun:bundle'
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import mapValues from 'lodash-es/mapValues.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getClaudeAIOAuthTokens } from 'src/utils/auth.js'
import { getMCPUserAgent } from 'src/utils/http.js'
import { logMCPDebug } from 'src/utils/log.js'
import { WebSocketTransport } from 'src/utils/mcpWebSocketTransport.js'
import { getWebSocketTLSOptions } from 'src/utils/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from 'src/utils/proxy.js'
import { getSessionIngressAuthToken } from 'src/utils/sessionIngressAuth.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { subprocessEnv } from 'src/utils/subprocessEnv.js'
import { ClaudeAuthProvider, wrapFetchWithStepUpDetection } from 'src/services/mcp/auth.js'
import { getMcpServerHeaders } from 'src/services/mcp/headersHelper.js'
import type { ScopedMcpServerConfig } from 'src/services/mcp/types.js'
import {
  createClaudeAiProxyFetch,
  MCP_REQUEST_TIMEOUT_MS,
  wrapFetchWithTimeout,
} from './fetch.js'

/* eslint-disable @typescript-eslint/no-require-imports */
// Lazy: wrapper.tsx → hostAdapter.ts → executor.ts pulls both native modules
// (@ant/computer-use-input + @ant/computer-use-swift). Runtime-gated by
// GrowthBook tengu_malort_pedway (see gates.ts).
export const computerUseWrapper = feature('CHICAGO_MCP')
  ? (): typeof import('src/utils/computerUse/wrapper.js') =>
    require('src/utils/computerUse/wrapper.js')
  : undefined
export const isComputerUseMCPServer = feature('CHICAGO_MCP')
  ? (
    require('src/utils/computerUse/common.js') as typeof import('src/utils/computerUse/common.js')
  ).isComputerUseMCPServer
  : undefined
/* eslint-enable @typescript-eslint/no-require-imports */

// Minimal interface for WebSocket instances passed to mcpWebSocketTransport
type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
async function createNodeWsClient(
  url: string,
  options: Record<string, unknown>,
): Promise<WsClientLike> {
  const wsModule = await import('ws')
  const WS = wsModule.default as unknown as new (
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) => WsClientLike
  return new WS(url, ['mcp'], options)
}

export type InProcessMcpServer = {
  connect(t: Transport): Promise<void>
  close(): Promise<void>
}

/**
 * Builds the MCP transport for a server based on its configured type
 * (sse / sse-ide / ws-ide / ws / http / claudeai-proxy / in-process / stdio).
 * Returns the transport plus, for in-process servers, the server handle so the
 * caller can close it. Stderr wiring is intentionally left to the caller.
 */
export async function createTransport(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<{ transport: Transport; inProcessServer?: InProcessMcpServer }> {
  let inProcessServer: InProcessMcpServer | undefined
  let transport

  // If we have the session ingress JWT, we will connect via the session ingress rather than
  // to remote MCP's directly.
  const sessionIngressToken = getSessionIngressAuthToken()

  if (serverRef.type === 'sse') {
    // Create an auth provider for this server
    const authProvider = new ClaudeAuthProvider(name, serverRef)

    // Get combined headers (static + dynamic)
    const combinedHeaders = await getMcpServerHeaders(name, serverRef)

    // Use the auth provider with SSEClientTransport
    const transportOptions: SSEClientTransportOptions = {
      authProvider,
      // Use fresh timeout per request to avoid stale AbortSignal bug.
      // Step-up detection wraps innermost so the 403 is seen before the
      // SDK's handler calls auth() → tokens().
      fetch: wrapFetchWithTimeout(
        wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
      ),
      requestInit: {
        headers: {
          'User-Agent': getMCPUserAgent(),
          ...combinedHeaders,
        },
      },
    }

    // IMPORTANT: Always set eventSourceInit with a fetch that does NOT use the
    // timeout wrapper. The EventSource connection is long-lived (stays open indefinitely
    // to receive server-sent events), so applying a 60-second timeout would kill it.
    // The timeout is only meant for individual API requests (POST, auth refresh), not
    // the persistent SSE stream.
    transportOptions.eventSourceInit = {
      fetch: async (url: string | URL, init?: RequestInit) => {
        // Get auth headers from the auth provider
        const authHeaders: Record<string, string> = {}
        const tokens = await authProvider.tokens()
        if (tokens) {
          authHeaders.Authorization = `Bearer ${tokens.access_token}`
        }

        const proxyOptions = getProxyFetchOptions()
        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        return fetch(url, {
          ...init,
          ...proxyOptions,
          headers: {
            'User-Agent': getMCPUserAgent(),
            ...authHeaders,
            ...init?.headers,
            ...combinedHeaders,
            Accept: 'text/event-stream',
          },
        })
      },
    }

    transport = new SSEClientTransport(
      new URL(serverRef.url),
      transportOptions,
    )
    logMCPDebug(name, `SSE transport initialized, awaiting connection`)
  } else if (serverRef.type === 'sse-ide') {
    logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
    // IDE servers don't need authentication
    // TODO: Use the auth token provided in the lockfile
    const proxyOptions = getProxyFetchOptions()
    const transportOptions: SSEClientTransportOptions =
      proxyOptions.dispatcher
        ? {
          eventSourceInit: {
            fetch: async (url: string | URL, init?: RequestInit) => {
              // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
              return fetch(url, {
                ...init,
                ...proxyOptions,
                headers: {
                  'User-Agent': getMCPUserAgent(),
                  ...init?.headers,
                },
              })
            },
          },
        }
        : {}

    transport = new SSEClientTransport(
      new URL(serverRef.url),
      Object.keys(transportOptions).length > 0
        ? transportOptions
        : undefined,
    )
  } else if (serverRef.type === 'ws-ide') {
    const tlsOptions = getWebSocketTLSOptions()
    const wsHeaders = {
      'User-Agent': getMCPUserAgent(),
      ...(serverRef.authToken && {
        'X-Claude-Code-Ide-Authorization': serverRef.authToken,
      }),
    }

    let wsClient: WsClientLike
    if (typeof Bun !== 'undefined') {
      // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      wsClient = new globalThis.WebSocket(serverRef.url, {
        protocols: ['mcp'],
        headers: wsHeaders,
        proxy: getWebSocketProxyUrl(serverRef.url),
        tls: tlsOptions || undefined,
      } as unknown as string[])
    } else {
      wsClient = await createNodeWsClient(serverRef.url, {
        headers: wsHeaders,
        agent: getWebSocketProxyAgent(serverRef.url),
        ...(tlsOptions || {}),
      })
    }
    transport = new WebSocketTransport(wsClient)
  } else if (serverRef.type === 'ws') {
    logMCPDebug(
      name,
      `Initializing WebSocket transport to ${serverRef.url}`,
    )

    const combinedHeaders = await getMcpServerHeaders(name, serverRef)

    const tlsOptions = getWebSocketTLSOptions()
    const wsHeaders = {
      'User-Agent': getMCPUserAgent(),
      ...(sessionIngressToken && {
        Authorization: `Bearer ${sessionIngressToken}`,
      }),
      ...combinedHeaders,
    }

    // Redact sensitive headers before logging
    const wsHeadersForLogging = mapValues(wsHeaders, (value, key) =>
      key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
    )

    logMCPDebug(
      name,
      `WebSocket transport options: ${jsonStringify({
        url: serverRef.url,
        headers: wsHeadersForLogging,
        hasSessionAuth: !!sessionIngressToken,
      })}`,
    )

    let wsClient: WsClientLike
    if (typeof Bun !== 'undefined') {
      // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      wsClient = new globalThis.WebSocket(serverRef.url, {
        protocols: ['mcp'],
        headers: wsHeaders,
        proxy: getWebSocketProxyUrl(serverRef.url),
        tls: tlsOptions || undefined,
      } as unknown as string[])
    } else {
      wsClient = await createNodeWsClient(serverRef.url, {
        headers: wsHeaders,
        agent: getWebSocketProxyAgent(serverRef.url),
        ...(tlsOptions || {}),
      })
    }
    transport = new WebSocketTransport(wsClient)
  } else if (serverRef.type === 'http') {
    logMCPDebug(name, `Initializing HTTP transport to ${serverRef.url}`)
    logMCPDebug(
      name,
      `Node version: ${process.version}, Platform: ${process.platform}`,
    )
    logMCPDebug(
      name,
      `Environment: ${jsonStringify({
        NODE_OPTIONS: process.env.NODE_OPTIONS || 'not set',
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || 'default',
        HTTP_PROXY: process.env.HTTP_PROXY || 'not set',
        HTTPS_PROXY: process.env.HTTPS_PROXY || 'not set',
        NO_PROXY: process.env.NO_PROXY || 'not set',
      })}`,
    )

    // Create an auth provider for this server
    const authProvider = new ClaudeAuthProvider(name, serverRef)

    // Get combined headers (static + dynamic)
    const combinedHeaders = await getMcpServerHeaders(name, serverRef)

    // Check if this server has stored OAuth tokens. If so, the SDK's
    // authProvider will set Authorization — don't override with the
    // session ingress token (SDK merges requestInit AFTER authProvider).
    // CCR proxy URLs (ccr_shttp_mcp) have no stored OAuth, so they still
    // get the ingress token. See PR #24454 discussion.
    const hasOAuthTokens = !!(await authProvider.tokens())

    // Use the auth provider with StreamableHTTPClientTransport
    const proxyOptions = getProxyFetchOptions()
    logMCPDebug(
      name,
      `Proxy options: ${proxyOptions.dispatcher ? 'custom dispatcher' : 'default'}`,
    )

    const transportOptions: StreamableHTTPClientTransportOptions = {
      authProvider,
      // Use fresh timeout per request to avoid stale AbortSignal bug.
      // Step-up detection wraps innermost so the 403 is seen before the
      // SDK's handler calls auth() → tokens().
      fetch: wrapFetchWithTimeout(
        wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
      ),
      requestInit: {
        ...proxyOptions,
        headers: {
          'User-Agent': getMCPUserAgent(),
          ...(sessionIngressToken &&
            !hasOAuthTokens && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
          ...combinedHeaders,
        },
      },
    }

    // Redact sensitive headers before logging
    const headersForLogging = transportOptions.requestInit?.headers
      ? mapValues(
        transportOptions.requestInit.headers as Record<string, string>,
        (value, key) =>
          key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
      )
      : undefined

    logMCPDebug(
      name,
      `HTTP transport options: ${jsonStringify({
        url: serverRef.url,
        headers: headersForLogging,
        hasAuthProvider: !!authProvider,
        timeoutMs: MCP_REQUEST_TIMEOUT_MS,
      })}`,
    )

    transport = new StreamableHTTPClientTransport(
      new URL(serverRef.url),
      transportOptions,
    )
    logMCPDebug(name, `HTTP transport created successfully`)
  } else if (serverRef.type === 'sdk') {
    throw new Error('SDK servers should be handled in print.ts')
  } else if (serverRef.type === 'claudeai-proxy') {
    logMCPDebug(
      name,
      `Initializing claude.ai proxy transport for server ${serverRef.id}`,
    )

    const tokens = getClaudeAIOAuthTokens()
    if (!tokens) {
      throw new Error('No claude.ai OAuth token found')
    }

    const oauthConfig = getOauthConfig()
    const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`

    logMCPDebug(name, `Using claude.ai proxy at ${proxyUrl}`)

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const fetchWithAuth = createClaudeAiProxyFetch(globalThis.fetch)

    const proxyOptions = getProxyFetchOptions()
    const transportOptions: StreamableHTTPClientTransportOptions = {
      // Wrap fetchWithAuth with fresh timeout per request
      fetch: wrapFetchWithTimeout(fetchWithAuth),
      requestInit: {
        ...proxyOptions,
        headers: {
          'User-Agent': getMCPUserAgent(),
          'X-Mcp-Client-Session-Id': getSessionId(),
        },
      },
    }

    transport = new StreamableHTTPClientTransport(
      new URL(proxyUrl),
      transportOptions,
    )
    logMCPDebug(name, `claude.ai proxy transport created successfully`)
  } else if (
    feature('CHICAGO_MCP') &&
    (serverRef.type === 'stdio' || !serverRef.type) &&
    isComputerUseMCPServer!(name)
  ) {
    // Run the Computer Use MCP server in-process — same rationale as
    // Chrome above. The package's CallTool handler is a stub; real
    // dispatch goes through wrapper.tsx's .call() override.
    const { createComputerUseMcpServerForCli } = await import(
      'src/utils/computerUse/mcpServer.js'
    )
    const { createLinkedTransportPair } = await import(
      'src/services/mcp/InProcessTransport.js'
    )
    const inProcess = await createComputerUseMcpServerForCli()
    inProcessServer = inProcess
    const [clientTransport, serverTransport] = createLinkedTransportPair()
    await inProcess.connect(serverTransport)
    transport = clientTransport
    logMCPDebug(name, `In-process Computer Use MCP server started`)
  } else if (serverRef.type === 'stdio' || !serverRef.type) {
    const finalCommand =
      process.env.CLAUDE_CODE_SHELL_PREFIX || serverRef.command
    const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
      ? [[serverRef.command, ...serverRef.args].join(' ')]
      : serverRef.args
    transport = new StdioClientTransport({
      command: finalCommand,
      args: finalArgs,
      env: {
        ...subprocessEnv(),
        ...serverRef.env,
      } as Record<string, string>,
      stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
    })
  } else {
    throw new Error(`Unsupported server type: ${serverRef.type}`)
  }

  return { transport, inProcessServer }
}
