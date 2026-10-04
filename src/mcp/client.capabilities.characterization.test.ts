/**
 * Characterization of what Claudin makes of a connected MCP server, pinned
 * before the clean-base rewrite (src/mcp/client/fetchCapabilities.ts,
 * sdkClients.ts, ide.ts, src/mcp/SdkControlTransport.ts, vscodeSdkMcp.ts,
 * claudeai.ts):
 *
 * - the tools, prompt commands and resources built from a server's lists, and
 *   what a tool does when the model calls it;
 * - the startup sweep over every configured server, and reconnecting one;
 * - the servers an SDK host runs in its own process, and the VS Code channel;
 * - the claude.ai connector listing.
 *
 * Servers are real SDK servers, reached over the in-memory transport, over a
 * loopback Streamable HTTP port, or spawned over stdio (see mcpServerBed).
 * The claude.ai listing lives at a fixed production URL, so its requests are
 * rerouted to a loopback server by rewriting the origin in an axios request
 * interceptor; the request itself still goes out over a socket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  clearServerCache,
  connectToServer,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  mcpToolInputToAutoClassifierInput,
  prefetchAllMcpResources,
  reconnectMcpServerImpl,
  setupSdkMcpClients,
  callIdeRpc,
} from 'src/mcp/client.js'
import { getServerKey } from 'src/mcp/auth.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
  hasClaudeAiMcpEverConnected,
  markClaudeAiMcpConnected,
} from 'src/mcp/claudeai.js'
import { setMcpAuthCacheEntry } from 'src/mcp/client/authCache.js'
import {
  type Catalog,
  type InMemoryLink,
  linkInMemory,
  sdkHost,
  serveHttp,
  until,
  useBuildMacro,
  writeStdioServer,
} from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { setMcpServerEnabled } from 'src/mcp/config/toggles.js'
import { SdkControlClientTransport } from 'src/mcp/SdkControlTransport.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { notifyVscodeFileUpdated, setupVscodeSdkMcp } from 'src/mcp/vscodeSdkMcp.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { classifyMcpToolForCollapse } from 'src/tools/MCPTool/classifyForCollapse.js'
import type { Tool } from 'src/tools/Tool.js'

useBuildMacro()
const store = useIsolatedStore()

const OWNED_ENV = [
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
  'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
let savedEnv: Record<string, string | undefined> = {}
const links: InMemoryLink[] = []
const closers: Array<() => unknown> = []
const opened: Array<{ name: string; config: ScopedMcpServerConfig }> = []
let serial = 0
const fresh = (stem: string) => `${stem}-${++serial}-${process.pid}`

beforeEach(() => {
  savedEnv = Object.fromEntries(OWNED_ENV.map(k => [k, process.env[k]]))
  for (const key of OWNED_ENV) delete process.env[key]
  clearOAuthTokenCache()
})

afterEach(async () => {
  for (const link of links.splice(0)) await link.close()
  for (const close of closers.splice(0)) await close()
  for (const { name, config } of opened.splice(0)) await clearServerCache(name, config).catch(() => {})
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearOAuthTokenCache()
})

async function link(name: string, catalog: Catalog, config?: ScopedMcpServerConfig): Promise<InMemoryLink> {
  const made = await linkInMemory(name, catalog, config)
  links.push(made)
  return made
}

/** A tool_use the model just emitted, as the tool layer hands it over. */
const parent = (id: string) => ({ message: { content: [{ type: 'tool_use', id, name: 'x', input: {} }] } }) as never

function toolContext() {
  return { abortController: new AbortController(), setAppState: () => {}, handleElicitation: undefined } as never
}

// --- tools -----------------------------------------------------------------------------

