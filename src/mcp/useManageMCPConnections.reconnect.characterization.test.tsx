/**
 * Characterization of what happens when a connected server goes away: the
 * automatic redial of remote servers with its backoff, the immediate failure
 * of local ones, and every way the user's choices stop a redial.
 *
 * The remote server is a real SDK server on a loopback WebSocket; stopping
 * its listener is the outage. The clock is held: every timer of a second or
 * more is parked, so each test reads the delay that was asked for and decides
 * when it elapses. MCP_TIMEOUT is raised past the parking range so the
 * connection timeout itself is never parked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { enterWorld, leaveWorld, localRecord, setToggles, setUserServers, withEnv, type World } from 'src/mcp/__testutils__/mcpConfigWorld.js'
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
import type { MCPServerConnection } from 'src/mcp/types.js'

const SLOW = 20_000

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

function written(server: SocketServer) {
  const { scope: _scope, ...rest } = socketConfig(server)
  return rest
}

/** A connected remote server named `sock`, with one tool and one prompt. */
async function connectedSocket(): Promise<{ ws: SocketServer; m: Mounted }> {
  const ws = startSocketServer({ tools: ['echo'], prompts: ['greet'] })
  setUserServers({ sock: written(ws) })
  const m = await mountManager()
  await m.reaches('sock', 'connected')
  await quiet(50)
  return { ws, m }
}

type Pending = Extract<MCPServerConnection, { type: 'pending' }>

/** The attempt counters `sock` showed while pending, in order. */
function attemptsShown(m: Mounted): Array<[number | undefined, number | undefined]> {
  return m
    .entries('sock')
    .filter((e): e is Pending => e.type === 'pending' && (e as Pending).reconnectAttempt !== undefined)
    .map(e => [e.reconnectAttempt, e.maxReconnectAttempts])
}

/** Waits until a backoff wait is parked and app state shows the attempt that preceded it. */
async function waitsAfterAttempt(m: Mounted, held: HeldClock, attempt: number): Promise<void> {
  await until(`a wait after attempt ${attempt}`, () => held.parked().length === 1)
  await until(`attempt ${attempt} in app state`, () => (m.client('sock') as Pending).reconnectAttempt === attempt)
}

describe('a remote server that goes away', () => {
  test(
    'is dialled again at once when it is still reachable, with no wait',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      ws.dropSessions()
      await until('a second session', () => ws.sessions() === 2)
      await m.reaches('sock', 'connected')
      await quiet(100)
      // The attempt's 'pending' and its success can land in the same batched
      // update, so app state may or may not show the attempt in between.
      expect(m.journey('sock').at(-1)).toBe('connected')
      expect(m.journey('sock')).not.toContain('failed')
      for (const shown of attemptsShown(m)) expect(shown).toEqual([1, 5])
      expect(clock.asked()).toEqual([])
      expect(m.toolNames()).toEqual(['mcp__sock__echo'])
    },
    SLOW,
  )

  test(
    'when unreachable: five attempts, waiting 1 s, 2 s, 4 s and 8 s between them, then failed',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      ws.stop()
      for (let attempt = 1; attempt <= 4; attempt++) {
        await waitsAfterAttempt(m, clock, attempt)
        // While it is being redialled the server keeps its tools and prompts.
        expect(m.toolNames()).toEqual(['mcp__sock__echo'])
        expect(m.commandNames()).toEqual(['mcp__sock__greet'])
        clock.elapse()
      }
      const last = await m.reaches('sock', 'failed')
      await quiet(100)
      expect(clock.asked()).toEqual([1_000, 2_000, 4_000, 8_000])
      expect(clock.parked()).toEqual([])
      // Attempts 1-4 are each followed by a wait, so app state shows them;
      // the fifth may be batched together with the give-up.
      expect(attemptsShown(m).slice(0, 4)).toEqual([
        [1, 5],
        [2, 5],
        [3, 5],
        [4, 5],
      ])
      expect(attemptsShown(m).length).toBeLessThanOrEqual(5)
      expect(last.type === 'failed' && typeof last.error).toBe('string')
      // Giving up takes the server's tools and prompts out of the pool.
      expect(m.toolNames()).toEqual([])
      expect(m.commandNames()).toEqual([])
    },
    SLOW,
  )

  test(
    'reconnects on the attempt that finds it back, and waits no more',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      ws.stop()
      await waitsAfterAttempt(m, clock, 1)
      clock.elapse()
      await waitsAfterAttempt(m, clock, 2)
      ws.restart()
      clock.elapse()
      await m.reaches('sock', 'connected')
      await quiet(150)
      expect(clock.asked()).toEqual([1_000, 2_000])
      expect(clock.parked()).toEqual([])
      expect(ws.sessions()).toBe(2)
      expect(attemptsShown(m).map(([a]) => a).slice(0, 2)).toEqual([1, 2])
      expect(m.toolNames()).toEqual(['mcp__sock__echo'])
    },
    SLOW,
  )

  test(
    'is not dialled again when it is switched off on disk by the time it closes',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      setToggles({ disabled: ['sock'] })
      ws.dropSessions()
      await quiet(400)
      expect(ws.sessions()).toBe(1)
      expect(clock.asked()).toEqual([])
      expect(m.journey('sock')).not.toContain('failed')
      expect(attemptsShown(m)).toEqual([])
    },
    SLOW,
  )

  test(
    'stops redialling when it is switched off on disk during a wait',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      ws.stop()
      await waitsAfterAttempt(m, clock, 1)
      setToggles({ disabled: ['sock'] })
      ws.restart()
      clock.elapse()
      await quiet(400)
      expect(ws.sessions()).toBe(1)
      expect(clock.asked()).toEqual([1_000])
      expect(attemptsShown(m).map(([a]) => a)).toEqual([1])
    },
    SLOW,
  )
})

