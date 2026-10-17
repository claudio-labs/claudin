/**
 * The one place that opens a WebSocket. Bun's native client and Node's `ws`
 * take proxies, TLS and headers in different shapes and deliver events in
 * different shapes; every caller used to repeat that split. Here it happens
 * once, and a caller hands over one set of handlers.
 *
 * - Bun: `globalThis.WebSocket(url, { headers, protocols, proxy, tls })`.
 *   It never reports the upgrade response, so `onUpgrade` and `onRefused` do
 *   not fire there; a refused upgrade arrives as `onError` then `onClose`.
 * - Node: `ws`, loaded on first use so a process that never opens a socket
 *   never evaluates it, with the proxy as an `agent` and TLS spread in.
 *   Inside `bun test` the name `ws` resolves to Bun's own shim, which emits
 *   neither `upgrade` nor `unexpected-response`; webSocket.node.test.ts runs
 *   this branch under node with the real package.
 *
 * The handle comes back synchronously; on Node the socket itself exists once
 * `ws` has loaded, which is invisible to callers because nothing can happen
 * before `onOpen`. Text frames reach `onMessage` as strings, unless the caller
 * passes `onBinary`, which then receives every frame as bytes.
 */
import type { IncomingMessage } from 'node:http'
import type WsWebSocket from 'ws'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from 'src/providers/transport/proxy.js'
import { getWebSocketTLSOptions } from 'src/providers/transport/mtls.js'

export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

export type WebSocketHandlers = {
  onOpen?(): void
  /** Node only: the headers of the 101 response, lower-cased. */
  onUpgrade?(headers: Record<string, string>): void
  onMessage?(data: string): void
  /** When set, every frame arrives here as bytes and `onMessage` is skipped. */
  onBinary?(data: Uint8Array): void
  onError?(error: Error): void
  onClose?(code: number, reason: string): void
  onPong?(): void
  /** Node only: the server answered the upgrade with a status other than 101. */
  onRefused?(status: number, body: string): void
}

export type WebSocketOpenOptions = {
  headers?: Record<string, string>
  protocols?: string[]
  /** Offer permessage-deflate (both runtimes default to true). */
  perMessageDeflate?: boolean
  handlers?: WebSocketHandlers
}

export type WebSocketHandle = {
  readonly url: string
  readonly readyState: number
  /** Replace the handlers; later events go to these. */
  listen(handlers: WebSocketHandlers): void
  send(data: string | Uint8Array): Promise<void>
  ping(): void
  close(code?: number, reason?: string): void
  /** Remove every listener this opener attached; later events are dropped. */
  detach(): void
}

type WsCtor = typeof WsWebSocket

/** Test seam: force a runtime, or hand in the `ws` constructor. */
export type WebSocketOpenerDeps = {
  runtime?: 'bun' | 'node'
  loadWs?: () => Promise<WsCtor>
}

let wsCtor: Promise<WsCtor> | undefined
function loadNodeWs(): Promise<WsCtor> {
  wsCtor ??= import('ws').then(mod => mod.default)
  return wsCtor
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(0)
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data
  return new TextDecoder().decode(toBytes(data))
}

function flatHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

export function openWebSocket(
  url: string,
  options: WebSocketOpenOptions = {},
  deps: WebSocketOpenerDeps = {},
): WebSocketHandle {
  const runtime = deps.runtime ?? (typeof Bun !== 'undefined' ? 'bun' : 'node')
  let handlers: WebSocketHandlers = options.handlers ?? {}
  const deliver = (data: unknown): void => {
    if (handlers.onBinary) handlers.onBinary(toBytes(data))
    else handlers.onMessage?.(toText(data))
  }
  return runtime === 'bun'
    ? openBun(url, options, () => handlers, h => { handlers = h }, deliver)
    : openNode(url, options, () => handlers, h => { handlers = h }, deliver, deps.loadWs ?? loadNodeWs)
}

