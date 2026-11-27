import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { Command } from 'src/commands/commands.js'
import {
  connectInMemoryMcpServer,
  type InMemoryMcpServer,
  type InMemoryServerSpec,
} from 'src/mcp/__testutils__/inMemoryMcpServer.js'
import * as auth from 'src/mcp/auth.js'
import * as claudeai from 'src/mcp/claudeai.js'
import * as authCache from 'src/mcp/client/authCache.js'
import * as callToolModule from 'src/mcp/client/callTool.js'
import * as connection from 'src/mcp/client/connection.js'
import { McpSessionExpiredError } from 'src/mcp/client/errors.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchResourceTemplatesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  mcpToolInputToAutoClassifierInput,
  prefetchAllMcpResources,
  reconnectMcpServerImpl,
} from 'src/mcp/client/fetchCapabilities.js'
import * as mcpConfig from 'src/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'
import * as log from 'src/shared/log.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import type { MCPProgress } from 'src/tools/MCPTool/MCPTool.js'

// --- harness ---------------------------------------------------------------

const servers: InMemoryMcpServer[] = []
const usedNames = new Set<string>()
const spies: Array<{ mockRestore: () => void }> = []

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const server of servers.splice(0)) await server.close()
  for (const name of usedNames) {
    fetchToolsForClient.cache.delete(name)
    fetchResourcesForClient.cache.delete(name)
    fetchResourceTemplatesForClient.cache.delete(name)
    fetchCommandsForClient.cache.delete(name)
  }
  usedNames.clear()
})

function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy)
  return spy
}

async function serve(
  name: string,
  spec: InMemoryServerSpec,
  config?: ScopedMcpServerConfig,
): Promise<InMemoryMcpServer['connection']> {
  usedNames.add(name)
  const server = await connectInMemoryMcpServer(name, spec, config)
  servers.push(server)
  return server.connection
}

const OBJECT_SCHEMA = { type: 'object' as const }

function mcpTool(name: string, extra: Record<string, unknown> = {}) {
  return { name, inputSchema: OBJECT_SCHEMA, ...extra }
}

async function toolsOf(name: string, spec: InMemoryServerSpec): Promise<Tool[]> {
  return fetchToolsForClient(await serve(name, spec))
}

type LooseCall = (
  args: Record<string, unknown>,
  context: ToolUseContext,
  canUseTool: unknown,
  parentMessage: unknown,
  onProgress?: (p: { toolUseID: string; data: MCPProgress }) => void,
) => Promise<{ data: unknown; mcpMeta?: Record<string, unknown> }>

function callOf(tool: Tool): LooseCall {
  return tool.call.bind(tool) as unknown as LooseCall
}

function makeContext(abort = new AbortController()): ToolUseContext {
  return {
    abortController: abort,
    setAppState: () => {},
  } as unknown as ToolUseContext
}

const TOOL_USE_MESSAGE = {
  message: { content: [{ type: 'tool_use', id: 'toolu_cover_1', name: 'x', input: {} }] },
}
const TEXT_MESSAGE = { message: { content: [{ type: 'text', text: 'hi' }] } }

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function stdioConfig(extra: Record<string, unknown> = {}): ScopedMcpServerConfig {
  return { type: 'stdio', command: 'unused', args: [], scope: 'local', ...extra } as ScopedMcpServerConfig
}

function httpConfig(url = 'https://mcp.invalid/mcp'): ScopedMcpServerConfig {
  return { type: 'http', url, scope: 'local' } as ScopedMcpServerConfig
}

// A connection whose lists answer from fixed pages without a protocol round
// trip, for the paths that only need what the fetchers make of a list. Every
// entry here is well-formed, so the wire filter would pass it unchanged.
function staticConnection(
  name: string,
  config: ScopedMcpServerConfig,
  lists: { tools?: unknown[]; prompts?: unknown[]; resources?: unknown[] },
): MCPServerConnection {
  usedNames.add(name)
  return {
    type: 'connected',
    name,
    config,
    cleanup: async () => {},
    capabilities: {
      ...(lists.tools && { tools: {} }),
      ...(lists.prompts && { prompts: {} }),
      ...(lists.resources && { resources: {} }),
    },
    client: {
      listTools: async () => ({ tools: lists.tools ?? [] }),
      listPrompts: async () => ({ prompts: lists.prompts ?? [] }),
      listResources: async () => ({ resources: lists.resources ?? [] }),
    },
  } as unknown as MCPServerConnection
}

// --- tools/list → Tool -----------------------------------------------------

