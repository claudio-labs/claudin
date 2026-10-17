import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import { CircularBuffer } from 'src/shared/data/CircularBuffer.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import {
  openWebSocket,
  type WebSocketHandle,
  type WebSocketHandlers,
} from 'src/providers/transport/webSocket.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from 'src/sessions/sessionActivity.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { Transport } from './Transport.js'

const KEEP_ALIVE_FRAME = '{"type":"keep_alive"}\n'

const DEFAULT_MAX_BUFFER_SIZE = 1000
const DEFAULT_BASE_RECONNECT_DELAY = 1000
const DEFAULT_MAX_RECONNECT_DELAY = 30000
/** Time budget for reconnection attempts before giving up (10 minutes). */
const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000
const DEFAULT_PING_INTERVAL = 10000
const DEFAULT_KEEPALIVE_INTERVAL = 300_000 // 5 minutes

/**
 * Threshold for detecting system sleep/wake. If the gap between consecutive
 * reconnection attempts exceeds this, the machine likely slept. We reset
 * the reconnection budget and retry — the server will reject with permanent
 * close codes (4001/1002) if the session was reaped during sleep.
 */
const SLEEP_DETECTION_THRESHOLD_MS = DEFAULT_MAX_RECONNECT_DELAY * 2 // 60s

/**
 * WebSocket close codes that indicate a permanent server-side rejection.
 * The transport transitions to 'closed' immediately without retrying.
 */
const PERMANENT_CLOSE_CODES = new Set([
  1002, // protocol error — server rejected handshake (e.g. session reaped)
  4001, // session expired / not found
  4003, // unauthorized
])

export type WebSocketTransportOptions = {
  /** When false, the transport does not attempt automatic reconnection on
   *  disconnect. Use this when the caller has its own recovery mechanism
   *  (e.g. the REPL bridge poll loop). Defaults to true. */
  autoReconnect?: boolean
}

type WebSocketTransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

export class WebSocketTransport implements Transport {
  private ws: WebSocketHandle | null = null
  private lastSentId: string | null = null
  protected url: URL
  protected state: WebSocketTransportState = 'idle'
  protected onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onConnectCallback?: () => void
  private headers: Record<string, string>
  private sessionId?: string
  private autoReconnect: boolean

  // Reconnection state
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastReconnectAttemptTime: number | null = null
  // Wall-clock of last WS data-frame activity (inbound message or outbound
  // ws.send). Used to compute idle time at close — the signal for diagnosing
  // proxy idle-timeout RSTs (e.g. Cloudflare 5-min). Excludes ping/pong
  // control frames (proxies don't count those).
  private lastActivityTime = 0

  // Ping interval for connection health checks
  private pingInterval: NodeJS.Timeout | null = null
  private pongReceived = true

  // Periodic keep_alive data frames to reset proxy idle timers
  private keepAliveInterval: NodeJS.Timeout | null = null

  // Message buffering for replay on reconnection
  private messageBuffer: CircularBuffer<StdoutMessage>
  // The server's last received id, from the 101 response. Only Node's ws
  // reports the upgrade response; on Bun this stays null.
  private upgradeLastId: string | null = null

  // Captured at connect() time for handleOpenEvent timing. Stored as an
  // instance field so the onOpen handler can be a stable class-property
  // arrow function (removable in doDisconnect) instead of a closure over
  // a local variable.
  private connectStartTime = 0

