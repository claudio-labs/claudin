/**
 * Characterization of the MCP and plugin runtime of the headless streaming
 * host (mcpRuntime.ts), pinned before the levers cut edits it.
 *
 * Each test runs a session the way `runHeadlessStreaming` does: the stdin
 * control loop is reading, and the context's wiring is the real runtime. MCP
 * servers are real SDK servers on in-memory transports. A server the host
 * declares as an SDK server is reached the way the Agent SDK reaches it: every
 * JSON-RPC message goes out as an `mcp_message` control request, and the test,
 * playing the SDK host, answers on stdin with the server's reply.
 *
 * Not pinned: `forwardMessagesToBridge`, whose only producer of a bridge
 * handle is `remote_control`, which goes with the cut.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'

import type { MCPServerConnection } from 'src/mcp/types.js'
import { getInitJsonSchema, setInitJsonSchema } from 'src/platform/bootstrap/state.js'
import { saveGlobalConfig } from 'src/platform/config/config.js'
import {
  openSession,
  useBuildMacro,
  type HeadlessSession,
  type SessionSetup,
} from 'src/platform/headless/print/__testutils__/streamingHarness.js'
import { runControlLoop } from 'src/platform/headless/print/controlLoop.js'
import {
  applyMcpServerChanges,
  applyPluginMcpDiff,
  buildAllTools,
  buildMcpServerStatuses,
  installPluginsAndApplyMcpInBackground,
  refreshPluginState,
  registerElicitationHandlers,
  updateSdkMcp,
} from 'src/platform/headless/print/mcpRuntime.js'
import { envSnapshot, eventually, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { useRestoreSandbox } from 'src/sessions/__testutils__/restoreHarness.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import type { Tool } from 'src/tools/Tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

useRestoreSandbox()
useBuildMacro()

let env: EnvSnapshot
let home: string
let initSchema: Record<string, unknown> | null
const running: Array<{ session: HeadlessSession; loop: Promise<void> }> = []
const servers: McpServer[] = []

beforeAll(() => {
  initSchema = getInitJsonSchema()
})

beforeEach(() => {
  env = envSnapshot(['HOME', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDIN_SIMPLE'])
  home = mkdtempSync(join(tmpdir(), 'mcp-runtime-home-'))
  process.env.HOME = home
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '0'
})

afterEach(async () => {
  for (const { session, loop } of running.splice(0)) {
    session.end()
    await loop
  }
  for (const server of servers.splice(0)) await server.close()
  setInitJsonSchema(initSchema as never)
  env.restore()
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  setInitJsonSchema(initSchema as never)
})

/** A session with its stdin loop running, as the streaming host runs it. */
function start(setup: SessionSetup = {}) {
  const session = openSession(setup)
  running.push({ session, loop: runControlLoop(session.ctx) })
  return session
}

/** A real MCP server with one tool, `add`, that is read-only. */
function calculator(name = 'calc'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' })
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  servers.push(server)
  return server
}

/**
 * Play the SDK host for `session`: answer every `mcp_message` control request
 * with the reply of the named server, and refuse the ones for servers it does
 * not host. Returns how many messages each server was sent.
 */
