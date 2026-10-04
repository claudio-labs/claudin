import type { ConnectionOptions } from 'node:tls'
import type { ClientOptions } from 'ws'
import { getWebSocketTLSOptions } from 'src/providers/transport/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from 'src/providers/transport/proxy.js'

/** The subprotocol every MCP WebSocket server is offered. */
const MCP_SUBPROTOCOL = 'mcp'

export type McpSocket = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

type Pem = string | Buffer
type TlsSettings = { ca?: Pem | Pem[]; cert?: Pem | Pem[]; key?: Pem | Pem[]; passphrase?: string }

/**
 * Bun's own constructor, which takes headers, proxy and TLS. The DOM typing of
 * the global only knows `(url, protocols)`, hence the one cast.
 */
type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => McpSocket
function runtimeWebSocket(): BunWebSocketConstructor {
  return globalThis.WebSocket as unknown as BunWebSocketConstructor
}

function isPem(value: unknown): value is Pem {
  return typeof value === 'string' || Buffer.isBuffer(value)
}

/** The PEM values of one TLS field; key objects and the like are left out. */
function pemField(value: ConnectionOptions['ca'] | ConnectionOptions['key']): Pem | Pem[] | undefined {
  if (isPem(value)) return value
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value
    const pems = items.filter(isPem)
    return pems.length > 0 ? pems : undefined
  }
  return undefined
}

export type SocketOptions = {
  headers: Record<string, string>
  /** Route through the configured HTTP proxy. IDE sockets are local and do not. */
  viaProxy: boolean
}

/**
 * Opens (without waiting for) a socket to an MCP server. Under Bun the
 * runtime's WebSocket takes headers, proxy and TLS itself; the bundle runs on
 * Node, where the `ws` package does.
 */
export async function openMcpSocket(url: string, options: SocketOptions): Promise<McpSocket> {
  const tls = tlsSettings()
  if (typeof Bun !== 'undefined') {
    const proxy = options.viaProxy ? getWebSocketProxyUrl(url) : undefined
    const init: Bun.WebSocketOptions = {
      protocols: [MCP_SUBPROTOCOL],
      headers: options.headers,
      ...(proxy ? { proxy } : {}),
      ...(tls ? { tls } : {}),
    }
    return new (runtimeWebSocket())(url, init)
  }
  const agent = options.viaProxy ? getWebSocketProxyAgent(url) : undefined
  return openWithWsPackage(url, {
    headers: options.headers,
    ...(agent ? { agent } : {}),
    ...tls,
  })
}

/** The host's CA and client certificate settings, the fields both socket kinds accept. */
function tlsSettings(): TlsSettings | undefined {
  const settings = getWebSocketTLSOptions()
  if (!settings) return undefined
  return {
    ca: pemField(settings.ca),
    cert: pemField(settings.cert),
    key: pemField(settings.key),
    passphrase: settings.passphrase,
  }
}

async function openWithWsPackage(url: string, options: ClientOptions): Promise<McpSocket> {
  const { default: WsSocket } = await import('ws')
  return new WsSocket(url, [MCP_SUBPROTOCOL], options)
}