describe('the Tool objects built from a server tools/list', () => {
  test('names the tool mcp__<server>__<tool> and keeps the raw names in mcpInfo', async () => {
    const [tool] = await toolsOf('cover-names', { tools: [mcpTool('do_thing')] })
    expect(tool!.name).toBe('mcp__cover-names__do_thing')
    expect(tool!.mcpInfo).toEqual({ serverName: 'cover-names', toolName: 'do_thing' })
    expect(tool!.isMcp).toBe(true)
  })

  test('userFacingName prefers the title annotation and falls back to the tool name', async () => {
    const tools = await toolsOf('cover-title', {
      tools: [mcpTool('titled', { annotations: { title: 'Pretty Title' } }), mcpTool('plain')],
    })
    expect(tools.map(t => t.userFacingName(undefined as never))).toEqual([
      'cover-title - Pretty Title (MCP)',
      'cover-title - plain (MCP)',
    ])
  })

  test('readOnly/destructive/openWorld hints drive the tool predicates', async () => {
    const [hinted, bare] = await toolsOf('cover-hints', {
      tools: [
        mcpTool('hinted', {
          annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
        }),
        mcpTool('bare'),
      ],
    })
    const flags = (t: Tool) => [
      t.isReadOnly({} as never),
      t.isConcurrencySafe({} as never),
      t.isDestructive?.({} as never),
      t.isOpenWorld?.({} as never),
    ]
    expect(flags(hinted!)).toEqual([true, true, true, true])
    expect(flags(bare!)).toEqual([false, false, false, false])
  })

  test('description() is the whole text and prompt() truncates past 2048 chars', async () => {
    const long = 'x'.repeat(connection.MAX_MCP_DESCRIPTION_LENGTH + 10)
    const [longTool, shortTool, noDesc] = await toolsOf('cover-desc', {
      tools: [
        mcpTool('long', { description: long }),
        mcpTool('short', { description: 'Short one' }),
        mcpTool('none'),
      ],
    })
    expect(await longTool!.description({} as never, {} as never)).toBe(long)
    expect(await longTool!.prompt({} as never)).toBe(
      'x'.repeat(connection.MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]',
    )
    expect(await shortTool!.prompt({} as never)).toBe('Short one')
    expect(await noDesc!.description({} as never, {} as never)).toBe('')
    expect(await noDesc!.prompt({} as never)).toBe('')
  })

  test('searchHint collapses whitespace, and alwaysLoad needs a literal true', async () => {
    const tools = await toolsOf('cover-meta', {
      tools: [
        mcpTool('hinted', {
          _meta: { 'anthropic/searchHint': '  find\n  things\tfast ', 'anthropic/alwaysLoad': true },
        }),
        mcpTool('blank', { _meta: { 'anthropic/searchHint': ' \n ', 'anthropic/alwaysLoad': 'yes' } }),
        mcpTool('none'),
      ],
    })
    expect(tools.map(t => [t.searchHint, t.alwaysLoad])).toEqual([
      ['find things fast', true],
      [undefined, false],
      [undefined, false],
    ])
  })

  test('the input schema passes through and the classifier input lists key=value pairs', async () => {
    const schema = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] }
    const [tool] = await toolsOf('cover-schema', { tools: [mcpTool('q', { inputSchema: schema })] })
    expect(tool!.inputJSONSchema).toEqual(schema)
    expect(tool!.toAutoClassifierInput({ q: 'term', n: 2 } as never)).toBe('q=term n=2')
    expect(tool!.toAutoClassifierInput({} as never)).toBe('q')
    expect(mcpToolInputToAutoClassifierInput({}, 'fallback')).toBe('fallback')
  })

  test('isSearchOrReadCommand classifies by the raw tool name', async () => {
    const [search, write] = await toolsOf('cover-collapse', {
      tools: [mcpTool('search_code'), mcpTool('create_issue')],
    })
    expect(search!.isSearchOrReadCommand?.({} as never)).toMatchObject({ isSearch: true })
    expect(write!.isSearchOrReadCommand?.({} as never)).toMatchObject({ isSearch: false, isRead: false })
  })

  test('checkPermissions passes through with an allow rule for the qualified name', async () => {
    const [tool] = await toolsOf('cover-perm', { tools: [mcpTool('act')] })
    expect(await tool!.checkPermissions({} as never, {} as never)).toEqual({
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'mcp__cover-perm__act', ruleContent: undefined }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })
  })

  test('the ide server keeps only executeCode and getDiagnostics', async () => {
    const tools = await toolsOf('ide', {
      tools: [mcpTool('executeCode'), mcpTool('getDiagnostics'), mcpTool('openDiff')],
    })
    expect(tools.map(t => t.name)).toEqual(['mcp__ide__executeCode', 'mcp__ide__getDiagnostics'])
  })

  test('an sdk server under CLAUDE_AGENT_SDK_MCP_NO_PREFIX keeps the bare name but a qualified rule', async () => {
    const saved = process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
    process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
    try {
      const [tool] = await toolsOf('cover-noprefix', { tools: [mcpTool('Read')] })
      expect(tool!.name).toBe('Read')
      const perm = (await tool!.checkPermissions({} as never, {} as never)) as {
        suggestions: Array<{ rules: Array<{ toolName: string }> }>
      }
      expect(perm.suggestions[0]!.rules[0]!.toolName).toBe('mcp__cover-noprefix__Read')
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
      else process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = saved
    }
  })

  test('a non-sdk server ignores CLAUDE_AGENT_SDK_MCP_NO_PREFIX', async () => {
    const saved = process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
    process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
    try {
      const client = staticConnection('cover-noprefix-stdio', stdioConfig(), { tools: [mcpTool('Read')] })
      expect((await fetchToolsForClient(client)).map(t => t.name)).toEqual(['mcp__cover-noprefix-stdio__Read'])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
      else process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = saved
    }
  })

  test('a server without the tools capability, or not connected, lists none', async () => {
    const noTools = await serve('cover-no-tools', { prompts: [] })
    expect(await fetchToolsForClient(noTools)).toEqual([])
    const failed = { name: 'cover-failed', type: 'failed', config: stdioConfig() } as MCPServerConnection
    expect(await fetchToolsForClient(failed)).toEqual([])
    expect(await fetchResourcesForClient(failed)).toEqual([])
    expect(await fetchResourceTemplatesForClient(failed)).toEqual([])
    expect(await fetchCommandsForClient(failed)).toEqual([])
  })
})

