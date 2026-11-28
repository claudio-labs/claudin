/**
 * Whether a failed connect to a remote MCP server gets another try, and when.
 *
 * A blip at startup (a 503 while the server comes up, a reset connection) left
 * the server failed for the session until a manual reconnect. Like opencode
 * (packages/core/src/mcp/client.ts), a transient failure is retried twice,
 * 250 ms and then 1 s later, and only while the server's startup deadline
 * still has room for the wait. A local server is never retried: its process
 * failing to start is not something waiting fixes.
 */
import { SseError } from '@modelcontextprotocol/client'
import { httpStatusOf } from 'src/mcp/client/errors.js'
import { WebSocketOpenError } from 'src/mcp/mcpWebSocketTransport.js'

const RETRY_DELAYS_MS = [250, 1000] as const

const RETRIED_TYPES = new Set(['http', 'sse', 'ws'])

// Network failures, as Node (undici, on the error or its cause) and Bun name them.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused',
  'ConnectionClosed',
])

function codeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined
}

export function isTransientConnectError(error: unknown): boolean {
  // A socket that never opened: a refused upgrade carries its HTTP status on
  // Node; on Bun, and for a refused port, nothing tells it from a server still
  // coming up, so it counts as one.
  if (error instanceof WebSocketOpenError) {
    return error.status === undefined || isTransientStatus(error.status)
  }
  // The SDK's SseError carries the HTTP status as `code`, and none when the
  // event stream could not be reached at all.
  if (error instanceof SseError && error.code === undefined) return true
  // The SDK's SdkHttpError and SseError carry the HTTP status.
  const status = httpStatusOf(error)
  if (status !== undefined) return isTransientStatus(status)
  const code = codeOf(error)
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
  return [code, codeOf(cause)].some(c => typeof c === 'string' && TRANSIENT_NETWORK_CODES.has(c))
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501)
}

/** The wait before the next attempt, or null when this failure is final. */
export function nextConnectRetryDelay(
  error: unknown,
  { type, attempt, remainingMs }: { type: string; attempt: number; remainingMs: number },
): number | null {
  if (!RETRIED_TYPES.has(type)) return null
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined || delay >= remainingMs) return null
  return isTransientConnectError(error) ? delay : null
}
