// How a failed tools/call surfaces to the tool layer.
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { isMcpSessionExpiredError } from 'src/mcp/client/errors.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

export type CallErrorKind = 'auth' | 'expired' | 'passthrough'

const UNAUTHORIZED = 401
// Transports with a server-held session, where a dropped connection means it is gone.
const SESSION_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'claudeai-proxy'])
const CONNECTION_CLOSED_RE = /Connection closed/

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function isClosedConnection(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === ErrorCode.ConnectionClosed &&
    CONNECTION_CLOSED_RE.test(error.message)
  )
}

/** A 401 from any layer or server type (spec, finding 6) is auth; 404 + -32001 is an expired session. */
export function classifyCallError(
  error: unknown,
  configType: ScopedMcpServerConfig['type'],
): CallErrorKind {
  if (error instanceof UnauthorizedError || codeOf(error) === UNAUTHORIZED) return 'auth'
  if (error instanceof Error && isMcpSessionExpiredError(error)) return 'expired'
  if (configType !== undefined && SESSION_TRANSPORTS.has(configType) && isClosedConnection(error)) {
    return 'expired'
  }
  return 'passthrough'
}