// --- Tool.call --------------------------------------------------------------

describe('call() on an MCP tool', () => {
  test('returns the text content, sends the tool_use id in _meta and reports progress', async () => {
    const seen: Array<{ args: unknown; meta: unknown }> = []
    const [tool] = await toolsOf('cover-call', {
      tools: [mcpTool('echo')],
      callTool: async (_name, args, extra) => {
        seen.push({ args, meta: extra.requestMeta?.['claudecode/toolUseId'] })
        const token = extra.requestMeta?.progressToken as string | number | undefined
        if (token !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1, total: 2, message: 'half' },
          })
        }
        return { content: [{ type: 'text', text: `echo ${String(args?.word)}` }] }
      },
    })
    const progress: Array<{ toolUseID: string; data: MCPProgress }> = []
    const result = await callOf(tool!)({ word: 'hi' }, makeContext(), undefined, TOOL_USE_MESSAGE, p =>
      progress.push(p),
    )

    expect(result).toEqual({ data: [{ type: 'text', text: 'echo hi' }] })
    expect(seen).toEqual([{ args: { word: 'hi' }, meta: 'toolu_cover_1' }])
    expect(progress.map(p => [p.toolUseID, p.data.status])).toEqual([
      ['toolu_cover_1', 'started'],
      ['toolu_cover_1', 'progress'],
      ['toolu_cover_1', 'completed'],
    ])
    const [started, mid, done] = progress.map(p => p.data as Record<string, unknown>)
    expect(started).toMatchObject({ type: 'mcp_progress', serverName: 'cover-call', toolName: 'echo' })
    expect(mid).toMatchObject({ progress: 1, total: 2, progressMessage: 'half', startedAt: started!.startedAt })
    expect(typeof done!.elapsedTimeMs).toBe('number')
  })

  test('without a tool_use parent it sends no toolUseId and reports no progress', async () => {
    const metas: unknown[] = []
    const [tool] = await toolsOf('cover-call-noid', {
      tools: [mcpTool('echo')],
      callTool: async (_n, _a, extra) => {
        metas.push(extra.requestMeta?.['claudecode/toolUseId'])
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const progress: unknown[] = []
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE, p => progress.push(p))
    expect(result.data).toEqual([{ type: 'text', text: 'ok' }])
    expect(metas).toEqual([undefined])
    expect(progress).toEqual([])
  })

  test('structuredContent and _meta come back as mcpMeta', async () => {
    const [tool] = await toolsOf('cover-structured', {
      tools: [mcpTool('data')],
      callTool: () => ({
        content: [{ type: 'text', text: '{"n":1}' }],
        structuredContent: { n: 1 },
        _meta: { trace: 'abc' },
      }),
    })
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE)
    expect(result.mcpMeta).toEqual({ _meta: { trace: 'abc' }, structuredContent: { n: 1 } })
  })

  test('only structuredContent leaves _meta out of mcpMeta', async () => {
    const [tool] = await toolsOf('cover-structured-only', {
      tools: [mcpTool('data')],
      callTool: () => ({ content: [], structuredContent: { ok: true } }),
    })
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE)
    expect(result.mcpMeta).toEqual({ structuredContent: { ok: true } })
  })

  test('an image result comes back as an image block', async () => {
    const [tool] = await toolsOf('cover-image', {
      tools: [mcpTool('shot')],
      callTool: () => ({ content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] }),
    })
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE)
    const blocks = result.data as Array<{ type: string; source?: { type: string; media_type: string } }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('image')
    expect(blocks[0]!.source).toMatchObject({ type: 'base64', media_type: 'image/png' })
  })

  test('an isError result throws its text and reports failed progress', async () => {
    const [tool] = await toolsOf('cover-iserror', {
      tools: [mcpTool('boom')],
      callTool: () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }),
    })
    const progress: Array<{ data: MCPProgress }> = []
    const logged = track(spyOn(log, 'logMCPError'))
    const error = await callOf(tool!)({}, makeContext(), undefined, TOOL_USE_MESSAGE, p => progress.push(p)).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    expect((error as Error).name).toBe('McpToolCallError')
    expect((error as Error).message).toBe('it broke')
    expect(progress.map(p => p.data.status)).toEqual(['started', 'failed'])
    expect(logged.mock.calls).toContainEqual(['cover-iserror', 'it broke'])
  })

  test('a JSON-RPC error from the server is rethrown telemetry-safe with its code', async () => {
    const [tool] = await toolsOf('cover-rpcerror', {
      tools: [mcpTool('boom')],
      callTool: () => {
        throw new Error('handler exploded')
      },
    })
    const error = (await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE).catch((e: unknown) => e)) as
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    expect(error).toBeInstanceOf(TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    expect(error.message).toContain('handler exploded')
    expect(error.telemetryMessage).toBe('McpError -32603')
  })

  test('a plain Error is rethrown telemetry-safe with its message', async () => {
    const [tool] = await toolsOf('cover-aborted', { tools: [mcpTool('slow')] })
    const abort = new AbortController()
    abort.abort()
    const error = (await callOf(tool!)({}, makeContext(abort), undefined, TEXT_MESSAGE).catch((e: unknown) => e)) as
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    expect(error).toBeInstanceOf(TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    expect(error.message).toBe('Tool call aborted during URL elicitation')
    expect(error.telemetryMessage).toBe('Tool call aborted during URL elicitation')
  })

  test('an expired session is retried once with a fresh client', async () => {
    const [tool] = await toolsOf('cover-expired', { tools: [mcpTool('t')] })
    let calls = 0
    track(
      spyOn(callToolModule, 'callMCPToolWithUrlElicitationRetry').mockImplementation(async () => {
        calls++
        if (calls === 1) throw new McpSessionExpiredError('cover-expired')
        return { content: 'second try' }
      }),
    )
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE)
    expect(result).toEqual({ data: 'second try' })
    expect(calls).toBe(2)
  })

  test('a session that expires twice surfaces the expiry unwrapped', async () => {
    const [tool] = await toolsOf('cover-expired-twice', { tools: [mcpTool('t')] })
    const spy = track(
      spyOn(callToolModule, 'callMCPToolWithUrlElicitationRetry').mockImplementation(async () => {
        throw new McpSessionExpiredError('cover-expired-twice')
      }),
    )
    const error = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(McpSessionExpiredError)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('a non-Error throw passes through untouched', async () => {
    const [tool] = await toolsOf('cover-nonerror', { tools: [mcpTool('t')] })
    track(
      spyOn(callToolModule, 'callMCPToolWithUrlElicitationRetry').mockImplementation(async () => {
        throw 'just a string'
      }),
    )
    expect(await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE).catch((e: unknown) => e)).toBe(
      'just a string',
    )
  })

  test('a non-sdk server calls through the connection connectToServer hands back', async () => {
    const live = await serve('cover-live', {
      tools: [mcpTool('who')],
      callTool: () => ({ content: [{ type: 'text', text: 'from the live connection' }] }),
    })
    const stale = staticConnection('cover-stale', stdioConfig(), { tools: [mcpTool('who')] })
    const [tool] = await fetchToolsForClient(stale)
    const connect = track(spyOn(connection, 'connectToServer').mockResolvedValue(live))
    const result = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE)
    expect(result.data).toEqual([{ type: 'text', text: 'from the live connection' }])
    expect(connect.mock.calls[0]!.slice(0, 2)).toEqual(['cover-stale', stale.config])
  })

  test('a non-sdk server that no longer connects fails the call', async () => {
    const stale = staticConnection('cover-gone', stdioConfig(), { tools: [mcpTool('who')] })
    const [tool] = await fetchToolsForClient(stale)
    track(
      spyOn(connection, 'connectToServer').mockResolvedValue({
        name: 'cover-gone',
        type: 'failed',
        config: stale.config,
      }),
    )
    const error = await callOf(tool!)({}, makeContext(), undefined, TEXT_MESSAGE).catch((e: unknown) => e)
    expect((error as Error).message).toBe('MCP server "cover-gone" is not connected')
  })
})