async function hostSdkServers(session: HeadlessSession, hosted: Record<string, McpServer>) {
  const sent: Record<string, number> = {}
  const links = new Map<string, { send(m: JSONRPCMessage): Promise<void>; replies: Map<unknown, (m: JSONRPCMessage) => void> }>()
  for (const [name, server] of Object.entries(hosted)) {
    const [hostSide, serverSide] = InMemoryTransport.createLinkedPair()
    const replies = new Map<unknown, (m: JSONRPCMessage) => void>()
    hostSide.onmessage = message => {
      const id = (message as { id?: unknown }).id
      replies.get(id)?.(message)
      replies.delete(id)
    }
    await server.connect(serverSide)
    await hostSide.start()
    links.set(name, { send: m => hostSide.send(m), replies })
  }
  let seen = 0
  let stopped = false
  const pump = async () => {
    while (!stopped) {
      while (seen < session.emitted.length) {
        const message = session.emitted[seen++] as {
          type: string
          request_id?: string
          request?: { subtype: string; server_name: string; message: JSONRPCMessage }
        }
        if (message.type !== 'control_request' || message.request?.subtype !== 'mcp_message') continue
        const { server_name, message: rpc } = message.request
        sent[server_name] = (sent[server_name] ?? 0) + 1
        const link = links.get(server_name)
        const respond = (response: object) =>
          session.send({ type: 'control_response', response: { request_id: message.request_id, ...response } })
        if (!link) {
          respond({ subtype: 'error', error: `no server named ${server_name}` })
          continue
        }
        const id = (rpc as { id?: unknown }).id
        if (id === undefined) {
          await link.send(rpc)
          respond({ subtype: 'success', response: { mcp_response: { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'debug', data: 'ack' } } } })
          continue
        }
        void new Promise<JSONRPCMessage>(resolve => {
          link.replies.set(id, resolve)
          void link.send(rpc)
        }).then(reply => respond({ subtype: 'success', response: { mcp_response: reply } }))
      }
      await Bun.sleep(2)
    }
  }
  void pump()
  return {
    sent,
    stop: () => {
      stopped = true
    },
  }
}

/** A client connected to `server` in memory, declaring the given capabilities. */
async function connectedTo(
  server: McpServer,
  name: string,
  capabilities: ConstructorParameters<typeof Client>[1] = {},
): Promise<MCPServerConnection> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-host', version: '1.0.0' }, capabilities)
  await server.connect(serverSide)
  await client.connect(clientSide)
  return {
    type: 'connected',
    name,
    client,
    capabilities: client.getServerCapabilities() ?? {},
    serverInfo: client.getServerVersion(),
    config: { type: 'stdio', command: 'calc', args: [], scope: 'user' },
    cleanup: async () => client.close(),
  } as MCPServerConnection
}

const toolNamed = (name: string, extra: Partial<Tool> = {}): Tool => ({ ...GlobTool, name, ...extra }) as Tool

// --- elicitation ----------------------------------------------------------------

describe('registerElicitationHandlers', () => {
  const ELICITING = { elicitation: { form: {}, url: {} } }

  test('a form elicitation goes to the SDK consumer and its answer back to the server', async () => {
    const server = calculator()
    const session = start()
    const connection = await connectedTo(server, 'calc', { capabilities: ELICITING })
    registerElicitationHandlers(session.ctx, [connection])

    const asked = server.server.elicitInput({
      message: 'Pick a colour',
      requestedSchema: { type: 'object', properties: { colour: { type: 'string' } } },
    })
    const request = (await eventually(
      () => session.emitted.find(m => m.type === 'control_request'),
      found => found !== undefined,
    )) as { request_id: string; request: Record<string, unknown> }
    expect(request.request).toMatchObject({
      subtype: 'elicitation',
      mcp_server_name: 'calc',
      message: 'Pick a colour',
      mode: 'form',
      requested_schema: { type: 'object', properties: { colour: { type: 'string' } } },
    })
    expect(request.request.url).toBeUndefined()

    session.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: { action: 'accept', content: { colour: 'teal' } } },
    })
    expect(await asked).toEqual({ action: 'accept', content: { colour: 'teal' } })
    expect([...session.ctx.elicitationRegistered]).toEqual(['calc'])
  })

  test('a URL elicitation carries its URL and id; a refused request comes back cancelled', async () => {
    const server = calculator()
    const session = start()
    registerElicitationHandlers(session.ctx, [await connectedTo(server, 'calc', { capabilities: ELICITING })])

    const asked = server.server.elicitInput({
      mode: 'url',
      message: 'Sign in',
      url: 'https://auth.example.test/start',
      elicitationId: 'el-7',
    })
    const request = (await eventually(
      () => session.emitted.find(m => m.type === 'control_request'),
      found => found !== undefined,
    )) as { request_id: string; request: Record<string, unknown> }
    expect(request.request).toMatchObject({
      mode: 'url',
      url: 'https://auth.example.test/start',
      elicitation_id: 'el-7',
    })
    session.send({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'no UI' } })
    expect(await asked).toEqual({ action: 'cancel' })
  })

  test('a completed URL elicitation is announced on the output stream', async () => {
    const server = calculator()
    const session = start()
    registerElicitationHandlers(session.ctx, [await connectedTo(server, 'calc', { capabilities: ELICITING })])

    await server.server.createElicitationCompletionNotifier('el-9')()
    const announced = await eventually(
      () => session.emitted.find(m => m.type === 'system'),
      found => found !== undefined,
    )
    expect(announced).toMatchObject({
      type: 'system',
      subtype: 'elicitation_complete',
      mcp_server_name: 'calc',
      elicitation_id: 'el-9',
    })
  })

  test('skips what it must not register, and registers a server only once', async () => {
    const session = start()
    const eliciting = await connectedTo(calculator(), 'twice', { capabilities: ELICITING })
    const plain = await connectedTo(calculator(), 'no-capability')
    const sdk = { ...(await connectedTo(calculator(), 'in-sdk', { capabilities: ELICITING })), config: { type: 'sdk', name: 'in-sdk' } }
    const pending = { type: 'pending', name: 'later', config: { type: 'stdio', command: 'x', args: [] } }
    const clients = [eliciting, plain, sdk, pending, eliciting] as MCPServerConnection[]

    registerElicitationHandlers(session.ctx, clients)
    registerElicitationHandlers(session.ctx, clients)

    expect([...session.ctx.elicitationRegistered]).toEqual(['twice'])
  })
})

