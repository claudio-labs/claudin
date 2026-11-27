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
  const code = codeOf(error)
  // The SDK's StreamableHTTPError and SseError carry the HTTP status as `code`.
  if (typeof code === 'number') {
    return code === 408 || code === 429 || (code >= 500 && code <= 599 && code !== 501)
  }
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
  return [code, codeOf(cause)].some(c => typeof c === 'string' && TRANSIENT_NETWORK_CODES.has(c))
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
