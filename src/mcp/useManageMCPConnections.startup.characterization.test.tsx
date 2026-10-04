/**
 * Characterization of what the connection manager starts when a session
 * opens: which configured servers get dialled, which are shown without being
 * dialled, which never appear, and what a successful or failed start leaves
 * in app state.
 *
 * Servers are real child processes (they write their pid when they start, so
 * "never spawned" is checked, not assumed) and a real SDK server on a
 * loopback WebSocket. Config lives in a throwaway world: CLAUDIN_CONFIG_DIR,
 * a temp project with its .mcp.json and settings, and a temp managed dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addPlugin,
  enterWorld,
  leaveWorld,
  setLocalServers,
  setToggles,
  setUserServers,
  writeManagedMcp,
  writeMcpJson,
  writeSettings,
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
  type StdioServer,
} from 'src/mcp/__testutils__/connectionRig.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

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

/** The config as a user would write it in a file: no scope. */
function asWritten(config: ScopedMcpServerConfig): Record<string, unknown> {
  const { scope: _scope, ...rest } = config
  return rest
}

function dynamicOf(server: StdioServer): ScopedMcpServerConfig {
  return { ...server.config, scope: 'dynamic' } as ScopedMcpServerConfig
}

type Outcome = 'connected' | 'disabled' | 'absent'

type Row = {
  why: string
  /** Places `target` somewhere; returns the props for the manager. */
  arrange: (target: StdioServer, witness: StdioServer) => { dynamic?: Record<string, ScopedMcpServerConfig>; strict?: boolean }
  outcome: Outcome
}

const withWitness = (witness: StdioServer, more: Record<string, ScopedMcpServerConfig> = {}) => ({
  dynamic: { witness: dynamicOf(witness), ...more },
})

const rows: Row[] = [
  {
    why: 'a user-scope server starts',
    arrange: (t, w) => (setUserServers({ target: asWritten(t.config) }), withWitness(w)),
    outcome: 'connected',
  },
  {
    why: 'a local-scope server starts',
    arrange: (t, w) => (setLocalServers({ target: asWritten(t.config) }), withWitness(w)),
    outcome: 'connected',
  },
  {
    why: 'an approved project server starts',
    arrange: (t, w) => {
      writeMcpJson({ mcpServers: { target: asWritten(t.config) } })
      writeSettings('local', { enabledMcpjsonServers: ['target'] })
      return withWitness(w)
    },
    outcome: 'connected',
  },
  {
    why: 'a project server nobody approved (pending) never appears',
    arrange: (t, w) => (writeMcpJson({ mcpServers: { target: asWritten(t.config) } }), withWitness(w)),
    outcome: 'absent',
  },
  {
    why: 'a rejected project server never appears',
    arrange: (t, w) => {
      writeMcpJson({ mcpServers: { target: asWritten(t.config) } })
      writeSettings('local', { disabledMcpjsonServers: ['target'] })
      return withWitness(w)
    },
    outcome: 'absent',
  },
  {
    why: 'a server the managed policy denies by name never appears',
    arrange: (t, w) => {
      setUserServers({ target: asWritten(t.config) })
      writeSettings('policy', { deniedMcpServers: [{ serverName: 'target' }] })
      return withWitness(w)
    },
    outcome: 'absent',
  },
  {
    why: 'a server missing from the managed allowlist never appears',
    arrange: (t, w) => {
      setUserServers({ target: asWritten(t.config) })
      writeSettings('policy', { allowedMcpServers: [{ serverName: 'witness' }] })
      return withWitness(w)
    },
    outcome: 'absent',
  },
  {
    why: 'a server switched off for this project shows as disabled and is not spawned',
    arrange: (t, w) => {
      setUserServers({ target: asWritten(t.config) })
      setToggles({ disabled: ['target'] })
      return withWitness(w)
    },
    outcome: 'disabled',
  },
  {
    why: 'a --mcp-config server starts',
    arrange: (t, w) => withWitness(w, { target: dynamicOf(t) }),
    outcome: 'connected',
  },
  {
    why: 'a --mcp-config server switched off shows as disabled and is not spawned',
    arrange: (t, w) => (setToggles({ disabled: ['target'] }), withWitness(w, { target: dynamicOf(t) })),
    outcome: 'disabled',
  },
  {
    why: 'strict mode ignores every config scope',
    arrange: (t, w) => (setUserServers({ target: asWritten(t.config) }), { ...withWitness(w), strict: true }),
    outcome: 'absent',
  },
  {
    why: 'strict mode still starts --mcp-config servers',
    arrange: (t, w) => ({ ...withWitness(w, { target: dynamicOf(t) }), strict: true }),
    outcome: 'connected',
  },
  {
    why: 'a managed-mcp.json takes over: a user server never appears',
    arrange: (t, w) => {
      setUserServers({ target: asWritten(t.config) })
      writeManagedMcp({ mcpServers: { corp: asWritten(w.config) } })
      return {}
    },
    outcome: 'absent',
  },
  {
    // The hook does not run --mcp-config entries through the policy; the CLI
    // filtered them before handing them over (Findings, 2).
    why: 'a --mcp-config server is not re-checked against the policy',
    arrange: (t, w) => {
      writeSettings('policy', { deniedMcpServers: [{ serverName: 'target' }] })
      return withWitness(w, { target: dynamicOf(t) })
    },
    outcome: 'connected',
  },
]

