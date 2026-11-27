/**
 * `claudin mcp login <name>` and `claudin mcp logout <name>`: the OAuth sign-in
 * the /mcp menu runs, from a shell. Login opens the browser and prints the URL
 * for when it cannot; on a terminal it also takes the URL the browser was sent
 * back to, pasted in, for a browser on another machine. Logout revokes the
 * tokens at the server where it supports RFC 7009, then deletes them here.
 * Only configured http and sse servers sign in this way.
 */
import { errorMessage } from 'src/shared/errors.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'

type OAuthServerConfig = McpSSEServerConfig | McpHTTPServerConfig

export type McpCliAuthDeps = {
  getConfig: (name: string) => ScopedMcpServerConfig | null
  performFlow: (
    name: string,
    config: OAuthServerConfig,
    onAuthorizationUrl: (url: string) => void,
    abortSignal?: AbortSignal,
    options?: { onWaitingForCallback?: (submit: (callbackUrl: string) => void) => void },
  ) => Promise<void>
  revoke: (name: string, config: OAuthServerConfig) => Promise<void>
  /** Asks for one line on the terminal; null when stdin is not one. */
  readLine: ((prompt: string) => Promise<string | null>) | null
  write: (text: string) => void
}

export type McpCliAuthResult = { ok: boolean; message: string }

function oauthServer(name: string, deps: McpCliAuthDeps): OAuthServerConfig | string {
  const config = deps.getConfig(name)
  if (!config) {
    return `No MCP server named "${name}". Run \`claudin mcp list\` to see the configured servers.`
  }
  if (config.type !== 'sse' && config.type !== 'http') {
    return `MCP server "${name}" is a ${config.type ?? 'stdio'} server; only http and sse servers sign in with OAuth.`
  }
  return config
}

export async function runMcpLogin(name: string, deps: McpCliAuthDeps): Promise<McpCliAuthResult> {
  const config = oauthServer(name, deps)
  if (typeof config === 'string') return { ok: false, message: config }
  try {
    await deps.performFlow(
      name,
      config,
      url => deps.write(`Opening your browser to authorize "${name}". If it does not open, visit:\n  ${url}\n`),
      undefined,
      {
        onWaitingForCallback: submit => {
          void deps
            .readLine?.('Or paste the URL your browser was sent to after authorizing, then press Enter:\n')
            .then(line => {
              if (line?.trim()) submit(line.trim())
            })
        },
      },
    )
  } catch (error) {
    return { ok: false, message: `Authentication with "${name}" failed: ${errorMessage(error)}` }
  }
  return { ok: true, message: `Authenticated with "${name}".` }
}

export async function runMcpLogout(name: string, deps: McpCliAuthDeps): Promise<McpCliAuthResult> {
  const config = oauthServer(name, deps)
  if (typeof config === 'string') return { ok: false, message: config }
  await deps.revoke(name, config)
  return {
    ok: true,
    message: `Signed out of "${name}": its tokens were revoked where the server supports it and removed here.`,
  }
}