describe('fetchToolsForClient', () => {
  test('each listed tool becomes a qualified MCP tool carrying what the server declared', async () => {
    const server = fresh('docs server')
    const longText = 'd'.repeat(2100)
    const { connection } = await link(server, {
      tools: [
        {
          name: 'search.pages',
          description: 'finds pages',
          annotations: { readOnlyHint: true, title: 'Search pages', openWorldHint: true },
          _meta: { 'anthropic/searchHint': '  find\n\tdocs   pages ', 'anthropic/alwaysLoad': true },
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        { name: 'wipe', description: longText, annotations: { destructiveHint: true } },
        { name: 'bare', _meta: { 'anthropic/searchHint': '   ', 'anthropic/alwaysLoad': 'yes' } },
      ],
    })
    const tools = await fetchToolsForClient(connection)
    const prefix = `mcp__${server.replace(/ /g, '_')}__`
    expect(tools.map(t => t.name)).toEqual([`${prefix}search_pages`, `${prefix}wipe`, `${prefix}bare`])

    const [search, wipe, bare] = tools as [Tool, Tool, Tool]
    const facts = (t: Tool) => ({
      mcpInfo: t.mcpInfo,
      isMcp: t.isMcp,
      searchHint: t.searchHint,
      alwaysLoad: t.alwaysLoad,
      readOnly: t.isReadOnly({} as never),
      concurrencySafe: t.isConcurrencySafe({} as never),
      destructive: t.isDestructive?.({} as never),
      openWorld: t.isOpenWorld?.({} as never),
      userFacing: t.userFacingName(undefined as never),
    })
    expect(facts(search)).toEqual({
      mcpInfo: { serverName: server, toolName: 'search.pages' },
      isMcp: true,
      searchHint: 'find docs pages',
      alwaysLoad: true,
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      openWorld: true,
      userFacing: `${server} - Search pages (MCP)`,
    })
    expect(facts(wipe)).toEqual({
      mcpInfo: { serverName: server, toolName: 'wipe' },
      isMcp: true,
      searchHint: undefined,
      alwaysLoad: false,
      readOnly: false,
      concurrencySafe: false,
      destructive: true,
      openWorld: false,
      userFacing: `${server} - wipe (MCP)`,
    })
    expect({ searchHint: bare.searchHint, alwaysLoad: bare.alwaysLoad }).toEqual({ searchHint: undefined, alwaysLoad: false })
    expect(search.inputJSONSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } })
    expect(search.isSearchOrReadCommand?.({} as never)).toEqual(classifyMcpToolForCollapse(server, 'search.pages'))

    expect(await search.description({} as never, {} as never)).toBe('finds pages')
    expect(await bare.description({} as never, {} as never)).toBe('')
    expect(await wipe.description({} as never, {} as never)).toBe(longText)
    expect(await search.prompt({} as never)).toBe('finds pages')
    expect(await wipe.prompt({} as never)).toBe(`${'d'.repeat(2048)}… [truncated]`)
    expect(await bare.prompt({} as never)).toBe('')

    expect(search.toAutoClassifierInput({ q: 'cats', limit: 3 } as never)).toBe('q=cats limit=3')
    expect(search.toAutoClassifierInput({} as never)).toBe('search.pages')

    expect(await search.checkPermissions({} as never, {} as never)).toEqual({
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: `${prefix}search_pages`, ruleContent: undefined }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })
  })

  test('a description of exactly 2048 characters is kept whole in the prompt', async () => {
    const { connection } = await link(fresh('edge'), { tools: [{ name: 't', description: 'e'.repeat(2048) }] })
    const [tool] = await fetchToolsForClient(connection)
    expect(await tool!.prompt({} as never)).toBe('e'.repeat(2048))
  })

  test('invisible and private-use characters are stripped from what the server sends', async () => {
    const { connection } = await link(fresh('sneaky'), {
      tools: [{ name: 'safe\u200Bname', description: 'visible\u202E\u{E0041}\uE000 text' }],
    })
    const [tool] = await fetchToolsForClient(connection)
    expect(tool!.mcpInfo).toEqual({ serverName: connection.name, toolName: 'safename' })
    expect(await tool!.description({} as never, {} as never)).toBe('visible text')
  })

  test('the ide server keeps only executeCode and getDiagnostics', async () => {
    const { connection } = await link('ide', {
      tools: [{ name: 'executeCode' }, { name: 'getDiagnostics' }, { name: 'openDiff' }, { name: 'close_tab' }],
    })
    const tools = await fetchToolsForClient(connection)
    expect(tools.map(t => t.name)).toEqual(['mcp__ide__executeCode', 'mcp__ide__getDiagnostics'])
    fetchToolsForClient.cache.delete('ide')
  })

  test('an SDK server can opt out of the prefix; other kinds cannot', async () => {
    process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
    const sdkName = fresh('host')
    const sdk = await link(sdkName, { tools: [{ name: 'Read' }] })
    const [bareTool] = await fetchToolsForClient(sdk.connection)
    expect(bareTool!.name).toBe('Read')
    expect(bareTool!.mcpInfo).toEqual({ serverName: sdkName, toolName: 'Read' })
    const permission = (await bareTool!.checkPermissions({} as never, {} as never)) as { suggestions: Array<{ rules: Array<{ toolName: string }> }> }
    expect(permission.suggestions[0]!.rules[0]!.toolName).toBe(`mcp__${sdkName}__Read`)

    const stdioName = fresh('local')
    const stdioLike = await link(stdioName, { tools: [{ name: 'Read' }] }, { type: 'stdio', command: 'x', args: [], scope: 'user' } as ScopedMcpServerConfig)
    const [prefixed] = await fetchToolsForClient(stdioLike.connection)
    expect(prefixed!.name).toBe(`mcp__${stdioName}__Read`)
  })

  test('no tools capability, or no connection, means no tools and no request', async () => {
    const quiet = await link(fresh('quiet'), { prompts: [] })
    expect(await fetchToolsForClient(quiet.connection)).toEqual([])
    expect(quiet.ledger.lists.tools).toBe(0)
    const states: MCPServerConnection['type'][] = ['failed', 'needs-auth', 'pending', 'disabled']
    for (const type of states) {
      const conn = { name: fresh(type), type, config: { command: 'x', scope: 'user' } } as unknown as MCPServerConnection
      expect({ type, tools: await fetchToolsForClient(conn) }).toEqual({ type, tools: [] })
    }
  })

  test('the list is asked once per server name until that entry is dropped', async () => {
    const name = fresh('memo')
    const { connection, ledger } = await link(name, { tools: [{ name: 'a' }] })
    const first = await fetchToolsForClient(connection)
    expect(await fetchToolsForClient(connection)).toBe(first)
    expect(ledger.lists.tools).toBe(1)
    fetchToolsForClient.cache.delete(name)
    await fetchToolsForClient(connection)
    expect(ledger.lists.tools).toBe(2)
  })

  test('tools/list is tried three times, a second then two seconds apart', async () => {
    const recovering = await link(fresh('flaky'), { tools: [{ name: 'a' }], toolListFailures: 2 })
    const started = Date.now()
    expect((await fetchToolsForClient(recovering.connection)).map(t => t.mcpInfo?.toolName)).toEqual(['a'])
    expect(recovering.ledger.lists.tools).toBe(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900)

    const broken = await link(fresh('broken'), { tools: [{ name: 'a' }], toolListFailures: 5 })
    expect(await fetchToolsForClient(broken.connection)).toEqual([])
    expect(broken.ledger.lists.tools).toBe(3)
  }, 15_000)
})

