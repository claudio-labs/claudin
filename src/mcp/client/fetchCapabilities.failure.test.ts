import { afterEach, describe, expect, test } from 'bun:test'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { connectRawMcpServer, type RawMcpServer } from 'src/mcp/__testutils__/rawMcpServer.js'

const ANSWERS: Record<string, Record<string, unknown>> = {
  'tools/list': { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] },
  'resources/list': { resources: [{ uri: 'file:///probe', name: 'probe' }] },
  'prompts/list': { prompts: [{ name: 'probe' }] },
}

// tools/list makes three attempts (1 s, then 2 s apart) before it
// gives up; resources/list and prompts/list make one.
const FAILURES_PER_FETCH: Record<string, number> = {
  'tools/list': 3,
  'resources/list': 1,
  'prompts/list': 1,
}

const servers: RawMcpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

// A server whose first fetch of each list fails all its attempts, then answers.
async function flakyServer(name: string): Promise<MCPServerConnection> {
  const failures = new Map<string, number>()
  const answers = Object.fromEntries(
    Object.keys(ANSWERS).map(method => [
      method,
      () => {
        const failed = failures.get(method) ?? 0
        if (failed < FAILURES_PER_FETCH[method]!) {
          failures.set(method, failed + 1)
          throw new Error(`${method} timed out`)
        }
        return ANSWERS[method]
      },
    ]),
  )
  const server = await connectRawMcpServer(
    name,
    { capabilities: { tools: {}, resources: {}, prompts: {} }, answers },
    { type: 'stdio', command: 'unused', args: [], scope: 'local' },
  )
  servers.push(server)
  return server.connection
}

// The memoized lists are keyed by server name, and only a reconnect or a
// list_changed notification clears them. A sub-agent naming the server
// (runAgent.ts) or a headless reconcile reads the memo without either, so a
// failure cached as [] hid the server's tools for the rest of the session.
describe('a failed MCP list call is not memoized', () => {
  test('tools/list', async () => {
    const client = await flakyServer('flaky-tools')
    expect(await fetchToolsForClient(client)).toEqual([])
    const tools = await fetchToolsForClient(client)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['probe'])
  }, 10_000)

  test('resources/list', async () => {
    const client = await flakyServer('flaky-resources')
    expect(await fetchResourcesForClient(client)).toEqual([])
    const resources = await fetchResourcesForClient(client)
    expect(resources.map(r => r.uri)).toEqual(['file:///probe'])
  })

  test('prompts/list', async () => {
    const client = await flakyServer('flaky-prompts')
    expect(await fetchCommandsForClient(client)).toEqual([])
    const commands = await fetchCommandsForClient(client)
    expect(commands.map(c => c.name)).toEqual(['mcp__flaky-prompts__probe'])
  })

  test('a successful list is still served from the memo', async () => {
    const client = await flakyServer('flaky-memo')
    await fetchResourcesForClient(client)
    const first = await fetchResourcesForClient(client)
    expect(await fetchResourcesForClient(client)).toBe(first)
  })
})