// --- SDK servers ------------------------------------------------------------------

describe('updateSdkMcp', () => {
  test('connects a newly declared SDK server and publishes its tools', async () => {
    const session = start({
      sdkMcpConfigs: { calc: { type: 'sdk', name: 'calc' } },
      appState: { mcp: { clients: [], tools: [toolNamed('mcp__calc__stale'), toolNamed('mcp__other__keep')], commands: [], resources: {} } } as never,
    })
    const host = await hostSdkServers(session, { calc: calculator() })

    await updateSdkMcp(session.ctx)
    host.stop()

    expect(session.ctx.sdkClients.map(c => [c.name, c.type])).toEqual([['calc', 'connected']])
    expect(session.ctx.sdkClients[0]!.config).toMatchObject({ type: 'sdk', scope: 'dynamic' })
    expect(session.ctx.sdkTools.map(t => t.name)).toEqual(['mcp__calc__add'])
    expect(session.state().mcp.tools.map(t => t.name)).toEqual(['mcp__other__keep', 'mcp__calc__add'])
    expect(host.sent.calc).toBeGreaterThan(0)
  })

  test('does nothing while every declared server is connected', async () => {
    const session = start({ sdkMcpConfigs: { calc: { type: 'sdk', name: 'calc' } } })
    const host = await hostSdkServers(session, { calc: calculator() })
    await updateSdkMcp(session.ctx)
    const handshake = host.sent.calc
    const clients = session.ctx.sdkClients
    const state = session.state()

    await updateSdkMcp(session.ctx)
    host.stop()

    expect(host.sent.calc).toBe(handshake)
    expect(session.ctx.sdkClients).toBe(clients)
    expect(session.state()).toBe(state)
  })

  test('closes a server that is no longer declared and drops its tools', async () => {
    let closed = 0
    const session = start({
      appState: { mcp: { clients: [], tools: [toolNamed('mcp__gone__add')], commands: [], resources: {} } } as never,
    })
    session.ctx.sdkClients = [
      { type: 'connected', name: 'gone', config: { type: 'sdk', name: 'gone' }, cleanup: async () => void closed++ },
    ] as never

    await updateSdkMcp(session.ctx)

    expect(closed).toBe(1)
    expect(session.ctx.sdkClients).toEqual([])
    expect(session.state().mcp.tools).toEqual([])
  })

  const retried: Array<[string, 'pending' | 'failed']> = [
    ['a pending server is connected', 'pending'],
    ['a failed server is retried', 'failed'],
  ]
  test.each(retried)('%s', async (_name, type) => {
    const session = start({ sdkMcpConfigs: { calc: { type: 'sdk', name: 'calc' } } })
    session.ctx.sdkClients = [{ type, name: 'calc', config: { type: 'sdk', name: 'calc' } }] as never
    const host = await hostSdkServers(session, { calc: calculator() })
    await updateSdkMcp(session.ctx)
    host.stop()
    expect(session.ctx.sdkClients.map(c => c.type)).toEqual(['connected'])
  })

  test('a server the host refuses is recorded as failed, with no tools', async () => {
    const session = start({ sdkMcpConfigs: { ghost: { type: 'sdk', name: 'ghost' } } })
    const host = await hostSdkServers(session, {})
    await updateSdkMcp(session.ctx)
    host.stop()
    expect(session.ctx.sdkClients.map(c => [c.name, c.type])).toEqual([['ghost', 'failed']])
    expect(session.ctx.sdkTools).toEqual([])
  })
})