describe('calling a fetched tool', () => {
  test('sends the arguments with the tool_use id in _meta, reports progress, and returns the content', async () => {
    const name = fresh('caller')
    const { connection, ledger } = await link(name, {
      tools: [
        {
          name: 'count',
          run: async ({ args, progress }) => {
            await progress(1, 2, 'halfway')
            return {
              content: [{ type: 'text', text: `counted ${String(args.n)}` }],
              structuredContent: { n: args.n },
              _meta: { trace: 't-1' },
            }
          },
        },
        { name: 'plain', run: () => ({ content: [{ type: 'text', text: 'just text' }] }) },
      ],
    })
    const [count, plain] = await fetchToolsForClient(connection)
    const events: Array<{ toolUseID: string; data: Record<string, unknown> }> = []
    const result = await count!.call({ n: 7 } as never, toolContext(), (() => {}) as never, parent('toolu_A'), ((p: never) =>
      void events.push(p)) as never,
    )
    // structuredContent, when present, is what the model gets, as JSON text.
    expect(result).toEqual({
      data: '{"n":7}',
      mcpMeta: { _meta: { trace: 't-1' }, structuredContent: { n: 7 } },
    })
    expect(ledger.calls[0]).toMatchObject({ name: 'count', args: { n: 7 } })
    expect(ledger.calls[0]!.meta).toMatchObject({ 'claudecode/toolUseId': 'toolu_A' })
    expect(events.every(e => e.toolUseID === 'toolu_A')).toBe(true)
    expect(events.map(e => e.data.status)).toEqual(['started', 'progress', 'completed'])
    expect(events[0]!.data).toEqual({ type: 'mcp_progress', status: 'started', serverName: name, toolName: 'count' })
    expect(events[1]!.data).toEqual({
      type: 'mcp_progress',
      status: 'progress',
      serverName: name,
      toolName: 'count',
      progress: 1,
      total: 2,
      progressMessage: 'halfway',
    })
    expect(events[2]!.data).toMatchObject({ type: 'mcp_progress', status: 'completed', serverName: name, toolName: 'count' })
    expect(typeof events[2]!.data.elapsedTimeMs).toBe('number')

    expect(await plain!.call({} as never, toolContext(), (() => {}) as never, parent('toolu_B'))).toEqual({
      data: [{ type: 'text', text: 'just text' }],
    })
  })

  test('without a tool_use id nothing extra goes in _meta and no progress is reported', async () => {
    const { connection, ledger } = await link(fresh('anon'), { tools: [{ name: 'a' }] })
    const [tool] = await fetchToolsForClient(connection)
    const events: unknown[] = []
    const notToolUse = { message: { content: [{ type: 'text', text: 'hi' }] } } as never
    await tool!.call({} as never, toolContext(), (() => {}) as never, notToolUse, ((p: never) => void events.push(p)) as never)
    expect(ledger.calls[0]!.meta?.['claudecode/toolUseId']).toBeUndefined()
    expect(events.filter(e => (e as { data: { status: string } }).data.status !== 'progress')).toEqual([])
  })

  test('failures are reported as failed progress and rethrown with the server message', async () => {
    const name = fresh('failing')
    const { connection } = await link(name, {
      tools: [
        { name: 'refuses', run: () => ({ isError: true, content: [{ type: 'text', text: 'quota exceeded' }] }) },
        { name: 'explodes', run: () => { throw new Error('disk on fire') } },
      ],
    })
    const [refuses, explodes] = await fetchToolsForClient(connection)
    for (const [tool, message] of [[refuses!, 'quota exceeded'], [explodes!, 'disk on fire']] as const) {
      const events: Array<{ data: Record<string, unknown> }> = []
      const outcome = await tool
        .call({} as never, toolContext(), (() => {}) as never, parent('toolu_F'), ((p: never) => void events.push(p)) as never)
        .then(() => undefined, (e: Error) => e)
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome!.message).toContain(message)
      expect(events.map(e => e.data.status)).toEqual(['started', 'failed'])
    }
  })

  test('an HTTP session that expired mid-call is reopened and the call made once more', async () => {
    const bed = serveHttp({ tools: [{ name: 'hello', run: () => ({ content: [{ type: 'text', text: 'hi again' }] }) }] })
    closers.push(bed.stop)
    const name = fresh('session')
    const config = { type: 'http', url: bed.url, scope: 'user' } as ScopedMcpServerConfig
    opened.push({ name, config })
    const conn = (await connectToServer(name, config)) as ConnectedMCPServer
    expect(conn.type).toBe('connected')
    const [tool] = await fetchToolsForClient(conn)
    bed.expireSessions()
    const result = await tool!.call({} as never, toolContext(), (() => {}) as never, parent('toolu_S'))
    expect(result).toEqual({ data: [{ type: 'text', text: 'hi again' }] })
    const initializes = bed.seen.filter(r => r.method === 'POST' && !r.headers['mcp-session-id'])
    expect(initializes.length).toBeGreaterThanOrEqual(2)
    expect(bed.ledger.calls.map(c => c.name)).toEqual(['hello'])
  })
})

