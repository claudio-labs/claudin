/**
 * What the rewrite decides that the characterization suites do not reach:
 * the paths that must not start or redial a server, the runtime once it is
 * disposed, and refetches that outlive their connection.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { addPlugin, enterWorld, leaveWorld, setToggles, setUserServers, withEnv, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  holdBackoffTimers,
  killAllStdioServers,
  mountManager,
  quiet,
  socketConfig,
  startSocketServer,
  stdioServer,
  stopAllSocketServers,
  unmountAll,
  until,
  type HeldClock,
  type Mounted,
  type SocketServer,
} from 'src/mcp/__testutils__/connectionRig.js'
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/mcp/claudeai.js'
import { followListChanges } from 'src/mcp/connectionManager/listRefresh.js'
import { createConnectionRuntime } from 'src/mcp/connectionManager/runtime.js'
import type { ServerUpdate } from 'src/mcp/connectionManager/types.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getSessionId, regenerateSessionId, setInlinePlugins, switchSession } from 'src/platform/bootstrap/state.js'
import { clearPluginCache } from 'src/plugins/pluginLoader.js'
import { emitAuthChanged } from 'src/providers/auth/authChanged.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { createStore } from 'src/terminal/state/store.js'

const SLOW = 20_000
const CONFIG = { type: 'ws', url: 'ws://127.0.0.1:1/mcp', scope: 'user' } as ScopedMcpServerConfig

type FakeClient = {
  onclose?: () => void
  handlers: Array<() => Promise<void>>
  setNotificationHandler: (schema: unknown, handler: () => Promise<void>) => void
  setRequestHandler: () => void
  request: () => Promise<unknown>
}

function fakeServer(request: () => Promise<unknown> = async () => ({ tools: [] })): {
  server: ConnectedMCPServer
  client: FakeClient
} {
  const client: FakeClient = {
    handlers: [],
    setNotificationHandler: (_schema, handler) => {
      client.handlers.push(handler)
    },
    setRequestHandler: () => {},
    request,
  }
  const server = {
    name: 'fake',
    type: 'connected',
    config: CONFIG,
    capabilities: { tools: { listChanged: true } },
    client: client as unknown as Client,
    cleanup: async () => {},
  } as ConnectedMCPServer
  return { server, client }
}

describe('the runtime once disposed', () => {
  test('watches nothing new, and hands a close back to the client', () => {
    const store = createStore(getDefaultAppState())
    const runtime = createConnectionRuntime(store, { dial: async () => ({ client: fakeServer().server, tools: [], commands: [] }) })
    const watched = fakeServer()
    const own = mock(() => {})
    watched.client.onclose = own
    runtime.adopt({ client: watched.server, tools: [], commands: [] })
    expect(watched.client.onclose).not.toBe(own)

    runtime.dispose()
    watched.client.onclose?.()
    expect(own).toHaveBeenCalledTimes(1)

    const late = fakeServer()
    const lateOwn = () => {}
    late.client.onclose = lateOwn
    runtime.adopt({ client: late.server, tools: [], commands: [] })
    expect(late.client.onclose).toBe(lateOwn)
  })
})

describe('a refetch through the runtime', () => {
  test('reaches nothing once its connection is retired', async () => {
    const store = createStore(getDefaultAppState())
    const runtime = createConnectionRuntime(store, { dial: async () => ({ client: fakeServer().server, tools: [], commands: [] }) })
    const { server, client } = fakeServer(async () => ({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] }))
    runtime.adopt({ client: server, tools: [], commands: [] })
    runtime.flush()
    expect(store.getState().mcp.clients.map(c => c.type)).toEqual(['connected'])

    runtime.retire('fake')
    const before = store.getState()
    await client.handlers[0]!()
    runtime.flush()
    expect(store.getState()).toBe(before)
    runtime.dispose()
  })
})

describe('a list refetch', () => {
  test('is reported while its connection is current, and dropped once it is not', async () => {
    let current = true
    const reports: ServerUpdate[] = []
    const { server, client } = fakeServer(async () => ({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] }))
    followListChanges(server, { isCurrent: () => current, report: update => reports.push(update) })
    expect(client.handlers).toHaveLength(1)

    await client.handlers[0]!()
    expect(reports.map(r => r.tools?.map(t => t.name))).toEqual([['mcp__fake__x']])

    current = false
    await client.handlers[0]!()
    expect(reports).toHaveLength(1)
  })
})

describe('through the manager', () => {
  let world: World
  let clock: HeldClock | undefined
  let restoreEnv: () => void
  beforeEach(() => {
    world = enterWorld()
    restoreEnv = withEnv({ MCP_TIMEOUT: '45000' })
  })
  afterEach(async () => {
    clock?.release()
    clock = undefined
    await unmountAll()
    stopAllSocketServers()
    killAllStdioServers()
    restoreEnv()
    leaveWorld()
  })

  const written = (server: SocketServer) => {
    const { scope: _scope, ...rest } = socketConfig(server)
    return rest
  }
  const bump = (m: Mounted) =>
    m.store.setState(s => ({ ...s, mcp: { ...s.mcp, pluginReconnectKey: s.mcp.pluginReconnectKey + 1 } }))

  async function connected(): Promise<{ ws: SocketServer; m: Mounted }> {
    const ws = startSocketServer({ tools: ['a'] })
    setUserServers({ sock: written(ws) })
    const m = await mountManager()
    await m.reaches('sock', 'connected')
    return { ws, m }
  }

  test(
    'a local server that exited after a reload is respawned by the next reload',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['t'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      await m.reaches('local', 'connected')
      bump(m)
      await quiet(300)
      const firstPid = local.pid()
      local.kill()
      await m.reaches('local', 'failed')
      bump(m)
      await until('a new process', () => local.pid() !== firstPid)
      await m.reaches('local', 'connected')
    },
    SLOW,
  )

  test(
    'reconnecting a local server does not report its old process as failed',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['t'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      await m.reaches('local', 'connected')
      const firstPid = local.pid()
      const from = m.changes()
      await m.reconnect('local')
      await quiet(800)
      expect(local.pid()).not.toBe(firstPid)
      const after = m.history().slice(from).map(s => s.mcp.clients.find(c => c.name === 'local')?.type)
      expect(after).not.toContain('failed')
      expect(m.client('local')?.type).toBe('connected')
    },
    SLOW,
  )

  test(
    'unmounting applies a queued update at once',
    async () => {
      setUserServers({ gone: { command: 'claudin-connection-rig-no-such-binary', args: [] } })
      const m = await mountManager()
      await m.reaches('gone', 'failed')
      void m.toggle('gone')
      m.unmount()
      expect(m.client('gone')?.type).toBe('disabled')
    },
    SLOW,
  )

  test(
    'a server disconnected for the session is not dialled again by a plugin reload',
    async () => {
      const { ws, m } = await connected()
      await m.disconnect('sock')
      await m.reaches('sock', 'disabled')
      bump(m)
      await quiet(500)
      expect(ws.sessions()).toBe(1)
      expect(m.client('sock')?.type).toBe('disabled')
    },
    SLOW,
  )

  test(
    'a plugin reload leaves a server in a redial wait to its loop',
    async () => {
      const { ws, m } = await connected()
      clock = holdBackoffTimers()
      ws.stop()
      await until('a wait', () => clock?.parked().length === 1)
      ws.restart()
      bump(m)
      await quiet(500)
      expect(ws.sessions()).toBe(1)
      expect(clock.parked()).toEqual([1_000])
      // A dial of its own would report the cached outcome over the loop's.
      expect(m.client('sock')).toMatchObject({ type: 'pending', reconnectAttempt: 1 })
    },
    SLOW,
  )

  test(
    'a plugin reload that removes a server cancels its redial wait',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      addPlugin('rigplug', { srv: written(ws) })
      const m = await mountManager()
      const name = 'plugin:rigplug:srv'
      await m.reaches(name, 'connected')
      clock = holdBackoffTimers()
      ws.stop()
      await until('a wait', () => clock?.parked().length === 1)
      setInlinePlugins([])
      clearPluginCache()
      bump(m)
      await until('the server to leave', () => m.client(name) === undefined)
      expect(clock.cancelled()).toBe(1)
      expect(clock.parked()).toEqual([])
    },
    SLOW,
  )

  test(
    'unmounted before its configs load, the manager starts nothing',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['t'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      m.unmount()
      await quiet(600)
      expect(local.pid()).toBeUndefined()
    },
    SLOW,
  )

  test(
    'switching a server on shows it pending before it connects',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['t'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      setToggles({ disabled: ['local'] })
      const m = await mountManager()
      await m.reaches('local', 'disabled')
      await m.toggle('local')
      await m.reaches('local', 'connected')
      expect(m.journey('local').filter(t => t !== 'absent')).toEqual(['disabled', 'pending', 'connected'])
    },
    SLOW,
  )

  test(
    'reconnecting a connected server opens one new session, and its old one does not redial',
    async () => {
      const { ws, m } = await connected()
      await m.reconnect('sock')
      await quiet(400)
      expect(ws.sessions()).toBe(2)
      expect(ws.open()).toBe(1)
    },
    SLOW,
  )

  test(
    'a new session id runs start-up again',
    async () => {
      const first = startSocketServer({ tools: ['a'] })
      setUserServers({ first: written(first) })
      const m = await mountManager()
      await m.reaches('first', 'connected')
      const later = startSocketServer({ tools: ['b'] })
      setUserServers({ first: written(first), later: written(later) })
      m.redraw({})
      await quiet(300)
      expect(m.client('later')).toBeUndefined()

      const before = getSessionId()
      regenerateSessionId()
      try {
        m.redraw({})
        await m.reaches('later', 'connected')
      } finally {
        switchSession(before)
      }
    },
    SLOW,
  )

  test(
    'the claude.ai listing is requested again after a login change, not after a plugin reload',
    async () => {
      const { m } = await connected()
      const cache = fetchClaudeAIMcpConfigsIfEligible.cache as unknown as Map<unknown, unknown>
      const listing = cache.get(undefined)
      expect(listing).toBeDefined()
      bump(m)
      await quiet(300)
      expect(cache.get(undefined)).toBe(listing)
      emitAuthChanged()
      await until('a new listing', () => cache.get(undefined) !== listing && cache.get(undefined) !== undefined)
    },
    SLOW,
  )
})
