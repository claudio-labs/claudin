/**
 * Request headers for a remote MCP server: the config's static `headers`,
 * with whatever its `headersHelper` prints laid over them. The parts live in
 * headersHelper/.
 */

import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpWebSocketServerConfig,
} from 'src/mcp/types.js'
import { mergeHeaders } from 'src/mcp/headersHelper/mergeHeaders.js'
import {
  defaultHeadersHelperDeps,
  readHelperHeaders,
} from 'src/mcp/headersHelper/readHelperHeaders.js'

export async function getMcpHeadersFromHelper(
  serverName: string,
  config: McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig,
): Promise<Record<string, string> | null> {
  return readHelperHeaders(serverName, config, defaultHeadersHelperDeps)
}

export async function getMcpServerHeaders(
  serverName: string,
  config: McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig,
): Promise<Record<string, string>> {
  const fromHelper = await getMcpHeadersFromHelper(serverName, config)
  return mergeHeaders(config.headers ?? {}, fromHelper ?? {})
}
