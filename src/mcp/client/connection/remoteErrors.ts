import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { logMCPDebug } from 'src/shared/log.js'
import { errorMessage } from 'src/shared/errors.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { isMcpSessionExpiredError } from 'src/mcp/client/errors.js'

/** The transports whose errors can mean the server is gone for good. */
export type RemoteTransportType = 'sse' | 'http' | 'claudeai-proxy'

export function remoteTransportType(config: ScopedMcpServerConfig): RemoteTransportType | undefined {
  switch (config.type) {
    case 'sse':
    case 'http':
    case 'claudeai-proxy':
      return config.type
    default:
      return undefined
  }
}

/** Network failures that, repeated, mean the connection will not come back by itself. */
const TERMINAL_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ECONNREFUSED|Body Timeout Error|terminated|SSE stream disconnected/
const RECONNECTION_EXHAUSTED_PATTERN = /Maximum reconnection attempts/
export const MAX_CONSECUTIVE_TERMINAL_ERRORS = 3

export type RemoteErrorVerdict = 'close' | 'count' | 'ignore'

/** What one error means for a connection; `count` is a terminal network error. */
export function judgeRemoteError(error: Error, type: RemoteTransportType): RemoteErrorVerdict {
  if (type !== 'sse' && isMcpSessionExpiredError(error)) return 'close'
  const message = errorMessage(error)
  if (RECONNECTION_EXHAUSTED_PATTERN.test(message)) return 'close'
  if (TERMINAL_ERROR_PATTERN.test(message)) return 'count'
  return 'ignore'
}

/**
 * Closes the client when its errors say the server is gone: an expired HTTP
 * session, the SDK giving up reconnecting, or three network errors in a row.
 * Closing fires the client's onclose, which forgets the connection, so the
 * next lookup connects again.
 */
export function closeOnTerminalErrors(client: Client, name: string, type: RemoteTransportType): void {
  let consecutive = 0
  client.onerror = error => {
    const verdict = judgeRemoteError(error, type)
    consecutive = verdict === 'count' ? consecutive + 1 : 0
    if (verdict === 'ignore') return
    if (verdict === 'count' && consecutive < MAX_CONSECUTIVE_TERMINAL_ERRORS) return
    logMCPDebug(name, `Closing the connection after: ${errorMessage(error)}`)
    client.close().catch((closeError: unknown) => {
      logMCPDebug(name, `Closing after a terminal error failed: ${errorMessage(closeError)}`)
    })
  }
}
