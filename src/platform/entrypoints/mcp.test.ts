import { afterAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type { Tool as InternalTool } from 'src/Tool.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { getCombinedTools, loadReexposedMcpTools } from 'src/platform/entrypoints/mcp.js'

type GetMcpToolsFn = typeof import('src/services/mcp/client/fetchCapabilities.js').getMcpToolsCommandsAndResources
type OnConnectionAttempt = Parameters<GetMcpToolsFn>[0]

const realMcpClient = { ...(await import('src/services/mcp/client.js')) }

// Mock the MCP client service to control the tools and connections returned
const mockGetMcpToolsCommandsAndResources = mock(async (_onConnectionAttempt: OnConnectionAttempt) => {})
mock.module('src/services/mcp/client.js', () => ({
  getMcpToolsCommandsAndResources: mockGetMcpToolsCommandsAndResources
}))

afterAll(() => {
  mock.module('src/services/mcp/client.js', () => realMcpClient)
})

describe('getCombinedTools', () => {
  it('deduplicates builtins when mcpTools have the same name, prioritizing mcpTools', () => {
    const builtinBash = { name: 'Bash', isMcp: false } as unknown as InternalTool
    const builtinRead = { name: 'Read', isMcp: false } as unknown as InternalTool
    const mcpBash = { name: 'Bash', isMcp: true } as unknown as InternalTool

    const builtins = [builtinBash, builtinRead]
    const mcpTools = [mcpBash]

    const result = getCombinedTools(builtins, mcpTools)

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(mcpBash)
    expect(result[1]).toBe(builtinRead)
  })
})

describe('placeholder stripping on the MCP server boundary', () => {
  // The call site is inside the server's CallTool handler, which cannot be
  // reached without standing up a transport, so this is a source pin — the
  // semantics are covered in toolInputPlaceholders.test.ts.
  const src = readFileSync(new URL('./mcp.ts', import.meta.url), 'utf8')

  it('normalizes args before the zod parse', () => {
    expect(src).toContain(
      'stripPlaceholderOptionalFields(tool, args ?? {}),',
    )
  })

  it('is deliberately ungated here, unlike the in-process tool loop', () => {
    // In toolExecution the strip is gated on our own transport. Here the
    // strict-schema harness is on the OTHER side of the wire (Claude Code,
    // Cursor, …), so our provider says nothing about what the caller sends.
    expect(src).not.toContain('transportSendsStrictToolSchemas')
  })
})

describe('loadReexposedMcpTools', () => {
  it('loads tools and clients regardless of connection state (including needs-auth)', async () => {
    // Setup the mock to simulate yielding a needs-auth server and a connected server
    mockGetMcpToolsCommandsAndResources.mockImplementation(async (onConnectionAttempt) => {
      const needsAuthClient = {
        name: 'auth-server',
        type: 'needs-auth',
        config: {}
      } as MCPServerConnection

      const authTool = {
        name: 'mcp__auth-server__authenticate',
        isMcp: true
      } as unknown as InternalTool

      const connectedClient = {
        name: 'connected-server',
        type: 'connected',
        config: {},
        client: {}
      } as MCPServerConnection

      const connectedTool = {
        name: 'mcp__connected-server__do_thing',
        isMcp: true
      } as unknown as InternalTool

      // Simulate the callback behavior
      onConnectionAttempt({ client: needsAuthClient, tools: [authTool], commands: [] })
      onConnectionAttempt({ client: connectedClient, tools: [connectedTool], commands: [] })
    })

    const { mcpClients, mcpTools } = await loadReexposedMcpTools()

    expect(mcpClients).toHaveLength(2)
    expect(mcpClients[0].type).toBe('needs-auth')
    expect(mcpClients[1].type).toBe('connected')

    expect(mcpTools).toHaveLength(2)
    expect(mcpTools[0].name).toBe('mcp__auth-server__authenticate')
    expect(mcpTools[1].name).toBe('mcp__connected-server__do_thing')

    // Reset mock for other tests
    mockGetMcpToolsCommandsAndResources.mockReset()
  })
})
