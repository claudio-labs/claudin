import { afterAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getEmptyToolPermissionContext, type Tool as InternalTool } from 'src/tools/Tool.js'
import { getTools } from 'src/tools/tools.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { getCombinedTools, listToolsForMcpServe, loadReexposedMcpTools } from 'src/platform/entrypoints/mcp.js'

type GetMcpToolsFn = typeof import('src/mcp/client/fetchCapabilities.js').getMcpToolsCommandsAndResources
type OnConnectionAttempt = Parameters<GetMcpToolsFn>[0]

const realMcpClient = { ...(await import('src/mcp/client.js')) }

// Mock the MCP client service to control the tools and connections returned
const mockGetMcpToolsCommandsAndResources = mock(async (_onConnectionAttempt: OnConnectionAttempt) => {})
mock.module('src/mcp/client.js', () => ({
  getMcpToolsCommandsAndResources: mockGetMcpToolsCommandsAndResources
}))

afterAll(() => {
  mock.module('src/mcp/client.js', () => realMcpClient)
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

describe('Tool.resolveInput on the MCP server boundary', () => {
  // In the same handler, so a source pin for the same reason. The await is
  // what lets a Read expand its globs there: that resolution reads the disk
  // (FileReadTool/readGlobs.ts) and comes back as a promise.
  const src = readFileSync(new URL('./mcp.ts', import.meta.url), 'utf8')

  it('awaits the resolution, which may be a promise', () => {
    expect(src).toContain('? await tool.resolveInput(parsedArgs as never, toolUseContext)')
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

describe('listToolsForMcpServe', () => {
  const context = getEmptyToolPermissionContext()
  const fakeTool = (name: string, schemas: Partial<InternalTool>) =>
    ({
      name,
      inputSchema: z.object({ q: z.string() }),
      prompt: async () => `${name} prompt`,
      ...schemas,
    }) as unknown as InternalTool

  it('lists a tool with its prompt as the description and both schemas as JSON Schema', async () => {
    const [listed] = await listToolsForMcpServe(
      [fakeTool('Plain', { outputSchema: z.object({ ok: z.boolean() }) } as Partial<InternalTool>)],
      context,
    )
    expect(listed!.name).toBe('Plain')
    expect(listed!.description).toBe('Plain prompt')
    expect(listed!.inputSchema).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } })
    expect(listed!.outputSchema).toMatchObject({ type: 'object', properties: { ok: { type: 'boolean' } } })
  })

  it('hands every tool the permission context and the whole list', async () => {
    const seen: unknown[] = []
    const tools = [
      fakeTool('A', {
        prompt: async (options: { getToolPermissionContext: () => Promise<unknown>; tools: unknown }) => {
          seen.push(await options.getToolPermissionContext(), options.tools)
          return 'a'
        },
      } as unknown as Partial<InternalTool>),
      fakeTool('B', {}),
    ]
    await listToolsForMcpServe(tools, context)
    expect(seen).toEqual([context, tools])
  })

  it('prefers a tool’s own JSON input schema', async () => {
    const inputJSONSchema = { type: 'object', properties: { raw: { type: 'number' } } }
    const [listed] = await listToolsForMcpServe(
      [fakeTool('Mcp', { inputJSONSchema } as unknown as Partial<InternalTool>)],
      context,
    )
    expect(listed!.inputSchema).toBe(inputJSONSchema as Tool['inputSchema'])
  })

  it('drops an output schema with no JSON Schema form and keeps the tool', async () => {
    const listed = await listToolsForMcpServe(
      [fakeTool('Custom', { outputSchema: z.custom<string>() } as Partial<InternalTool>), fakeTool('Next', {})],
      context,
    )
    expect(listed.map(t => t.name)).toEqual(['Custom', 'Next'])
    expect(listed[0]!.outputSchema).toBeUndefined()
  })

  it('drops an output schema whose root is not an object', async () => {
    const [listed] = await listToolsForMcpServe(
      [fakeTool('Union', { outputSchema: z.union([z.string(), z.number()]) } as Partial<InternalTool>)],
      context,
    )
    expect(listed!.outputSchema).toBeUndefined()
  })

  it('leaves out only the tool whose input schema has no JSON Schema form', async () => {
    const listed = await listToolsForMcpServe(
      [fakeTool('Broken', { inputSchema: z.custom<string>() } as unknown as Partial<InternalTool>), fakeTool('Fine', {})],
      context,
    )
    expect(listed.map(t => t.name)).toEqual(['Fine'])
  })

  it('lists every built-in tool', async () => {
    const builtins = getTools(context)
    const listed = await listToolsForMcpServe(builtins, context)
    expect(listed.map(t => t.name)).toEqual(builtins.map(t => t.name))
  })
})
