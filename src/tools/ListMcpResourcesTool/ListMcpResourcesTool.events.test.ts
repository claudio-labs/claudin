import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { type EventsFixture, serveEvents } from 'src/mcp/__testutils__/eventsServer.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'

/*
 * The event types a 2026-07-28 server publishes (SEP-3415) are listed after
 * its resources, so the model finds what Monitor's mcp_event can watch
 * without a tool of its own. A server without the extension is not asked.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
const fixtures: EventsFixture[] = []
const connections: MCPServerConnection[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
})

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
  for (const fixture of fixtures.splice(0)) await fixture.stop()
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

async function connect(name: string, spec: Parameters<typeof serveEvents>[0]) {
  const fixture = serveEvents(spec)
  fixtures.push(fixture)
  const connection = await connectToServer(name, { type: 'http', url: fixture.url, scope: 'user' })
  connections.push(connection)
  return { fixture, connection }
}

const context = (mcpClients: MCPServerConnection[]) => ({ options: { mcpClients } }) as unknown as ToolUseContext

describe('ListMcpResourcesTool and MCP events', () => {
  test('lists a server’s event types after its resources, and the result names Monitor', async () => {
    const { connection } = await connect('ci', {
      types: [{ name: 'build', description: 'a build finished', delivery: ['push'], inputSchema: { type: 'object' } }, { name: 'tick' }],
    })
    const { data } = await ListMcpResourcesTool.call({}, context([connection]))
    expect(data).toEqual([
      { event: 'build', description: 'a build finished', delivery: ['push'], inputSchema: { type: 'object' }, server: 'ci' },
      { event: 'tick', server: 'ci' },
    ])
    expect(ListMcpResourcesTool.outputSchema!.safeParse(data).success).toBe(true)
    const block = ListMcpResourcesTool.mapToolResultToToolResultBlockParam(data, 'u1')
    expect(block.content).toBe(
      'No resources found. MCP servers may still provide tools even if they have no resources.\n\n' +
        "MCP event types (watch one with Monitor's mcp_event: {server, event, args?}):\n" +
        JSON.stringify(data),
    )
  })

  test('a server without the extension is not asked, and the result reads as it always has', async () => {
    const { fixture, connection } = await connect('plain', { types: [{ name: 'build' }], extension: false })
    const { data } = await ListMcpResourcesTool.call({}, context([connection]))
    expect(data).toEqual([])
    expect(fixture.eventHits()).toEqual([])
    const resources = [{ uri: 'res://a', name: 'a', server: 's' }]
    expect(ListMcpResourcesTool.mapToolResultToToolResultBlockParam(resources, 'u2').content).toBe(JSON.stringify(resources))
  })

  test('resources and events side by side; a failed events list costs only its own section', async () => {
    const { connection: broken } = await connect('broken', { types: 'not a list' as unknown as unknown[] })
    const { connection: ci } = await connect('ci2', { types: [{ name: 'deploy', delivery: ['poll'] }] })
    const { data } = await ListMcpResourcesTool.call({}, context([broken, ci]))
    expect(data).toEqual([{ event: 'deploy', delivery: ['poll'], server: 'ci2' }])

    const mixed = [{ uri: 'res://r', name: 'r', server: 'ci2' }, ...data]
    const content = String(ListMcpResourcesTool.mapToolResultToToolResultBlockParam(mixed, 'u3').content)
    expect(content.startsWith(`${JSON.stringify([mixed[0]])}\n\nMCP event types`)).toBe(true)
    expect(content.endsWith(JSON.stringify(data))).toBe(true)
  })
})
