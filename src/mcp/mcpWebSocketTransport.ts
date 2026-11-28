import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { ClaudeError, toError } from 'src/shared/errors.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'
import {
  WS_CONNECTING,
  WS_OPEN,
  type WebSocketHandle,
} from 'src/providers/transport/webSocket.js'

/**
 * The socket never opened. `status` is the server's HTTP answer to the
 * upgrade when the runtime reports it (Node does, Bun does not), so a connect
 * retry can tell a 503 from a 400 (src/mcp/client/connectRetry.ts).
 */
export class WebSocketOpenError extends ClaudeError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * An MCP transport over a socket from the shared opener, which already hides
 * the Bun/Node split: frames arrive as text, errors as Error, and send()
 * settles once the frame is written on either runtime.
 */
export class WebSocketTransport implements Transport {
  private started = false
  private closed = false
  private refusedStatus: number | undefined
  private opened: Promise<void>
  /** Settles `opened` with the first open or error; later ones are no-ops. */
  private settleOpen: ((error?: Error) => void) | undefined

  constructor(private ws: WebSocketHandle) {
    this.opened = new Promise((resolve, reject) => {
      if (this.ws.readyState === WS_OPEN) {
        resolve()
        return
      }
      this.settleOpen = error => {
        this.settleOpen = undefined
        if (error) reject(error)
        else resolve()
      }
    })
    // A connect failure reaches onerror too; the rejection only matters to
    // start(), which may never be called.
    this.opened.catch(() => {})

    this.ws.listen({
      onOpen: () => this.settleOpen?.(),
      onMessage: this.onSocketMessage,
      onError: this.onSocketError,
      onClose: () => this.handleCloseCleanup(),
      onRefused: status => {
        this.refusedStatus = status
      },
    })
  }

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private onSocketMessage = (data: string) => {
    try {
      const messageObj = jsonParse(data)
      const message = JSONRPCMessageSchema.parse(messageObj)
      this.onmessage?.(message)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onSocketError = (error: Error) => {
    if (this.settleOpen) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_connect_fail')
      const openError = new WebSocketOpenError(error.message, this.refusedStatus)
      this.settleOpen(openError)
      this.handleError(openError)
      return
    }
    this.handleError(error)
  }

  private handleError(error: unknown): void {
    logForDiagnosticsNoPII('error', 'mcp_websocket_message_fail')
    this.onerror?.(toError(error))
  }

  // Reached from the close event and from close(), and on Bun close() makes the
  // socket emit 'close' synchronously; only the first call counts, or onclose
  // fired twice and the reconnect logic behind it ran twice.
  private handleCloseCleanup(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    // Detached, the socket can no longer report that it never opened.
    this.settleOpen?.(
      new WebSocketOpenError(
        this.refusedStatus === undefined
          ? 'WebSocket closed before it opened.'
          : `WebSocket upgrade refused with HTTP ${this.refusedStatus}`,
        this.refusedStatus,
      ),
    )
    this.ws.detach()
  }

  /**
   * Starts listening for messages on the WebSocket.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Start can only be called once per transport.')
    }
    await this.opened
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_start_not_opened')
      throw new Error('WebSocket is not open. Cannot start transport.')
    }
    this.started = true
    // Unlike stdio, WebSocket connections are typically already established when the transport is created.
    // No explicit connection action needed here, just attaching listeners.
  }

  /**
   * Closes the WebSocket connection.
   */
  async close(): Promise<void> {
    if (
      this.ws.readyState === WS_OPEN ||
      this.ws.readyState === WS_CONNECTING
    ) {
      this.ws.close()
    }
    // Ensure listeners are removed even if close was called externally or connection was already closed
    this.handleCloseCleanup()
  }

  /**
   * Sends a JSON-RPC message over the WebSocket connection.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_send_not_opened')
      throw new Error('WebSocket is not open. Cannot send message.')
    }
    const json = jsonStringify(message)

    try {
      await this.ws.send(json)
    } catch (error) {
      this.handleError(error)
      throw error
    }
  }
}
