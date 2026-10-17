/**
 * The Responses API over WebSocket, behind a call that always returns a
 * fetch-shaped `Response` whose body is the same SSE a POST would stream, so
 * every reader of that body works unchanged.
 *
 * Protocol facts (OpenAI's WebSocket mode, Codex CLI 0.163 on the wire):
 * - upgrade with `OpenAI-Beta: responses_websockets=2026-02-06`; a client
 *   frame is the POST body plus `type: "response.create"`;
 * - server frames are the streaming events, one JSON object each, ending in
 *   response.completed / response.incomplete / response.failed / error;
 * - a connection lives at most 60 minutes (`websocket_connection_limit_reached`)
 *   and a message at most ~16 MiB (close 1009);
 * - with `store: false` only the last response is kept, per connection; an id
 *   it no longer has fails with `previous_response_not_found`.
 *
 * The caller passes its POST as `http`. It runs whenever the socket cannot
 * serve: the latch is on, every socket is busy at the cap, the frame is too
 * large, or the upgrade failed. The latch is sticky for the process, like
 * Codex CLI's `force_http_fallback`, and turns on when an upgrade failed but
 * the POST of the same request answered 2xx (the backend works, WebSocket does
 * not), or when two responses in a row lost their socket mid-stream. A 401,
 * 429 or 5xx from the POST leaves it off: that was not about the transport.
 */
import { createHash } from 'node:crypto'
import { onSessionSwitch } from 'src/platform/bootstrap/state.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDebugging } from 'src/shared/debug.js'
import { stableStringify } from 'src/shared/data/stableStringify.js'
import { nextChain, type FramePlan } from 'src/providers/transport/responsesSocket/frame.js'
import {
  type PoolDeps,
  type PooledSocket,
  ResponsesSocketPool,
  type ServerEvent,
  SocketUnavailableError,
} from 'src/providers/transport/responsesSocket/pool.js'

export const RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06'

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])
const RETRY_FULL_CODES = new Set(['previous_response_not_found'])
const RETRY_NEW_SOCKET_CODES = new Set(['websocket_connection_limit_reached'])
const DROPS_BEFORE_LATCH = 2

export type ResponsesSocketLimits = {
  maxSockets: number
  idleMs: number
  maxAgeMs: number
  maxFrameBytes: number
}

export const DEFAULT_RESPONSES_SOCKET_LIMITS: ResponsesSocketLimits = {
  maxSockets: 8,
  idleMs: 5 * 60_000,
  maxAgeMs: 55 * 60_000,
  maxFrameBytes: 15 * 1024 * 1024,
}

export type ResponsesSocketRequest = {
  /** The https URL the POST goes to; the Response reports it as its `url`. */
  url: string
  socketUrl: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
  http: () => Promise<Response>
}

export type ResponsesSocketTransport = {
  request(request: ResponsesSocketRequest): Promise<Response>
  closeAll(): void
  readonly latched: boolean
}

export type TransportDeps = PoolDeps & {
  label?: string
  lifecycle?: {
    onSessionSwitch(listener: () => void): unknown
    registerCleanup(cleanup: () => Promise<void>): unknown
  }
}

type FirstEvent = { kind: 'event'; event: ServerEvent } | { kind: 'closed'; code: number }

