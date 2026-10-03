
import { normalizeNameForMCP } from 'src/mcp/normalization.js'

const BOUNDARY = '__'
const NAMESPACE = `mcp${BOUNDARY}`

/**
 * Splits `mcp__<server>[__<tool>]` at the first boundary after the server.
 * Everything past it, further boundaries included, is the tool.
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  if (!toolString.startsWith(NAMESPACE)) return null
  const qualified = toolString.slice(NAMESPACE.length)
  const boundary = qualified.indexOf(BOUNDARY)
  const serverName = boundary === -1 ? qualified : qualified.slice(0, boundary)
  if (serverName === '') return null
  const toolName =
    boundary === -1 ? undefined : qualified.slice(boundary + BOUNDARY.length)
  return { serverName, toolName }
}

export function getMcpPrefix(serverName: string): string {
  return `${NAMESPACE}${normalizeNameForMCP(serverName)}${BOUNDARY}`
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return getMcpPrefix(serverName) + normalizeNameForMCP(toolName)
}

/**
 * An MCP tool is matched by its qualified name even when it is displayed
 * under a builtin's name, so a rule for `Write` never reaches it.
 */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  const info = tool.mcpInfo
  return info ? buildMcpToolName(info.serverName, info.toolName) : tool.name
}

export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = getMcpPrefix(serverName)
  const at = fullName.indexOf(prefix)
  if (at === -1) return fullName
  return fullName.slice(0, at) + fullName.slice(at + prefix.length)
}

const MCP_TAG_AT_END = /\s*\(MCP\)\s*$/
const SERVER_TOOL_SEPARATOR = ' - '

export function extractMcpToolDisplayName(userFacingName: string): string {
  const label = userFacingName.replace(MCP_TAG_AT_END, '').trim()
  const separator = label.indexOf(SERVER_TOOL_SEPARATOR)
  if (separator === -1) return label
  return label.slice(separator + SERVER_TOOL_SEPARATOR.length).trim()
}
