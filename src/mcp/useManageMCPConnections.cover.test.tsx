// Characterization of useManageMCPConnections: how servers move through
// pending → connected / failed / needs-auth / disabled in AppState, the 16 ms
// batched flush, the list_changed refetches, the reconnect-with-backoff loop
// and the three functions the hook hands back. Pins CURRENT behavior ahead of
// the SDK v2 migration — see the harness for the seams.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import * as debug from 'src/shared/debug.js'
import * as log from 'src/shared/log.js'
import * as mcpClient from 'src/mcp/client.js'
import {
  clientTypes,
  connected,
  deferred,
  failed,
  fakeCommand,
  fakeResource,
  fakeTool,
  httpConfig,
  installMcpFakes,
  mountConnections,
  needsAuth,
  stdioConfig,
  type ConnectionResult,
  type Fakes,
  type Harness,
} from 'src/mcp/__testutils__/mcpConnectionsHarness.js'
import { isSessionDisconnected, markSessionDisconnected } from 'src/mcp/sessionDisconnects.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { PluginError } from 'src/shared/types/plugin.js'
import type { AppState } from 'src/terminal/state/AppState.js'

let installed: Fakes
let ui: Harness | undefined
const extraSpies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  installed = installMcpFakes()
})

afterEach(async () => {
  await ui?.cleanup()
  ui = undefined
  for (const spy of extraSpies.splice(0)) spy.mockRestore()
  installed.restore()
})

function spyLog<K extends 'logMCPError' | 'logMCPDebug'>(name: K) {
  const spy = spyOn(log, name)
  extraSpies.push(spy)
  return spy
}

function client(s: AppState, name: string) {
  return s.mcp.clients.find(c => c.name === name)
}

const settle = () => Bun.sleep(40)

function listChanged(sdk: { notificationHandlers: Map<string, () => Promise<void>> }) {
  return [...sdk.notificationHandlers.keys()].filter(k => k.endsWith('/list_changed')).sort()
}

