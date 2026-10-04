/**
 * The client secret half of the credential store: reading one from the
 * environment or a TTY prompt, and persisting or clearing it per server.
 */

import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import {
  putClientSecret,
  removeClientSecret,
} from 'src/mcp/auth/credentialMaps.js'
import { promptHiddenLine } from 'src/mcp/auth/hiddenPrompt.js'

const SECRET_ENV_VAR = 'MCP_CLIENT_SECRET'

export async function readClientSecret(): Promise<string> {
  const fromEnv = process.env[SECRET_ENV_VAR]
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) {
    throw new Error(
      `No TTY available to prompt for client secret. Set ${SECRET_ENV_VAR} env var instead.`,
    )
  }
  return promptHiddenLine('Enter OAuth client secret: ')
}

export function saveMcpClientSecret(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  clientSecret: string,
): void {
  putClientSecret(getServerKey(serverName, serverConfig), clientSecret)
}

export function clearMcpClientConfig(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  removeClientSecret(getServerKey(serverName, serverConfig))
}
