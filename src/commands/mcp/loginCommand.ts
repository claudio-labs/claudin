/**
 * MCP login and logout CLI subcommands.
 */
import { type Command } from '@commander-js/extra-typings'
import type { McpCliAuthDeps, McpCliAuthResult } from 'src/mcp/auth/cliLogin.js'

export async function cliAuthDeps(): Promise<McpCliAuthDeps> {
  const [{ getMcpConfigByName }, { performMCPOAuthFlow }, { revokeServerTokens }, { createInterface }] =
    await Promise.all([
      import('src/mcp/config.js'),
      import('src/mcp/auth/oauthFlow.js'),
      import('src/mcp/auth/tokenRevocation.js'),
      import('node:readline/promises'),
    ])
  return {
    getConfig: getMcpConfigByName,
    performFlow: performMCPOAuthFlow,
    revoke: revokeServerTokens,
    readLine: process.stdin.isTTY
      ? async prompt => {
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            return await rl.question(prompt)
          } finally {
            rl.close()
          }
        }
      : null,
    write: text => {
      process.stdout.write(text)
    },
  }
}

async function finish(result: Promise<McpCliAuthResult>): Promise<void> {
  const { ok, message } = await result
  const { cliError, cliOk } = await import('src/platform/headless/exit.js')
  if (ok) cliOk(message)
  else cliError(message)
}

export function registerMcpLoginCommands(mcp: Command): void {
  mcp
    .command('login <name>')
    .description('Sign in to an http or sse MCP server with OAuth (opens the browser)')
    .action(async (name: string) => {
      const { runMcpLogin } = await import('src/mcp/auth/cliLogin.js')
      await finish(runMcpLogin(name, await cliAuthDeps()))
    })
  mcp
    .command('logout <name>')
    .description("Sign out of an MCP server: revoke its OAuth tokens and delete them")
    .action(async (name: string) => {
      const { runMcpLogout } = await import('src/mcp/auth/cliLogin.js')
      await finish(runMcpLogout(name, await cliAuthDeps()))
    })
}