function errorCode(data: Record<string, unknown>): string | undefined {
  const nested = data.error && typeof data.error === 'object' ? (data.error as { code?: unknown }).code : undefined
  const code = nested ?? data.code
  return typeof code === 'string' ? code : undefined
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

const encoder = new TextEncoder()
function sseChunk(event: ServerEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${event.text.replaceAll('\n', '\ndata: ')}\n\n`)
}

export function createResponsesSocketTransport(
  limits: Partial<ResponsesSocketLimits> = {},
  deps: TransportDeps = {},
): ResponsesSocketTransport {
  const max = { ...DEFAULT_RESPONSES_SOCKET_LIMITS, ...limits }
  const pool = new ResponsesSocketPool(max, deps)
  const label = deps.label ?? 'responses-ws'
  const lifecycle = deps.lifecycle ?? { onSessionSwitch, registerCleanup }
  let latched = false
  let drops = 0
  let hooked = false

  const latch = (why: string): void => {
    if (latched) return
    latched = true
    pool.closeAll()
    logForDebugging(`[${label}] WebSocket off for this process (${why}); requests go over HTTP`, { level: 'warn' })
  }

  const hookLifecycle = (): void => {
    if (hooked) return
    hooked = true
    lifecycle.onSessionSwitch(() => pool.closeAll())
    lifecycle.registerCleanup(async () => pool.closeAll())
  }

  const viaHttp = async (request: ResponsesSocketRequest, upgradeFailed: boolean): Promise<Response> => {
    const response = await request.http()
    if (upgradeFailed && response.ok) latch('the upgrade failed and HTTP answered')
    return response
  }

  /** Waits for the frame's first server event, or the socket closing first. */
  const sendAndAwaitFirst = (socket: PooledSocket, text: string, signal?: AbortSignal): Promise<FirstEvent> =>
    new Promise<FirstEvent>((resolve, reject) => {
      const onAbort = (): void => {
        socket.sink = undefined
        pool.discard(socket)
        reject(abortError(signal!))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.sink = {
        event: event => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ kind: 'event', event })
        },
        closed: code => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ kind: 'closed', code })
        },
      }
      socket.send(text).catch(() => {})
    })

  const stream = (socket: PooledSocket, plan: FramePlan, first: ServerEvent, request: ResponsesSocketRequest): Response => {
    let finished = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = (): void => {
          if (finished) return
          finished = true
          pool.discard(socket)
          controller.error(abortError(request.signal!))
        }
        const finish = (event: ServerEvent): void => {
          finished = true
          request.signal?.removeEventListener('abort', onAbort)
          if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            socket.chain = nextChain(plan, event.data.response as Record<string, unknown> | undefined)
            drops = 0
          } else {
            socket.chain = undefined
          }
          controller.close()
          pool.release(socket)
        }
        const push = (event: ServerEvent): void => {
          if (finished) return
          controller.enqueue(sseChunk(event))
          if (TERMINAL_EVENTS.has(event.type)) finish(event)
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        socket.sink = {
          event: push,
          closed: (code, reason) => {
            if (finished) return
            finished = true
            request.signal?.removeEventListener('abort', onAbort)
            drops += 1
            if (drops >= DROPS_BEFORE_LATCH) latch(`${drops} responses in a row lost their socket`)
            controller.error(new Error(`WebSocket closed before the response completed (${code}${reason ? `: ${reason}` : ''})`))
          },
        }
        push(first)
      },
      cancel() {
        if (finished) return
        finished = true
        pool.discard(socket)
      },
    })
    const response = new Response(body, {
      status: 200,
      headers: { ...socket.upgradeHeaders, 'content-type': 'text/event-stream' },
    })
    Object.defineProperty(response, 'url', { value: request.url })
    return response
  }

  const request = async (request: ResponsesSocketRequest): Promise<Response> => {
    if (latched) return request.http()
    hookLifecycle()
    const auth = request.headers.Authorization ?? request.headers.authorization ?? ''
    const key = `${request.socketUrl}\n${createHash('sha256').update(auth).digest('hex').slice(0, 16)}`
    let retried = false
    for (;;) {
      const acquired = pool.acquire(key, request.socketUrl, request.headers, request.body)
      if (!acquired) {
        logForDebugging(`[${label}] all ${max.maxSockets} sockets busy; this request goes over HTTP`)
        return request.http()
      }
      const { socket, plan } = acquired
      const text = stableStringify(plan.frame)
      if (Buffer.byteLength(text) > max.maxFrameBytes) {
        pool.release(socket)
        logForDebugging(`[${label}] frame of ${Buffer.byteLength(text)} bytes is over the limit; this request goes over HTTP`)
        return request.http()
      }
      try {
        await socket.ready
      } catch (error) {
        pool.discard(socket)
        if (!(error instanceof SocketUnavailableError)) throw error
        logForDebugging(`[${label}] ${error.message}; this request goes over HTTP`, { level: 'warn' })
        return viaHttp(request, true)
      }
      logForDebugging(
        plan.incremental
          ? `[${label}] frame incremental (${(plan.frame.input as unknown[]).length} items)`
          : `[${label}] frame full (${plan.reason}, ${plan.inputKeys.length} items)`,
      )
      const first = await sendAndAwaitFirst(socket, text, request.signal)
      if (first.kind === 'closed') {
        if (!retried) {
          retried = true
          continue
        }
        throw new Error(`WebSocket closed before the response started (${first.code})`)
      }
      if (first.event.type === 'error' && !retried) {
        const code = errorCode(first.event.data)
        if (code && RETRY_FULL_CODES.has(code)) {
          retried = true
          socket.chain = undefined
          pool.release(socket)
          continue
        }
        if (code && RETRY_NEW_SOCKET_CODES.has(code)) {
          retried = true
          pool.discard(socket)
          continue
        }
      }
      return stream(socket, plan, first.event, request)
    }
  }

  return {
    request,
    closeAll: () => pool.closeAll(),
    get latched() {
      return latched
    },
  }
}