describe('user actions during a wait', () => {
  type Row = {
    why: string
    act: (m: Mounted, ws: SocketServer) => Promise<void>
    settlesAs: MCPServerConnection['type']
    sessionsAfter: number
  }
  const rows: Row[] = [
    {
      why: 'switching it off cancels the wait and leaves it disabled',
      act: async m => m.toggle('sock'),
      settlesAs: 'disabled',
      sessionsAfter: 1,
    },
    {
      why: 'disconnecting it cancels the wait and leaves it disabled',
      act: async m => m.disconnect('sock'),
      settlesAs: 'disabled',
      sessionsAfter: 1,
    },
    {
      why: 'reconnecting by hand cancels the wait and dials at once',
      act: async m => {
        await m.reconnect('sock')
      },
      settlesAs: 'connected',
      sessionsAfter: 2,
    },
  ]
  for (const row of rows) {
    test(
      row.why,
      async () => {
        const { ws, m } = await connectedSocket()
        clock = holdBackoffTimers()
        ws.stop()
        await waitsAfterAttempt(m, clock, 1)
        ws.restart()
        await row.act(m, ws)
        await m.reaches('sock', row.settlesAs)
        await quiet(300)
        expect(clock.cancelled()).toBe(1)
        expect(clock.parked()).toEqual([])
        expect(ws.sessions()).toBe(row.sessionsAfter)
        expect(m.client('sock')?.type).toBe(row.settlesAs)
      },
      SLOW,
    )
  }

  test(
    'unmounting the manager cancels the wait',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      ws.stop()
      await waitsAfterAttempt(m, clock, 1)
      m.unmount()
      expect(clock.cancelled()).toBe(1)
      expect(clock.parked()).toEqual([])
    },
    SLOW,
  )
})

describe('a session disconnect', () => {
  test(
    'closes the server, writes nothing to disk, and is not undone by the closing transport',
    async () => {
      const { ws, m } = await connectedSocket()
      clock = holdBackoffTimers()
      await m.disconnect('sock')
      await until('the session to close', () => ws.open() === 0)
      await quiet(400)
      expect(ws.sessions()).toBe(1)
      expect(m.client('sock')?.type).toBe('disabled')
      expect(attemptsShown(m)).toEqual([])
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
    },
    SLOW,
  )

  test(
    'is taken back by a reconnect: the server comes up and is redialled again after a drop',
    async () => {
      const { ws, m } = await connectedSocket()
      await m.disconnect('sock')
      await until('the session to close', () => ws.open() === 0)
      const result = await m.reconnect('sock')
      expect(result.client.type).toBe('connected')
      await m.reaches('sock', 'connected')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
      const before = ws.sessions()
      ws.dropSessions()
      await until('a redial after the drop', () => ws.sessions() === before + 1)
      await m.reaches('sock', 'connected')
    },
    SLOW,
  )

  test(
    'is taken back by switching the server on',
    async () => {
      const { ws, m } = await connectedSocket()
      await m.disconnect('sock')
      await until('the session to close', () => ws.open() === 0)
      // The toggle reads app state, so it must see the disconnect first.
      await m.reaches('sock', 'disabled')
      await m.toggle('sock')
      await m.reaches('sock', 'connected')
      expect(localRecord().disabledMcpServers ?? []).toEqual([])
      const before = ws.sessions()
      ws.dropSessions()
      await until('a redial after the drop', () => ws.sessions() === before + 1)
      await m.reaches('sock', 'connected')
    },
    SLOW,
  )
})

describe('a local (stdio) server that exits', () => {
  test(
    'is marked failed at once and not respawned; its tools stay, its prompts go',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['tool'], prompts: ['prompt'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      await m.reaches('local', 'connected')
      await until('its prompt in the pool', () => m.commandNames().length === 1)
      const firstPid = local.pid()
      local.kill()
      await m.reaches('local', 'failed')
      await quiet(400)
      expect(m.journey('local').slice(-2)).toEqual(['connected', 'failed'])
      const redials = m.entries('local').filter(e => e.type === 'pending' && (e as Pending).reconnectAttempt !== undefined)
      expect(redials).toEqual([])
      expect(local.pid()).toBe(firstPid)
      expect(m.toolNames()).toEqual(['mcp__local__tool'])
      expect(m.commandNames()).toEqual([])
    },
    SLOW,
  )

  test(
    'switched off on disk by the time it exits: not marked failed, not respawned',
    async () => {
      const local = stdioServer(world.root, 'local', { tools: ['tool'] })
      const { scope: _scope, ...asWritten } = local.config
      setUserServers({ local: asWritten })
      const m = await mountManager()
      await m.reaches('local', 'connected')
      const firstPid = local.pid()
      setToggles({ disabled: ['local'] })
      local.kill()
      await quiet(600)
      // Today the entry is left as it was; the rewrite may show it disabled
      // (Findings, 4). Either way it is not a failure to report.
      expect(m.journey('local')).not.toContain('failed')
      expect(local.pid()).toBe(firstPid)
    },
    SLOW,
  )
})
