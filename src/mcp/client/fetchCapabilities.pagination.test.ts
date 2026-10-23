import { describe, expect, test } from 'bun:test'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { MCPServerConnection } from 'src/mcp/types.js'

type ListRequest = { method: string; params?: { cursor?: string } }

// A server that pages every list: page one carries a cursor, page two ends it.
function pagingServer(name: string): { client: MCPServerConnection; requests: ListRequest[] } {
  const requests: ListRequest[] = []
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
  const client = {
    type: 'connected',
    name,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    config: { type: 'stdio', command: 'unused', args: [], scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async (req: ListRequest) => {
        requests.push(req)
        const [first, second] = pages[req.method]!
        return req.params?.cursor === 'p2' ? second : first
      },
    },
  } as unknown as MCPServerConnection
  return { client, requests }
}

describe('MCP list calls follow nextCursor', () => {
  test('tools/list returns the tools of every page', async () => {
    const { client, requests } = pagingServer('pager-tools')
    const tools = await fetchToolsForClient(client)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['first', 'second'])
    expect(requests.map(r => r.params?.cursor)).toEqual([undefined, 'p2'])
  })

  test('resources/list returns the resources of every page', async () => {
    const { client } = pagingServer('pager-resources')
    const resources = await fetchResourcesForClient(client)
    expect(resources.map(r => r.uri)).toEqual(['file:///one', 'file:///two'])
  })

  test('prompts/list returns the prompts of every page', async () => {
    const { client } = pagingServer('pager-prompts')
    const commands = await fetchCommandsForClient(client)
    expect(commands.map(c => c.name)).toEqual(['mcp__pager-prompts__alpha', 'mcp__pager-prompts__beta'])
  })
})
