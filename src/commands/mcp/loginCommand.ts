/**
 * MCP login and logout CLI subcommands.
 */
import { type Command } from '@commander-js/extra-typings'
import {
  type McpCliAuthDeps,
  type McpCliAuthResult,
  runMcpLogin,
  runMcpLogout,
} from 'src/mcp/auth/cliLogin.js'
import { cliError, cliOk } from 'src/platform/headless/exit.js'

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
  // The OAuth callback server and its timeout are unref'd, so off a terminal
  // nothing else kept the process alive: it exited before the browser came
  // back. This holds it until the flow settles.
  const keepAlive = setInterval(() => {}, 60_000)
  let outcome: McpCliAuthResult
  try {
    outcome = await result
  } finally {
    clearInterval(keepAlive)
  }
  const { ok, message } = outcome
  if (ok) cliOk(message)
  else cliError(message)
}

export function registerMcpLoginCommands(mcp: Command): void {
  mcp
    .command('login <name>')
    .description('Sign in to an http or sse MCP server with OAuth (opens the browser)')
    .action(async (name: string) => {
      await finish(runMcpLogin(name, await cliAuthDeps()))
    })
  mcp
    .command('logout <name>')
    .description("Sign out of an MCP server: revoke its OAuth tokens and delete them")
    .action(async (name: string) => {
      await finish(runMcpLogout(name, await cliAuthDeps()))
    })
}
