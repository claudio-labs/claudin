/**
 * The key every stored credential hangs off. Two servers that differ in name,
 * transport, URL or headers must never share one — a collision hands one
 * server's tokens to another.
 */

import { createHash } from 'crypto'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { getOAuthEntry } from 'src/mcp/auth/credentialMaps.js'

// A storage format: users' credentials are filed under keys of this length.
const DIGEST_HEX_CHARS = 16

export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string {
  // Member order is part of the format, so the object is spelled out.
  const identity = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers ?? {},
  })
  const digest = createHash('sha256').update(identity).digest('hex')
  return `${serverName}|${digest.slice(0, DIGEST_HEX_CHARS)}`
}

export function hasMcpDiscoveryButNoToken(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): boolean {
  const entry = getOAuthEntry(getServerKey(serverName, serverConfig))
  if (!entry) return false
  return !entry.accessToken && !entry.refreshToken
}
