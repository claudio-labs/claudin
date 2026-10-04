/**
 * Characterization of the three actions the manager hands to its children
 * (reconnect, switch on/off, disconnect for the session), of what a server
 * can push to the client once connected (list changes, elicitation), and of
 * how the manager reacts when its inputs change (a plugin reload, a new
 * --mcp-config, an unmount).
 *
 * Every server is real: an SDK server on a loopback WebSocket, or a child
 * process speaking stdio. Disk state is the temp world's global config.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addPlugin,
  enterWorld,
  leaveWorld,
  localRecord,
  setToggles,
  setUserServers,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'
import {
  killAllStdioServers,
  mountManager,
  quiet,
  socketConfig,
  startSocketServer,
  stdioServer,
  stopAllSocketServers,
  unmountAll,
  until,
  type Mounted,
  type SocketServer,
  type StdioServer,
} from 'src/mcp/__testutils__/connectionRig.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { setInlinePlugins } from 'src/platform/bootstrap/state.js'
import { clearPluginCache } from 'src/plugins/pluginLoader.js'

const SLOW = 20_000

let world: World
beforeEach(() => {
  world = enterWorld()
})
afterEach(async () => {
  await unmountAll()
  stopAllSocketServers()
  killAllStdioServers()
  leaveWorld()
})

function asWritten(config: ScopedMcpServerConfig): Record<string, unknown> {
  const { scope: _scope, ...rest } = config
  return rest
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `sock` (remote, tools a/b, a prompt, a resource) and `other` (stdio, tool x), both connected. */
async function twoServers(): Promise<{ ws: SocketServer; other: StdioServer; m: Mounted }> {
  const ws = startSocketServer({ tools: ['a', 'b'], prompts: ['p'], resources: ['r'] })
  const other = stdioServer(world.root, 'other', { tools: ['x'], prompts: ['q'] })
  setUserServers({ sock: asWritten(socketConfig(ws)), other: asWritten(other.config) })
  const m = await mountManager()
  await m.reaches('sock', 'connected')
  await m.reaches('other', 'connected')
  await until('both prompts in the pool', () => m.commandNames().length === 2)
  return { ws, other, m }
}

/** The SDK client behind `sock`'s entry, or behind a reconnect result. */
function sdkClientOf(from: Mounted | { client: MCPServerConnection }): unknown {
  const entry = 'state' in from ? from.client('sock') : from.client
  return entry?.type === 'connected' ? entry.client : undefined
}

const sockTools = (m: Mounted) => m.toolNames().filter(n => n.startsWith('mcp__sock__'))

