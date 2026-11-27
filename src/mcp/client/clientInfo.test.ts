import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { getMcpClientInfo } from 'src/mcp/client/clientInfo.js'

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '1.2.3' }
})

afterEach(() => {
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

describe('getMcpClientInfo', () => {
  test('describes Claudin and keeps the claude-code name servers may key on', () => {
    expect(getMcpClientInfo()).toEqual({
      name: 'claude-code',
      title: 'Claudin',
      version: '1.2.3',
      description: 'Claudin, an open-source coding agent',
      websiteUrl: 'https://claudiolabs.ai',
    })
  })

  test('says nothing about Anthropic', () => {
    const info = JSON.stringify(getMcpClientInfo())
    expect(info).not.toContain('Anthropic')
    expect(info).not.toContain('claude.com')
  })

  test('both MCP clients introduce themselves with it', () => {
    // Source pins: the Clients are built inside connectToServer and
    // setupSdkMcpClients, past a real transport.
    for (const file of ['./connection.ts', './sdkClients.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src).toContain('new Client(\n        getMcpClientInfo(),')
      expect(src).not.toContain("Anthropic's agentic coding tool")
    }
  })
})