describe('initial load', () => {
  test('servers start pending, then land as connected / failed / needs-auth with their pool', async () => {
    const { fakes } = installed
    const gate = deferred<void>()
    fakes.servers = { alpha: stdioConfig('alpha'), beta: httpConfig('https://beta.test/mcp') }
    fakes.connect = async (name, config) => {
      await gate.promise
      if (name === 'beta') return failed(name, config)
      if (name === 'gamma') return needsAuth(name, config)
      return connected(name, config, {
        tools: [fakeTool(name, 'echo')],
        commands: [fakeCommand(name, 'greet')],
        resources: [fakeResource(name, 'file:///a')],
      })
    }
    ui = await mountConnections({ gamma: httpConfig('https://gamma.test/mcp', 'dynamic') })
    await ui.until(s => s.mcp.clients.length === 3, 'three pending servers')
    expect(clientTypes(ui.state())).toEqual({ alpha: 'pending', beta: 'pending', gamma: 'pending' })

    gate.resolve()
    await ui.until(s => clientTypes(s).alpha === 'connected', 'alpha connected')
    const s = ui.state()
    expect(clientTypes(s)).toEqual({ alpha: 'connected', beta: 'failed', gamma: 'needs-auth' })
    expect(s.mcp.tools.map(t => t.name)).toEqual(['mcp__alpha__echo'])
    expect(s.mcp.commands.map(c => c.name)).toEqual(['mcp__alpha__greet'])
    expect(s.mcp.resources).toEqual({ alpha: [fakeResource('alpha', 'file:///a')] })
    // The dynamic config is merged over the on-disk ones for the connect.
    expect(Object.keys(installed.fakes.connectBatches[0]!).sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('a disabled server shows as disabled and is never dialled', async () => {
    const { fakes } = installed
    fakes.servers = { on: stdioConfig('on'), off: stdioConfig('off') }
    fakes.disabled.add('off')
    ui = await mountConnections(undefined)
    await ui.until(s => clientTypes(s).on === 'connected', 'on connected')
    expect(clientTypes(ui.state())).toEqual({ on: 'connected', off: 'disabled' })
    expect(fakes.connectBatches).toEqual([{ on: stdioConfig('on') }])
  })

  test('updates arriving inside one 16 ms window commit as a single AppState change', async () => {
    const { fakes } = installed
    fakes.servers = { one: stdioConfig('one'), two: stdioConfig('two'), three: stdioConfig('three') }
    ui = await mountConnections(undefined)
    await ui.until(s => Object.values(clientTypes(s)).every(t => t === 'connected') && s.mcp.clients.length === 3, 'all connected')
    // No committed state ever had some servers connected and others not.
    const partial = ui.history.filter(s => {
      const types = Object.values(clientTypes(s))
      return types.includes('connected') && types.some(t => t !== 'connected')
    })
    expect(partial).toEqual([])
  })

  test('config errors reach plugins.errors once, deduplicated by type:source:plugin', async () => {
    const { fakes } = installed
    const err = { type: 'mcp-config-invalid', source: '.mcp.json', plugin: 'p' } as unknown as PluginError
    const other = { type: 'mcp-config-invalid', source: 'other.json' } as unknown as PluginError
    fakes.configErrors = [err, other]
    ui = await mountConnections(undefined)
    await ui.until(s => s.plugins.errors.length === 2, 'two errors')
    await settle()
    // Both effects report the same list; the second report adds nothing.
    expect(ui.state().plugins.errors).toEqual([err, other])
  })

  test('strict mode connects only the dynamic config and skips disk and claude.ai', async () => {
    const { fakes, spies } = installed
    fakes.servers = { disk: stdioConfig('disk') }
    fakes.claudeai = { 'claude.ai Slack': httpConfig('https://slack.test/mcp', 'claudeai') }
    ui = await mountConnections({ cli: stdioConfig('cli', 'dynamic') }, { strict: true })
    await ui.until(s => clientTypes(s).cli === 'connected', 'cli connected')
    await settle()
    expect(clientTypes(ui.state())).toEqual({ cli: 'connected' })
    expect(spies.getClaudeCodeMcpConfigs).not.toHaveBeenCalled()
    expect(spies.fetchClaudeAIMcpConfigsIfEligible).not.toHaveBeenCalled()
    expect(fakes.connectBatches).toEqual([{ cli: stdioConfig('cli', 'dynamic') }])
  })

  test('claude.ai connectors join as a second phase, deduped against manual servers', async () => {
    const { fakes, spies } = installed
    fakes.servers = {
      slack: httpConfig('https://slack.test/mcp', 'user'),
      ent: stdioConfig('ent', 'enterprise'),
      proj: stdioConfig('proj', 'project'),
      plug: stdioConfig('plug', 'dynamic'),
    }
    fakes.claudeai = {
      'claude.ai Slack': httpConfig('https://slack.test/mcp', 'claudeai'),
      'claude.ai Drive': httpConfig('https://drive.test/mcp', 'claudeai'),
      'claude.ai Off': httpConfig('https://off.test/mcp', 'claudeai'),
    }
    fakes.disabled.add('claude.ai Off')
    ui = await mountConnections(undefined)
    await ui.until(s => clientTypes(s)['claude.ai Drive'] === 'connected', 'drive connected')
    expect(spies.clearClaudeAIMcpConfigsCache).toHaveBeenCalledTimes(1)
    expect(clientTypes(ui.state())['claude.ai Slack']).toBeUndefined()
    expect(clientTypes(ui.state())['claude.ai Off']).toBe('disabled')
    expect(fakes.connectBatches).toHaveLength(2)
    expect(Object.keys(fakes.connectBatches[1]!)).toEqual(['claude.ai Drive'])
  })

  test('an enterprise MCP config turns claude.ai connectors off', async () => {
    const { fakes, spies } = installed
    fakes.enterprise = true
    fakes.servers = { a: stdioConfig('a') }
    fakes.claudeai = { 'claude.ai Drive': httpConfig('https://drive.test/mcp', 'claudeai') }
    ui = await mountConnections(undefined)
    await ui.until(s => clientTypes(s).a === 'connected', 'a connected')
    await settle()
    expect(spies.clearClaudeAIMcpConfigsCache).not.toHaveBeenCalled()
    expect(spies.fetchClaudeAIMcpConfigsIfEligible).not.toHaveBeenCalled()
    expect(fakes.connectBatches).toHaveLength(1)
  })

  test('a failing config load and a failing connect batch are logged, not thrown', async () => {
    const { fakes, spies } = installed
    const logged = spyLog('logMCPError')
    fakes.servers = { a: stdioConfig('a') }
    spies.getClaudeCodeMcpConfigs.mockImplementationOnce(async () => {
      throw new Error('bad json')
    })
    spies.getMcpToolsCommandsAndResources.mockImplementationOnce(async () => {
      throw new Error('spawn failed')
    })
    ui = await mountConnections(undefined)
    await ui.until(() => logged.mock.calls.length >= 2, 'both errors logged')
    expect(logged.mock.calls).toContainEqual([
      'useManageMCPConnections',
      'Failed to initialize servers as pending: bad json',
    ])
    expect(logged.mock.calls).toContainEqual(['useManageMcpConnections', 'Failed to get MCP resources: spawn failed'])
  })

  test('a claude.ai connect batch that rejects is logged', async () => {
    const { fakes, spies } = installed
    const logged = spyLog('logMCPError')
    fakes.claudeai = { 'claude.ai Drive': httpConfig('https://drive.test/mcp', 'claudeai') }
    const real = spies.getMcpToolsCommandsAndResources.getMockImplementation()!
    spies.getMcpToolsCommandsAndResources.mockImplementation(async (cb, configs) => {
      if (configs && 'claude.ai Drive' in configs) throw new Error('proxy down')
      return real(cb, configs)
    })
    ui = await mountConnections(undefined)
    await ui.until(() => logged.mock.calls.length >= 1, 'error logged')
    expect(logged.mock.calls).toContainEqual([
      'useManageMcpConnections',
      'Failed to get claude.ai MCP resources: proxy down',
    ])
    expect(clientTypes(ui.state())['claude.ai Drive']).toBe('pending')
  })
})

describe('re-running on a config change', () => {
  test('a server whose config changed is torn down, its pool dropped, and dialled again', async () => {
    const { fakes, spies } = installed
    let generation = 0
    fakes.connect = (name, config) => {
      generation++
      return connected(name, config, { tools: [fakeTool(name, `v${generation}`)] })
    }
    ui = await mountConnections({ srv: stdioConfig('old', 'dynamic') })
    await ui.until(s => s.mcp.tools.some(t => t.name === 'mcp__srv__v1'), 'first generation')
    const first = client(ui.state(), 'srv') as { client: { onclose?: unknown } }
    expect(typeof first.client.onclose).toBe('function')

    ui.setDynamic({ srv: stdioConfig('new', 'dynamic') })
    await ui.until(s => s.mcp.tools.some(t => t.name === 'mcp__srv__v2'), 'second generation')
    expect(first.client.onclose).toBeUndefined()
    expect(spies.clearServerCache).toHaveBeenCalledWith('srv', stdioConfig('old', 'dynamic'))
    expect(ui.state().mcp.tools.map(t => t.name)).toEqual(['mcp__srv__v2'])
    expect((client(ui.state(), 'srv') as { config: unknown }).config).toEqual(stdioConfig('new', 'dynamic'))
  })

  test('a plugin server that left the config is dropped; a never-connected stale one is not cleaned up', async () => {
    const { fakes, spies } = installed
    fakes.connect = (name, config) =>
      name === 'gone' ? failed(name, config) : connected(name, config)
    ui = await mountConnections({ keep: stdioConfig('keep', 'dynamic'), gone: stdioConfig('gone', 'dynamic') })
    await ui.until(s => clientTypes(s).gone === 'failed' && clientTypes(s).keep === 'connected', 'both settled')

    ui.setDynamic({ keep: stdioConfig('keep', 'dynamic') })
    await ui.until(s => clientTypes(s).gone === undefined, 'gone removed')
    expect(spies.clearServerCache).not.toHaveBeenCalled()
  })

  test('changing the config while the first load is in flight abandons the first load', async () => {
    const { fakes, spies } = installed
    const firstLoad = deferred<{ servers: Record<string, ScopedMcpServerConfig>; errors: PluginError[] }>()
    spies.getClaudeCodeMcpConfigs
      .mockImplementationOnce(async () => ({ servers: {}, errors: [] }))
      .mockImplementationOnce(() => firstLoad.promise)
    ui = await mountConnections({ a: stdioConfig('a', 'dynamic') })
    await ui.until(s => clientTypes(s).a === 'pending', 'a pending')
    ui.setDynamic({ b: stdioConfig('b', 'dynamic') })
    await ui.until(s => clientTypes(s).b === 'connected', 'b connected')
    firstLoad.resolve({ servers: {}, errors: [] })
    await settle()
    expect(fakes.connectBatches).toEqual([{ b: stdioConfig('b', 'dynamic') }])
  })

  test('claude.ai phase is abandoned when the config changes while it is fetched', async () => {
    const { fakes, spies } = installed
    const slow = deferred<Record<string, ScopedMcpServerConfig>>()
    // The export is memoized, so its type carries `.cache`; the spy never reads it.
    spies.fetchClaudeAIMcpConfigsIfEligible.mockImplementationOnce((() => slow.promise) as never)
    fakes.claudeai = { 'claude.ai Drive': httpConfig('https://drive.test/mcp', 'claudeai') }
    ui = await mountConnections({ a: stdioConfig('a', 'dynamic') })
    await ui.until(s => clientTypes(s).a === 'connected', 'a connected')
    ui.setDynamic({ a: stdioConfig('a', 'dynamic'), b: stdioConfig('b', 'dynamic') })
    await ui.until(s => clientTypes(s)['claude.ai Drive'] === 'connected', 'second run connects drive')
    const batchesBefore = fakes.connectBatches.length
    slow.resolve({ 'claude.ai Late': httpConfig('https://late.test/mcp', 'claudeai') })
    await settle()
    expect(fakes.connectBatches).toHaveLength(batchesBefore)
    expect(clientTypes(ui.state())['claude.ai Late']).toBeUndefined()
  })

  test('bumping pluginReconnectKey reloads the configs', async () => {
    const { fakes, spies } = installed
    fakes.servers = { a: stdioConfig('a') }
    ui = await mountConnections(undefined)
    await ui.until(s => clientTypes(s).a === 'connected', 'a connected')
    const calls = spies.getClaudeCodeMcpConfigs.mock.calls.length
    fakes.servers = { a: stdioConfig('a'), b: stdioConfig('b') }
    ui.store().setState(s => ({ ...s, mcp: { ...s.mcp, pluginReconnectKey: s.mcp.pluginReconnectKey + 1 } }))
    await ui.until(s => clientTypes(s).b === 'connected', 'b connected')
    expect(spies.getClaudeCodeMcpConfigs.mock.calls.length).toBe(calls + 2)
  })
})

describe('a connected server', () => {
  test('gets the real elicitation handler registered on its client', async () => {
    const { fakes } = installed
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    fakes.connect = (name, config) => {
      const r = connected(name, config)
      sdk = r.sdk
      return r
    }
    ui = await mountConnections({ a: stdioConfig('a', 'dynamic') })
    await ui.until(s => clientTypes(s).a === 'connected', 'a connected')
    expect(sdk!.requestHandlers).toEqual(['elicitation/create'])
  })

  test('registers list_changed handlers only for the lists the server says can change', async () => {
    const { fakes } = installed
    const sdks: Record<string, ReturnType<typeof connected>['sdk']> = {}
    fakes.connect = (name, config) => {
      const r = connected(name, config, {
        capabilities:
          name === 'all'
            ? { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } }
            : { tools: {}, prompts: { listChanged: false }, resources: {} },
      })
      sdks[name] = r.sdk
      return r
    }
    ui = await mountConnections({ all: stdioConfig('all', 'dynamic'), none: stdioConfig('none', 'dynamic') })
    await ui.until(s => clientTypes(s).all === 'connected' && clientTypes(s).none === 'connected', 'connected')
    expect(listChanged(sdks.all!)).toEqual([
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
      'notifications/tools/list_changed',
    ])
    expect(listChanged(sdks.none!)).toEqual([])
    // The elicitation handler adds its URL-mode completion listener either way.
    expect([...sdks.none!.notificationHandlers.keys()]).toEqual(['notifications/elicitation/complete'])
  })

  test('a list_changed refetch that throws is logged and leaves the pool alone', async () => {
    const { fakes } = installed
    const logged = spyLog('logMCPError')
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    fakes.connect = (name, config) => {
      const r = connected(name, config, {
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } },
        tools: [fakeTool(name, 'keep')],
      })
      sdk = r.sdk
      return r
    }
    const boom = () => Promise.reject(new Error('gone'))
    const tools = spyOn(mcpClient, 'fetchToolsForClient').mockImplementation(boom as never)
    const prompts = spyOn(mcpClient, 'fetchCommandsForClient').mockImplementation(boom as never)
    const resources = spyOn(mcpClient, 'fetchResourcesForClient').mockImplementation(boom as never)
    extraSpies.push(tools, prompts, resources)
    // The hook clears the memo before refetching; the spies carry the real caches.
    Object.assign(tools, { cache: new Map() })
    Object.assign(prompts, { cache: new Map() })
    Object.assign(resources, { cache: new Map() })

    ui = await mountConnections({ err: stdioConfig('err', 'dynamic') })
    await ui.until(s => clientTypes(s).err === 'connected', 'connected')
    for (const list of ['tools', 'prompts', 'resources']) {
      await sdk!.notificationHandlers.get(`notifications/${list}/list_changed`)!()
    }
    await settle()
    expect(logged.mock.calls).toEqual([
      ['err', 'Failed to refresh tools after list_changed notification: gone'],
      ['err', 'Failed to refresh prompts after list_changed notification: gone'],
      ['err', 'Failed to refresh resources after list_changed notification: gone'],
    ])
    expect(ui.state().mcp.tools.map(t => t.name)).toEqual(['mcp__err__keep'])
  })
})

