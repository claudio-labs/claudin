import { describe, expect, test } from 'bun:test'
import { callMCPTool } from 'src/mcp/client/callTool.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'

// A connected server whose tool call never answers.
function hangingServer(config: Record<string, unknown>): ConnectedMCPServer {
  return {
    type: 'connected',
    name: 'hangs',
    capabilities: { tools: {} },
    config: { scope: 'user', ...config },
    cleanup: async () => {},
    client: { callTool: () => new Promise(() => {}) },
  } as unknown as ConnectedMCPServer
}

describe('callMCPTool timeout', () => {
  test('a server’s toolTimeout bounds the call', async () => {
    const started = Date.now()
    await expect(
      callMCPTool({
        client: hangingServer({ type: 'http', url: 'http://srv/mcp', toolTimeout: 50 }),
        tool: 'slow',
        args: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('MCP server "hangs" tool "slow" timed out after 0s')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