describe('applyMcpServerChanges', () => {
  test('declares SDK servers in the shared config object, in place', async () => {
    const shared = { old: { type: 'sdk' as const, name: 'old' } }
    const session = start({ sdkMcpConfigs: shared })
    session.ctx.sdkClients = [{ type: 'pending', name: 'old', config: { type: 'sdk', name: 'old', scope: 'dynamic' } }] as never

    const outcome = await applyMcpServerChanges(session.ctx, { calc: { type: 'sdk', name: 'calc' } })

    expect(outcome).toEqual({ response: { added: ['calc'], removed: ['old'], errors: {} }, sdkServersChanged: true })
    expect(session.ctx.sdkMcpConfigs).toBe(shared)
    expect(shared).toEqual({ calc: { type: 'sdk', name: 'calc' } } as never)
    expect(session.ctx.sdkClients.map(c => [c.name, c.type])).toEqual([['calc', 'pending']])
  })

  test('calls run one after another, each seeing the last one’s result', async () => {
    const session = start()
    const [first, second] = await Promise.all([
      applyMcpServerChanges(session.ctx, { a: { type: 'sdk', name: 'a' } }),
      applyMcpServerChanges(session.ctx, { a: { type: 'sdk', name: 'a' }, b: { type: 'sdk', name: 'b' } }),
    ])
    expect(first.response.added).toEqual(['a'])
    expect(second.response.added).toEqual(['b'])
    expect(Object.keys(session.ctx.sdkMcpConfigs)).toEqual(['a', 'b'])
  })

  test('removing an SDK server drops its tools from the app state', async () => {
    const session = start({
      sdkMcpConfigs: { calc: { type: 'sdk', name: 'calc' } },
      appState: { mcp: { clients: [], tools: [toolNamed('mcp__calc__add'), toolNamed('mcp__keep__x')], commands: [], resources: {} } } as never,
    })
    session.ctx.sdkClients = [{ type: 'pending', name: 'calc', config: { type: 'sdk', name: 'calc', scope: 'dynamic' } }] as never
    const outcome = await applyMcpServerChanges(session.ctx, {})
    expect(outcome.response.removed).toEqual(['calc'])
    expect(session.state().mcp.tools.map(t => t.name)).toEqual(['mcp__keep__x'])
  })

  test('no change reports an empty diff and keeps the SDK tools', async () => {
    const session = start({
      appState: { mcp: { clients: [], tools: [toolNamed('mcp__calc__add')], commands: [], resources: {} } } as never,
    })
    const outcome = await applyMcpServerChanges(session.ctx, {})
    expect(outcome).toEqual({ response: { added: [], removed: [], errors: {} }, sdkServersChanged: false })
    expect(session.state().mcp.tools.map(t => t.name)).toEqual(['mcp__calc__add'])
  })
})