describe('which configured servers start', () => {
  for (const row of rows) {
    test(
      row.why,
      async () => {
        const target = stdioServer(world.root, 'target', { tools: ['ping'] })
        const witness = stdioServer(world.root, 'witness')
        const props = row.arrange(target, witness)
        const m = await mountManager(props)
        // Something else in the same session must have finished starting, so
        // "absent" means "decided against", not "not yet".
        const witnessName = props.dynamic ? 'witness' : 'corp'
        await m.reaches(witnessName, 'connected')
        if (row.outcome !== 'absent') await m.reaches('target', row.outcome)
        await quiet(250)

        const seen = m.client('target')?.type ?? 'absent'
        expect({ seen, spawned: target.pid() !== undefined }).toEqual({
          seen: row.outcome,
          spawned: row.outcome === 'connected',
        })
        if (row.outcome === 'connected') expect(m.toolNames()).toContain('mcp__target__ping')
        else expect(m.toolNames().some(n => n.startsWith('mcp__target__'))).toBe(false)
        // A server that is not started is never shown as pending first.
        if (row.outcome !== 'connected') expect(m.journey('target')).not.toContain('pending')
      },
      SLOW,
    )
  }

  test(
    'a --mcp-config entry replaces a same-named entry from the config scopes',
    async () => {
      const fromFile = stdioServer(world.root, 'file')
      const fromFlag = stdioServer(world.root, 'flag', { tools: ['flagged'] })
      setUserServers({ shared: asWritten(fromFile.config) })
      const m = await mountManager({ dynamic: { shared: dynamicOf(fromFlag) } })
      const client = await m.reaches('shared', 'connected')
      await quiet(200)
      expect(client.config.scope).toBe('dynamic')
      expect(fromFlag.pid()).toBeDefined()
      expect(fromFile.pid()).toBeUndefined()
      expect(m.toolNames()).toEqual(['mcp__shared__flagged'])
    },
    SLOW,
  )
})

