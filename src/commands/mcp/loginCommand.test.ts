import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { cliAuthDeps, registerMcpLoginCommands } from 'src/commands/mcp/loginCommand.js'
import { performMCPOAuthFlow } from 'src/mcp/auth/oauthFlow.js'
import { revokeServerTokens } from 'src/mcp/auth/tokenRevocation.js'

describe('registerMcpLoginCommands', () => {
  test('adds login and logout, each taking a server name', () => {
    const mcp = new Command('mcp')
    registerMcpLoginCommands(mcp)
    expect(mcp.commands.map(c => [c.name(), c.usage()])).toEqual([
      ['login', '[options] <name>'],
      ['logout', '[options] <name>'],
    ])
  })
})

describe('cliAuthDeps', () => {
  test('wires the OAuth flow and the revocation the /mcp menu uses', async () => {
    const deps = await cliAuthDeps()
    expect(deps.performFlow).toBe(performMCPOAuthFlow)
    expect(deps.revoke).toBe(revokeServerTokens)
    expect(typeof deps.getConfig).toBe('function')
  })

  test('asks for a pasted URL only when stdin is a terminal', async () => {
    const isTTY = process.stdin.isTTY
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
      expect((await cliAuthDeps()).readLine).toBeNull()
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      expect(typeof (await cliAuthDeps()).readLine).toBe('function')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
    }
  })
})