// --- the tool pool and the server list ----------------------------------------------

describe('buildAllTools', () => {
  test('merges the base, SDK and dynamic tools into the built-in pool, once each', () => {
    const session = start({ tools: [toolNamed('mcp__base__one')] })
    session.ctx.sdkTools = [toolNamed('mcp__sdk__two'), toolNamed('mcp__base__one')]
    session.ctx.dynamicMcpState = { clients: [], tools: [toolNamed('mcp__dyn__three')], configs: {} }

    const names = buildAllTools(session.ctx, session.state()).map(t => t.name)

    expect(names.filter(n => n.startsWith('mcp__'))).toEqual(['mcp__base__one', 'mcp__dyn__three', 'mcp__sdk__two'])
    expect(names).toContain('Glob')
    expect(new Set(names).size).toBe(names.length)
  })

  test('leaves out the permission-prompt tool', () => {
    const session = start({ tools: [toolNamed('mcp__perm__ask')], options: { permissionPromptToolName: 'mcp__perm__ask' } })
    expect(buildAllTools(session.ctx, session.state()).map(t => t.name)).not.toContain('mcp__perm__ask')
  })

  const structured: Array<[string, Record<string, unknown> | null, Record<string, unknown> | undefined, boolean]> = [
    ['an initialize schema adds the structured-output tool', { type: 'object', properties: {} }, undefined, true],
    ['a --json-schema flag takes over from it', { type: 'object', properties: {} }, { type: 'object' }, false],
    ['no schema, no tool', null, undefined, false],
  ]
  test.each(structured)('%s', (_name, initSchemaValue, flagSchema, present) => {
    setInitJsonSchema(initSchemaValue as never)
    const session = start({ options: { jsonSchema: flagSchema } })
    expect(buildAllTools(session.ctx, session.state()).map(t => t.name).includes('StructuredOutput')).toBe(present)
  })
})

describe('buildMcpServerStatuses', () => {
  test('describes every server once, in app, SDK, dynamic order', async () => {
    const live = await connectedTo(calculator(), 'calc')
    const session = start({
      appState: {
        mcp: {
          clients: [
            live,
            { type: 'failed', name: 'broken', error: 'spawn ENOENT', config: { type: 'stdio', command: 'nope', args: ['-x'], scope: 'project' } },
          ],
          tools: [toolNamed('mcp__calc__add', { isReadOnly: () => true, isDestructive: () => false, mcpInfo: { serverName: 'calc', toolName: 'add' } } as never)],
          commands: [],
          resources: {},
        },
      } as never,
    })
    session.ctx.sdkClients = [{ type: 'pending', name: 'inproc', config: { type: 'sdk', name: 'inproc', scope: 'dynamic' } }] as never
    session.ctx.dynamicMcpState = {
      clients: [
        { type: 'needs-auth', name: 'remote', config: { type: 'http', url: 'https://mcp.example.test', headers: { a: 'b' }, scope: 'dynamic' } },
        { type: 'pending', name: 'broken', config: { type: 'stdio', command: 'dup', args: [], scope: 'dynamic' } },
      ],
      tools: [],
      configs: {},
    } as never

    const statuses = buildMcpServerStatuses(session.ctx)

    expect(statuses.map(s => [s.name, s.status])).toEqual([
      ['calc', 'connected'],
      ['broken', 'failed'],
      ['inproc', 'pending'],
      ['remote', 'needs-auth'],
    ])
    expect(statuses[0]).toMatchObject({
      serverInfo: { name: 'calc', version: '1.0.0' },
      tools: [{ name: 'add', annotations: { readOnly: true, destructive: undefined, openWorld: undefined } }],
      scope: 'user',
    })
    expect(statuses[1]).toMatchObject({ error: 'spawn ENOENT', config: { type: 'stdio', command: 'nope', args: ['-x'] }, tools: undefined })
    expect(statuses[2]!.config).toBeUndefined()
    expect(statuses[3]!.config).toEqual({ type: 'http', url: 'https://mcp.example.test', headers: { a: 'b' }, oauth: undefined } as never)
  })

  const configs: Array<[string, Record<string, unknown>, unknown]> = [
    ['sse', { type: 'sse', url: 'https://s.test', oauth: { clientId: 'c' } }, { type: 'sse', url: 'https://s.test', headers: undefined, oauth: { clientId: 'c' } }],
    ['claudeai-proxy', { type: 'claudeai-proxy', url: 'https://p.test', id: 'srv_1' }, { type: 'claudeai-proxy', url: 'https://p.test', id: 'srv_1' }],
    ['stdio with no type', { command: 'run', args: ['a'] }, { type: 'stdio', command: 'run', args: ['a'] }],
    ['ws', { type: 'ws', url: 'wss://w.test' }, undefined],
  ]
  test.each(configs)('reports a %s config', (_name, config, expected) => {
    const session = start()
    session.ctx.dynamicMcpState = { clients: [{ type: 'pending', name: 'x', config: { ...config, scope: 'dynamic' } }], tools: [], configs: {} } as never
    expect(buildMcpServerStatuses(session.ctx)[0]!.config).toEqual(expected as never)
  })
})