describe('the start of a server, as app state sees it', () => {
  test(
    'an enabled server is listed as pending before it connects; a disabled one is listed as disabled straight away',
    async () => {
      const on = stdioServer(world.root, 'on')
      const off = stdioServer(world.root, 'off')
      setUserServers({ on: asWritten(on.config), off: asWritten(off.config) })
      setToggles({ disabled: ['off'] })
      const m = await mountManager()
      await m.reaches('on', 'connected')
      await quiet(150)
      expect(m.journey('on').filter(t => t !== 'absent')).toEqual(['pending', 'connected'])
      expect(m.journey('off').filter(t => t !== 'absent')).toEqual(['disabled'])
      // The config handed back on the entry is the scoped one.
      expect(m.client('on')?.config).toMatchObject({ scope: 'user', command: process.execPath })
    },
    SLOW,
  )

  test(
    'a connected server brings its tools, prompts and resources into app state',
    async () => {
      const ws = startSocketServer({ tools: ['alpha', 'beta'], prompts: ['greet'], resources: ['notes'] })
      setUserServers({ sock: asWritten(socketConfig(ws)) })
      const m = await mountManager()
      const client = await m.reaches('sock', 'connected')
      await quiet(100)
      expect(client.type === 'connected' && client.capabilities.tools).toBeTruthy()
      expect(m.toolNames()).toEqual(['mcp__sock__alpha', 'mcp__sock__beta', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])
      expect(m.commandNames()).toEqual(['mcp__sock__greet'])
      expect(m.state().mcp.resources.sock?.map(r => r.uri)).toEqual(['rig://notes'])
      expect(m.state().mcp.resources.sock?.[0]).toMatchObject({ server: 'sock' })
    },
    SLOW,
  )

  test(
    'servers that cannot start end up failed, with the reason, and add nothing to the pool',
    async () => {
      const ws = startSocketServer()
      ws.stop()
      setUserServers({
        nobinary: { command: 'claudin-connection-rig-no-such-binary', args: [] },
        refused: asWritten(socketConfig(ws)),
      })
      const m = await mountManager()
      for (const name of ['nobinary', 'refused']) {
        const client = await m.reaches(name, 'failed')
        expect(client.type === 'failed' && typeof client.error).toBe('string')
      }
      expect(m.toolNames()).toEqual([])
      expect(m.commandNames()).toEqual([])
    },
    SLOW,
  )

  test(
    'servers already in app state are not listed twice, and a bad server does not hold back a good one',
    async () => {
      const good = stdioServer(world.root, 'good', { tools: ['t'] })
      setUserServers({ good: asWritten(good.config), bad: { command: 'claudin-connection-rig-no-such-binary', args: [] } })
      const base = getDefaultAppState()
      const m = await mountManager({}, base)
      await m.reaches('good', 'connected')
      await m.reaches('bad', 'failed')
      await quiet(150)
      expect(m.state().mcp.clients.map(c => c.name).sort()).toEqual(['bad', 'good'])
    },
    SLOW,
  )
})

describe('config problems reach the plugin error list', () => {
  test(
    'a plugin server with an unset variable is reported once, however many times configs load',
    async () => {
      const server = stdioServer(world.root, 'plug')
      addPlugin('rigplug', {
        broken: { command: '${CONNECTION_RIG_UNSET_VAR}', args: [] },
        fine: asWritten(server.config),
      })
      const m = await mountManager()
      await m.reaches('plugin:rigplug:fine', 'connected')
      await quiet(200)
      const errors = m.state().plugins.errors.filter(e => e.type === 'mcp-config-invalid')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ plugin: 'rigplug', source: 'plugin:rigplug', serverName: 'broken' })

      // A reload loads configs again; the same error is still listed once.
      m.store.setState(s => ({ ...s, mcp: { ...s.mcp, pluginReconnectKey: s.mcp.pluginReconnectKey + 1 } }))
      await quiet(400)
      expect(m.state().plugins.errors.filter(e => e.type === 'mcp-config-invalid')).toHaveLength(1)
    },
    SLOW,
  )

  test(
    'an error already on the list is not added again, and other errors are kept',
    async () => {
      addPlugin('rigplug', { broken: { command: '${CONNECTION_RIG_UNSET_VAR}', args: [] } })
      const base = getDefaultAppState()
      // A plugin MCP error's source is `plugin:<plugin>`.
      const earlier = { type: 'mcp-config-invalid', source: 'plugin:rigplug', plugin: 'rigplug', serverName: 'broken', validationError: 'seen before' }
      const unrelated = { type: 'generic-error', source: 'elsewhere', error: 'kept' }
      const initial = { ...base, plugins: { ...base.plugins, errors: [earlier, unrelated] } } as typeof base
      const m = await mountManager({}, initial)
      await quiet(500)
      expect(m.state().plugins.errors).toEqual([earlier, unrelated] as never)
    },
    SLOW,
  )
})
