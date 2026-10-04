/**
 * Giving credentials back: RFC 7009 revocation against the authorization
 * server (best-effort, with a Bearer fallback for non-compliant ones) and the
 * local clearing that happens either way. The work is in revocation/.
 */

import type { McpHTTPServerConfig, McpSSEServerConfig } from 'src/mcp/types.js'
import { removeOAuthEntry } from 'src/mcp/auth/credentialMaps.js'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import {
  DEFAULT_REVOCATION_DEPS,
  signOutServer,
} from 'src/mcp/auth/revocation/signOut.js'

export async function revokeServerTokens(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  { preserveStepUpState = false }: { preserveStepUpState?: boolean } = {},
): Promise<void> {
  await signOutServer(
    serverName,
    serverConfig,
    preserveStepUpState,
    DEFAULT_REVOCATION_DEPS,
  )
}

export function clearServerTokensFromSecureStorage(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): void {
  removeOAuthEntry(getServerKey(serverName, serverConfig))
}