// --- resources and prompts -----------------------------------------------------------------

describe('fetchResourcesForClient and fetchCommandsForClient', () => {
  test('resources come back tagged with their server', async () => {
    const name = fresh('files')
    const { connection } = await link(name, {
      resources: [
        { uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain' },
        { uri: 'mem://b', name: 'b' },
      ],
    })
    expect(await fetchResourcesForClient(connection)).toEqual([
      { uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain', server: name },
      { uri: 'mem://b', name: 'b', server: name },
    ])
    const none = await link(fresh('no-res'), { tools: [] })
    expect(await fetchResourcesForClient(none.connection)).toEqual([])
    expect(none.ledger.lists.resources).toBe(0)
  })

  test('prompts become /mcp__server__prompt commands that fetch the prompt with positional arguments', async () => {
    const server = fresh('my tools')
    const { connection, ledger } = await link(server, {
      prompts: [
        {
          name: 'review',
          description: 'review a change',
          arguments: [{ name: 'path', required: true }, { name: 'focus' }],
          reply: args => [
            { role: 'user', content: { type: 'text', text: `review ${args.path} for ${args.focus}` } },
            { role: 'assistant', content: { type: 'resource_link', uri: 'file:///x', name: 'x' } },
          ],
        },
        { name: 'bare' },
      ],
    })
    const commands = await fetchCommandsForClient(connection)
    const [review, bare] = commands as [any, any]
    const reviewFields: Array<[string, unknown]> = [
      ['type', 'prompt'],
      ['name', `mcp__${server.replace(/ /g, '_')}__review`],
      ['description', 'review a change'],
      ['hasUserSpecifiedDescription', true],
      ['contentLength', 0],
      ['isHidden', false],
      ['isMcp', true],
      ['progressMessage', 'running'],
      ['argNames', ['path', 'focus']],
      ['source', 'mcp'],
    ]
    for (const [field, value] of reviewFields) expect({ field, value: review[field] }).toEqual({ field, value })
    expect([review.isEnabled(), review.userFacingName()]).toEqual([true, `${server}:review (MCP)`])
    expect({ description: bare.description, has: bare.hasUserSpecifiedDescription, argNames: bare.argNames }).toEqual({
      description: '',
      has: false,
      argNames: [],
    })

    const blocks = await review.getPromptForCommand('src/a.ts security extra-word')
    expect(ledger.promptGets.at(-1)).toEqual({ name: 'review', args: { path: 'src/a.ts', focus: 'security' } })
    expect(blocks).toEqual([
      { type: 'text', text: 'review src/a.ts for security' },
      { type: 'text', text: '[Resource link: x] file:///x' },
    ])
    await expect(bare.getPromptForCommand('')).rejects.toThrow('prompt bare has no body')
  })

  test('a server without prompts gives no commands; a broken list gives none either', async () => {
    const plain = await link(fresh('plain'), { tools: [] })
    expect(await fetchCommandsForClient(plain.connection)).toEqual([])
    expect(plain.ledger.lists.prompts).toBe(0)
    const gone = await link(fresh('gone'), { prompts: [{ name: 'p' }], resources: [] })
    await gone.close()
    expect(await fetchCommandsForClient(gone.connection)).toEqual([])
    expect(await fetchResourcesForClient(gone.connection)).toEqual([])
    expect(await fetchToolsForClient({ ...gone.connection, capabilities: { tools: {} } })).toEqual([])
  })
})

// --- connecting and sweeping -------------------------------------------------------------------

describe('reconnectMcpServerImpl, getMcpToolsCommandsAndResources, prefetchAllMcpResources', () => {
  test('reconnecting returns the fresh connection with its tools, commands and resources', async () => {
    const bed = serveHttp({
      tools: [{ name: 'lookup' }],
      resources: [{ uri: 'mem://r', name: 'r' }],
      prompts: [{ name: 'p' }],
    })
    closers.push(bed.stop)
    const name = fresh('reconnect')
    const config = { type: 'http', url: bed.url, scope: 'user' } as ScopedMcpServerConfig
    opened.push({ name, config })
    const first = await connectToServer(name, config)
    const result = await reconnectMcpServerImpl(name, config)
    expect(result.client).not.toBe(first)
    expect(result.client.type).toBe('connected')
    expect(result.tools.map(t => t.name)).toEqual([`mcp__${name}__lookup`, 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
    expect(result.commands.map(c => c.name)).toEqual([`mcp__${name}__p`])
    expect(result.resources).toEqual([{ uri: 'mem://r', name: 'r', server: name }])
  })

  test('reconnecting a server that cannot connect returns it with nothing', async () => {
    const name = fresh('unreachable')
    const config = { type: 'stdio', command: join(store.root(), 'missing'), args: [], scope: 'user' } as ScopedMcpServerConfig
    opened.push({ name, config })
    const result = await reconnectMcpServerImpl(name, config)
    expect(result.client.type).toBe('failed')
    expect({ tools: result.tools, commands: result.commands, resources: result.resources }).toEqual({ tools: [], commands: [], resources: undefined })
  })

  test('the sweep reports every server once: disabled, cached needs-auth, probed-without-token, connected, failed', async () => {
    const stdio = writeStdioServer(store.root())
    const withResources = serveHttp({ tools: [{ name: 'a' }], resources: [{ uri: 'mem://1', name: '1' }] })
    const alsoResources = serveHttp({ tools: [{ name: 'b' }], resources: [{ uri: 'mem://2', name: '2' }] })
    const untouched = serveHttp({ tools: [] })
    closers.push(withResources.stop, alsoResources.stop, untouched.stop)
    const names = {
      off: fresh('off'),
      cached: fresh('cached'),
      probed: fresh('probed'),
      local: fresh('local'),
      res1: fresh('res1'),
      res2: fresh('res2'),
      broken: fresh('broken'),
    }
    const configs: Record<string, ScopedMcpServerConfig> = {
      [names.off]: { type: 'http', url: untouched.url, scope: 'user' } as ScopedMcpServerConfig,
      [names.cached]: { type: 'http', url: untouched.url, scope: 'user' } as ScopedMcpServerConfig,
      [names.probed]: { type: 'sse', url: `${untouched.url}?probed`, scope: 'user' } as ScopedMcpServerConfig,
      [names.local]: stdio.config(),
      [names.res1]: { type: 'http', url: withResources.url, scope: 'user' } as ScopedMcpServerConfig,
      [names.res2]: { type: 'http', url: alsoResources.url, scope: 'user' } as ScopedMcpServerConfig,
      [names.broken]: { type: 'stdio', command: join(store.root(), 'missing'), args: [], scope: 'user' } as ScopedMcpServerConfig,
    }
    for (const [name, config] of Object.entries(configs)) opened.push({ name, config })
    setMcpServerEnabled(names.off, false)
    setMcpAuthCacheEntry(names.cached)
    const probedKey = getServerKey(names.probed, configs[names.probed] as never)
    store.write({ ...(store.read() ?? {}), mcpOAuth: { [probedKey]: { serverName: names.probed, serverUrl: 'x', accessToken: '', expiresAt: 0, discoveryState: { authorizationServerUrl: 'https://as.example' } } } })
    await until(() => existsSync(join(store.configDir(), 'mcp-needs-auth-cache.json')), Boolean, 'the cache entry')

    const seen: Array<{ client: MCPServerConnection; tools: Tool[]; commands: unknown[]; resources?: unknown[] }> = []
    try {
      await getMcpToolsCommandsAndResources(result => void seen.push(result), configs)
    } finally {
      setMcpServerEnabled(names.off, true)
    }
    const byName = Object.fromEntries(seen.map(s => [s.client.name, s]))
    expect(seen).toHaveLength(7)
    expect(Object.keys(byName).sort()).toEqual(Object.values(names).sort())

    expect(byName[names.off]).toEqual({ client: { name: names.off, type: 'disabled', config: configs[names.off] }, tools: [], commands: [] })
    for (const skipped of [names.cached, names.probed]) {
      expect(byName[skipped]!.client).toEqual({ name: skipped, type: 'needs-auth', config: configs[skipped] })
      expect(byName[skipped]!.tools.map(t => t.name)).toEqual([`mcp__${skipped}__authenticate`])
    }
    expect(untouched.seen).toEqual([])

    expect(byName[names.local]!.client.type).toBe('connected')
    expect(byName[names.local]!.tools.map(t => t.name)).toEqual([`mcp__${names.local}__echo`])
    expect(byName[names.local]!.resources).toBeUndefined()

    const resourceTools = [byName[names.res1]!, byName[names.res2]!].map(r => r.tools.map(t => t.name).filter(n => !n.startsWith('mcp__')))
    expect(resourceTools.flat()).toEqual(['ListMcpResourcesTool', 'ReadMcpResourceTool'])
    expect(byName[names.res1]!.resources).toEqual([{ uri: 'mem://1', name: '1', server: names.res1 }])

    expect(byName[names.broken]).toMatchObject({ client: { name: names.broken, type: 'failed' }, tools: [], commands: [] })
  })

  test('a server that answers 401 during the sweep is offered the authenticate tool', async () => {
    const { startAuthBed } = await import('src/mcp/auth/__testutils__/oauthTestBed.js')
    const bed = startAuthBed({ onResource: () => new Response('{}', { status: 401 }) })
    closers.push(bed.stop)
    const name = fresh('locked')
    const config = { type: 'http', url: bed.mcpUrl, scope: 'user' } as ScopedMcpServerConfig
    opened.push({ name, config })
    const seen: Array<{ client: MCPServerConnection; tools: Tool[] }> = []
    await getMcpToolsCommandsAndResources(r => void seen.push(r), { [name]: config })
    expect(seen.map(s => ({ type: s.client.type, tools: s.tools.map(t => t.name) }))).toEqual([
      { type: 'needs-auth', tools: [`mcp__${name}__authenticate`] },
    ])
  })

  test('the prefetch gathers clients, tools and commands from every server; none configured resolves empty', async () => {
    expect(await prefetchAllMcpResources({})).toEqual({ clients: [], tools: [], commands: [] })
    const stdio = writeStdioServer(store.root())
    const bed = serveHttp({ prompts: [{ name: 'hello' }] })
    closers.push(bed.stop)
    const a = fresh('pre-a')
    const b = fresh('pre-b')
    const configs = { [a]: stdio.config(), [b]: { type: 'http', url: bed.url, scope: 'user' } as ScopedMcpServerConfig }
    for (const [name, config] of Object.entries(configs)) opened.push({ name, config })
    const result = await prefetchAllMcpResources(configs)
    expect(result.clients.map(c => [c.name, c.type]).sort()).toEqual([[a, 'connected'], [b, 'connected']].sort())
    expect(result.tools.map(t => t.name)).toEqual([`mcp__${a}__echo`])
    expect(result.commands.map(c => c.name)).toEqual([`mcp__${b}__hello`])
  })

  test('the classifier input is key=value pairs, or the tool name when there are none', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'tool'],
      [{ q: 'hello world', n: 2 }, 'q=hello world n=2'],
      [{ flag: true, nothing: null, list: [1, 2] }, 'flag=true nothing=null list=1,2'],
      [{ nested: { a: 1 } }, 'nested=[object Object]'],
    ]
    for (const [input, expected] of cases) expect(mcpToolInputToAutoClassifierInput(input, 'tool')).toBe(expected)
  })
})

// --- SDK servers and the VS Code channel ------------------------------------------------------------

describe('SDK servers run by the host', () => {
  test('each config gets a client over the control channel, with its tools, scoped dynamic', async () => {
    const host = await sdkHost({ tools: [{ name: 'lookup', run: () => ({ content: [{ type: 'text', text: 'from host' }] }) }] })
    closers.push(host.close)
    const name = fresh('host-tools')
    const { clients, tools } = await setupSdkMcpClients({ [name]: { type: 'sdk', name } } as never, host.send)
    expect(clients).toHaveLength(1)
    const [client] = clients as [ConnectedMCPServer]
    expect({ type: client.type, name: client.name, config: client.config, capabilities: client.capabilities }).toEqual({
      type: 'connected',
      name,
      config: { type: 'sdk', name, scope: 'dynamic' },
      capabilities: { tools: {} },
    })
    expect(tools.map(t => t.name)).toEqual([`mcp__${name}__lookup`])
    expect(new Set(host.routed)).toEqual(new Set([name]))
    expect(host.ledger.hello.clientInfo).toMatchObject({ name: 'claude-code', title: 'Claudin' })
    expect(host.ledger.hello.capabilities).toEqual({})

    const out = await tools[0]!.call({} as never, toolContext(), (() => {}) as never, parent('toolu_H'))
    expect(out).toEqual({ data: [{ type: 'text', text: 'from host' }] })
    await client.cleanup()
  })

  test('a server whose channel fails is listed as failed, scoped user, with no tools', async () => {
    const name = fresh('host-down')
    const { clients, tools } = await setupSdkMcpClients({ [name]: { type: 'sdk', name } } as never, async () => {
      throw new Error('host went away')
    })
    expect(clients).toEqual([{ type: 'failed', name, config: { type: 'sdk', name, scope: 'user' } }])
    expect(tools).toEqual([])
  })

  test('a server with no tools capability contributes none', async () => {
    const host = await sdkHost({ prompts: [] })
    closers.push(host.close)
    const name = fresh('host-quiet')
    const { clients, tools } = await setupSdkMcpClients({ [name]: { type: 'sdk', name } } as never, host.send)
    expect(clients.map(c => c.type)).toEqual(['connected'])
    expect(tools).toEqual([])
    expect(host.ledger.lists.tools).toBe(0)
  })

  test('the control transport forwards each message and hands the answer back; once closed it refuses', async () => {
    const sent: Array<[string, JSONRPCMessage]> = []
    const transport = new SdkControlClientTransport('srv', async (server, message) => {
      sent.push([server, message])
      return { jsonrpc: '2.0', id: 9, result: { echoed: true } } as JSONRPCMessage
    })
    const received: JSONRPCMessage[] = []
    let closes = 0
    transport.onclose = () => void (closes += 1)
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 9, method: 'ping' } as JSONRPCMessage)
    expect(sent).toEqual([['srv', { jsonrpc: '2.0', id: 9, method: 'ping' }]])
    expect(received).toEqual([])
    transport.onmessage = m => void received.push(m)
    await transport.send({ jsonrpc: '2.0', id: 9, method: 'ping' } as JSONRPCMessage)
    expect(received).toEqual([{ jsonrpc: '2.0', id: 9, result: { echoed: true } }])
    await transport.close()
    await transport.close()
    expect(closes).toBe(1)
    await expect(transport.send({ jsonrpc: '2.0', id: 10, method: 'ping' } as JSONRPCMessage)).rejects.toThrow('Transport is closed')
    expect(sent).toHaveLength(2)
  })
})

