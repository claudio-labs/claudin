/**
 * Per-server MCP options, resolved once here for every caller.
 *
 * Timeouts, in ms: a server's own `startupTimeout` (its connect) and
 * `toolTimeout` (each tool call) win over `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT`,
 * which win over the defaults below. An env value that is not a positive
 * number is ignored. A stdio server's `cwd` resolves `~` to the home dir and
 * a relative path against the project dir.
 */
import { isAbsolute, join, resolve } from 'path'
import type { McpServerConfig } from 'src/mcp/types.js'

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

export function getMcpConnectTimeoutMs(config?: McpServerConfig): number {
  const own = config && 'startupTimeout' in config ? config.startupTimeout : undefined
  return own ?? positiveMs(process.env.MCP_TIMEOUT) ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
}

export function getMcpToolTimeoutMs(config?: McpServerConfig): number {
  const own = config && 'toolTimeout' in config ? config.toolTimeout : undefined
  return own ?? positiveMs(process.env.MCP_TOOL_TIMEOUT) ?? DEFAULT_MCP_TOOL_TIMEOUT_MS
}

export function resolveStdioCwd(
  cwd: string | undefined,
  projectDir: string,
  homeDir: string,
): string | undefined {
  if (!cwd) return undefined
  if (cwd === '~') return homeDir
  if (cwd.startsWith('~/')) return join(homeDir, cwd.slice(2))
  return isAbsolute(cwd) ? cwd : resolve(projectDir, cwd)
}