// --- prompts/list → Command ------------------------------------------------

type PromptCommand = Command & {
  argNames: string[]
  getPromptForCommand: (args: string) => Promise<unknown>
  userFacingName: () => string
}

describe('prompts as commands', () => {
  test('a prompt becomes a prompt command with its argument names', async () => {
    const client = await serve('cover prompts.v1', {
      prompts: [
        {
          name: 'review',
          description: 'Review a file',
          arguments: [{ name: 'file', required: true }, { name: 'focus' }],
        },
        { name: 'bare' },
      ],
    })
    const [review, bare] = (await fetchCommandsForClient(client)) as PromptCommand[]
    expect(review).toMatchObject({
      type: 'prompt',
      name: 'mcp__cover_prompts_v1__review',
      description: 'Review a file',
      hasUserSpecifiedDescription: true,
      contentLength: 0,
      isHidden: false,
      isMcp: true,
      progressMessage: 'running',
      argNames: ['file', 'focus'],
      source: 'mcp',
    })
    expect(review!.isEnabled?.()).toBe(true)
    expect(review!.userFacingName()).toBe('cover prompts.v1:review (MCP)')
    expect(bare).toMatchObject({ description: '', hasUserSpecifiedDescription: false, argNames: [] })
  })

  test('getPromptForCommand sends the arguments and returns the transformed messages', async () => {
    const received: unknown[] = []
    const client = await serve('cover-getprompt', {
      prompts: [{ name: 'greet', arguments: [{ name: 'who' }] }],
      getPrompt: (name, args) => {
        received.push({ name, args })
        return {
          messages: [
            { role: 'user', content: { type: 'text', text: `hello ${args?.who}` } },
            { role: 'assistant', content: { type: 'text', text: 'second' } },
          ],
        }
      },
    })
    const [greet] = (await fetchCommandsForClient(client)) as PromptCommand[]
    expect(await greet!.getPromptForCommand('world')).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'text', text: 'second' },
    ])
    expect(received).toEqual([{ name: 'greet', args: { who: 'world' } }])
  })

  test('a failing getPrompt is logged and rethrown', async () => {
    const client = await serve('cover-badprompt', {
      prompts: [{ name: 'broken' }],
      getPrompt: () => {
        throw new Error('no such prompt today')
      },
    })
    const [broken] = (await fetchCommandsForClient(client)) as PromptCommand[]
    const logged = track(spyOn(log, 'logMCPError'))
    const error = await broken!.getPromptForCommand('').catch((e: unknown) => e)
    expect((error as Error).message).toContain('no such prompt today')
    expect(logged.mock.calls.map(c => String(c[1]))).toContainEqual(
      expect.stringMatching(/^Error running command 'broken': .*no such prompt today/),
    )
  })

  test('a server without the prompts capability has no commands', async () => {
    expect(await fetchCommandsForClient(await serve('cover-noprompts', { tools: [] }))).toEqual([])
  })
})

