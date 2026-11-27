import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { fetchToolsForClient } from 'src/mcp/client/fetchCapabilities.js'
import { setupSdkMcpClients } from 'src/mcp/client/sdkClients.js'
import type { McpSdkServerConfig } from 'src/mcp/types.js'

type Incoming = {
  id?: string | number
  method?: string
  params?: { protocolVersion?: string; capabilities?: unknown; cursor?: string }
}

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

const MIXED_TOOLS = {
  tools: [
    { name: 'good', inputSchema: { type: 'object' } },
    { name: 'bad', inputSchema: { type: 'string' } },
  ],
}

// The SDK process on the other end of the control channel, answering raw;
// every request it gets is kept in `seen`.
function sdkProcess(listTools: (cursor: string | undefined) => unknown = () => MIXED_TOOLS) {
  const seen: Incoming[] = []
  const answer = async (_server: string, message: JSONRPCMessage): Promise<JSONRPCMessage> => {
    const incoming = message as Incoming
    seen.push(incoming)
    const { id, method, params } = incoming
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result }) as JSONRPCMessage
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'sdk-fixture', version: '1.0.0' },
      })
    }
    if (method === 'tools/list') return reply(listTools(params?.cursor))
    // A notification has no answer; the transport still hands one back.
    return { jsonrpc: '2.0', method: 'notifications/noop' } as JSONRPCMessage
  }
  return { seen, answer }
}

async function setUp(name: string, sdk: ReturnType<typeof sdkProcess>) {
  const config = { type: 'sdk', name } as McpSdkServerConfig
  const setup = await setupSdkMcpClients({ [name]: config }, sdk.answer)
  return {
    ...setup,
    done: async () => {
      fetchToolsForClient.cache.delete(name)
      for (const client of setup.clients) if (client.type === 'connected') await client.cleanup()
    },
  }
}

describe('setupSdkMcpClients', () => {
  test('lists through the wire filter: one malformed tool does not cost the server its tools', async () => {
    const { clients, tools, done } = await setUp(`sdk-wire-${process.pid}`, sdkProcess())
    try {
      expect(clients.map(c => c.type)).toEqual(['connected'])
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['good'])
    } finally {
      await done()
    }
  })

  // The client is built with no capabilities and handles no server request
  // (roots/list, elicitation), so it announces none, as it did before v2.
  test('initialize announces exactly the capabilities the client was built with: none', async () => {
    const sdk = sdkProcess()
    const { done } = await setUp(`sdk-init-${process.pid}`, sdk)
    try {
      const initialize = sdk.seen.filter(m => m.method === 'initialize')
      expect(initialize.map(m => m.params?.capabilities)).toEqual([{}])
    } finally {
      await done()
    }
  })

  test('a 70-page tool list is followed to its end, past the SDK’s default cap of 64', async () => {
    const sdk = sdkProcess(cursor => {
      const page = Number(cursor ?? 1)
      return {
        tools: [{ name: `t${page}`, inputSchema: { type: 'object' } }],
        ...(page < 70 && { nextCursor: String(page + 1) }),
      }
    })
    const { tools, done } = await setUp(`sdk-pages-${process.pid}`, sdk)
    try {
      expect(tools).toHaveLength(70)
      expect(tools.at(-1)?.mcpInfo?.toolName).toBe('t70')
    } finally {
      await done()
    }
  }, 20_000)
})
