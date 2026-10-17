import { randomUUID } from 'crypto'
import { getOauthConfig } from 'src/shared/constants/oauth.js'
import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type {
  SDKControlCancelRequest,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
} from 'src/platform/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { openWebSocket, type WebSocketHandle } from 'src/providers/transport/webSocket.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 5
const PING_INTERVAL_MS = 30000

/**
 * Maximum retries for 4001 (session not found). During compaction the
 * server may briefly consider the session stale; a short retry window
 * lets the client recover without giving up permanently.
 */
const MAX_SESSION_NOT_FOUND_RETRIES = 3

/**
 * WebSocket close codes that indicate a permanent server-side rejection.
 * The client stops reconnecting immediately.
 * Note: 4001 (session not found) is handled separately with limited
 * retries since it can be transient during compaction.
 */
const PERMANENT_CLOSE_CODES = new Set([
  4003, // unauthorized
])

type WebSocketState = 'connecting' | 'connected' | 'closed'

type SessionsMessage =
  | SDKMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKControlCancelRequest

function isSessionsMessage(value: unknown): value is SessionsMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  // Accept any message with a string `type` field. Downstream handlers
  // (sdkMessageAdapter, RemoteSessionManager) decide what to do with
  // unknown types. A hardcoded allowlist here would silently drop new
  // message types the backend starts sending before the client is updated.
  return typeof value.type === 'string'
}

export type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  /** Fired when a transient close is detected and a reconnect is scheduled.
   *  onClose fires only for permanent close (server ended / attempts exhausted). */
  onReconnecting?: () => void
}

/**
 * WebSocket client for connecting to CCR sessions via /v1/sessions/ws/{id}/subscribe
 *
 * Protocol:
 * 1. Connect to wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...
 * 2. Send auth message: { type: 'auth', credential: { type: 'oauth', token: '...' } }
 * 3. Receive SDKMessage stream from the session
 */