describe('list_changed over a real SDK client and server', () => {
  test('a server that adds a tool, a prompt and a resource is refetched into the pool', async () => {
    const server = new McpServer({ name: 'live', version: '1.0.0' })
    server.registerTool('first', { description: 'one' }, async () => ({ content: [] }))
    server.registerPrompt('hello', { description: 'hi' }, async () => ({ messages: [] }))
    server.registerResource('a', 'live://a', {}, async uri => ({ contents: [{ uri: uri.href, text: 'a' }] }))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const sdk = new Client({ name: 'cover', version: '1.0.0' }, { capabilities: { elicitation: {} } })
    await Promise.all([server.connect(serverSide), sdk.connect(clientSide)])
    const config = { type: 'sdk', name: 'live', scope: 'dynamic' } as ScopedMcpServerConfig
    const conn = {
      type: 'connected',
      name: 'live',
      config,
      capabilities: sdk.getServerCapabilities()!,
      client: sdk,
      cleanup: async () => {},
    } as ConnectedMCPServer
    // A foreign tool ahead of the server's block: the refresh must not move it.
    installed.fakes.connect = async () => ({
      client: conn,
      tools: [fakeTool('other', 'x'), ...(await mcpClient.fetchToolsForClient(conn))],
      commands: await mcpClient.fetchCommandsForClient(conn),
      resources: await mcpClient.fetchResourcesForClient(conn),
    })
    try {
      ui = await mountConnections({ live: config })
      await ui.until(s => clientTypes(s).live === 'connected', 'live connected')
      const before = ui.state().mcp.tools.find(t => t.name === 'mcp__live__first')

      server.registerTool('second', { description: 'two' }, async () => ({ content: [] }))
      await ui.until(s => s.mcp.tools.length === 3, 'second tool')
      expect(ui.state().mcp.tools.map(t => t.name)).toEqual([
        'mcp__other__x',
        'mcp__live__first',
        'mcp__live__second',
      ])
      // Same position, fresh object: the memo was dropped before the refetch.
      expect(ui.state().mcp.tools[1]).not.toBe(before)

      server.registerPrompt('bye', { description: 'bye' }, async () => ({ messages: [] }))
      await ui.until(s => s.mcp.commands.length === 2, 'second prompt')
      expect(ui.state().mcp.commands.map(c => c.name).sort()).toEqual(['mcp__live__bye', 'mcp__live__hello'])

      server.registerResource('b', 'live://b', {}, async uri => ({ contents: [{ uri: uri.href, text: 'b' }] }))
      await ui.until(s => (s.mcp.resources.live ?? []).length === 2, 'second resource')
      expect(ui.state().mcp.resources.live!.map(r => r.uri)).toEqual(['live://a', 'live://b'])
    } finally {
      await ui?.cleanup()
      ui = undefined
      sdk.onclose = undefined
      await sdk.close()
      await server.close()
      for (const fetch of [
        mcpClient.fetchToolsForClient,
        mcpClient.fetchCommandsForClient,
        mcpClient.fetchResourcesForClient,
        mcpClient.fetchResourceTemplatesForClient,
      ]) {
        fetch.cache.delete('live')
      }
    }
  })
})

