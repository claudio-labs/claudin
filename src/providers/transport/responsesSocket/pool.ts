/**
 * Open Responses sockets, picked per request by what the request continues.
 *
 * A socket serves one response at a time and remembers only its last one, so
 * the pool hands a request the idle socket whose chain it extends (a delta),
 * else an idle socket with no chain, else a new socket up to the cap, so that
 * one thread's request never takes another thread's chain while there is
 * room; at the cap, the least recently used idle socket (a full frame). With
 * every socket busy at the cap the request goes over HTTP. Concurrency needs
 * no thread key this way: each sub-agent ends up on the socket of its own
 * chain. A fork that replays an idle owner's history can take its socket; the
 * owner then pays one full frame, never tokens — the prompt cache is shared
 * across connections.
 */
import { type FramePlan, planResponseFrame, type ResponsesChain } from 'src/providers/transport/responsesSocket/frame.js'
import { openWebSocket, WS_OPEN, type WebSocketHandle } from 'src/providers/transport/webSocket.js'

export type ServerEvent = { type: string; text: string; data: Record<string, unknown> }

export type SocketSink = {
  event(event: ServerEvent): void
  closed(code: number, reason: string): void
}

/** The upgrade did not lead to an open socket. `status` is known on Node only. */
export class SocketUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SocketUnavailableError'
  }
}

export type PoolLimits = { maxSockets: number; idleMs: number; maxAgeMs: number }

export type PoolDeps = {
  open?: typeof openWebSocket
  now?: () => number
}

export class PooledSocket {
  readonly openedAt: number
  lastUsed: number
  busy = false
  closed = false
  chain: ResponsesChain | undefined
  upgradeHeaders: Record<string, string> = {}
  sink: SocketSink | undefined
  readonly ready: Promise<void>
  private readonly handle: WebSocketHandle
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly key: string,
    url: string,
    headers: Record<string, string>,
    open: typeof openWebSocket,
    now: () => number,
    private readonly onGone: (socket: PooledSocket) => void,
  ) {
    this.openedAt = now()
    this.lastUsed = this.openedAt
    let settle: { resolve(): void; reject(error: Error): void } | undefined
    this.ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // A rejection nobody awaits yet must not surface as unhandled.
    this.ready.catch(() => {})
    let opened = false
    let refusal: SocketUnavailableError | undefined
    this.handle = open(url, {
      headers,
      perMessageDeflate: true,
      handlers: {
        onUpgrade: upgradeHeaders => {
          this.upgradeHeaders = upgradeHeaders
        },
        onOpen: () => {
          opened = true
          settle?.resolve()
        },
        onRefused: (status, body) => {
          refusal = new SocketUnavailableError(`WebSocket upgrade refused (${status}): ${body.slice(0, 200)}`, status)
        },
        onError: error => {
          if (!opened) refusal ??= new SocketUnavailableError(`WebSocket upgrade failed: ${error.message}`)
        },
        onMessage: text => {
          let data: unknown
          try {
            data = JSON.parse(text)
          } catch {
            return
          }
          if (!data || typeof data !== 'object') return
          const type = (data as { type?: unknown }).type
          if (typeof type !== 'string') return
          this.sink?.event({ type, text, data: data as Record<string, unknown> })
        },
        onClose: (code, reason) => {
          this.closed = true
          this.clearIdle()
          if (!opened) settle?.reject(refusal ?? new SocketUnavailableError(`WebSocket closed before opening (${code})`))
          const sink = this.sink
          this.sink = undefined
          sink?.closed(code, reason)
          this.onGone(this)
        },
      },
    })
  }

  get isOpen(): boolean {
    return !this.closed && this.handle.readyState === WS_OPEN
  }

  send(text: string): Promise<void> {
    return this.handle.send(text)
  }

  close(code = 1000): void {
    this.clearIdle()
    if (!this.closed) this.handle.close(code)
  }

  armIdle(idleMs: number, onIdle: () => void): void {
    this.clearIdle()
    this.idleTimer = setTimeout(onIdle, idleMs)
    this.idleTimer.unref?.()
  }

  clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

export type Acquired = { socket: PooledSocket; plan: FramePlan }

export class ResponsesSocketPool {
  private readonly sockets = new Set<PooledSocket>()
  private readonly open: typeof openWebSocket
  private readonly now: () => number

  constructor(private readonly limits: PoolLimits, deps: PoolDeps = {}) {
    this.open = deps.open ?? openWebSocket
    this.now = deps.now ?? Date.now
  }

  get size(): number {
    return this.sockets.size
  }

  /** A socket for this request and the frame to send on it, or undefined when every socket is busy at the cap. */
  acquire(key: string, url: string, headers: Record<string, string>, body: Record<string, unknown>): Acquired | undefined {
    const now = this.now()
    const idle: PooledSocket[] = []
    for (const socket of this.sockets) {
      if (socket.closed) continue
      if (now - socket.openedAt >= this.limits.maxAgeMs && !socket.busy) {
        this.discard(socket)
        continue
      }
      if (socket.key === key && !socket.busy) idle.push(socket)
    }
    for (const socket of idle) {
      if (!socket.chain) continue
      const plan = planResponseFrame(socket.chain, body)
      if (plan.incremental) return this.take(socket, plan)
    }
    const unchained = idle.find(socket => !socket.chain)
    if (unchained) return this.take(unchained, planResponseFrame(undefined, body))
    if (this.sockets.size < this.limits.maxSockets) {
      const socket = new PooledSocket(key, url, headers, this.open, this.now, gone => this.sockets.delete(gone))
      this.sockets.add(socket)
      return this.take(socket, planResponseFrame(undefined, body))
    }
    const lru = idle.sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (lru) {
      lru.chain = undefined
      return this.take(lru, planResponseFrame(undefined, body))
    }
    return undefined
  }

  /** Give a socket back after a response; it closes itself after the idle limit. */
  release(socket: PooledSocket): void {
    socket.busy = false
    socket.sink = undefined
    socket.lastUsed = this.now()
    if (socket.closed) {
      this.sockets.delete(socket)
      return
    }
    socket.armIdle(this.limits.idleMs, () => {
      if (!socket.busy) this.discard(socket)
    })
  }

  /** Close a socket and forget it: an abort mid-response, a refusal, the age limit. */
  discard(socket: PooledSocket): void {
    socket.sink = undefined
    this.sockets.delete(socket)
    socket.close()
  }

  closeAll(): void {
    for (const socket of [...this.sockets]) this.discard(socket)
  }

  private take(socket: PooledSocket, plan: FramePlan): Acquired {
    socket.clearIdle()
    socket.busy = true
    socket.lastUsed = this.now()
    return { socket, plan }
  }
}