describe('the VS Code channel', () => {
  test('file updates go to the claude-vscode server once it is set up, as file_updated notifications', async () => {
    const host = await sdkHost({ tools: [] })
    closers.push(host.close)

    // Nothing is set up yet in this file: the call is a no-op.
    expect(() => notifyVscodeFileUpdated('/tmp/x', 'a', 'b')).not.toThrow()

    const { clients: others } = await setupSdkMcpClients({ 'not-vscode': { type: 'sdk', name: 'not-vscode' } } as never, host.send)
    setupVscodeSdkMcp(others)
    setupVscodeSdkMcp([{ name: 'claude-vscode', type: 'failed', config: {} } as never])
    notifyVscodeFileUpdated('/tmp/ignored.ts', null, 'x')
    await Bun.sleep(20)
    expect(host.ledger.notes.filter(n => n.method === 'file_updated')).toEqual([])

    const { clients } = await setupSdkMcpClients({ 'claude-vscode': { type: 'sdk', name: 'claude-vscode' } } as never, host.send)
    setupVscodeSdkMcp([...others, ...clients])
    notifyVscodeFileUpdated('/work/a.ts', 'old text', 'new text')
    notifyVscodeFileUpdated('/work/new.ts', null, 'created')
    notifyVscodeFileUpdated('/work/gone.ts', 'was here', null)
    const notes = await until(() => host.ledger.notes.filter(n => n.method === 'file_updated'), l => l.length === 3, 'three notifications')
    expect(notes.map(n => n.params)).toEqual([
      { filePath: '/work/a.ts', oldContent: 'old text', newContent: 'new text' },
      { filePath: '/work/new.ts', oldContent: null, newContent: 'created' },
      { filePath: '/work/gone.ts', oldContent: 'was here', newContent: null },
    ])

    // A channel that went away swallows the failure.
    await (clients[0] as ConnectedMCPServer).cleanup()
    expect(() => notifyVscodeFileUpdated('/work/after.ts', 'a', 'b')).not.toThrow()
    await Bun.sleep(20)
    for (const client of others) if (client.type === 'connected') await client.cleanup()
  })
})