describe('when the transport closes', () => {
  async function mountOne(name: string, config: ScopedMcpServerConfig, extra: Partial<Parameters<typeof connected>[2]> = {}) {
    const { fakes } = installed
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    fakes.connect = (n, c) => {
      const r = connected(n, c, {
        tools: [fakeTool(n, 'echo')],
        commands: [fakeCommand(n, 'greet')],
        resources: [fakeResource(n, 'file:///r')],
        ...extra,
      })
      sdk = r.sdk
      return r
    }
    ui = await mountConnections({ [name]: config })
    await ui.until(s => clientTypes(s)[name] === 'connected', `${name} connected`)
    return sdk!
  }

  test('a stdio server goes failed, keeps its tools, drops its commands — and its resources stay', async () => {
    const config = stdioConfig('loc', 'dynamic')
    const sdk = await mountOne('loc', config)
    sdk.onclose!()
    await ui!.until(s => clientTypes(s).loc === 'failed', 'loc failed')
    const s = ui!.state()
    expect(s.mcp.tools.map(t => t.name)).toEqual(['mcp__loc__echo'])
    expect(s.mcp.commands).toEqual([])
    // CURRENT BEHAVIOR (bug): `{ ...mcp.resources, ...omit(mcp.resources, name) }`
    // spreads the old map first, so the omit never removes the server's key.
    expect(s.mcp.resources).toEqual({ loc: [fakeResource('loc', 'file:///r')] })
    expect(installed.spies.clearServerCache).toHaveBeenCalledWith('loc', config)
    expect(installed.fakes.reconnectCalls).toEqual([])
  })

  test('an sdk server goes failed without a reconnect', async () => {
    const sdk = await mountOne('inproc', { type: 'sdk', name: 'inproc', scope: 'dynamic' } as ScopedMcpServerConfig)
    sdk.onclose!()
    await ui!.until(s => clientTypes(s).inproc === 'failed', 'inproc failed')
    expect(installed.fakes.reconnectCalls).toEqual([])
  })

  test('a cache-clear failure on close is only a debug line', async () => {
    const debugged = spyOn(debug, 'logForDebugging')
    extraSpies.push(debugged)
    installed.spies.clearServerCache.mockImplementation(async () => {
      throw new Error('x')
    })
    const sdk = await mountOne('cc', stdioConfig('cc', 'dynamic'))
    sdk.onclose!()
    await ui!.until(s => clientTypes(s).cc === 'failed', 'cc failed')
    await settle()
    expect(debugged.mock.calls).toContainEqual(['Failed to invalidate the server cache: cc'])
  })

  // The close handler's own guard must stop the redial before the reconnect
  // loop starts — the loop re-checks the same thing, so the end state alone
  // cannot tell the two apart. The debug lines say which guard fired.
  for (const how of ['disabled on disk', 'disconnected for the session'] as const) {
    test(`a server ${how} is left alone, stopped before the reconnect loop starts`, async () => {
      const sdk = await mountOne('quiet', httpConfig('https://quiet.test/mcp', 'dynamic'))
      const debugLog = spyLog('logMCPDebug')
      if (how === 'disabled on disk') installed.fakes.disabled.add('quiet')
      else markSessionDisconnected('quiet')
      sdk.onclose!()
      await settle()
      const lines = debugLog.mock.calls.filter(c => c[0] === 'quiet').map(c => c[1])
      expect(lines).toEqual(['Server is disabled, skipping automatic reconnection'])
      expect(clientTypes(ui!.state()).quiet).toBe('connected')
      expect(installed.fakes.reconnectCalls).toEqual([])
      expect(installed.fakes.backoffDelays).toEqual([])
    })
  }

  test('an http server goes pending with attempt 1/5 and comes back connected', async () => {
    const debugLog = spyLog('logMCPDebug')
    const config = httpConfig('https://remote.test/mcp', 'dynamic')
    const sdk = await mountOne('remote', config)
    const gate = deferred<ConnectionResult>()
    const back = connected('remote', config, { tools: [fakeTool('remote', 'fresh')] })
    const reconnect = installed.spies.reconnectMcpServerImpl.mockImplementation((async () => gate.promise) as never)

    sdk.onclose!()
    await ui!.until(s => clientTypes(s).remote === 'pending', 'remote pending')
    expect(client(ui!.state(), 'remote')).toMatchObject({ reconnectAttempt: 1, maxReconnectAttempts: 5 })
    gate.resolve(back)
    await ui!.until(s => clientTypes(s).remote === 'connected', 'remote back')
    expect(ui!.state().mcp.tools.map(t => t.name)).toEqual(['mcp__remote__fresh'])
    expect(reconnect).toHaveBeenCalledWith('remote', config)
    // The new client gets its own handlers.
    expect(back.sdk.requestHandlers).toEqual(['elicitation/create'])
    expect(typeof back.sdk.onclose).toBe('function')
    expect(debugLog.mock.calls.map(c => c[1])).toContain(
      'HTTP transport closed/disconnected, attempting automatic reconnection',
    )
  })

  test('five failed attempts back off 1s, 2s, 4s, 8s and settle on the last result, tools included', async () => {
    const config = { type: 'sse', url: 'https://sse.test/mcp', scope: 'dynamic' } as ScopedMcpServerConfig
    const sdk = await mountOne('sse', config)
    installed.fakes.reconnect = [failed('sse', config)]
    sdk.onclose!()
    await ui!.until(() => installed.fakes.reconnectCalls.length === 5, 'five attempts')
    await ui!.until(s => clientTypes(s).sse === 'failed', 'sse failed')
    expect(installed.fakes.backoffDelays).toEqual([1000, 2000, 4000, 8000])
    // The final result's explicit `tools: []` replaces the pool — unlike a bare close.
    expect(ui!.state().mcp.tools).toEqual([])
  })

  test('five attempts that throw end failed', async () => {
    const errors = spyLog('logMCPError')
    const config = { type: 'ws', url: 'wss://ws.test/mcp', scope: 'dynamic' } as ScopedMcpServerConfig
    const sdk = await mountOne('ws', config)
    installed.fakes.reconnect = [new Error('refused')]
    sdk.onclose!()
    await ui!.until(() => installed.fakes.reconnectCalls.length === 5, 'five attempts')
    await ui!.until(s => clientTypes(s).ws === 'failed', 'ws failed')
    expect(errors.mock.calls).toHaveLength(5)
    expect(String(errors.mock.calls[0]![1])).toMatch(/^WebSocket reconnection attempt 1 failed after \d+ms: Error: refused$/)
  })

  test('disabling the server between attempts stops the retry', async () => {
    const config = httpConfig('https://flaky.test/mcp', 'dynamic')
    const sdk = await mountOne('flaky', config)
    const reconnect = installed.spies.reconnectMcpServerImpl.mockImplementation((async () => {
      installed.fakes.disabled.add('flaky')
      return failed('flaky', config)
    }) as never)
    sdk.onclose!()
    await ui!.until(() => installed.fakes.backoffDelays.length === 1, 'first backoff')
    await settle()
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(clientTypes(ui!.state()).flaky).toBe('pending')
  })

  test('a second close while a retry waits cancels the waiting timer', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://twice.test/mcp', 'dynamic')
    const sdk = await mountOne('twice', config)
    installed.fakes.reconnect = [failed('twice', config)]
    sdk.onclose!()
    await ui!.until(() => installed.fakes.backoffDelays.length === 1, 'first backoff armed')
    sdk.onclose!()
    await ui!.until(() => installed.fakes.backoffDelays.length === 2, 'second loop backoff armed')
    // Each loop made exactly one attempt; the first loop's timer was cleared.
    expect(installed.fakes.reconnectCalls).toHaveLength(2)
  })

  test('a stale server with a waiting retry has its timer cleared on config change', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://moving.test/mcp', 'dynamic')
    const sdk = await mountOne('moving', config)
    installed.fakes.reconnect = [failed('moving', config)]
    sdk.onclose!()
    await ui!.until(() => installed.fakes.backoffDelays.length === 1, 'backoff armed')
    await ui!.until(s => clientTypes(s).moving === 'pending', 'moving pending')
    // The retry is still pending → stale but not connected: no cache clear.
    ui!.setDynamic({ moving: httpConfig('https://moved.test/mcp', 'dynamic') })
    await ui!.until(
      s => (client(s, 'moving') as { config: { url: string } } | undefined)?.config.url === 'https://moved.test/mcp' &&
        clientTypes(s).moving === 'connected',
      'reconnected at the new url',
    )
    expect(installed.spies.clearServerCache).toHaveBeenCalledTimes(1) // only the onclose one
  })

  test('unmount during a backoff wait cancels the retry', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://bye.test/mcp', 'dynamic')
    const sdk = await mountOne('bye', config)
    installed.fakes.reconnect = [failed('bye', config)]
    sdk.onclose!()
    await ui!.until(() => installed.fakes.backoffDelays.length === 1, 'backoff armed')
    const timer = installed.fakes.backoffTimers[0]
    const cleared = spyOn(globalThis, 'clearTimeout')
    extraSpies.push(cleared)
    await ui!.cleanup()
    ui = undefined
    expect(cleared.mock.calls.map(c => c[0])).toContain(timer as never)
    expect(installed.fakes.reconnectCalls).toHaveLength(1)
  })
})

