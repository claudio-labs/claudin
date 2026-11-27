import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getEmptyToolPermissionContext, type Tool as InternalTool, type ToolUseContext } from 'src/tools/Tool.js'
import { getTools } from 'src/tools/tools.js'
import { McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import {
  getCombinedTools,
  listToolsForMcpServe,
  loadReexposedMcpTools,
  startMCPServer,
} from 'src/platform/entrypoints/mcp.js'

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

// startMCPServer builds its own stdio transport. Server.prototype.connect is
// spied so the real server instance is connected to one end of an in-memory
// pair instead, and a real SDK Client drives it from the other end. These pin
// what `claudin mcp serve` answers TODAY, gaps included (no structuredContent,
// an abortController not tied to the request) — the SDK v2 migration and the
// fixes after it change them on purpose.
describe('startMCPServer, driven by an SDK client', () => {
  const realConnect = Server.prototype.connect
  const serverOwnedConnect = Object.hasOwn(Server.prototype, 'connect')
  const macroHost = globalThis as { MACRO?: unknown }
  const savedMacro = macroHost.MACRO
  let savedCwd: string
  let tmp: string
  let client: Client | undefined

  const fakeConnection = { name: 'fake', type: 'connected', config: {}, client: {} } as unknown as MCPServerConnection

  const fakeMcpTool = (name: string, overrides: Record<string, unknown> = {}) =>
    ({
      name,
      isMcp: true,
      inputSchema: z.object({ q: z.string().optional() }),
      isEnabled: () => true,
      prompt: async () => `${name} prompt`,
      call: async () => ({ data: 'ok' }),
      ...overrides,
    }) as unknown as InternalTool

  async function serve(mcpTools: InternalTool[] = [], debug = false, verbose = false) {
    mockGetMcpToolsCommandsAndResources.mockImplementation(async onConnectionAttempt => {
      onConnectionAttempt({ client: fakeConnection, tools: mcpTools, commands: [] })
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const handed: unknown[] = []
    spyOn(Server.prototype, 'connect').mockImplementation(function (this: Server, transport) {
      handed.push(transport)
      return realConnect.call(this, serverSide)
    })
    await startMCPServer(tmp, debug, verbose)
    // Record what reaches the server, ahead of the server's own handler.
    const received: string[] = []
    const serverOnMessage = serverSide.onmessage!
    serverSide.onmessage = (message, extra) => {
      if ('method' in message) received.push(message.method)
      serverOnMessage(message, extra)
    }
    client = new Client({ name: 'cover', version: '0.0.0' })
    await client.connect(clientSide)
    return { client, handed, received }
  }

  const callRaw = (name: string, args?: Record<string, unknown>) =>
    client!.callTool({ name, arguments: args }) as Promise<CallToolResult>

  beforeEach(() => {
    savedCwd = getCwdState()
    macroHost.MACRO = { VERSION: '9.9.9-cover' }
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-serve-cover-')))
    writeFileSync(join(tmp, 'alpha.txt'), 'a')
    writeFileSync(join(tmp, 'beta.md'), 'b')
  })

  afterEach(async () => {
    await client?.close()
    client = undefined
    mock.restore()
    // Server inherits connect from Protocol: make sure the spy left no own
    // property behind on Server.prototype.
    if (!serverOwnedConnect && Object.hasOwn(Server.prototype, 'connect')) {
      delete (Server.prototype as { connect?: unknown }).connect
    }
    mockGetMcpToolsCommandsAndResources.mockReset()
    setCwdState(savedCwd)
    if (savedMacro === undefined) delete macroHost.MACRO
    else macroHost.MACRO = savedMacro
    rmSync(tmp, { recursive: true, force: true })
  })

  it('announces itself as claudin with tools only, over a stdio transport, in the given cwd', async () => {
    const { client, handed } = await serve()
    expect(handed).toHaveLength(1)
    expect(handed[0]).toBeInstanceOf(StdioServerTransport)
    expect(client.getServerVersion()).toEqual({ name: 'claudin', version: '9.9.9-cover' })
    expect(client.getServerCapabilities()).toEqual({ tools: {} })
    expect(getCwdState()).toBe(tmp)
  })

  it('lists the re-exposed MCP tools first, then the built-ins they do not shadow', async () => {
    const shadow = fakeMcpTool('Glob', { prompt: async () => 'shadowing glob' })
    const { client } = await serve([
      fakeMcpTool('mcp__fake__echo', { outputSchema: z.object({ ok: z.boolean() }) }),
      fakeMcpTool('mcp__fake__custom_out', { outputSchema: z.custom<string>() }),
      fakeMcpTool('mcp__fake__broken_in', { inputSchema: z.custom<string>() }),
      shadow,
    ])
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names.slice(0, 3)).toEqual(['mcp__fake__echo', 'mcp__fake__custom_out', 'Glob'])
    expect(names.filter(n => n === 'Glob')).toHaveLength(1)
    expect(names).not.toContain('mcp__fake__broken_in')
    expect(names).toContain('Read')

    const [echo, customOut, glob] = tools
    expect(echo!.description).toBe('mcp__fake__echo prompt')
    expect(echo!.inputSchema).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } })
    expect(echo!.outputSchema).toMatchObject({ type: 'object', properties: { ok: { type: 'boolean' } } })
    expect(customOut!.outputSchema).toBeUndefined()
    expect(glob!.description).toBe('shadowing glob')
  })

  it('runs a built-in Glob in the server cwd and answers its object result as JSON text, without structuredContent', async () => {
    await serve()
    const result = await callRaw('Glob', { pattern: '*.txt' })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const block = result.content[0] as { type: string; text: string }
    expect(block.type).toBe('text')
    expect(JSON.parse(block.text)).toMatchObject({ filenames: ['alpha.txt'], numFiles: 1, truncated: false })
  })

  it('fails the SDK client output-schema check once Glob was listed (the -32600 gap)', async () => {
    const { client } = await serve()
    await client.listTools()
    const error = await client.callTool({ name: 'Glob', arguments: { pattern: '*.txt' } }).catch(e => e)
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).code).toBe(-32600)
    expect((error as McpError).message).toContain('has an output schema but did not return structured content')
  })

  it('treats a "" placeholder for an optional arg as absent', async () => {
    await serve()
    const result = await callRaw('Glob', { pattern: '*.md', path: '' })
    expect(result.isError).toBe(false)
    expect(JSON.parse((result.content[0] as { text: string }).text).filenames).toEqual(['beta.md'])
  })

  it('answers a validateInput failure as an isError result', async () => {
    await serve()
    const result = await callRaw('Glob', { pattern: '*', path: join(tmp, 'nope') })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toStartWith(
      `Tool Glob input is invalid: Directory does not exist: ${join(tmp, 'nope')}.`,
    )
  })

  it('answers a zod failure with one line per issue, nested paths joined by dots', async () => {
    await serve([fakeMcpTool('mcp__fake__strict', { inputSchema: z.object({ a: z.object({ b: z.number() }), n: z.number() }) })])
    const result = await callRaw('mcp__fake__strict', { a: { b: 'x' }, n: 'y' })
    expect(result.isError).toBe(true)
    const lines = (result.content[0] as { text: string }).text.split('\n')
    expect(lines[0]).toBe('Tool mcp__fake__strict input is invalid:')
    expect(lines.slice(1).map(l => l.split(':')[0])).toEqual(['- a.b', '- n'])
  })

  it('parses missing arguments as an empty object', async () => {
    let seen: unknown
    await serve([fakeMcpTool('mcp__fake__noargs', { call: async (input: unknown) => ((seen = input), { data: 'done' }) })])
    const result = await callRaw('mcp__fake__noargs')
    expect(result).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false })
    expect(seen).toEqual({})
  })

  it('answers an unknown tool with a JSON-RPC error, not a result', async () => {
    await serve()
    const error = await callRaw('NoSuchTool').catch(e => e)
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).code).toBe(-32603)
    expect((error as McpError).message).toContain('Tool NoSuchTool not found')
  })

  it('refuses a disabled tool as an isError result', async () => {
    const call = mock(async () => ({ data: 'never' }))
    await serve([fakeMcpTool('mcp__fake__off', { isEnabled: () => false, call })])
    const result = await callRaw('mcp__fake__off')
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Tool mcp__fake__off is not enabled' }] })
    expect(call).not.toHaveBeenCalled()
  })

  it('applies resolveInput, and refuses when it is not ok', async () => {
    let seen: unknown
    await serve([
      fakeMcpTool('mcp__fake__resolved', {
        resolveInput: async (input: { q?: string }) => ({ ok: true, input: { q: `${input.q}!` } }),
        call: async (input: unknown) => ((seen = input), { data: 'r' }),
      }),
      fakeMcpTool('mcp__fake__unresolved', { resolveInput: () => ({ ok: false, message: 'no glob matched' }) }),
    ])
    await callRaw('mcp__fake__resolved', { q: 'hi' })
    expect(seen).toEqual({ q: 'hi!' })
    const result = await callRaw('mcp__fake__unresolved', { q: 'x' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe('Tool mcp__fake__unresolved input is invalid: no glob matched')
  })

  it('maps array results block by block, warning on the ones it cannot map', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    await serve([
      fakeMcpTool('mcp__fake__blocks', {
        call: async () => ({
          data: [
            { type: 'text', text: 'hello' },
            { type: 'text' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'image' },
            { kind: 'odd' },
          ],
        }),
      }),
    ])
    const result = await callRaw('mcp__fake__blocks')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '{"type":"image"}' },
      { type: 'text', text: '{"kind":"odd"}' },
    ])
    expect(warn.mock.calls.map(c => c[0])).toEqual([
      'Unmapped content block type from tool mcp__fake__blocks: image',
      'Unmapped content block type from tool mcp__fake__blocks: unknown',
    ])
  })

  it('carries a tool result isError through', async () => {
    await serve([fakeMcpTool('mcp__fake__failing', { call: async () => ({ data: 'bad', isError: true }) })])
    expect(await callRaw('mcp__fake__failing')).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true })
  })

  it('answers a throwing tool with its error parts, or a bare "Error"', async () => {
    const thrown = Object.assign(new Error('boom'), { stderr: 'err out', stdout: '' })
    await serve([
      fakeMcpTool('mcp__fake__throws', { call: async () => { throw thrown } }),
      fakeMcpTool('mcp__fake__throws_string', { call: async () => { throw 'plain string' } }),
      fakeMcpTool('mcp__fake__throws_empty', { call: async () => { throw new Error('') } }),
    ])
    const texts = async (name: string) => {
      const result = await callRaw(name)
      expect(result.isError).toBe(true)
      return (result.content[0] as { text: string }).text
    }
    expect(await texts('mcp__fake__throws')).toBe('boom\nerr out')
    expect(await texts('mcp__fake__throws_string')).toBe('plain string')
    expect(await texts('mcp__fake__throws_empty')).toBe('Error')
  })

  it('hands the tool a non-interactive context with the serve flags, the review command and the MCP clients', async () => {
    const contexts: ToolUseContext[] = []
    const tool = fakeMcpTool('mcp__fake__ctx', {
      call: async (_input: unknown, ctx: ToolUseContext) => (contexts.push(ctx), { data: 'ctx' }),
    })
    await serve([tool], true, false)
    await callRaw('mcp__fake__ctx')
    await callRaw('mcp__fake__ctx')
    const [first, second] = contexts
    expect(first!.options.isNonInteractiveSession).toBe(true)
    expect(first!.options.debug).toBe(true)
    expect(first!.options.verbose).toBe(false)
    expect(first!.options.thinkingConfig).toEqual({ type: 'disabled' })
    expect(first!.options.commands.map(c => c.name)).toEqual(['review'])
    expect(first!.options.mcpClients).toEqual([fakeConnection])
    expect(first!.options.tools[0]).toBe(tool)
    expect(first!.messages).toEqual([])
    // One LRU read-file cache per server, shared by every call; a fresh
    // abort controller per call.
    expect(second!.readFileState).toBe(first!.readFileState)
    expect(second!.abortController).not.toBe(first!.abortController)
  })

  it('does not abort the tool when the client cancels the request (the cancellation gap)', async () => {
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let toolSignal: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>(resolve => (entered = resolve))
    const { received } = await serve([
      fakeMcpTool('mcp__fake__slow', {
        call: async (_input: unknown, ctx: ToolUseContext) => {
          toolSignal = ctx.abortController.signal
          entered()
          await released
          return { data: 'late' }
        },
      }),
    ])
    const requestAbort = new AbortController()
    const pending = client!.callTool({ name: 'mcp__fake__slow' }, undefined, { signal: requestAbort.signal }).catch(e => e)
    await started
    requestAbort.abort('user cancelled')
    const error = await pending
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).message).toContain('user cancelled')
    // Let notifications/cancelled reach the server before looking.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toContain('notifications/cancelled')
    expect(toolSignal!.aborted).toBe(false)
    release()
  })
})