describe('callIdeRpc', () => {
  test('calls the tool on the given client and returns its content untouched by size limits', async () => {
    const big = 'z'.repeat(200_000)
    const { connection, ledger } = await link('ide', {
      tools: [
        { name: 'getDiagnostics', run: ({ args }) => ({ content: [{ type: 'text', text: `diag for ${String(args.uri)}` }] }) },
        { name: 'dump', run: () => ({ content: [{ type: 'text', text: big }] }) },
        { name: 'fail', run: () => ({ isError: true, content: [{ type: 'text', text: 'no editor' }] }) },
      ],
    })
    expect(await callIdeRpc('getDiagnostics', { uri: 'file:///a.ts' }, connection)).toEqual([{ type: 'text', text: 'diag for file:///a.ts' }])
    expect(ledger.calls[0]).toEqual({ name: 'getDiagnostics', args: { uri: 'file:///a.ts' }, meta: undefined })
    expect(await callIdeRpc('dump', {}, connection)).toEqual([{ type: 'text', text: big }])
    await expect(callIdeRpc('fail', {}, connection)).rejects.toThrow('no editor')
  })
})

// --- claude.ai connectors -----------------------------------------------------------------------------

describe('the claude.ai connector listing', () => {
  type Listed = { status: number; body: unknown }
  let answer: Listed = { status: 200, body: { data: [], has_more: false, next_page: null } }
  const requests: Array<{ path: string; search: string; headers: Record<string, string> }> = []
  let listing: ReturnType<typeof Bun.serve>
  let interceptor = -1

  beforeAll(() => {
    listing = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, search: url.search, headers: Object.fromEntries(request.headers.entries()) })
        return Response.json(answer.body, { status: answer.status })
      },
    })
    interceptor = axios.interceptors.request.use(config => {
      const target = new URL(config.url ?? '')
      if (target.origin === 'https://api.anthropic.com') {
        config.url = `http://127.0.0.1:${listing.port}${target.pathname}${target.search}`
      }
      return config
    })
  })

  afterAll(() => {
    axios.interceptors.request.eject(interceptor)
    listing.stop(true)
  })

  beforeEach(() => {
    requests.length = 0
    answer = { status: 200, body: { data: [], has_more: false, next_page: null } }
    fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  })

  afterEach(() => {
    fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  })

  function login(scopes: string[]) {
    store.write({ claudeAiOauth: { accessToken: 'ai-tok', refreshToken: null, expiresAt: Date.now() + 3_600_000, scopes } })
    clearOAuthTokenCache()
  }

  const server = (id: string, display_name: string) => ({
    type: 'mcp_server',
    id,
    display_name,
    url: `https://mcp.example/${id}`,
    created_at: '2026-01-01T00:00:00Z',
  })

  test('lists the org connectors under "claude.ai <name>", numbering names that normalize alike', async () => {
    login(['user:inference', 'user:mcp_servers'])
    answer = {
      status: 200,
      body: {
        data: [server('s1', 'Example Server'), server('s2', 'Example Server!'), server('s3', 'Example Server 2'), server('s4', 'Drive')],
        has_more: false,
        next_page: null,
      },
    }
    const configs = await fetchClaudeAIMcpConfigsIfEligible()
    expect(configs).toEqual({
      'claude.ai Example Server': { type: 'claudeai-proxy', url: 'https://mcp.example/s1', id: 's1', scope: 'claudeai' },
      'claude.ai Example Server! (2)': { type: 'claudeai-proxy', url: 'https://mcp.example/s2', id: 's2', scope: 'claudeai' },
      'claude.ai Example Server 2 (2)': { type: 'claudeai-proxy', url: 'https://mcp.example/s3', id: 's3', scope: 'claudeai' },
      'claude.ai Drive': { type: 'claudeai-proxy', url: 'https://mcp.example/s4', id: 's4', scope: 'claudeai' },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/v1/mcp_servers')
    expect(requests[0]!.search).toBe('?limit=1000')
    const sent: Array<[string, string]> = [
      ['authorization', 'Bearer ai-tok'],
      ['anthropic-beta', 'mcp-servers-2025-12-04'],
      ['anthropic-version', '2023-06-01'],
      ['content-type', 'application/json'],
    ]
    for (const [header, value] of sent) expect([header, requests[0]!.headers[header]]).toEqual([header, value])

    expect(await fetchClaudeAIMcpConfigsIfEligible()).toBe(configs)
    expect(requests).toHaveLength(1)
  })

  test('nothing is fetched when traffic is restricted, when switched off, without a login, or without the scope', async () => {
    const cases: Array<{ label: string; env: Record<string, string | undefined>; scopes?: string[] }> = [
      { label: 'essential traffic only (the default)', env: { CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC: undefined }, scopes: ['user:mcp_servers'] },
      { label: 'ENABLE_CLAUDEAI_MCP_SERVERS=false', env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, scopes: ['user:mcp_servers'] },
      { label: 'no login', env: {} },
      { label: 'login without user:mcp_servers', env: {}, scopes: ['user:inference'] },
      { label: 'env token (inference scope only)', env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' } },
    ]
    for (const { label, env, scopes } of cases) {
      fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
      process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      if (scopes) login(scopes)
      else {
        store.write({})
        clearOAuthTokenCache()
      }
      expect({ label, configs: await fetchClaudeAIMcpConfigsIfEligible() }).toEqual({ label, configs: {} })
      for (const k of Object.keys(env)) delete process.env[k]
    }
    expect(requests).toEqual([])
  })

  test('a failed listing yields no connectors', async () => {
    login(['user:mcp_servers'])
    answer = { status: 500, body: { error: 'down' } }
    expect(await fetchClaudeAIMcpConfigsIfEligible()).toEqual({})
    expect(requests).toHaveLength(1)
  })

  test('clearing the cache fetches again and forgets which servers needed auth', async () => {
    login(['user:mcp_servers'])
    await fetchClaudeAIMcpConfigsIfEligible()
    setMcpAuthCacheEntry('claude.ai Drive')
    const cacheFile = join(store.configDir(), 'mcp-needs-auth-cache.json')
    await until(() => existsSync(cacheFile), Boolean, 'the needs-auth file')
    clearClaudeAIMcpConfigsCache()
    await until(() => existsSync(cacheFile), present => !present, 'the needs-auth file to go')
    await fetchClaudeAIMcpConfigsIfEligible()
    expect(requests).toHaveLength(2)
  })

  test('a connector that connected once is remembered in the global config, once', () => {
    const before = getGlobalConfig().claudeAiMcpEverConnected
    try {
      const name = fresh('claude.ai Calendar')
      const known = () => hasClaudeAiMcpEverConnected(name)
      expect(known()).toBe(false)
      for (let round = 0; round < 2; round++) markClaudeAiMcpConnected(name)
      expect(known()).toBe(true)
      expect(getGlobalConfig().claudeAiMcpEverConnected!.filter(n => n === name)).toEqual([name])
    } finally {
      saveGlobalConfig(c => ({ ...c, claudeAiMcpEverConnected: before }))
    }
  })

  test('a connector that connects, in the sweep or on reconnect, is recorded as having connected', async () => {
    const bed = serveHttp({ tools: [{ name: 'note' }] })
    closers.push(bed.stop)
    login(['user:mcp_servers'])
    const realFetch = globalThis.fetch
    const loopback = new URL(bed.url).origin
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
        const rerouted = target.origin === 'https://mcp-proxy.anthropic.com' ? `${loopback}${target.pathname}` : target.href
        return realFetch(rerouted, init)
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch
    const before = getGlobalConfig().claudeAiMcpEverConnected
    const swept = `claude.ai Notes ${++serial}`
    const reconnected = `claude.ai Tasks ${++serial}`
    try {
      for (const name of [swept, reconnected]) setMcpServerEnabled(name, true)
      const config = (id: string) => ({ type: 'claudeai-proxy', url: 'https://ignored.example', id, scope: 'claudeai' }) as ScopedMcpServerConfig
      opened.push({ name: swept, config: config('n1') }, { name: reconnected, config: config('t1') })
      const reported: MCPServerConnection[] = []
      await getMcpToolsCommandsAndResources(r => void reported.push(r.client), { [swept]: config('n1') })
      expect(reported.map(c => c.type)).toEqual(['connected'])
      expect(hasClaudeAiMcpEverConnected(swept)).toBe(true)

      expect(hasClaudeAiMcpEverConnected(reconnected)).toBe(false)
      const again = await reconnectMcpServerImpl(reconnected, config('t1'))
      expect(again.client.type).toBe('connected')
      expect(hasClaudeAiMcpEverConnected(reconnected)).toBe(true)
      expect(bed.seen.map(r => r.path)).toContain('/v1/mcp/n1')
      expect(bed.seen.map(r => r.path)).toContain('/v1/mcp/t1')
    } finally {
      globalThis.fetch = realFetch
      for (const name of [swept, reconnected]) setMcpServerEnabled(name, false)
      saveGlobalConfig(c => ({ ...c, claudeAiMcpEverConnected: before }))
    }
  })
})