describe('returned functions', () => {
  test('reconnectMcpServer redials, clears a session disconnect, and returns the result', async () => {
    const config = stdioConfig('re', 'dynamic')
    installed.fakes.connect = (n, c) => failed(n, c)
    ui = await mountConnections({ re: config })
    await ui.until(s => clientTypes(s).re === 'failed', 're failed')
    markSessionDisconnected('re')
    const back = connected('re', config, { tools: [fakeTool('re', 't')] })
    installed.fakes.reconnect = [back]
    const result = await ui.api().reconnectMcpServer('re')
    expect(result).toBe(back)
    expect(isSessionDisconnected('re')).toBe(false)
    expect(installed.fakes.reconnectCalls).toEqual([['re', config]])
    await ui.until(s => clientTypes(s).re === 'connected', 're connected')
    expect(ui.state().mcp.tools.map(t => t.name)).toEqual(['mcp__re__t'])
  })

  test('reconnectMcpServer cancels a waiting automatic retry', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://manual.test/mcp', 'dynamic')
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    installed.fakes.connect = (n, c) => {
      const r = connected(n, c)
      sdk = r.sdk
      return r
    }
    ui = await mountConnections({ manual: config })
    await ui.until(s => clientTypes(s).manual === 'connected', 'connected')
    installed.fakes.reconnect = [failed('manual', config), connected('manual', config)]
    sdk!.onclose!()
    await ui.until(() => installed.fakes.backoffDelays.length === 1, 'backoff armed')
    await ui.api().reconnectMcpServer('manual')
    await ui.until(s => clientTypes(s).manual === 'connected', 'manual connected')
    await settle()
    expect(installed.fakes.reconnectCalls).toHaveLength(2)
  })

  test('all three throw for an unknown server', async () => {
    ui = await mountConnections(undefined)
    await expect(ui.api().reconnectMcpServer('nope')).rejects.toThrow('MCP server nope not found')
    await expect(ui.api().toggleMcpServer('nope')).rejects.toThrow('MCP server nope not found')
    await expect(ui.api().disconnectMcpServer('nope')).rejects.toThrow('MCP server nope not found')
  })

  test('toggleMcpServer disables a connected server: persisted, cache cleared, pool emptied', async () => {
    const config = stdioConfig('tog', 'dynamic')
    installed.fakes.connect = (n, c) =>
      connected(n, c, { tools: [fakeTool(n, 'a')], commands: [fakeCommand(n, 'p')], resources: [fakeResource(n, 'r://1')] })
    ui = await mountConnections({ tog: config })
    await ui.until(s => clientTypes(s).tog === 'connected', 'connected')
    await ui.api().toggleMcpServer('tog')
    await ui.until(s => clientTypes(s).tog === 'disabled', 'disabled')
    expect(installed.spies.setMcpServerEnabled).toHaveBeenCalledWith('tog', false)
    expect(installed.spies.clearServerCache).toHaveBeenCalledWith('tog', config)
    const s = ui.state()
    expect(s.mcp.tools).toEqual([])
    expect(s.mcp.commands).toEqual([])
    // CURRENT BEHAVIOR (bug): see the stdio-close test — the resources key survives.
    expect(s.mcp.resources).toEqual({ tog: [fakeResource('tog', 'r://1')] })
  })

  test('toggleMcpServer on a failed server disables it without touching the cache', async () => {
    installed.fakes.connect = (n, c) => failed(n, c)
    ui = await mountConnections({ f: stdioConfig('f', 'dynamic') })
    await ui.until(s => clientTypes(s).f === 'failed', 'failed')
    await ui.api().toggleMcpServer('f')
    await ui.until(s => clientTypes(s).f === 'disabled', 'disabled')
    expect(installed.spies.clearServerCache).not.toHaveBeenCalled()
  })

  test('toggleMcpServer enables a disabled server: persisted, pending, then the reconnect result', async () => {
    const config = stdioConfig('en', 'dynamic')
    installed.fakes.disabled.add('en')
    markSessionDisconnected('en')
    ui = await mountConnections({ en: config })
    await ui.until(s => clientTypes(s).en === 'disabled', 'disabled')
    const gate = deferred<ConnectionResult>()
    const reconnect = installed.spies.reconnectMcpServerImpl.mockImplementation((() => gate.promise) as never)
    const toggled = ui.api().toggleMcpServer('en')
    await ui.until(s => clientTypes(s).en === 'pending', 'pending')
    expect(installed.spies.setMcpServerEnabled).toHaveBeenCalledWith('en', true)
    expect(isSessionDisconnected('en')).toBe(false)
    gate.resolve(connected('en', config))
    await toggled
    await ui.until(s => clientTypes(s).en === 'connected', 'connected')
    expect(reconnect).toHaveBeenCalledWith('en', config)
  })

  test('toggleMcpServer cancels a waiting automatic retry before disabling', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://tog2.test/mcp', 'dynamic')
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    installed.fakes.connect = (n, c) => {
      const r = connected(n, c)
      sdk = r.sdk
      return r
    }
    ui = await mountConnections({ tog2: config })
    await ui.until(s => clientTypes(s).tog2 === 'connected', 'connected')
    installed.fakes.reconnect = [failed('tog2', config)]
    sdk!.onclose!()
    await ui.until(() => installed.fakes.backoffDelays.length === 1, 'backoff armed')
    await ui.api().toggleMcpServer('tog2')
    await ui.until(s => clientTypes(s).tog2 === 'disabled', 'disabled')
    expect(installed.fakes.reconnectCalls).toHaveLength(1)
  })

  test('disconnectMcpServer drops the server for the session only, and the close does not redial', async () => {
    const config = httpConfig('https://drop.test/mcp', 'dynamic')
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    installed.fakes.connect = (n, c) => {
      const r = connected(n, c, { tools: [fakeTool(n, 'x')] })
      sdk = r.sdk
      return r
    }
    installed.spies.clearServerCache.mockImplementation(async () => {
      sdk!.onclose?.()
    })
    ui = await mountConnections({ drop: config })
    await ui.until(s => clientTypes(s).drop === 'connected', 'connected')
    await ui.api().disconnectMcpServer('drop')
    await ui.until(s => clientTypes(s).drop === 'disabled', 'disabled')
    await settle()
    expect(isSessionDisconnected('drop')).toBe(true)
    expect(installed.spies.setMcpServerEnabled).not.toHaveBeenCalled()
    expect(installed.spies.clearServerCache).toHaveBeenCalledWith('drop', config)
    expect(installed.fakes.reconnectCalls).toEqual([])
    expect(clientTypes(ui.state()).drop).toBe('disabled')
    expect(ui.state().mcp.tools).toEqual([])
  })

  test('disconnectMcpServer cancels a waiting retry and skips the cache for a non-connected server', async () => {
    installed.fakes.shrinkBackoff = false
    const config = httpConfig('https://dc.test/mcp', 'dynamic')
    let sdk: ReturnType<typeof connected>['sdk'] | undefined
    installed.fakes.connect = (n, c) => {
      const r = connected(n, c)
      sdk = r.sdk
      return r
    }
    ui = await mountConnections({ dc: config })
    await ui.until(s => clientTypes(s).dc === 'connected', 'connected')
    installed.fakes.reconnect = [failed('dc', config)]
    sdk!.onclose!()
    await ui.until(() => installed.fakes.backoffDelays.length === 1, 'backoff armed')
    await ui.until(s => clientTypes(s).dc === 'pending', 'dc pending')
    const cacheClears = installed.spies.clearServerCache.mock.calls.length
    await ui.api().disconnectMcpServer('dc')
    await ui.until(s => clientTypes(s).dc === 'disabled', 'disabled')
    expect(installed.spies.clearServerCache.mock.calls.length).toBe(cacheClears)
    expect(installed.fakes.reconnectCalls).toHaveLength(1)
  })

  test('unmount flushes an update still waiting in the 16 ms batch', async () => {
    installed.fakes.connect = (n, c) => failed(n, c)
    ui = await mountConnections({ late: stdioConfig('late', 'dynamic') })
    await ui.until(s => clientTypes(s).late === 'failed', 'failed')
    const store = ui.store()
    void ui.api().disconnectMcpServer('late')
    expect(clientTypes(store.getState()).late).toBe('failed')
    await ui.cleanup()
    ui = undefined
    expect(clientTypes(store.getState()).late).toBe('disabled')
  })
})
