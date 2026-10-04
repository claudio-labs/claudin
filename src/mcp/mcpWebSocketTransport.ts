import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { toError } from 'src/shared/errors.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

/** The WebSocket readyState values, shared by the runtime's socket and `ws`. */
const READY_STATE = { connecting: 0, open: 1 } as const

type WebSocketLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

type SocketEventName = 'open' | 'message' | 'error' | 'close'
type SocketListener = (event: unknown) => void

/**
 * Both socket kinds this transport is given (the runtime's own WebSocket and
 * the `ws` package's) speak the EventTarget API, where `ws` hands text frames
 * over as strings.
 */
type ListenableSocket = WebSocketLike & {
  addEventListener(type: SocketEventName, listener: SocketListener): void
  removeEventListener(type: SocketEventName, listener: SocketListener): void
}

function isListenable(socket: WebSocketLike): socket is ListenableSocket {
  return (
    typeof (socket as Partial<ListenableSocket>).addEventListener === 'function' &&
    typeof (socket as Partial<ListenableSocket>).removeEventListener === 'function'
  )
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

function socketError(event: unknown): Error {
  if (typeof event === 'object' && event !== null) {
    const detail = event as { error?: unknown; message?: unknown }
    if (detail.error !== undefined) return toError(detail.error)
    if (typeof detail.message === 'string' && detail.message) return new Error(detail.message)
  }
  return new Error('WebSocket error')
}

/** An MCP transport over an already-created WebSocket, one JSON-RPC message per text frame. */
export class WebSocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  readonly #socket: ListenableSocket
  #started = false
  #closed = false

  constructor(ws: WebSocketLike) {
    if (!isListenable(ws)) {
      throw new TypeError('WebSocketTransport needs a socket with addEventListener')
    }
    this.#socket = ws
    ws.addEventListener('message', this.#onMessage)
    ws.addEventListener('error', this.#onError)
    ws.addEventListener('close', this.#onClose)
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('Start can only be called once per transport.')
    this.#started = true
    const state = this.#socket.readyState
    if (state === READY_STATE.open) return
    if (state !== READY_STATE.connecting) throw new Error('WebSocket is closed. Cannot start.')
    await this.#opened()
  }

  async close(): Promise<void> {
    this.#socket.close()
    this.#finish()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#socket.readyState !== READY_STATE.open) {
      throw new Error('WebSocket is not open. Cannot send message.')
    }
    this.#socket.send(jsonStringify(message))
  }

  #opened(): Promise<void> {
    const socket = this.#socket
    return new Promise((resolve, reject) => {
      const settle = (outcome: () => void) => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onFailure)
        socket.removeEventListener('close', onFailure)
        outcome()
      }
      const onOpen = () => settle(resolve)
      const onFailure = (event: unknown) => settle(() => reject(socketError(event)))
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onFailure)
      socket.addEventListener('close', onFailure)
    })
  }

  readonly #onMessage = (event: unknown) => {
    const data = typeof event === 'object' && event !== null ? (event as { data?: unknown }).data : event
    let message: JSONRPCMessage
    try {
      message = JSONRPCMessageSchema.parse(jsonParse(frameText(data)))
    } catch (error) {
      this.onerror?.(toError(error))
      return
    }
    this.onmessage?.(message)
  }

  readonly #onError = (event: unknown) => {
    this.onerror?.(socketError(event))
  }

  readonly #onClose = () => {
    this.#finish()
  }

  /**
   * Runs once, whether the socket closed first or `close()` was called. The
   * listeners stay: `ws` throws an 'error' event that finds no listener.
   */
  #finish(): void {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.()
  }
}
