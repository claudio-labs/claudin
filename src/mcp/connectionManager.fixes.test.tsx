/**
 * The findings of the connection-manager spec the rewrite fixes (1, 3, 4, 5,
 * 6 and 9), each pinned here. The hook-level rows mount the real manager on
 * the connection rig; the rest drive the pure modules directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import { applyServerUpdate, mergePluginErrors, removeServers } from 'src/mcp/connectionManager/poolUpdate.js'
import { createRedialer, type Wait } from 'src/mcp/connectionManager/redial.js'
import { updateFrom } from 'src/mcp/connectionManager/runtime.js'
import type { ConnectionResult, McpState, ServerUpdate } from 'src/mcp/connectionManager/types.js'
import { mergeClients } from 'src/mcp/hooks/useMergedClients.js'
import type { MCPServerConnection, ScopedMcpServerConfig, ServerResource } from 'src/mcp/types.js'
import type { PluginError } from 'src/shared/types/plugin.js'
import type { Tool } from 'src/tools/Tool.js'

const SLOW = 20_000
const CONFIG = { type: 'ws', url: 'ws://127.0.0.1:1/mcp', scope: 'user' } as ScopedMcpServerConfig

const tool = (name: string) => ({ name }) as unknown as Tool
const resource = (server: string, uri: string): ServerResource => ({ uri, name: uri, server })

function pool(over: Partial<McpState> = {}): McpState {
  return { clients: [], tools: [], commands: [], resources: {}, pluginReconnectKey: 0, ...over }
}

function written(server: SocketServer): Record<string, unknown> {
  const { scope: _scope, ...rest } = socketConfig(server)
  return rest
}

// ---------------------------------------------------------------------------
// Pure rows

describe('Finding 1: resources leave with the server', () => {
  const before = pool({ resources: { sock: [resource('sock', 'rig://r')], other: [resource('other', 'rig://o')] } })
  type Row = { why: string; update: ServerUpdate; sock: string[] | undefined }
  const rows: Row[] = [
    { why: 'disabled', update: { name: 'sock', type: 'disabled', config: CONFIG }, sock: undefined },
    { why: 'failed', update: { name: 'sock', type: 'failed', config: CONFIG }, sock: undefined },
    { why: 'needs-auth', update: { name: 'sock', type: 'needs-auth', config: CONFIG }, sock: undefined },
    { why: 'an empty list', update: { name: 'sock', type: 'pending', config: CONFIG, resources: [] }, sock: undefined },
    { why: 'pending with no list keeps them', update: { name: 'sock', type: 'pending', config: CONFIG }, sock: ['rig://r'] },
    {
      why: 'a new list replaces them',
      update: { name: 'sock', type: 'pending', config: CONFIG, resources: [resource('sock', 'rig://r2')] },
      sock: ['rig://r2'],
    },
  ]
  for (const row of rows) {
    test(row.why, () => {
      const after = applyServerUpdate(before, row.update)
      expect(after.resources.sock?.map(r => r.uri)).toEqual(row.sock as never)
      expect(after.resources.other?.map(r => r.uri)).toEqual(['rig://o'])
    })
  }

  test('a connected result with no resource list means it has none', () => {
    const result: ConnectionResult = {
      client: { name: 'sock', type: 'failed', config: CONFIG },
      tools: [],
      commands: [],
    }
    expect(updateFrom(result).resources).toBeUndefined()
    const connected = { ...result, client: { ...result.client, type: 'connected' } } as unknown as ConnectionResult
    expect(updateFrom(connected).resources).toEqual([])
  })

  test('a stale server is removed with its resources, tools and clients entry', () => {
    const mcp = pool({
      clients: [
        { name: 'sock', type: 'failed', config: CONFIG },
        { name: 'other', type: 'failed', config: CONFIG },
      ],
      tools: [tool('mcp__sock__a'), tool('mcp__other__b')],
      resources: before.resources,
    })
    const after = removeServers(mcp, ['sock'])
    expect(after.clients.map(c => c.name)).toEqual(['other'])
    expect(after.tools.map(t => t.name)).toEqual(['mcp__other__b'])
    expect(Object.keys(after.resources)).toEqual(['other'])
    expect(removeServers(mcp, [])).toBe(mcp)
  })
})

describe('Finding 3: the shared resource tools join the pool once', () => {
  test('a second update bringing them again adds nothing', () => {
    const brought = [tool('mcp__sock__a'), tool('ListMcpResourcesTool'), tool('ReadMcpResourceTool')]
    const once = applyServerUpdate(pool(), { name: 'sock', type: 'connected', config: CONFIG, tools: brought } as ServerUpdate)
    const twice = applyServerUpdate(once, { name: 'sock', type: 'connected', config: CONFIG, tools: brought } as ServerUpdate)
    const fromOther = applyServerUpdate(twice, {
      name: 'other',
      type: 'connected',
      config: CONFIG,
      tools: [tool('mcp__other__x'), tool('ListMcpResourcesTool')],
    } as ServerUpdate)
    expect(fromOther.tools.map(t => t.name)).toEqual([
      'mcp__sock__a',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'mcp__other__x',
    ])
  })
})

describe('Finding 5: plugin errors are kept per server', () => {
  const broken = (serverName: string, validationError = 'unset'): PluginError =>
    ({ type: 'mcp-config-invalid', source: 'plugin:p', plugin: 'p', serverName, validationError }) as PluginError
  const rows: Array<{ why: string; existing: PluginError[]; incoming: PluginError[]; out: PluginError[] }> = [
    { why: 'two servers of one plugin are two errors', existing: [], incoming: [broken('a'), broken('b')], out: [broken('a'), broken('b')] },
    { why: 'the same server again is skipped', existing: [broken('a')], incoming: [broken('a', 'other text')], out: [broken('a')] },
    { why: 'a repeat within one load is skipped', existing: [], incoming: [broken('a'), broken('a')], out: [broken('a')] },
  ]
  for (const row of rows) {
    test(row.why, () => {
      expect(mergePluginErrors(row.existing, row.incoming)).toEqual(row.out)
    })
  }

  test('nothing new gives back the same list', () => {
    const existing = [broken('a')]
    expect(mergePluginErrors(existing, [broken('a')])).toBe(existing)
  })
})

describe('Finding 6: mergeClients without initial clients', () => {
  test('keeps the app-state list, one entry per name', () => {
    const a = { name: 'a', type: 'pending', config: CONFIG } as MCPServerConnection
    const b = { name: 'b', type: 'pending', config: CONFIG } as MCPServerConnection
    const again = { name: 'a', type: 'failed', config: CONFIG } as MCPServerConnection
    expect(mergeClients(undefined, [a, b, again])).toEqual([a, b])
  })
})

describe('Finding 9: a redial loop ends when cancelled, and never dials after', () => {
  type Rig = {
    dials: string[]
    waits: number[]
    reports: ServerUpdate[]
    settled: ConnectionResult[]
    releaseWait: (passed: boolean) => void
    finishDial: (type: 'connected' | 'failed') => void
    stop: boolean
  }
  function rig(): { state: Rig; redial: ReturnType<typeof createRedialer> } {
    let waiting: ((passed: boolean) => void) | undefined
    const dialling: Array<(result: ConnectionResult) => void> = []
    const state: Rig = {
      dials: [],
      waits: [],
      reports: [],
      settled: [],
      releaseWait: passed => waiting?.(passed),
      finishDial: type => {
        for (const finish of dialling.splice(0)) {
          finish({ client: { name: 'sock', type, config: CONFIG } as MCPServerConnection, tools: [], commands: [] })
        }
      },
      stop: false,
    }
    const wait: Wait = (ms, signal) =>
      new Promise(resolve => {
        state.waits.push(ms)
        waiting = resolve
        signal.addEventListener('abort', () => resolve(false), { once: true })
      })
    const redial = createRedialer({
      dial: name => {
        state.dials.push(name)
        return new Promise(resolve => {
          dialling.push(resolve)
        })
      },
      shouldStop: () => state.stop,
      report: update => state.reports.push(update),
      settle: result => state.settled.push(result),
      wait,
    })
    return { state, redial }
  }
  const settles = async (loop: Promise<void>) => {
    let done = false
    void loop.then(() => {
      done = true
    })
    await until('the loop to end', () => done, 1_000)
  }

  test('cancelling a wait ends the loop; nothing is dialled after', async () => {
    const { state, redial } = rig()
    const loop = redial.start('sock', CONFIG)
    state.finishDial('failed')
    await until('the first wait', () => state.waits.length === 1, 1_000)
    redial.cancel('sock')
    await settles(loop)
    expect(redial.isActive('sock')).toBe(false)
    expect(state.dials).toEqual(['sock'])
  })

  test('closing during an attempt: its result is dropped, no wait, no more dials, no new loops', async () => {
    const { state, redial } = rig()
    const loop = redial.start('sock', CONFIG)
    redial.cancelAll()
    state.finishDial('failed')
    await settles(loop)
    expect(state.waits).toEqual([])
    expect(state.settled).toEqual([])
    await redial.start('sock', CONFIG)
    expect(state.dials).toEqual(['sock'])
  })

  test('a new start replaces the loop already running', async () => {
    const { state, redial } = rig()
    const first = redial.start('sock', CONFIG)
    const second = redial.start('sock', CONFIG)
    state.finishDial('connected')
    await settles(first)
    await settles(second)
    // Only the loop that replaced the first one applies its result.
    expect(state.dials).toEqual(['sock', 'sock'])
    expect(state.settled.map(r => r.client.type)).toEqual(['connected'])
    expect(redial.isActive('sock')).toBe(false)
  })

  test('the schedule: 1, 2, 4 and 8 s between five attempts, then the last result', async () => {
    const { state, redial } = rig()
    const loop = redial.start('sock', CONFIG)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await until(`attempt ${attempt}`, () => state.dials.length === attempt, 1_000)
      state.finishDial('failed')
      if (attempt < 5) {
        await until(`wait ${attempt}`, () => state.waits.length === attempt, 1_000)
        state.releaseWait(true)
      }
    }
    await settles(loop)
    expect(state.waits).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(state.reports.map(r => (r as { reconnectAttempt?: number }).reconnectAttempt)).toEqual([1, 2, 3, 4, 5])
    expect(state.settled.map(r => r.client.type)).toEqual(['failed'])
  })

  test('a server switched off before an attempt is settled disabled, not dialled', async () => {
    const { state, redial } = rig()
    state.stop = true
    await redial.start('sock', CONFIG)
    expect(state.dials).toEqual([])
    expect(state.reports.map(r => r.type)).toEqual(['disabled'])
  })

  test('a dial that throws counts as a failed attempt (Finding 8, parity)', async () => {
    const reports: ServerUpdate[] = []
    const settled: ConnectionResult[] = []
    const redial = createRedialer({
      dial: async () => {
        throw new Error('boom')
      },
      shouldStop: () => false,
      report: update => reports.push(update),
      settle: result => settled.push(result),
      schedule: { maxAttempts: 1, delayBeforeAttempt: () => 0 },
    })
    await redial.start('sock', CONFIG)
    expect(settled.map(r => [r.client.type, (r.client as { error?: string }).error])).toEqual([['failed', 'boom']])
  })
})

// ---------------------------------------------------------------------------
// Through the mounted manager

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

  async function withResources(listChanged = false): Promise<{ ws: SocketServer; m: Mounted }> {
    const ws = startSocketServer({ tools: ['a'], resources: ['r'] }, { listChanged })
    setUserServers({ sock: written(ws) })
    const m = await mountManager()
    await m.reaches('sock', 'connected')
    await until('its resources listed', () => m.state().mcp.resources.sock !== undefined)
    return { ws, m }
  }

  for (const action of ['toggle', 'disconnect'] as const) {
    test(
      `Finding 1: ${action} takes the server's resources out`,
      async () => {
        const { m } = await withResources()
        await m[action]('sock')
        await m.reaches('sock', 'disabled')
        await until('the resources to go', () => m.state().mcp.resources.sock === undefined)
      },
      SLOW,
    )
  }

  test(
    'Finding 1: a resource list that becomes empty takes the entry out',
    async () => {
      const { ws, m } = await withResources(true)
      ws.catalog.resources = []
      await ws.announce('resources')
      await until('the resources to go', () => m.state().mcp.resources.sock === undefined)
    },
    SLOW,
  )

  test(
    'Finding 3: reconnecting twice does not grow the pool',
    async () => {
      const { m } = await withResources()
      await quiet(50)
      const before = m.toolNames()
      expect(before).toEqual(['mcp__sock__a', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
      await m.reconnect('sock')
      await m.reconnect('sock')
      await quiet(50)
      expect(m.toolNames()).toEqual(before)
    },
    SLOW,
  )

  test(
    'Finding 4: a server switched off on disk is shown disabled when it closes',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      setUserServers({ sock: written(ws) })
      const m = await mountManager()
      await m.reaches('sock', 'connected')
      setToggles({ disabled: ['sock'] })
      ws.dropSessions()
      await m.reaches('sock', 'disabled')
      expect(m.toolNames()).toEqual([])
      expect(ws.sessions()).toBe(1)
    },
    SLOW,
  )

  test(
    'Finding 4: a redial stopped by a switch-off during its wait leaves the server disabled',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      setUserServers({ sock: written(ws) })
      const m = await mountManager()
      await m.reaches('sock', 'connected')
      clock = holdBackoffTimers()
      ws.stop()
      await until('a wait', () => clock?.parked().length === 1)
      setToggles({ disabled: ['sock'] })
      clock.elapse()
      await m.reaches('sock', 'disabled')
      expect(clock.asked()).toEqual([1_000])
    },
    SLOW,
  )

  test(
    'Finding 4: a local server switched off on disk is shown disabled when it exits',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['t'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      await m.reaches('local', 'connected')
      setToggles({ disabled: ['local'] })
      local.kill()
      await m.reaches('local', 'disabled')
    },
    SLOW,
  )

  test(
    'Finding 5: two broken servers of one plugin are both reported',
    async () => {
      addPlugin('rigplug', {
        first: { command: '${CONNECTION_RIG_UNSET_VAR}', args: [] },
        second: { command: '${CONNECTION_RIG_UNSET_VAR}', args: ['2'] },
      })
      const m = await mountManager()
      await until('the errors', () => m.state().plugins.errors.length >= 2)
      await quiet(200)
      const names = m.state().plugins.errors.map(e => ('serverName' in e ? e.serverName : undefined))
      expect(names.sort()).toEqual(['first', 'second'])
    },
    SLOW,
  )

  test(
    'Finding 9: unmounting during an attempt dials nothing afterwards',
    async () => {
      const ws = startSocketServer({ tools: ['a'] })
      setUserServers({ sock: written(ws) })
      const m = await mountManager()
      await m.reaches('sock', 'connected')
      clock = holdBackoffTimers()
      ws.stop()
      await until('a wait', () => clock?.parked().length === 1)
      ws.restart()
      m.unmount()
      expect(clock.parked()).toEqual([])
      await quiet(300)
      expect(ws.sessions()).toBe(1)
      expect(clock.asked()).toEqual([1_000])
    },
    SLOW,
  )
})
