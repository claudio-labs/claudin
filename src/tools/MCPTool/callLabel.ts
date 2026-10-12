import { jsonStringify } from 'src/platform/slowOperations.js'

const CLAUDE_AI_SERVER_PREFIX_RE = /^claude\.ai /

type McpInfo = { serverName: string; toolName: string }

/**
 * `server.tool`, the name an MCP call goes by in the TUI. A claude.ai server
 * drops its prefix, as the collapsed group's header does.
 */
export function mcpCallName(mcpInfo: McpInfo): string {
  return `${mcpInfo.serverName.replace(CLAUDE_AI_SERVER_PREFIX_RE, '')}.${mcpInfo.toolName}`
}

/** `server.tool({...})`, with the arguments as the model sent them. */
export function mcpCallText(mcpInfo: McpInfo, input: unknown): string {
  return `${mcpCallName(mcpInfo)}(${jsonStringify(input ?? {})})`
}
