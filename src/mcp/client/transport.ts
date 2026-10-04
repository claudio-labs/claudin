import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getOauthConfig } from 'src/shared/constants/oauth.js'
import { getClaudeAIOAuthTokens } from 'src/providers/auth/auth.js'
import { getMCPUserAgent } from 'src/shared/http.js'
import { logMCPDebug } from 'src/shared/log.js'
import { errorMessage } from 'src/shared/errors.js'
import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'
import { getProxyFetchOptions } from 'src/providers/transport/proxy.js'
import { getSessionIngressAuthToken } from 'src/sessions/sessionIngressAuth.js'
import { subprocessEnv } from 'src/shared/proc/subprocessEnv.js'
import { ClaudeAuthProvider, wrapFetchWithStepUpDetection } from 'src/mcp/auth.js'
import { getMcpServerHeaders } from 'src/mcp/headersHelper.js'
import type {
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  McpWebSocketServerConfig,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'
import { createClaudeAiProxyFetch, wrapFetchWithTimeout } from 'src/mcp/client/fetch.js'
import { outgoingHeaders } from 'src/mcp/client/transport/credentials.js'
import { openMcpSocket } from 'src/mcp/client/transport/webSocket.js'

export type InProcessMcpServer = {
  connect(t: Transport): Promise<void>
  close(): Promise<void>
}

type BuiltTransport = { transport: Transport; inProcessServer?: InProcessMcpServer }

const SERVER_ID_PLACEHOLDER = '{server_id}'

/** The global fetch, read per call so a replaced `globalThis.fetch` is honoured. */
const globalFetch: FetchLike = (url, init) => fetch(url, init)

/** Fetch with the proxy and TLS settings of the host, when there are any. */
function hostFetch(): FetchLike {
  const options: RequestInit = getProxyFetchOptions()
  return Object.keys(options).length > 0 ? createFetchWithInit(globalFetch, options) : globalFetch
}

/** The parent's environment with the config's laid over it, without unset names. */
function childEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...subprocessEnv(), ...overrides })) {
    if (value !== undefined) env[key] = value
  }
  return env
}

function stdioTransport(config: McpStdioServerConfig): Transport {
  const args = config.args ?? []
  // Tracked (spec Finding 2): the prefix gets one unquoted string.
  const prefix = process.env.CLAUDIN_SHELL_PREFIX
  return new StdioClientTransport({
    command: prefix || config.command,
    args: prefix ? [[config.command, ...args].join(' ')] : args,
    env: childEnvironment(config.env),
    stderr: 'pipe',
  })
}

async function storedAccessToken(name: string, provider: ClaudeAuthProvider): Promise<string | undefined> {
  try {
    return (await provider.tokens())?.access_token
  } catch (error) {
    logMCPDebug(name, `Reading the stored OAuth token failed: ${errorMessage(error)}`)
    return undefined
  }
}

async function httpTransport(name: string, config: McpHTTPServerConfig): Promise<Transport> {
  const authProvider = new ClaudeAuthProvider(name, config)
  const headers = outgoingHeaders('http', {
    userAgent: getMCPUserAgent(),
    configured: await getMcpServerHeaders(name, config),
    hasStoredToken: (await storedAccessToken(name, authProvider)) !== undefined,
    ingressToken: getSessionIngressAuthToken(),
  })
  return new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider,
    fetch: wrapFetchWithTimeout(wrapFetchWithStepUpDetection(hostFetch(), authProvider)),
    requestInit: { headers },
  })
}

async function sseTransport(name: string, config: McpSSEServerConfig): Promise<Transport> {
  const authProvider = new ClaudeAuthProvider(name, config)
  const headers = outgoingHeaders('sse', {
    userAgent: getMCPUserAgent(),
    configured: await getMcpServerHeaders(name, config),
  })
  return new SSEClientTransport(new URL(config.url), {
    authProvider,
    // The event stream is a GET, which the timeout wrapper leaves alone.
    fetch: wrapFetchWithTimeout(wrapFetchWithStepUpDetection(hostFetch(), authProvider)),
    requestInit: { headers },
  })
}

async function wsTransport(name: string, config: McpWebSocketServerConfig): Promise<Transport> {
  const headers = outgoingHeaders('ws', {
    userAgent: getMCPUserAgent(),
    configured: await getMcpServerHeaders(name, config),
    ingressToken: getSessionIngressAuthToken(),
  })
  return new WebSocketTransport(await openMcpSocket(config.url, { headers, viaProxy: true }))
}

function claudeAiProxyTransport(config: McpClaudeAIProxyServerConfig): Transport {
  if (!getClaudeAIOAuthTokens()?.accessToken) throw new Error('No claude.ai OAuth token found')
  const { MCP_PROXY_URL, MCP_PROXY_PATH } = getOauthConfig()
  const path = MCP_PROXY_PATH.split(SERVER_ID_PLACEHOLDER).join(encodeURIComponent(config.id))
  const headers = outgoingHeaders('claudeai-proxy', {
    userAgent: getMCPUserAgent(),
    sessionId: getSessionId(),
  })
  return new StreamableHTTPClientTransport(new URL(`${MCP_PROXY_URL}${path}`), {
    fetch: wrapFetchWithTimeout(createClaudeAiProxyFetch(hostFetch())),
    requestInit: { headers },
  })
}

/**
 * The transport for one configured server. Nothing is connected yet; stderr
 * of a stdio child is left for the caller to wire. No transport in this fork
 * runs a server in process, so `inProcessServer` is never set.
 */
export async function createTransport(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<{ transport: Transport; inProcessServer?: InProcessMcpServer }> {
  const built = await buildTransport(name, serverRef)
  logMCPDebug(name, `Transport ready for type ${serverRef.type ?? 'stdio'}`)
  return built
}

async function buildTransport(name: string, config: ScopedMcpServerConfig): Promise<BuiltTransport> {
  switch (config.type) {
    case undefined:
    case 'stdio':
      return { transport: stdioTransport(config) }
    case 'http':
      return { transport: await httpTransport(name, config) }
    case 'sse':
      return { transport: await sseTransport(name, config) }
    case 'sse-ide': {
      const headers = outgoingHeaders('sse-ide', { userAgent: getMCPUserAgent() })
      return { transport: new SSEClientTransport(new URL(config.url), { requestInit: { headers } }) }
    }
    case 'ws':
      return { transport: await wsTransport(name, config) }
    case 'ws-ide': {
      const headers = outgoingHeaders('ws-ide', { userAgent: getMCPUserAgent(), ideToken: config.authToken })
      return { transport: new WebSocketTransport(await openMcpSocket(config.url, { headers, viaProxy: false })) }
    }
    case 'claudeai-proxy':
      return { transport: claudeAiProxyTransport(config) }
    case 'sdk':
      throw new Error('SDK servers should be handled in print.ts')
    default: {
      const unknownType: unknown = (config as { type?: unknown }).type
      throw new Error(`Unsupported server type: ${String(unknownType)}`)
    }
  }
}