// --- plugins --------------------------------------------------------------------------

describe('plugins', () => {
  test('refreshPluginState reloads the commands and keeps only the agents the SDK injected', async () => {
    const injected = { agentType: 'from-sdk', whenToUse: 'sdk', source: 'flagSettings', getSystemPrompt: () => '' } as AgentDefinition
    const stale = { agentType: 'stale-plugin-agent', whenToUse: 'old', source: 'projectSettings', getSystemPrompt: () => '' } as AgentDefinition
    const session = start({ agents: [stale, injected] })

    await refreshPluginState(session.ctx)

    const types = session.ctx.currentAgents.map(a => a.agentType)
    expect(types.at(-1)).toBe('from-sdk')
    expect(types).not.toContain('stale-plugin-agent')
    expect(types.length).toBeGreaterThan(1)
    expect(session.ctx.currentCommands.length).toBeGreaterThan(0)
  })

  const diffs: Array<[string, boolean, number]> = [
    ['connects SDK servers when they changed', true, 1],
    ['leaves SDK servers alone when they did not', false, 0],
  ]
  test.each(diffs)('applyPluginMcpDiff re-applies the supported servers and %s', async (_name, sdkChanged, connects) => {
    saveGlobalConfig(current => ({
      ...current,
      mcpServers: {
        local: { type: 'stdio', command: 'node', args: ['server.js'] },
        legacy: { command: 'python', args: ['-m', 'srv'] },
        events: { type: 'sse', url: 'https://sse.example.test' },
        web: { type: 'http', url: 'https://http.example.test' },
        socket: { type: 'ws', url: 'wss://ws.example.test' },
      },
    }))
    const applied: Array<Record<string, unknown>> = []
    const session = start({
      sdkMcpConfigs: { inproc: { type: 'sdk', name: 'inproc' } },
      wiring: {
        applyMcpServerChanges: async configs => {
          applied.push(configs)
          return { response: { added: [], removed: [], errors: {} }, sdkServersChanged: sdkChanged }
        },
        updateSdkMcp: async () => {},
      },
    })

    await applyPluginMcpDiff(session.ctx)

    expect(applied).toHaveLength(1)
    expect(Object.keys(applied[0]!).sort()).toEqual(['events', 'inproc', 'legacy', 'local', 'web'])
    expect(applied[0]!.inproc).toEqual({ type: 'sdk', name: 'inproc' })
    expect(session.calls.updateSdkMcp).toBe(connects)
  })

  test('with nothing to install, the background install leaves MCP alone', async () => {
    const session = start({ wiring: { applyPluginMcpDiff: async () => {} } })
    await installPluginsAndApplyMcpInBackground(session.ctx)
    expect(session.calls.applyPluginMcpDiff).toBe(0)
  })
})
