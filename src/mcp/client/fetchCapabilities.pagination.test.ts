import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as log from 'src/shared/log.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import { connectRawMcpServer, type RawMcpServer, type RawParams } from 'src/mcp/__testutils__/rawMcpServer.js'

const servers: RawMcpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

// A server that pages every list: page one carries a cursor, page two ends it.
async function pagingServer(name: string): Promise<RawMcpServer> {
  const pages: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
    'tools/list': [
      { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
      { tools: [{ name: 'second', inputSchema: { type: 'object' } }] },
    ],
    'resources/list': [
      { resources: [{ uri: 'file:///one', name: 'one' }], nextCursor: 'p2' },
      { resources: [{ uri: 'file:///two', name: 'two' }] },
    ],
    'prompts/list': [
      { prompts: [{ name: 'alpha' }], nextCursor: 'p2' },
      { prompts: [{ name: 'beta' }] },
    ],
  }
  const answers = Object.fromEntries(
    Object.entries(pages).map(([method, [first, second]]) => [
      method,
      (params: RawParams) => (params?.cursor === 'p2' ? second : first),
    ]),
  )
  const server = await connectRawMcpServer(name, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    answers,
  })
  servers.push(server)
  return server
}

describe('MCP list calls follow nextCursor', () => {
  test('tools/list returns the tools of every page', async () => {
    const server = await pagingServer('pager-tools')
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'second'])
    expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'p2'])
  })

  test('resources/list returns the resources of every page', async () => {
    const server = await pagingServer('pager-resources')
    const resources = await fetchResourcesForClient(server.connection)
    expect(resources.map(r => r.uri)).toEqual(['file:///one', 'file:///two'])
  })

  test('prompts/list returns the prompts of every page', async () => {
    const server = await pagingServer('pager-prompts')
    const commands = await fetchCommandsForClient(server.connection)
    expect(commands.map(c => c.name)).toEqual(['mcp__pager-prompts__alpha', 'mcp__pager-prompts__beta'])
  })

  test('a malformed entry on a later page is dropped from that page only', async () => {
    const server = await connectRawMcpServer('pager-malformed', {
      capabilities: { tools: {} },
      answers: {
        'tools/list': params =>
          params?.cursor === 'p2'
            ? { tools: [{ name: 'bad', inputSchema: { type: 'string' } }, { name: 'third', inputSchema: { type: 'object' } }] }
            : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
      },
    })
    servers.push(server)
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'third'])
  })
})

// cursor → [tool name, next cursor]
async function cursorServer(name: string, chain: Record<string, [string, string | undefined]>) {
  const server = await connectRawMcpServer(name, {
    capabilities: { tools: {} },
    answers: {
      'tools/list': params => {
        const [tool, nextCursor] = chain[(params?.cursor as string | undefined) ?? '']!
        return { tools: [{ name: tool, inputSchema: { type: 'object' } }], ...(nextCursor && { nextCursor }) }
      },
    },
  })
  servers.push(server)
  return server
}

describe('a server whose cursors cycle', () => {
  test('control: a three-page list is followed to its end', async () => {
    const server = await cursorServer('pager-three', { '': ['one', 'a'], a: ['two', 'b'], b: ['three', undefined] })
    const tools = await fetchToolsForClient(server.connection)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['one', 'two', 'three'])
    expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'a', 'b'])
  })

  test('keeps the tools listed before the repeated cursor, and logs it once', async () => {
    // a → b → a: the SDK alone would page until its 64-page cap and throw.
    const server = await cursorServer('pager-cycle', { '': ['one', 'a'], a: ['two', 'b'], b: ['three', 'a'] })
    const logged = spyOn(log, 'logMCPError')
    try {
      const tools = await fetchToolsForClient(server.connection)
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['one', 'two', 'three'])
      expect(server.requests.map(r => r.params?.cursor)).toEqual([undefined, 'a', 'b'])
      const cycles = logged.mock.calls.filter(call => String(call[1]).includes('repeated the cursor'))
      expect(cycles).toEqual([
        ['pager-cycle', 'tools/list repeated the cursor "a"; the list stops at the entries already received'],
      ])
    } finally {
      logged.mockRestore()
    }
  })
})
