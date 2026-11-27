import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { fetchToolsForClient } from 'src/mcp/client/fetchCapabilities.js'
import { setupSdkMcpClients } from 'src/mcp/client/sdkClients.js'
import type { McpSdkServerConfig } from 'src/mcp/types.js'

type Incoming = { id?: string | number; method?: string; params?: { protocolVersion?: string } }

// getMcpClientInfo reads MACRO.VERSION, which only the build defines.
const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
})
afterEach(() => {
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

// The SDK process on the other end of the control channel, answering raw.
async function answer(_server: string, message: JSONRPCMessage): Promise<JSONRPCMessage> {
  const { id, method, params } = message as Incoming
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result }) as JSONRPCMessage
  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'sdk-fixture', version: '1.0.0' },
    })
  }
  if (method === 'tools/list') {
    return reply({
      tools: [
        { name: 'good', inputSchema: { type: 'object' } },
        { name: 'bad', inputSchema: { type: 'string' } },
      ],
    })
  }
  // A notification has no answer; the transport still hands one back.
  return { jsonrpc: '2.0', method: 'notifications/noop' } as JSONRPCMessage
}

describe('setupSdkMcpClients', () => {
  test('lists through the wire filter: one malformed tool does not cost the server its tools', async () => {
    const name = `sdk-wire-${process.pid}`
    const config = { type: 'sdk', name } as McpSdkServerConfig
    const { clients, tools } = await setupSdkMcpClients({ [name]: config }, answer)
    try {
      expect(clients.map(c => c.type)).toEqual(['connected'])
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['good'])
    } finally {
      fetchToolsForClient.cache.delete(name)
      for (const client of clients) if (client.type === 'connected') await client.cleanup()
    }
  })
})