function openBun(
  url: string,
  options: WebSocketOpenOptions,
  current: () => WebSocketHandlers,
  replace: (h: WebSocketHandlers) => void,
  deliver: (data: unknown) => void,
): WebSocketHandle {
  const init = {
    headers: options.headers ?? {},
    proxy: getWebSocketProxyUrl(url),
    tls: getWebSocketTLSOptions() || undefined,
    ...(options.protocols && { protocols: options.protocols }),
    ...(options.perMessageDeflate !== undefined && { perMessageDeflate: options.perMessageDeflate }),
  }
  // Bun's client takes an options object; the DOM typings only know protocols.
  const ws = new globalThis.WebSocket(url, init as unknown as string[])
  ws.binaryType = 'arraybuffer'
  const onOpen = (): void => current().onOpen?.()
  const onMessage = (event: MessageEvent): void => deliver(event.data)
  const onError = (event: Event): void => {
    const message = (event as ErrorEvent).message
    current().onError?.(new Error(message || 'WebSocket error'))
  }
  const onClose = (event: CloseEvent): void => current().onClose?.(event.code, event.reason)
  const onPong = (): void => current().onPong?.()
  // 'pong' is Bun-specific — not in the DOM typings.
  const target = ws as unknown as EventTarget
  ws.addEventListener('open', onOpen)
  ws.addEventListener('message', onMessage)
  ws.addEventListener('error', onError)
  ws.addEventListener('close', onClose)
  target.addEventListener('pong', onPong)
  return {
    url,
    get readyState() {
      return ws.readyState
    },
    listen: replace,
    send(data) {
      ws.send(data as string | BufferSource)
      return Promise.resolve()
    },
    ping() {
      if (ws.readyState === WS_OPEN) (ws as unknown as { ping(): void }).ping()
    },
    close(code, reason) {
      ws.close(code, reason)
    },
    detach() {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
      target.removeEventListener('pong', onPong)
      replace({})
    },
  }
}

function openNode(
  url: string,
  options: WebSocketOpenOptions,
  current: () => WebSocketHandlers,
  replace: (h: WebSocketHandlers) => void,
  deliver: (data: unknown) => void,
  loadWs: () => Promise<WsCtor>,
): WebSocketHandle {
  let ws: WsWebSocket | undefined
  let closedEarly: { code?: number; reason?: string } | undefined
  let detached = false
  let refused = false
  const onOpen = (): void => current().onOpen?.()
  const onUpgrade = (res: IncomingMessage): void => current().onUpgrade?.(flatHeaders(res.headers))
  const onMessage = (data: unknown): void => deliver(data)
  // After a refusal, the abort below surfaces as a socket hang-up; the
  // refusal already said what happened.
  const onError = (error: Error): void => {
    if (!refused) current().onError?.(error)
  }
  const onClose = (code: number, reason: Buffer): void => current().onClose?.(code, reason.toString())
  const onPong = (): void => current().onPong?.()
  const onUnexpected = (_req: unknown, res: IncomingMessage): void => {
    // With this listener attached, ws leaves the handshake to us: read the
    // body, then terminate, which aborts it and emits 'close' (1006).
    let body = ''
    res.setEncoding('utf8')
    res.on('data', chunk => {
      body += chunk
    })
    res.on('end', () => {
      refused = true
      current().onRefused?.(res.statusCode ?? 0, body)
      ws?.terminate()
    })
  }
  const attach = (socket: WsWebSocket): void => {
    socket.on('open', onOpen)
    socket.on('upgrade', onUpgrade)
    socket.on('message', onMessage)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('pong', onPong)
    socket.on('unexpected-response', onUnexpected)
  }
  const detachFrom = (socket: WsWebSocket): void => {
    socket.off('open', onOpen)
    socket.off('upgrade', onUpgrade)
    socket.off('message', onMessage)
    socket.off('error', onError)
    socket.off('close', onClose)
    socket.off('pong', onPong)
    socket.off('unexpected-response', onUnexpected)
  }
  void loadWs().then(
    WS => {
      if (closedEarly || detached) {
        if (closedEarly && !detached) current().onClose?.(closedEarly.code ?? 1000, closedEarly.reason ?? '')
        return
      }
      ws = new WS(url, options.protocols ?? [], {
        headers: options.headers ?? {},
        agent: getWebSocketProxyAgent(url),
        ...getWebSocketTLSOptions(),
        ...(options.perMessageDeflate !== undefined && { perMessageDeflate: options.perMessageDeflate }),
      })
      attach(ws)
    },
    (error: unknown) => {
      current().onError?.(error instanceof Error ? error : new Error(String(error)))
      current().onClose?.(1006, '')
    },
  )
  return {
    url,
    get readyState() {
      if (ws) return ws.readyState
      return closedEarly ? WS_CLOSED : WS_CONNECTING
    },
    listen: replace,
    send(data) {
      const socket = ws
      if (!socket) return Promise.reject(new Error('WebSocket is not open'))
      return new Promise((resolve, reject) => {
        socket.send(data, error => (error ? reject(error) : resolve()))
      })
    },
    ping() {
      if (ws?.readyState === WS_OPEN) ws.ping()
    },
    close(code, reason) {
      if (ws) ws.close(code, reason)
      else closedEarly = { code, reason }
    },
    detach() {
      detached = true
      if (ws) detachFrom(ws)
      replace({})
    },
  }
}