// --- resources and templates ------------------------------------------------

describe('resources and resource templates', () => {
  test('resources carry the server name', async () => {
    const client = await serve('cover-res', {
      resources: [{ uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain' }],
    })
    expect(await fetchResourcesForClient(client)).toEqual([
      { uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain', server: 'cover-res' },
    ])
  })

  test('a server without the resources capability lists neither', async () => {
    const client = await serve('cover-nores', { tools: [] })
    expect(await fetchResourcesForClient(client)).toEqual([])
    expect(await fetchResourceTemplatesForClient(client)).toEqual([])
  })

  test('templates carry the server name', async () => {
    const client = await serve('cover-tpl', {
      resources: [],
      resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
    })
    expect(await fetchResourceTemplatesForClient(client)).toEqual([
      { uriTemplate: 'file:///{path}', name: 'file', server: 'cover-tpl' },
    ])
  })

  test('a server without templates/list answers none without logging an error', async () => {
    const client = await serve('cover-tpl-missing', { resources: [] })
    const logged = track(spyOn(log, 'logMCPError'))
    expect(await fetchResourceTemplatesForClient(client)).toEqual([])
    expect(logged).not.toHaveBeenCalled()
  })

  test('any other templates/list failure answers none and is logged', async () => {
    const client = await serve('cover-tpl-broken', {
      resources: [],
      resourceTemplates: () => {
        throw new Error('templates exploded')
      },
    })
    const logged = track(spyOn(log, 'logMCPError'))
    expect(await fetchResourceTemplatesForClient(client)).toEqual([])
    expect(logged.mock.calls.map(c => String(c[1]))).toContainEqual(
      expect.stringMatching(/^Failed to fetch resource templates, listing none: .*templates exploded/),
    )
  })
})

// --- reconnect ---------------------------------------------------------------

function stubConnect(impl: (name: string, config: ScopedMcpServerConfig) => Promise<MCPServerConnection>) {
  return track(
    spyOn(connection, 'connectToServer').mockImplementation(((name: string, config: ScopedMcpServerConfig) =>
      impl(name, config)) as unknown as typeof connection.connectToServer),
  )
}

describe('reconnectMcpServerImpl', () => {
  test('clears the old connection, then returns tools, commands, resources and the resource tools', async () => {
    const config = stdioConfig()
    const clear = track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    stubConnect(async name =>
      staticConnection(name, config, {
        tools: [mcpTool('t')],
        prompts: [{ name: 'p' }],
        resources: [{ uri: 'file:///r', name: 'r' }],
      }),
    )
    const result = await reconnectMcpServerImpl('cover-reconnect', config)
    expect(clear.mock.calls).toEqual([['cover-reconnect', config]])
    expect(result.client.type).toBe('connected')
    expect(result.tools.map(t => t.name)).toEqual([
      'mcp__cover-reconnect__t',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
    ])
    expect(result.commands.map(c => c.name)).toEqual(['mcp__cover-reconnect__p'])
    expect(result.resources?.map(r => r.uri)).toEqual(['file:///r'])
  })

  test('a server without resources gets no resource tools and no resources field', async () => {
    const config = stdioConfig()
    track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    stubConnect(async name => staticConnection(name, config, { tools: [mcpTool('t')] }))
    const result = await reconnectMcpServerImpl('cover-reconnect-nores', config)
    expect(result.tools.map(t => t.name)).toEqual(['mcp__cover-reconnect-nores__t'])
    expect(result.commands).toEqual([])
    expect(result.resources).toBeUndefined()
  })

  test('an empty resource list leaves the resources field out but keeps the resource tools', async () => {
    const config = stdioConfig()
    track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    stubConnect(async name => staticConnection(name, config, { resources: [] }))
    const result = await reconnectMcpServerImpl('cover-reconnect-empty', config)
    expect(result.tools.map(t => t.name)).toEqual(['ListMcpResourcesTool', 'ReadMcpResourceTool'])
    expect(result.resources).toBeUndefined()
  })

  test('a server that already exposes a resource tool by that name does not get ours', async () => {
    const config = { type: 'sdk', name: 'cover-reconnect-dup', scope: 'local' } as ScopedMcpServerConfig
    const saved = process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
    process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
    try {
      track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
      stubConnect(async name =>
        staticConnection(name, config, { tools: [mcpTool('ListMcpResourcesTool')], resources: [] }),
      )
      const result = await reconnectMcpServerImpl('cover-reconnect-dup', config)
      expect(result.tools.map(t => t.name)).toEqual(['ListMcpResourcesTool'])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
      else process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = saved
    }
  })

  test('a connection that does not come up returns it with no tools or commands', async () => {
    const config = httpConfig()
    track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    stubConnect(async name => ({ name, type: 'needs-auth', config }))
    expect(await reconnectMcpServerImpl('cover-reconnect-auth', config)).toEqual({
      client: { name: 'cover-reconnect-auth', type: 'needs-auth', config },
      tools: [],
      commands: [],
    })
  })

  test('a connect that throws returns a failed client', async () => {
    const config = stdioConfig()
    track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    stubConnect(async () => {
      throw new Error('spawn failed')
    })
    const logged = track(spyOn(log, 'logMCPError'))
    expect(await reconnectMcpServerImpl('cover-reconnect-throw', config)).toEqual({
      client: { name: 'cover-reconnect-throw', type: 'failed', config },
      tools: [],
      commands: [],
    })
    expect(logged.mock.calls).toContainEqual(['cover-reconnect-throw', 'Error during reconnection: spawn failed'])
  })

  test('a claude.ai proxy server is marked as having connected', async () => {
    const config = { type: 'claudeai-proxy', url: 'https://x.invalid', id: 'x', scope: 'claudeai' } as ScopedMcpServerConfig
    track(spyOn(connection, 'clearServerCache').mockResolvedValue(undefined))
    const mark = track(spyOn(claudeai, 'markClaudeAiMcpConnected').mockImplementation(() => {}))
    stubConnect(async name => staticConnection(name, config, {}))
    await reconnectMcpServerImpl('cover-reconnect-proxy', config)
    expect(mark.mock.calls).toEqual([['cover-reconnect-proxy']])
  })
})

// --- connect-all ---------------------------------------------------------------

type Attempt = Parameters<Parameters<typeof getMcpToolsCommandsAndResources>[0]>[0]

function stubAuthGates(opts: { disabled?: string[]; authCached?: string[]; discoveryNoToken?: string[] } = {}) {
  track(spyOn(mcpConfig, 'isMcpServerDisabled').mockImplementation(name => (opts.disabled ?? []).includes(name)))
  track(spyOn(authCache, 'isMcpAuthCached').mockImplementation(async name => (opts.authCached ?? []).includes(name)))
  track(
    spyOn(auth, 'hasMcpDiscoveryButNoToken').mockImplementation(name => (opts.discoveryNoToken ?? []).includes(name)),
  )
}

async function connectAll(configs: Record<string, ScopedMcpServerConfig>): Promise<Map<string, Attempt>> {
  const attempts = new Map<string, Attempt>()
  await getMcpToolsCommandsAndResources(a => attempts.set(a.client.name, a), configs)
  return attempts
}

describe('getMcpToolsCommandsAndResources', () => {
  test('a disabled server is reported disabled without connecting', async () => {
    stubAuthGates({ disabled: ['cover-off'] })
    const connect = stubConnect(async () => {
      throw new Error('must not connect')
    })
    const config = stdioConfig()
    const attempts = await connectAll({ 'cover-off': config })
    expect(attempts.get('cover-off')).toEqual({
      client: { name: 'cover-off', type: 'disabled', config },
      tools: [],
      commands: [],
    })
    expect(connect).not.toHaveBeenCalled()
  })

  test('a server disabled after the partition is still reported disabled without connecting', async () => {
    stubAuthGates()
    let checks = 0
    track(spyOn(mcpConfig, 'isMcpServerDisabled').mockImplementation(() => ++checks > 1))
    const connect = stubConnect(async () => {
      throw new Error('must not connect')
    })
    const attempts = await connectAll({ 'cover-late-off': stdioConfig() })
    expect(attempts.get('cover-late-off')!.client.type).toBe('disabled')
    expect(connect).not.toHaveBeenCalled()
  })

  test('a remote server with a cached 401, or discovery but no token, is needs-auth with the auth tool', async () => {
    stubAuthGates({ authCached: ['cover-401'], discoveryNoToken: ['cover-notoken'] })
    const connect = stubConnect(async () => {
      throw new Error('must not connect')
    })
    const attempts = await connectAll({
      'cover-401': httpConfig('https://a.invalid/mcp'),
      'cover-notoken': { type: 'sse', url: 'https://b.invalid/sse', scope: 'local' } as ScopedMcpServerConfig,
    })
    for (const name of ['cover-401', 'cover-notoken']) {
      const attempt = attempts.get(name)!
      expect(attempt.client.type).toBe('needs-auth')
      expect(attempt.tools.map(t => t.name)).toEqual([`mcp__${name}__authenticate`])
    }
    expect(connect).not.toHaveBeenCalled()
  })

  test('a connect that answers needs-auth or failed is reported as such', async () => {
    stubAuthGates()
    stubConnect(async (name, config) =>
      name === 'cover-needs' ? { name, type: 'needs-auth', config } : { name, type: 'failed', config, error: 'x' },
    )
    const attempts = await connectAll({ 'cover-needs': httpConfig(), 'cover-broken': stdioConfig() })
    expect(attempts.get('cover-needs')!.tools.map(t => t.name)).toEqual(['mcp__cover-needs__authenticate'])
    expect(attempts.get('cover-broken')).toMatchObject({ client: { type: 'failed' }, tools: [], commands: [] })
  })

  test('connected servers bring their lists, and only the first with resources brings the resource tools', async () => {
    stubAuthGates()
    stubConnect(async (name, config) =>
      staticConnection(name, config, {
        tools: [mcpTool('t')],
        prompts: [{ name: 'p' }],
        resources: [{ uri: `file:///${name}`, name }],
      }),
    )
    const attempts = await connectAll({ 'cover-a': stdioConfig(), 'cover-b': stdioConfig({ command: 'other' }) })
    const resourceToolCount = [...attempts.values()].filter(a =>
      a.tools.some(t => t.name === 'ListMcpResourcesTool'),
    ).length
    expect(resourceToolCount).toBe(1)
    for (const name of ['cover-a', 'cover-b']) {
      const attempt = attempts.get(name)!
      expect(attempt.tools.map(t => t.name)).toContain(`mcp__${name}__t`)
      expect(attempt.commands.map(c => c.name)).toEqual([`mcp__${name}__p`])
      expect(attempt.resources?.map(r => r.uri)).toEqual([`file:///${name}`])
    }
  })

  test('a server without resources has no resources field', async () => {
    stubAuthGates()
    stubConnect(async (name, config) => staticConnection(name, config, { tools: [mcpTool('t')] }))
    const attempts = await connectAll({ 'cover-plain': stdioConfig() })
    expect(attempts.get('cover-plain')!.resources).toBeUndefined()
    expect(attempts.get('cover-plain')!.tools.map(t => t.name)).toEqual(['mcp__cover-plain__t'])
  })

  test('connect receives the transport counts of the active servers', async () => {
    stubAuthGates({ disabled: ['cover-stat-off'] })
    const connect = stubConnect(async (name, config) => ({ name, type: 'failed', config }))
    await connectAll({
      'cover-stat-stdio': stdioConfig(),
      'cover-stat-http': httpConfig(),
      'cover-stat-sse': { type: 'sse', url: 'https://s.invalid', scope: 'local' } as ScopedMcpServerConfig,
      'cover-stat-sseide': { type: 'sse-ide', url: 'http://127.0.0.1:1', ideName: 'x', scope: 'local' } as ScopedMcpServerConfig,
      'cover-stat-wside': { type: 'ws-ide', url: 'ws://127.0.0.1:1', ideName: 'x', scope: 'local' } as ScopedMcpServerConfig,
      'cover-stat-off': stdioConfig(),
    })
    expect(connect).toHaveBeenCalledTimes(5)
    for (const call of connect.mock.calls) {
      expect((call as unknown[])[2]).toEqual({
        totalServers: 5,
        stdioCount: 1,
        sseCount: 1,
        httpCount: 1,
        sseIdeCount: 1,
        wsIdeCount: 1,
      })
    }
  })

  test('a connect that throws reports a failed client', async () => {
    stubAuthGates()
    stubConnect(async () => {
      throw new Error('kaboom')
    })
    const logged = track(spyOn(log, 'logMCPError'))
    const config = stdioConfig()
    const attempts = await connectAll({ 'cover-throw': config })
    expect(attempts.get('cover-throw')).toEqual({
      client: { name: 'cover-throw', type: 'failed', config },
      tools: [],
      commands: [],
    })
    expect(logged.mock.calls).toContainEqual(['cover-throw', 'Error fetching tools/commands/resources: kaboom'])
  })

  test('a claude.ai proxy server is marked as having connected', async () => {
    stubAuthGates()
    const mark = track(spyOn(claudeai, 'markClaudeAiMcpConnected').mockImplementation(() => {}))
    const config = { type: 'claudeai-proxy', url: 'https://x.invalid', id: 'x', scope: 'claudeai' } as ScopedMcpServerConfig
    stubConnect(async name => staticConnection(name, config, {}))
    await connectAll({ 'cover-proxy': config })
    expect(mark.mock.calls).toEqual([['cover-proxy']])
  })
})

// --- prefetch -------------------------------------------------------------------

describe('prefetchAllMcpResources', () => {
  test('no servers resolves empty', async () => {
    expect(await prefetchAllMcpResources({})).toEqual({ clients: [], tools: [], commands: [] })
  })

  test('collects every server once all of them have answered', async () => {
    stubAuthGates()
    stubConnect(async (name, config) =>
      name === 'cover-pre-a'
        ? staticConnection(name, config, { tools: [mcpTool('t')], prompts: [{ name: 'p', description: 'd' }] })
        : { name, type: 'failed', config },
    )
    const result = await prefetchAllMcpResources({ 'cover-pre-a': stdioConfig(), 'cover-pre-b': stdioConfig() })
    expect(result.clients.map(c => [c.name, c.type]).sort()).toEqual([
      ['cover-pre-a', 'connected'],
      ['cover-pre-b', 'failed'],
    ])
    expect(result.tools.map(t => t.name)).toEqual(['mcp__cover-pre-a__t'])
    expect(result.commands.map(c => c.name)).toEqual(['mcp__cover-pre-a__p'])
  })

  test('a failure outside the per-server handling resolves empty', async () => {
    track(
      spyOn(mcpConfig, 'isMcpServerDisabled').mockImplementation(() => {
        throw new Error('config unreadable')
      }),
    )
    const logged = track(spyOn(log, 'logMCPError'))
    expect(await prefetchAllMcpResources({ 'cover-pre-err': stdioConfig() })).toEqual({
      clients: [],
      tools: [],
      commands: [],
    })
    expect(logged.mock.calls).toContainEqual([
      'prefetchAllMcpResources',
      'Failed to get MCP resources: config unreadable',
    ])
  })
})
