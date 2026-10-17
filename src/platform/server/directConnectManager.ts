import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  StdoutMessage,
} from 'src/platform/entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from 'src/platform/remote/RemoteSessionManager.js'
import {
  openWebSocket,
  WS_OPEN,
  type WebSocketHandle,
} from 'src/providers/transport/webSocket.js'
import { logForDebugging } from 'src/shared/debug.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'
import type { RemoteMessageContent } from 'src/platform/teleport/api.js'

export type DirectConnectConfig = {
  serverUrl: string
  sessionId: string
  wsUrl: string
  authToken?: string
}

export type DirectConnectCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

export class DirectConnectSessionManager {
  private ws: WebSocketHandle | null = null
  private config: DirectConnectConfig
  private callbacks: DirectConnectCallbacks

  constructor(config: DirectConnectConfig, callbacks: DirectConnectCallbacks) {
    this.config = config
    this.callbacks = callbacks
  }

  connect(): void {
    const headers: Record<string, string> = {}
    if (this.config.authToken) {
      headers['authorization'] = `Bearer ${this.config.authToken}`
    }
    // Through the shared opener, so the socket honors HTTPS_PROXY and the
    // mTLS/CA settings and works under Node too; it used to be Bun-only.
    this.ws = openWebSocket(this.config.wsUrl, {
      headers,
      handlers: {
        onOpen: () => {
          this.callbacks.onConnected?.()
        },
        onMessage: (data, isBinary) => {
          if (!isBinary) this.handleFrame(data)
        },
        onClose: () => {
          this.callbacks.onDisconnected?.()
        },
        onError: () => {
          this.callbacks.onError?.(new Error('WebSocket connection error'))
        },
        onRefused: () => {
          this.callbacks.onError?.(new Error('WebSocket connection error'))
        },
      },
    })
  }

  private handleFrame(data: string): void {
    const lines = data.split('\n').filter((l: string) => l.trim())

    for (const line of lines) {
      let raw: unknown
      try {
        raw = jsonParse(line)
      } catch {
        continue
      }

      if (!isStdoutMessage(raw)) {
        continue
      }
      const parsed = raw

      // Handle control requests (permission requests)
      if (parsed.type === 'control_request') {
        if (parsed.request.subtype === 'can_use_tool') {
          this.callbacks.onPermissionRequest(
            parsed.request,
            parsed.request_id,
          )
        } else {
          // Send an error response for unrecognized subtypes so the
          // server doesn't hang waiting for a reply that never comes.
          logForDebugging(
            `[DirectConnect] Unsupported control request subtype: ${parsed.request.subtype}`,
          )
          this.sendErrorResponse(
            parsed.request_id,
            `Unsupported control request subtype: ${parsed.request.subtype}`,
          )
        }
        continue
      }

      // Forward SDK messages (assistant, result, system, etc.)
      if (
        parsed.type !== 'control_response' &&
        parsed.type !== 'keep_alive' &&
        parsed.type !== 'control_cancel_request' &&
        parsed.type !== 'streamlined_text' &&
        parsed.type !== 'streamlined_tool_use_summary' &&
        !(parsed.type === 'system' && parsed.subtype === 'post_turn_summary')
      ) {
        this.callbacks.onMessage(parsed as SDKMessage)
      }
    }
  }

  sendMessage(content: RemoteMessageContent): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return false
    }

    // Must match SDKUserMessage format expected by `--input-format stream-json`
    const message = jsonStringify({
      type: 'user',
      message: {
        role: 'user',
        content: content,
      },
      parent_tool_use_id: null,
      session_id: '',
    })
    void this.ws.send(message)
    return true
  }

  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return
    }

    // Must match SDKControlResponse format expected by StructuredIO
    const response = jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    })
    void this.ws.send(response)
  }

  /**
   * Send an interrupt signal to cancel the current request
   */
  sendInterrupt(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return
    }

    // Must match SDKControlRequest format expected by StructuredIO
    const request = jsonStringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: {
        subtype: 'interrupt',
      },
    })
    void this.ws.send(request)
  }

  private sendErrorResponse(requestId: string, error: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return
    }
    const response = jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error,
      },
    })
    void this.ws.send(response)
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN
  }
}