describe('switching a server off and on', () => {
  test(
    'off: written to disk, connection closed, its tools and prompts leave the pool',
    async () => {
      const { ws, m } = await twoServers()
      await m.toggle('sock')
      await m.reaches('sock', 'disabled')
      await until('the session to close', () => ws.open() === 0)
      expect(localRecord().disabledMcpServers).toEqual(['sock'])
      expect(sockTools(m)).toEqual([])
      expect(m.commandNames()).toEqual(['mcp__other__q'])
      // Its resources stay listed: Findings, 1 (fix), so not pinned here.
      // The other server is untouched; the resource tools it does not own stay.
      expect(m.toolNames()).toContain('mcp__other__x')
      expect(m.client('other')?.type).toBe('connected')
    },
    SLOW,
  )

  test(
    'on: removed from the disabled list, shown pending, dialled, and its tools come back',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      setUserServers({ sock: asWritten(socketConfig(ws)) })
      setToggles({ disabled: ['sock'] })
      const m = await mountManager()
      await m.reaches('sock', 'disabled')
      await quiet(150)
      expect(ws.sessions()).toBe(0)
      await m.toggle('sock')
      await m.reaches('sock', 'connected')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
      // 'pending' may share a batched update with the connect, so only the end is pinned.
      expect(m.journey('sock').slice(-1)).toEqual(['connected'])
      expect(sockTools(m)).toEqual(['mcp__sock__a'])
    },
    SLOW,
  )

  test(
    'off for a server that never connected: written to disk and shown disabled, nothing dialled',
    async () => {
      const ws = startSocketServer()
      ws.stop()
      setUserServers({ sock: asWritten(socketConfig(ws)) })
      const m = await mountManager()
      await m.reaches('sock', 'failed')
      ws.restart()
      await m.toggle('sock')
      await m.reaches('sock', 'disabled')
      await quiet(200)
      expect(localRecord().disabledMcpServers).toEqual(['sock'])
      expect(ws.sessions()).toBe(0)
    },
    SLOW,
  )

  test(
    'switching on a server that cannot start leaves it failed, without throwing',
    async () => {
      setUserServers({ gone: { command: 'claudin-connection-rig-no-such-binary', args: [] } })
      setToggles({ disabled: ['gone'] })
      const m = await mountManager()
      await m.reaches('gone', 'disabled')
      await m.toggle('gone')
      await m.reaches('gone', 'failed')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
    },
    SLOW,
  )

  test(
    'two changes made together reach app state in one update',
    async () => {
      setUserServers({
        one: { command: 'claudin-connection-rig-no-such-binary', args: ['1'] },
        two: { command: 'claudin-connection-rig-no-such-binary', args: ['2'] },
      })
      const m = await mountManager()
      await m.reaches('one', 'failed')
      await m.reaches('two', 'failed')
      await quiet(100)
      const from = m.changes()
      await Promise.all([m.toggle('one'), m.toggle('two')])
      await m.reaches('two', 'disabled')
      await quiet(100)
      const after = m.history().slice(from)
      const halfway = after.some(s => {
        const types = s.mcp.clients.filter(c => c.name === 'one' || c.name === 'two').map(c => c.type)
        return types.includes('disabled') && types.includes('failed')
      })
      expect(halfway).toBe(false)
    },
    SLOW,
  )
})

