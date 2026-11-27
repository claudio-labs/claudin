/**
 * MCP timeouts, resolved once here for every caller: `MCP_TIMEOUT` caps a
 * server's connect and `MCP_TOOL_TIMEOUT` a tool call, both in ms, over the
 * defaults below. A value that is not a positive number is ignored.
 */

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000

/**
 * Default timeout for MCP tool calls (5 minutes — reasonable for most tools).
 * The previous default of ~27.8 hours effectively meant no timeout, causing
 * tools to hang indefinitely on unresponsive servers.
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300_000

function positiveMs(raw: string | undefined): number | undefined {
  const parsed = parseInt(raw || '', 10)
  return parsed > 0 ? parsed : undefined
}

export function getMcpConnectTimeoutMs(): number {
  return positiveMs(process.env.MCP_TIMEOUT) ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
}

export function getMcpToolTimeoutMs(): number {
  return positiveMs(process.env.MCP_TOOL_TIMEOUT) ?? DEFAULT_MCP_TOOL_TIMEOUT_MS
}