  private refreshHeaders?: () => Record<string, string>

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions,
  ) {
    this.url = url
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.autoReconnect = options?.autoReconnect ?? true
    this.messageBuffer = new CircularBuffer(DEFAULT_MAX_BUFFER_SIZE)
  }

  public async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `WebSocketTransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_failed')
      return
    }
    this.state = 'reconnecting'

    this.connectStartTime = Date.now()
    logForDebugging(`WebSocketTransport: Opening ${this.url.href}`)
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_opening')

    // Start with provided headers and add runtime headers
    const headers = { ...this.headers }
    if (this.lastSentId) {
      headers['X-Last-Request-Id'] = this.lastSentId
      logForDebugging(
        `WebSocketTransport: Adding X-Last-Request-Id header: ${this.lastSentId}`,
      )
    }

    this.upgradeLastId = null
    this.ws = openWebSocket(this.url.href, {
      headers,
      handlers: this.wsHandlers,
    })
  }

  // One handler set for every connection, so doDisconnect() can drop it
  // with handle.detach(): without that, each reconnect orphans the old
  // socket + its closures until GC, which accumulates under network
  // instability.
  private readonly wsHandlers: WebSocketHandlers = {
    // Only Node reports the 101 response; Bun never calls this.
    onUpgrade: headers => {
      const lastId = headers['x-last-request-id']
      this.upgradeLastId = lastId ? lastId : null
    },
    onOpen: () => {
      this.handleOpenEvent()
      // Replay from the server's last id when the upgrade carried one;
      // without it (always, on Bun), replay everything — the server
      // deduplicates by uuid.
      if (this.upgradeLastId || this.lastSentId) {
        this.replayBufferedMessages(this.upgradeLastId ?? '')
      }
    },
    onMessage: message => {
      this.lastActivityTime = Date.now()
      logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
        length: message.length,
      })
      if (this.onData) {
        this.onData(message)
      }
    },
    onError: error => {
      logForDebugging(`WebSocketTransport: Error: ${error.message}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
      // close event fires after error — let it call handleConnectionError
    },
    // Node only: the opener reports a refused upgrade here instead of as an
    // error; the close (1006) that follows drives the reconnect.
    onRefused: status => {
      logForDebugging(
        `WebSocketTransport: Error: Unexpected server response: ${status}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    },
    onClose: code => {
      const isClean = code === 1000 || code === 1001
      logForDebugging(
        `WebSocketTransport: Closed: ${code}`,
        isClean ? undefined : { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
      this.handleConnectionError(code)
    },
    onPong: () => {
      this.pongReceived = true
    },
  }

  private handleOpenEvent(): void {
    const connectDuration = Date.now() - this.connectStartTime
    logForDebugging('WebSocketTransport: Connected')
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_connected', {
      duration_ms: connectDuration,
    })


    this.reconnectAttempts = 0
    this.reconnectStartTime = null
    this.lastReconnectAttemptTime = null
    this.lastActivityTime = Date.now()
    this.state = 'connected'
    this.onConnectCallback?.()

    // Start periodic pings to detect dead connections
    this.startPingInterval()

    // Start periodic keep_alive data frames to reset proxy idle timers
    this.startKeepaliveInterval()

    // Register callback for session activity signals
    registerSessionActivityCallback(() => {
      void this.write({ type: 'keep_alive' })
    })
  }

  protected sendLine(line: string): boolean {
    if (!this.ws || this.state !== 'connected') {
      logForDebugging('WebSocketTransport: Not connected')
      logForDiagnosticsNoPII('info', 'cli_websocket_send_not_connected')
      return false
    }

    try {
      void this.ws.send(line)
      this.lastActivityTime = Date.now()
      return true
    } catch (error) {
      logForDebugging(`WebSocketTransport: Failed to send: ${error}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_send_error')
      // Don't null this.ws here — let doDisconnect() (via handleConnectionError)
      // handle cleanup so listeners are removed before the WS is released.
      this.handleConnectionError()
      return false
    }
  }

  protected doDisconnect(): void {
    // Stop pinging and keepalive when disconnecting
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // Unregister session activity callback
    unregisterSessionActivityCallback()

    if (this.ws) {
      // Remove listeners BEFORE close() so the old WS + closures can be
      // GC'd promptly instead of lingering until the next mark-and-sweep.
      this.ws.detach()
      this.ws.close()
      this.ws = null
    }
  }

  private handleConnectionError(closeCode?: number): void {
    logForDebugging(
      `WebSocketTransport: Disconnected from ${this.url.href}` +
        (closeCode != null ? ` (code ${closeCode})` : ''),
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_disconnected')
    this.doDisconnect()

    if (this.state === 'closing' || this.state === 'closed') return

    // Permanent codes: don't retry — server has definitively ended the session.
    // Exception: 4003 (unauthorized) can be retried when refreshHeaders is
    // available and returns a new token (e.g. after the parent process mints
    // a fresh session ingress token during reconnection).
    let headersRefreshed = false
    if (closeCode === 4003 && this.refreshHeaders) {
      const freshHeaders = this.refreshHeaders()
      if (freshHeaders.Authorization !== this.headers.Authorization) {
        Object.assign(this.headers, freshHeaders)
        headersRefreshed = true
        logForDebugging(
          'WebSocketTransport: 4003 received but headers refreshed, scheduling reconnect',
        )
        logForDiagnosticsNoPII('info', 'cli_websocket_4003_token_refreshed')
      }
    }

    if (
      closeCode != null &&
      PERMANENT_CLOSE_CODES.has(closeCode) &&
      !headersRefreshed
    ) {
      logForDebugging(
        `WebSocketTransport: Permanent close code ${closeCode}, not reconnecting`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_permanent_close', {
        closeCode,
      })
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // When autoReconnect is disabled, go straight to closed state.
    // The caller (e.g. REPL bridge poll loop) handles recovery.
    if (!this.autoReconnect) {
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // Schedule reconnection with exponential backoff and time budget
    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    // Detect system sleep/wake: if the gap since our last reconnection
    // attempt greatly exceeds the max delay, the machine likely slept
    // (e.g. laptop lid closed). Reset the budget and retry from scratch —
    // the server will reject with permanent close codes (4001/1002) if
    // the session was reaped while we were asleep.
    if (
      this.lastReconnectAttemptTime !== null &&
      now - this.lastReconnectAttemptTime > SLEEP_DETECTION_THRESHOLD_MS
    ) {
      logForDebugging(
        `WebSocketTransport: Detected system sleep (${Math.round((now - this.lastReconnectAttemptTime) / 1000)}s gap), resetting reconnection budget`,
      )
      logForDiagnosticsNoPII('info', 'cli_websocket_sleep_detected', {
        gapMs: now - this.lastReconnectAttemptTime,
      })
      this.reconnectStartTime = now
      this.reconnectAttempts = 0
    }
    this.lastReconnectAttemptTime = now

    const elapsed = now - this.reconnectStartTime
    if (elapsed < DEFAULT_RECONNECT_GIVE_UP_MS) {
      // Clear any existing reconnection timer to avoid duplicates
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // Refresh headers before reconnecting (e.g. to pick up a new session token).
      // Skip if already refreshed by the 4003 path above.
      if (!headersRefreshed && this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('WebSocketTransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        DEFAULT_BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
        DEFAULT_MAX_RECONNECT_DELAY,
      )
      // Add ±25% jitter to avoid thundering herd
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `WebSocketTransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `WebSocketTransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s for ${this.url.href}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'

      // Notify close callback
      if (this.onCloseCallback) {
        this.onCloseCallback(closeCode)
      }
    }
  }

  close(): void {
    // Clear any pending reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Clear ping and keepalive intervals
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // Unregister session activity callback
    unregisterSessionActivityCallback()

    this.state = 'closing'
    this.doDisconnect()
  }

  private replayBufferedMessages(lastId: string): void {
    const messages = this.messageBuffer.toArray()
    if (messages.length === 0) return

    // Find where to start replay based on server's last received message
    let startIndex = 0
    if (lastId) {
      const lastConfirmedIndex = messages.findIndex(
        message => 'uuid' in message && message.uuid === lastId,
      )
      if (lastConfirmedIndex >= 0) {
        // Server confirmed messages up to lastConfirmedIndex — evict them
        startIndex = lastConfirmedIndex + 1
        // Rebuild the buffer with only unconfirmed messages
        const remaining = messages.slice(startIndex)
        this.messageBuffer.clear()
        this.messageBuffer.addAll(remaining)
        if (remaining.length === 0) {
          this.lastSentId = null
        }
        logForDebugging(
          `WebSocketTransport: Evicted ${startIndex} confirmed messages, ${remaining.length} remaining`,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_websocket_evicted_confirmed_messages',
          {
            evicted: startIndex,
            remaining: remaining.length,
          },
        )
      }
    }

    const messagesToReplay = messages.slice(startIndex)
    if (messagesToReplay.length === 0) {
      logForDebugging('WebSocketTransport: No new messages to replay')
      logForDiagnosticsNoPII('info', 'cli_websocket_no_messages_to_replay')
      return
    }

    logForDebugging(
      `WebSocketTransport: Replaying ${messagesToReplay.length} buffered messages`,
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_messages_to_replay', {
      count: messagesToReplay.length,
    })

    for (const message of messagesToReplay) {
      const line = jsonStringify(message) + '\n'
      const success = this.sendLine(line)
      if (!success) {
        this.handleConnectionError()
        break
      }
    }
    // Do NOT clear the buffer after replay — messages remain buffered until
    // the server confirms receipt on the next reconnection. This prevents
    // message loss if the connection drops after replay but before the server
    // processes the messages.
  }

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  getStateLabel(): string {
    return this.state
  }

  async write(message: StdoutMessage): Promise<void> {
    if ('uuid' in message && typeof message.uuid === 'string') {
      this.messageBuffer.add(message)
      this.lastSentId = message.uuid
    }

    const line = jsonStringify(message) + '\n'

    if (this.state !== 'connected') {
      // Message buffered for replay when connected (if it has a UUID)
      return
    }

    const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
    const detailLabel = this.getControlMessageDetailLabel(message)

    logForDebugging(
      `WebSocketTransport: Sending message type=${message.type}${sessionLabel}${detailLabel}`,
    )

    this.sendLine(line)
  }

  private getControlMessageDetailLabel(message: StdoutMessage): string {
    if (message.type === 'control_request') {
      const { request_id, request } = message
      const toolName =
        request.subtype === 'can_use_tool' ? request.tool_name : ''
      return ` subtype=${request.subtype} request_id=${request_id}${toolName ? ` tool=${toolName}` : ''}`
    }
    if (message.type === 'control_response') {
      const { subtype, request_id } = message.response
      return ` subtype=${subtype} request_id=${request_id}`
    }
    return ''
  }

  private startPingInterval(): void {
    // Clear any existing interval
    this.stopPingInterval()

    this.pongReceived = true
    let lastTickTime = Date.now()

    // Send ping periodically to detect dead connections.
    // If the previous ping got no pong, treat the connection as dead.
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        const now = Date.now()
        const gap = now - lastTickTime
        lastTickTime = now

        // Process-suspension detector. If the wall-clock gap between ticks
        // greatly exceeds the 10s interval, the process was suspended
        // (laptop lid, SIGSTOP, VM pause). setInterval does not queue
        // missed ticks — it coalesces — so on wake this callback fires
        // once with a huge gap. The socket is almost certainly dead:
        // NAT mappings drop in 30s–5min, and the server has been
        // retransmitting into the void. Don't wait for a ping/pong
        // round-trip to confirm (ws.ping() on a dead socket returns
        // immediately with no error — bytes go into the kernel send
        // buffer). Assume dead and reconnect now. A spurious reconnect
        // after a short sleep is cheap — replayBufferedMessages() handles
        // it and the server dedups by UUID.
        if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
          logForDebugging(
            `WebSocketTransport: ${Math.round(gap / 1000)}s tick gap detected — process was suspended, forcing reconnect`,
          )
          logForDiagnosticsNoPII(
            'info',
            'cli_websocket_sleep_detected_on_ping',
            { gapMs: gap },
          )
          this.handleConnectionError()
          return
        }

        if (!this.pongReceived) {
          logForDebugging(
            'WebSocketTransport: No pong received, connection appears dead',
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_pong_timeout')
          this.handleConnectionError()
          return
        }

        this.pongReceived = false
        try {
          this.ws.ping()
        } catch (error) {
          logForDebugging(`WebSocketTransport: Ping failed: ${error}`, {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_ping_failed')
        }
      }
    }, DEFAULT_PING_INTERVAL)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private startKeepaliveInterval(): void {
    this.stopKeepaliveInterval()

    // In CCR sessions, session activity heartbeats handle keep-alives
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      return
    }

    this.keepAliveInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        try {
          void this.ws.send(KEEP_ALIVE_FRAME)
          this.lastActivityTime = Date.now()
          logForDebugging(
            'WebSocketTransport: Sent periodic keep_alive data frame',
          )
        } catch (error) {
          logForDebugging(
            `WebSocketTransport: Periodic keep_alive failed: ${error}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_keepalive_failed')
        }
      }
    }, DEFAULT_KEEPALIVE_INTERVAL)
  }

  private stopKeepaliveInterval(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }
}
