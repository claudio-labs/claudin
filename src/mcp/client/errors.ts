import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'

/** The server wants a new token; the tool layer marks it needs-auth instead of retrying. */
export class McpAuthError extends Error {
  serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpAuthError'
    this.serverName = serverName
  }
}

export class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" session expired`)
    this.name = 'McpSessionExpiredError'
  }
}

/** A result with `isError: true`. Its message is the server's own, which error consumers parse. */
export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    readonly mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

const HTTP_NOT_FOUND = 404
// The JSON-RPC "session not found" code, as servers serialize it in the body.
const SESSION_NOT_FOUND_CODES = ['"code":-32001', '"code": -32001'] as const

/** HTTP 404 whose body carries JSON-RPC -32001: the server forgot the session. */
export function isMcpSessionExpiredError(error: Error): boolean {
  if (!('code' in error) || error.code !== HTTP_NOT_FOUND) return false
  return SESSION_NOT_FOUND_CODES.some(code => error.message.includes(code))
}
