import { CLAUDEAI_SERVER_PREFIX, isClaudeAIMcpServerName } from 'src/mcp/normalization.js'
import { jsonStringify } from 'src/platform/slowOperations.js'

type McpInfo = { serverName: string; toolName: string }

/**
 * `server.tool`, the name an MCP call goes by in the TUI. A claude.ai server
 * drops its prefix, as the collapsed group's header does.
 */
export function mcpCallName({ serverName, toolName }: McpInfo): string {
  const server = isClaudeAIMcpServerName(serverName)
    ? serverName.slice(CLAUDEAI_SERVER_PREFIX.length)
    : serverName
  return `${server}.${toolName}`
}

/** `server.tool({...})`, with the arguments as the model sent them. */
export function mcpCallText(mcpInfo: McpInfo, input: unknown): string {
  return `${mcpCallName(mcpInfo)}(${jsonStringify(input ?? {})})`
}
