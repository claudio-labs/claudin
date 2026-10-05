/**
 * A rig for the /mcp server-menu characterization suites.
 *
 * A menu talks to two things besides its props: the connection manager's
 * actions (reconnect, switch on/off) through React context, and app state.
 * So it is mounted the way the /mcp panel runs it: inside a real
 * `MCPConnectionManager`, under the app-state and key-binding providers of
 * the prompt-frame rig, on the fake terminal. The servers the manager dials
 * are real, and so is the OAuth server.
 *
 * - `menuWorld` gives each test a temp config home with the vault and browser
 *   stand-ins of the OAuth test bed (no real keychain, no real browser), a
 *   temp project as the session's directory, and isolated managed settings.
 * - `mountMenu` mounts a node inside the manager, with `dynamic` as the only
 *   config it starts (strict mode), and records what the menu reported to its
 *   caller (`onComplete`, `onCancel`, `onViewTools`).
 * - `startGatedServer` is a Streamable HTTP MCP server that answers 401 until
 *   it is shown a bearer token minted by the given authorization server, and
 *   advertises that server in its RFC 9728 metadata.
 */
import { afterEach, beforeEach } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { clearMcpAuthCache, clearServerCache } from 'src/mcp/client.js'
import { MCPConnectionManager, useMcpDisconnect } from 'src/mcp/MCPConnectionManager.js'
import { type AuthBed, useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import { type Catalog, type HttpBed, serveHttp, useBuildMacro } from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { markSessionDisconnected, resetSessionDisconnectsForTests } from 'src/mcp/sessionDisconnects.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getOriginalCwd, setCwdState, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

export { flat, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

/** The frame without its box border, squeezed to single spaces. */
export const plain = (frame: string) => frame.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ').trim()

// --- the world ------------------------------------------------------------------

export type MenuWorld = ReturnType<typeof useIsolatedStore> & { project: () => string }

/** Registers the per-test world in the calling file. */
export function menuWorld(): MenuWorld {
  useBuildMacro()
  const store = useIsolatedStore()
  let before = ''
  let project = ''
  // The global config is an in-memory singleton under test: what a test puts
  // there (user-scope servers, the claude.ai account) is taken back after it.
  let globals: Pick<ReturnType<typeof getGlobalConfig>, 'mcpServers' | 'oauthAccount'> = {}
  beforeEach(() => {
    const { mcpServers, oauthAccount } = getGlobalConfig()
    globals = { mcpServers, oauthAccount }
    before = getOriginalCwd()
    project = join(realpathSync(store.root()), 'project')
    mkdirSync(join(store.root(), 'managed'))
    mkdirSync(project)
    setOriginalCwd(project)
    setCwdState(project)
    getManagedFilePath.cache.set(undefined, join(store.root(), 'managed'))
    getManagedSettingsDropInDir.cache.set(undefined, join(store.root(), 'managed', 'managed-settings.d'))
    resetSettingsCache()
    clearMcpAuthCache()
    clearOAuthTokenCache()
  })
  afterEach(async () => {
    await closeAll()
    getManagedFilePath.cache.delete(undefined)
    getManagedSettingsDropInDir.cache.delete(undefined)
    setOriginalCwd(before)
    setCwdState(before)
    resetSettingsCache()
    clearMcpAuthCache()
    clearOAuthTokenCache()
    for (const stop of stoppers.splice(0)) await stop()
    saveGlobalConfig(c => ({ ...c, ...globals }))
  })
  return { ...store, project: () => project }
}

// --- mounting -------------------------------------------------------------------

export type Calls = {
  completed: Array<string | undefined>
  cancelled: number
  viewedTools: number
}

export type MenuScreen = Screen & {
  calls: Calls
  /** Mounts the node of a `deferred` mount, once the manager has settled. */
  show: () => Promise<void>
  /** The manager's entry for `name` right now. */
  client: (name: string) => MCPServerConnection | undefined
  /** Waits until the manager has `name` in one of `types`. */
  reaches: (name: string, ...types: MCPServerConnection['type'][]) => Promise<MCPServerConnection>
  /** Waits until the menu has reported `count` results to its caller. */
  completes: (count?: number) => Promise<string | undefined>
}

type Callbacks = {
  onComplete: (result?: string) => void
  onCancel: () => void
  onViewTools: () => void
}

type MountMenu = {
  dynamic?: Record<string, ScopedMcpServerConfig>
  appState?: Partial<AppState>
  columns?: number
  ready?: (frame: string) => boolean
  /** Keep the node out until `show()`: the manager starts first, as in a running session. */
  deferred?: boolean
}

const live: Array<() => Promise<void>> = []

async function closeAll(): Promise<void> {
  while (live.length) await live.pop()?.()
}

/**
 * Mounts `render(callbacks)` inside the manager. The callbacks record into
 * `screen.calls`.
 */
export async function mountMenu(render: (cb: Callbacks) => React.ReactNode, options: MountMenu = {}): Promise<MenuScreen> {
  resetSessionDisconnectsForTests()
  const calls: Calls = { completed: [], cancelled: 0, viewedTools: 0 }
  const cb: Callbacks = {
    onComplete: result => void calls.completed.push(result),
    onCancel: () => void (calls.cancelled += 1),
    onViewTools: () => void (calls.viewedTools += 1),
  }
  const hold: { disconnect?: ReturnType<typeof useMcpDisconnect>; reveal?: () => void } = {}
  function Stage(): React.ReactNode {
    hold.disconnect = useMcpDisconnect()
    const [shown, setShown] = React.useState(!options.deferred)
    hold.reveal = () => setShown(true)
    return shown ? render(cb) : null
  }
  const screen = await mount(
    <MCPConnectionManager dynamicMcpConfig={options.dynamic} isStrictMcpConfig>
      <Stage />
    </MCPConnectionManager>,
    {
      columns: options.columns ?? 200,
      appState: options.appState,
      ready: options.ready ?? (options.deferred ? () => true : undefined),
    },
  )
  const client = (name: string) => screen.state().mcp.clients.find(c => c.name === name)
  const waitFor = async (what: string, holds: () => boolean) => {
    const stopAt = Date.now() + 12_000
    while (!holds()) {
      if (Date.now() > stopAt) throw new Error(`waited in vain for ${what}; the screen shows:\n${screen.text()}`)
      await Bun.sleep(15)
    }
  }
  live.push(async () => {
    const clients = screen.state().mcp.clients
    for (const c of clients) markSessionDisconnected(c.name)
    await Promise.all(
      clients.filter(c => c.type === 'connected').map(c => hold.disconnect?.(c.name).catch(() => {})),
    )
    await screen.close()
    await Promise.all(clients.map(c => clearServerCache(c.name, c.config).catch(() => {})))
  })
  return Object.assign(screen, {
    calls,
    show: async () => {
      hold.reveal?.()
      // Key handlers subscribe in an effect after the first paint.
      await Bun.sleep(200)
    },
    client,
    reaches: async (name: string, ...types: MCPServerConnection['type'][]) => {
      await waitFor(`${name} to reach ${types.join('/')}`, () => types.includes(client(name)?.type as never))
      return client(name) as MCPServerConnection
    },
    completes: async (count = 1) => {
      await waitFor(`${count} result(s) reported to the caller`, () => calls.completed.length >= count)
      return calls.completed[count - 1]
    },
  })
}

// --- a server behind OAuth -------------------------------------------------------

const stoppers: Array<() => unknown> = []

export type GatedServer = {
  /** The MCP endpoint. */
  url: string
  inner: HttpBed
  /** Every Authorization header the gate let through, in order. */
  admitted: string[]
  /** How many requests were turned away with 401. */
  refused: () => number
  stop: () => Promise<void>
}

export function startGatedServer(bed: AuthBed, catalog: Catalog): GatedServer {
  const inner = serveHttp(catalog)
  const admitted: string[] = []
  let refusals = 0
  let origin = ''
  const front = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/.well-known/oauth-protected-resource/mcp') {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [bed.base] })
      }
      if (path !== '/mcp') return Response.json({}, { status: 404 })
      const presented = req.headers.get('authorization') ?? ''
      if (!/^Bearer access-\d+$/.test(presented)) {
        refusals += 1
        return Response.json(
          { error: 'unauthorized' },
          {
            status: 401,
            headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
          },
        )
      }
      admitted.push(presented)
      const headers = new Headers(req.headers)
      headers.delete('authorization')
      headers.delete('host')
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
      return fetch(inner.url, { method: req.method, headers, body })
    },
  })
  origin = `http://127.0.0.1:${front.port}`
  const gate: GatedServer = {
    url: `${origin}/mcp`,
    inner,
    admitted,
    refused: () => refusals,
    stop: async () => {
      front.stop(true)
      await inner.stop()
    },
  }
  stoppers.push(gate.stop)
  return gate
}

/**
 * Takes `keys` out of the environment for every test of the calling file and
 * puts the old values back afterwards; a test may then set them freely.
 */
export function ownEnv(...keys: string[]): void {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    for (const k of keys) delete process.env[k]
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
}

/** Stops `thing` after the test. */
export function stopAfter(stop: () => unknown): void {
  stoppers.push(stop)
}