export class SessionsWebSocket {
  private ws: WebSocketHandle | null = null
  private state: WebSocketState = 'closed'
  private reconnectAttempts = 0
  private sessionNotFoundRetries = 0
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly sessionId: string,
    private readonly orgUuid: string,
    private readonly getAccessToken: () => string,
    private readonly callbacks: SessionsWebSocketCallbacks,
  ) {}

  /**
   * Connect to the sessions WebSocket endpoint
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting') {
      logForDebugging('[SessionsWebSocket] Already connecting')
      return
    }

    this.state = 'connecting'

    const baseUrl = getOauthConfig().BASE_API_URL.replace('https://', 'wss://')
    const url = `${baseUrl}/v1/sessions/ws/${this.sessionId}/subscribe?organization_uuid=${this.orgUuid}`

    logForDebugging(`[SessionsWebSocket] Connecting to ${url}`)

    // Get fresh token for each connection attempt
    const accessToken = this.getAccessToken()
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
    }

    this.ws = openWebSocket(url, {
      headers,
      handlers: {
        onOpen: () => {
          logForDebugging(
            '[SessionsWebSocket] Connection opened, authenticated via headers',
          )
          // Auth is handled via headers, so we're immediately connected
          this.state = 'connected'
          this.reconnectAttempts = 0
          this.sessionNotFoundRetries = 0
          this.startPingInterval()
          this.callbacks.onConnected?.()
        },
        onMessage: data => {
          this.handleMessage(data)
        },
        onError: error => {
          logError(
            new Error(`[SessionsWebSocket] WebSocket error: ${error.message}`),
          )
          this.callbacks.onError?.(
            new Error('[SessionsWebSocket] WebSocket error', { cause: error }),
          )
        },
        onClose: (code, reason) => {
          logForDebugging(
            `[SessionsWebSocket] Closed: code=${code} reason=${reason}`,
          )
          this.handleClose(code)
        },
        onPong: () => {
          logForDebugging('[SessionsWebSocket] Pong received')
        },
      },
    })
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message: unknown = jsonParse(data)

      // Forward SDK messages to callback
      if (isSessionsMessage(message)) {
        this.callbacks.onMessage(message)
      } else {
        logForDebugging(
          `[SessionsWebSocket] Ignoring message type: ${typeof message === 'object' && message !== null && 'type' in message ? String(message.type) : 'unknown'}`,
        )
      }
    } catch (error) {
      logError(
        new Error(
          `[SessionsWebSocket] Failed to parse message: ${errorMessage(error)}`,
        ),
      )
    }
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(closeCode: number): void {
    this.stopPingInterval()

    if (this.state === 'closed') {
      return
    }

    this.ws = null

    const previousState = this.state
    this.state = 'closed'

    // Permanent codes: stop reconnecting — server has definitively ended the session
    if (PERMANENT_CLOSE_CODES.has(closeCode)) {
      logForDebugging(
        `[SessionsWebSocket] Permanent close code ${closeCode}, not reconnecting`,
      )
      this.callbacks.onClose?.()
      return
    }

    // 4001 (session not found) can be transient during compaction: the
    // server may briefly consider the session stale while the CLI worker
    // is busy with the compaction API call and not emitting events.
    if (closeCode === 4001) {
      this.sessionNotFoundRetries++
      if (this.sessionNotFoundRetries > MAX_SESSION_NOT_FOUND_RETRIES) {
        logForDebugging(
          `[SessionsWebSocket] 4001 retry budget exhausted (${MAX_SESSION_NOT_FOUND_RETRIES}), not reconnecting`,
        )
        this.callbacks.onClose?.()
        return
      }
      this.scheduleReconnect(
        RECONNECT_DELAY_MS * this.sessionNotFoundRetries,
        `4001 attempt ${this.sessionNotFoundRetries}/${MAX_SESSION_NOT_FOUND_RETRIES}`,
      )
      return
    }

    // Attempt reconnection if we were connected
    if (
      previousState === 'connected' &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      this.reconnectAttempts++
      this.scheduleReconnect(
        RECONNECT_DELAY_MS,
        `attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      )
    } else {
      logForDebugging('[SessionsWebSocket] Not reconnecting')
      this.callbacks.onClose?.()
    }
  }

  private scheduleReconnect(delay: number, label: string): void {
    this.callbacks.onReconnecting?.()
    logForDebugging(
      `[SessionsWebSocket] Scheduling reconnect (${label}) in ${delay}ms`,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private startPingInterval(): void {
    this.stopPingInterval()

    this.pingInterval = setInterval(() => {
      if (this.ws && this.state === 'connected') {
        try {
          this.ws.ping()
        } catch {
          // Ignore ping errors, close handler will deal with connection issues
        }
      }
    }, PING_INTERVAL_MS)
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * Send a control response back to the session
   */
  sendControlResponse(response: SDKControlResponse): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    logForDebugging('[SessionsWebSocket] Sending control response')
    void this.ws.send(jsonStringify(response))
  }

  /**
   * Send a control request to the session (e.g., interrupt)
   */
  sendControlRequest(request: SDKControlRequestInner): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    const controlRequest: SDKControlRequest = {
      type: 'control_request',
      request_id: randomUUID(),
      request,
    }

    logForDebugging(
      `[SessionsWebSocket] Sending control request: ${request.subtype}`,
    )
    void this.ws.send(jsonStringify(controlRequest))
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected'
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    logForDebugging('[SessionsWebSocket] Closing connection')
    this.state = 'closed'
    this.stopPingInterval()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      // The handlers stay attached: the close event that follows reaches
      // handleClose with state 'closed', which returns early.
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Force reconnect - closes existing connection and establishes a new one.
   * Useful when the subscription becomes stale (e.g., after container shutdown).
   */
  reconnect(): void {
    logForDebugging('[SessionsWebSocket] Force reconnecting')
    this.reconnectAttempts = 0
    this.sessionNotFoundRetries = 0
    this.close()
    // Small delay before reconnecting (stored in reconnectTimer so it can be cancelled)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 500)
  }
}
