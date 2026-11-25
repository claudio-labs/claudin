import { describe, expect, test } from 'bun:test'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { MCPServerConnection } from 'src/mcp/types.js'

type ListRequest = { method: string }

const ANSWERS: Record<string, Record<string, unknown>> = {
  'tools/list': { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] },
  'resources/list': { resources: [{ uri: 'file:///probe', name: 'probe' }] },
  'prompts/list': { prompts: [{ name: 'probe' }] },
}

// A server whose first list call of each kind fails, then answers.
function flakyServer(name: string): MCPServerConnection {
  const failed = new Set<string>()
  return {
    type: 'connected',
    name,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    config: { type: 'stdio', command: 'unused', args: [], scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async (req: ListRequest) => {
        if (!failed.has(req.method)) {
          failed.add(req.method)
          throw new Error(`${req.method} timed out`)
        }
        return ANSWERS[req.method]
      },
    },
  } as unknown as MCPServerConnection
}

// The memoized lists are keyed by server name, and only a reconnect or a
// list_changed notification clears them. A sub-agent naming the server
// (runAgent.ts) or a headless reconcile reads the memo without either, so a
// failure cached as [] hid the server's tools for the rest of the session.
describe('a failed MCP list call is not memoized', () => {
  test('tools/list', async () => {
    const client = flakyServer('flaky-tools')
    expect(await fetchToolsForClient(client)).toEqual([])
    const tools = await fetchToolsForClient(client)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['probe'])
  })

  test('resources/list', async () => {
    const client = flakyServer('flaky-resources')
    expect(await fetchResourcesForClient(client)).toEqual([])
    const resources = await fetchResourcesForClient(client)
    expect(resources.map(r => r.uri)).toEqual(['file:///probe'])
  })

  test('prompts/list', async () => {
    const client = flakyServer('flaky-prompts')
    expect(await fetchCommandsForClient(client)).toEqual([])
    const commands = await fetchCommandsForClient(client)
    expect(commands.map(c => c.name)).toEqual(['mcp__flaky-prompts__probe'])
  })

  test('a successful list is still served from the memo', async () => {
    const client = flakyServer('flaky-memo')
    await fetchToolsForClient(client)
    const first = await fetchToolsForClient(client)
    expect(await fetchToolsForClient(client)).toBe(first)
  })
})