describe('reconnecting by hand', () => {
  test(
    'dials a fresh session and returns what it found',
    async () => {
      const { ws, m } = await twoServers()
      const before = ws.sessions()
      const result = await m.reconnect('sock')
      expect(ws.sessions()).toBeGreaterThan(before)
      expect(result.client.type).toBe('connected')
      expect(result.client.name).toBe('sock')
      expect(result.tools.map(t => t.name)).toEqual(['mcp__sock__a', 'mcp__sock__b', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
      expect(result.commands.map(c => c.name)).toEqual(['mcp__sock__p'])
      expect(result.resources?.map(r => r.uri)).toEqual(['rig://r'])
      await until('the new client in app state', () => sdkClientOf(m) === sdkClientOf(result))
    },
    SLOW,
  )

  test(
    'keeps the tool pool in its order when the server comes back with the same tools',
    async () => {
      const { m } = await twoServers()
      await quiet(100)
      const order = m.toolNames()
      const result = await m.reconnect('sock')
      await until('the new client in app state', () => sdkClientOf(m) === sdkClientOf(result))
      await quiet(50)
      // Compared without repeats: the resource tools are appended again on
      // every reconnect (Findings, 3: fix), which is not pinned.
      expect([...new Set(m.toolNames())]).toEqual(order)
    },
    SLOW,
  )

  test(
    'reports a server it cannot reach as failed, without throwing',
    async () => {
      const { ws, m } = await twoServers()
      ws.stop()
      await until('the outage seen', () => m.client('sock')?.type !== 'connected')
      const result = await m.reconnect('sock')
      expect(result.client.type).toBe('failed')
      expect(result.tools).toEqual([])
      await m.reaches('sock', 'failed')
    },
    SLOW,
  )
})

describe('an action on a server the manager does not know', () => {
  const actions = ['reconnect', 'toggle', 'disconnect'] as const
  for (const action of actions) {
    test(`${action} rejects, naming the server`, async () => {
      const m = await mountManager()
      await expect(m[action]('ghost')).rejects.toThrow('MCP server ghost not found')
    })
  }
})

describe('a disconnect for the session', () => {
  test(
    'closes the connection, takes its tools and prompts out of the pool, and writes nothing to disk',
    async () => {
      const { ws, m } = await twoServers()
      await m.disconnect('sock')
      await m.reaches('sock', 'disabled')
      await until('the session to close', () => ws.open() === 0)
      expect(sockTools(m)).toEqual([])
      expect(m.commandNames()).toEqual(['mcp__other__q'])
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
    },
    SLOW,
  )

  test(
    'of a stdio server stops its process',
    async () => {
      const { other, m } = await twoServers()
      const pid = other.pid()
      await m.disconnect('other')
      await m.reaches('other', 'disabled')
      await until('the process to exit', () => !alive(pid))
    },
    SLOW,
  )
})

describe('what a connected server pushes', () => {
  async function announcing(listChanged: boolean): Promise<{ ws: SocketServer; m: Mounted }> {
    const ws = startSocketServer({ tools: ['a', 'b'], prompts: ['p'], resources: ['r'] }, { listChanged })
    const other = stdioServer(world.root, 'other', { tools: ['x'] })
    // `other` first, so the pool has a neighbour on each side of sock's tools.
    setUserServers({ sock: asWritten(socketConfig(ws)), other: asWritten(other.config) })
    const m = await mountManager()
    await m.reaches('sock', 'connected')
    await m.reaches('other', 'connected')
    await quiet(100)
    return { ws, m }
  }

  test(
    'a tool list change refreshes the pool in place: kept tools keep their slot, new ones go last',
    async () => {
      const { ws, m } = await announcing(true)
      const before = m.toolNames()
      ws.catalog.tools = ['c', 'b']
      await ws.announce('tools')
      await until('the pool to change', () => m.toolNames().includes('mcp__sock__c'))
      const expected = before.filter(n => n !== 'mcp__sock__a').concat('mcp__sock__c')
      expect(m.toolNames()).toEqual(expected)
    },
    SLOW,
  )

  test(
    'a prompt list change replaces the server prompts',
    async () => {
      const { ws, m } = await announcing(true)
      ws.catalog.prompts = ['p2', 'p3']
      await ws.announce('prompts')
      await until('the prompts to change', () => m.commandNames().includes('mcp__sock__p3'))
      expect(m.commandNames().filter(n => n.startsWith('mcp__sock__'))).toEqual(['mcp__sock__p2', 'mcp__sock__p3'])
    },
    SLOW,
  )

  test(
    'a resource list change replaces the server resources',
    async () => {
      const { ws, m } = await announcing(true)
      ws.catalog.resources = ['r2']
      await ws.announce('resources')
      await until('the resources to change', () => m.state().mcp.resources.sock?.[0]?.uri === 'rig://r2')
      expect(m.state().mcp.resources.sock?.map(r => r.uri)).toEqual(['rig://r2'])
      // An empty list should remove the entry; it does not (Findings, 1: fix).
    },
    SLOW,
  )

  test(
    'list changes are ignored when the server did not declare it sends them',
    async () => {
      const { ws, m } = await announcing(false)
      const tools = m.toolNames()
      const commands = m.commandNames()
      ws.catalog.tools = ['c']
      ws.catalog.prompts = ['p2']
      ws.catalog.resources = ['r2']
      await ws.announce('tools')
      await ws.announce('prompts')
      await ws.announce('resources')
      await quiet(400)
      expect(m.toolNames()).toEqual(tools)
      expect(m.commandNames()).toEqual(commands)
      expect(m.state().mcp.resources.sock?.map(r => r.uri)).toEqual(['rig://r'])
    },
    SLOW,
  )

  test(
    'an elicitation request is queued in app state for the UI, and the answer goes back to the server',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      setUserServers({ sock: asWritten(socketConfig(ws)) })
      const m = await mountManager()
      await m.reaches('sock', 'connected')
      const answer = ws.elicit('Proceed?')
      await until('the request in the queue', () => m.state().elicitation.queue.length === 1)
      const queued = m.state().elicitation.queue[0]
      expect(queued?.serverName).toBe('sock')
      expect(queued?.params.message).toBe('Proceed?')
      queued?.respond({ action: 'accept', content: { ok: true } })
      expect(await answer).toMatchObject({ action: 'accept', content: { ok: true } })
    },
    SLOW,
  )
})

describe('when the inputs change', () => {
  const bump = (m: Mounted) =>
    m.store.setState(s => ({ ...s, mcp: { ...s.mcp, pluginReconnectKey: s.mcp.pluginReconnectKey + 1 } }))

  test(
    'a plugin reload drops the servers of a removed plugin and stops them',
    async () => {
      const keep = stdioServer(world.root, 'keep', { tools: ['k'] })
      const plugged = stdioServer(world.root, 'plugged', { tools: ['t'], prompts: ['pp'] })
      setUserServers({ keep: asWritten(keep.config) })
      addPlugin('rigplug', { srv: asWritten(plugged.config) })
      const m = await mountManager()
      const name = 'plugin:rigplug:srv'
      await m.reaches(name, 'connected')
      await m.reaches('keep', 'connected')
      await until('the plugin prompt in the pool', () => m.commandNames().length === 1)
      const pid = plugged.pid()

      setInlinePlugins([])
      clearPluginCache()
      bump(m)
      await until('the plugin server to leave', () => m.client(name) === undefined)
      await until('its process to exit', () => !alive(pid))
      expect(m.toolNames()).toEqual(['mcp__keep__k'])
      expect(m.commandNames()).toEqual([])
      expect(m.client('keep')?.type).toBe('connected')
    },
    SLOW,
  )

  test(
    'a plugin reload re-dials a server whose config changed, with the new config',
    async () => {
      const first = stdioServer(world.root, 'first', { tools: ['old'] })
      const second = stdioServer(world.root, 'second', { tools: ['new'] })
      setUserServers({ srv: asWritten(first.config) })
      const m = await mountManager()
      await m.reaches('srv', 'connected')
      const firstPid = first.pid()

      setUserServers({ srv: asWritten(second.config) })
      bump(m)
      await until('the new config connected', () => m.client('srv')?.type === 'connected' && m.toolNames().includes('mcp__srv__new'))
      await until('the old process to exit', () => !alive(firstPid))
      expect(m.toolNames()).toEqual(['mcp__srv__new'])
      const argsOf = (c: unknown) => (c as { args: string[] }).args
      expect(argsOf(m.client('srv')?.config)).toEqual(argsOf(second.config))
    },
    SLOW,
  )

  test(
    'a new --mcp-config server is started, and a removed one is dropped',
    async () => {
      const a = stdioServer(world.root, 'a', { tools: ['ta'] })
      const b = stdioServer(world.root, 'b', { tools: ['tb'] })
      const dyn = (s: StdioServer) => ({ ...s.config, scope: 'dynamic' }) as ScopedMcpServerConfig
      const m = await mountManager({ dynamic: { a: dyn(a) } })
      await m.reaches('a', 'connected')
      m.redraw({ dynamic: { b: dyn(b) } })
      await m.reaches('b', 'connected')
      await until('a to leave', () => m.client('a') === undefined)
      await until('a tools to leave', () => !m.toolNames().includes('mcp__a__ta'))
      expect(m.toolNames()).toEqual(['mcp__b__tb'])
    },
    SLOW,
  )

  test(
    'unmounting applies updates still waiting to be batched',
    async () => {
      setUserServers({ gone: { command: 'claudin-connection-rig-no-such-binary', args: [] } })
      const m = await mountManager()
      await m.reaches('gone', 'failed')
      await quiet(50)
      void m.toggle('gone')
      m.unmount()
      await quiet(100)
      expect(m.client('gone')?.type).toBe('disabled')
    },
    SLOW,
  )
})
