/**
 * The key every stored credential hangs off. Two servers that differ in name,
 * transport, URL or headers must never share one — a collision hands one
 * server's tokens to another.
 */

import { createHash } from 'crypto'
import { getSecureStorage } from 'src/platform/secureStorage/index.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'

/**
 * Generates a unique key for server credentials based on both name and config hash
 * This prevents credentials from being reused across different servers
 * with the same name or different configurations
 */
export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string {
  const configJson = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers || {},
  })

  const hash = createHash('sha256')
    .update(configJson)
    .digest('hex')
    .substring(0, 16)

  return `${serverName}|${hash}`
}

/**
 * True when we have probed this server before (OAuth discovery state is
 * stored) but hold no credentials to try. A connection attempt in this
 * state is guaranteed to 401 — the only way out is the user running
 * /mcp to authenticate.
 */
export function hasMcpDiscoveryButNoToken(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): boolean {
  const serverKey = getServerKey(serverName, serverConfig)
  const entry = getSecureStorage().read()?.mcpOAuth?.[serverKey]
  return entry !== undefined && !entry.accessToken && !entry.refreshToken
}
