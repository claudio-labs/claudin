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

// tools/list retries a page 3 times (1 s, then 2 s apart) before it gives up;
// resources/list and prompts/list do not retry.
const FAILURES_PER_FETCH: Record<string, number> = {
  'tools/list': 3,
  'resources/list': 1,
  'prompts/list': 1,
}

// A server whose first fetch of each list fails all its attempts, then answers.
function flakyServer(name: string): MCPServerConnection {
  const failures = new Map<string, number>()
  return {
    type: 'connected',
    name,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    config: { type: 'stdio', command: 'unused', args: [], scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async (req: ListRequest) => {
        const failed = failures.get(req.method) ?? 0
        if (failed < FAILURES_PER_FETCH[req.method]!) {
          failures.set(req.method, failed + 1)
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
  }, 10_000)

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
    await fetchResourcesForClient(client)
    const first = await fetchResourcesForClient(client)
    expect(await fetchResourcesForClient(client)).toBe(first)
  })
})
