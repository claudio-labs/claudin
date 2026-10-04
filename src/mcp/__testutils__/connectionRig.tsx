/**
 * A rig for the connection-manager characterization suites.
 *
 * It mounts `<MCPConnectionManager>` the way the REPL does — inside a real
 * `AppStateProvider`, in an Ink root drawn on the fake terminal — and hands
 * the test the three context actions plus the live app-state store. Every
 * state the store passes through is kept, so a test can ask which types a
 * server went through, in order.
 *
 * The servers on the other end are real:
 *   - `startSocketServer` runs an SDK `Server` behind a loopback WebSocket
 *     (config type `ws`), which is a remote transport, so it is the one that
 *     exercises automatic reconnection;
 *   - the stdio probes of `stdioProbeServers` are child processes, which say
 *     whether they were spawned at all.
 *
 * `holdBackoffTimers` is the clock: it parks every timer of one second or
 * more (up to the 30 s ceiling) so the test can see the delay that was asked
 * for and decide when it elapses. Shorter timers run normally.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  type JSONRPCMessage,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ServerWebSocket } from 'bun'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { clearServerCache } from 'src/mcp/client.js'
import { MCPConnectionManager, useMcpDisconnect, useMcpReconnect, useMcpToggleEnabled } from 'src/mcp/MCPConnectionManager.js'
import { markSessionDisconnected, resetSessionDisconnectsForTests } from 'src/mcp/sessionDisconnects.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { AppStateProvider, useAppStateStore } from 'src/terminal/state/AppState.js'
import type { AppState, AppStateStore } from 'src/terminal/state/AppStateStore.js'

// ---------------------------------------------------------------------------
// The build inlines MACRO; the client handshake reads its version under test too.

type WithMacro = { MACRO?: { VERSION: string } }
const holder = globalThis as unknown as WithMacro
if (holder.MACRO === undefined) holder.MACRO = { VERSION: '0.0.0-connection-rig' }

// ---------------------------------------------------------------------------
// Polling

export async function until(what: string, holds: () => boolean, withinMs = 12_000): Promise<void> {
  const stopAt = performance.now() + withinMs
  while (!holds()) {
    if (performance.now() > stopAt) throw new Error(`gave up after ${withinMs} ms waiting for: ${what}`)
    await Bun.sleep(10)
  }
}

/** Lets in-flight work run for a while, for assertions about what did NOT happen. */
export const quiet = (ms = 300): Promise<void> => Bun.sleep(ms)

// ---------------------------------------------------------------------------
// The mounted manager

type Actions = {
  reconnect: ReturnType<typeof useMcpReconnect>
  toggle: ReturnType<typeof useMcpToggleEnabled>
  disconnect: ReturnType<typeof useMcpDisconnect>
}

export type Mounted = Actions & {
  store: AppStateStore
  state: () => AppState
  /** The client entry for `name`, if any. */
  client: (name: string) => MCPServerConnection | undefined
  /** Every type `name` was seen in, in order, without repeats in a row. */
  journey: (name: string) => string[]
  /** Every distinct entry `name` had, in order. */
  entries: (name: string) => MCPServerConnection[]
  /** How many state changes the store has gone through. */
  changes: () => number
  /** Every state the store went through, oldest first. */
  history: () => readonly AppState[]
  /** Tool names in the pool, in pool order. */
  toolNames: () => string[]
  commandNames: () => string[]
  /** Waits until `name` is in one of `types`. */
  reaches: (name: string, ...types: MCPServerConnection['type'][]) => Promise<MCPServerConnection>
  redraw: (props: { dynamic?: Record<string, ScopedMcpServerConfig>; strict?: boolean }) => void
  unmount: () => void
}

const mounted: Array<() => Promise<void>> = []

export async function mountManager(
  props: { dynamic?: Record<string, ScopedMcpServerConfig>; strict?: boolean } = {},
  initialState?: AppState,
): Promise<Mounted> {
  resetSessionDisconnectsForTests()
  const terminal = createFakeTerminal({ columns: 100 })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, exitOnCtrlC: false, patchConsole: false })
  const history: AppState[] = []
  const box: { actions?: Actions; store?: AppStateStore } = {}
  const record = ({ newState }: { newState: AppState }) => {
    history.push(newState)
  }

  function Grip(): React.ReactNode {
    box.actions = { reconnect: useMcpReconnect(), toggle: useMcpToggleEnabled(), disconnect: useMcpDisconnect() }
    box.store = useAppStateStore()
    return null
  }

  const draw = (next: { dynamic?: Record<string, ScopedMcpServerConfig>; strict?: boolean }) =>
    root.render(
      <AppStateProvider initialState={initialState} onChangeAppState={record}>
        <MCPConnectionManager dynamicMcpConfig={next.dynamic} isStrictMcpConfig={next.strict ?? false}>
          <Grip />
        </MCPConnectionManager>
      </AppStateProvider>,
    )
  draw(props)
  await until('the manager to mount', () => box.store !== undefined)

  let gone = false
  const unmount = () => {
    if (gone) return
    gone = true
    root.unmount()
    terminal.close()
  }
  // Teardown goes through the manager's own disconnect, so no redial loop
  // outlives the test: disconnecting cancels a pending wait and closes the
  // connection without dialling back. Attempts already in flight are given
  // time to land before the unmount clears whatever wait they scheduled.
  mounted.push(async () => {
    const store = box.store as AppStateStore
    if (!gone) {
      const live = store.getState().mcp.clients.filter(c => c.type !== 'disabled')
      await Promise.all(live.map(c => (box.actions as Actions).disconnect(c.name).catch(() => {})))
      await quiet(300)
      for (const c of store.getState().mcp.clients) markSessionDisconnected(c.name)
    }
    unmount()
    await Promise.all(
      store
        .getState()
        .mcp.clients.filter(c => c.type === 'connected')
        .map(c => clearServerCache(c.name, c.config).catch(() => {})),
    )
  })

  const store = box.store as AppStateStore
  const state = () => store.getState()
  const client = (name: string) => state().mcp.clients.find(c => c.name === name)
  return {
    // The actions are stable across renders; read them late anyway, the way a
    // component re-reading its context would.
    reconnect: name => (box.actions as Actions).reconnect(name),
    toggle: name => (box.actions as Actions).toggle(name),
    disconnect: name => (box.actions as Actions).disconnect(name),
    store,
    state,
    client,
    journey: name => {
      const seen: string[] = []
      for (const s of history) {
        const type = s.mcp.clients.find(c => c.name === name)?.type ?? 'absent'
        if (seen[seen.length - 1] !== type) seen.push(type)
      }
      return seen
    },
    entries: name => {
      const out: MCPServerConnection[] = []
      for (const s of history) {
        const entry = s.mcp.clients.find(c => c.name === name)
        if (entry && out[out.length - 1] !== entry) out.push(entry)
      }
      return out
    },
    changes: () => history.length,
    history: () => history,
    toolNames: () => state().mcp.tools.map(t => t.name),
    commandNames: () => state().mcp.commands.map(c => c.name),
    reaches: async (name, ...types) => {
      await until(`${name} to reach ${types.join('/')}`, () => types.includes(client(name)?.type as never))
      return client(name) as MCPServerConnection
    },
    redraw: draw,
    unmount,
  }
}

/**
 * For an afterEach: unmounts every manager and closes what it connected.
 * The session-disconnect marks it leaves stay until the next mount, so a
 * transport closed by the rest of the teardown does not start a redial.
 */
export async function unmountAll(): Promise<void> {
  while (mounted.length) await mounted.pop()?.()
}

// ---------------------------------------------------------------------------
// A real MCP server on a loopback WebSocket

export type Catalog = {
  tools: string[]
  prompts: string[]
  resources: string[]
}

export type SocketServer = {
  url: string
  /** How many WebSocket sessions have been opened so far. */
  sessions: () => number
  /** How many are open right now. */
  open: () => number
  catalog: Catalog
  /** Tells every connected client that one of its lists changed. */
  announce: (what: 'tools' | 'prompts' | 'resources') => Promise<void>
  /** Asks the most recent session's client to fill in a form. */
  elicit: (message: string) => Promise<unknown>
  /** Closes every session from the server side; keeps listening. */
  dropSessions: () => void
  /** Stops listening and closes every session. */
  stop: () => void
  /** Listens again, on the same port. */
  restart: () => void
}

const servers: SocketServer[] = []

/**
 * The server side of one accepted Bun WebSocket, as the SDK wants it: the
 * SDK installs its own message and close callbacks on the returned object.
 */
function acceptedSocket(socket: ServerWebSocket<unknown>): Transport {
  return {
    start: async () => {},
    send: async message => {
      socket.send(JSON.stringify(message))
    },
    close: async () => {
      socket.close()
    },
  }
}

type Capabilities = { tools?: boolean; prompts?: boolean; resources?: boolean; listChanged?: boolean }

export function startSocketServer(start: Partial<Catalog> = {}, caps: Capabilities = {}): SocketServer {
  const catalog: Catalog = { tools: start.tools ?? ['echo'], prompts: start.prompts ?? [], resources: start.resources ?? [] }
  const wantPrompts = caps.prompts ?? catalog.prompts.length > 0
  const wantResources = caps.resources ?? catalog.resources.length > 0
  const listChanged = caps.listChanged ?? false
  const live = new Map<ServerWebSocket<unknown>, { link: Transport; server: Server }>()
  let opened = 0
  let port = 0

  const sdkServerFor = (): Server => {
    const server = new Server(
      { name: 'rig-socket', version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged },
          ...(wantPrompts ? { prompts: { listChanged } } : {}),
          ...(wantResources ? { resources: { listChanged } } : {}),
        },
      },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: catalog.tools.map(name => ({ name, description: `tool ${name}`, inputSchema: { type: 'object' as const, properties: {} } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: 'text', text: `called ${req.params.name}` }] }))
    if (wantPrompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: catalog.prompts.map(name => ({ name, description: `prompt ${name}` })),
      }))
    }
    if (wantResources) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: catalog.resources.map(name => ({ uri: `rig://${name}`, name })),
      }))
    }
    return server
  }

  let listener: ReturnType<typeof Bun.serve> | null = null
  const listen = () => {
    listener = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {}, headers: { 'Sec-WebSocket-Protocol': 'mcp' } })) return undefined
        return new Response('websocket only', { status: 426 })
      },
      websocket: {
        open(socket) {
          opened++
          const link = acceptedSocket(socket)
          const server = sdkServerFor()
          live.set(socket, { link, server })
          void server.connect(link)
        },
        message(socket, data) {
          live.get(socket)?.link.onmessage?.(JSON.parse(String(data)) as JSONRPCMessage)
        },
        close(socket) {
          const entry = live.get(socket)
          live.delete(socket)
          entry?.link.onclose?.()
        },
      },
    })
    port = listener.port as number
  }
  listen()

  const self: SocketServer = {
    url: `ws://127.0.0.1:${port}/mcp`,
    sessions: () => opened,
    open: () => live.size,
    catalog,
    announce: async what => {
      for (const { server } of live.values()) {
        if (what === 'tools') await server.sendToolListChanged()
        else if (what === 'prompts') await server.sendPromptListChanged()
        else await server.sendResourceListChanged()
      }
    },
    elicit: message => {
      const last = [...live.values()].at(-1)
      if (!last) throw new Error('no session to elicit on')
      return last.server.elicitInput({ message, requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } })
    },
    dropSessions: () => {
      for (const socket of [...live.keys()]) socket.close()
    },
    stop: () => {
      listener?.stop(true)
      listener = null
    },
    restart: () => {
      if (!listener) listen()
    },
  }
  servers.push(self)
  return self
}

export function stopAllSocketServers(): void {
  while (servers.length) servers.pop()?.stop()
}

export function socketConfig(server: SocketServer, scope: ScopedMcpServerConfig['scope'] = 'user'): ScopedMcpServerConfig {
  return { type: 'ws', url: server.url, scope } as ScopedMcpServerConfig
}

// ---------------------------------------------------------------------------
// A stdio MCP server with tools and prompts, as a child process

// Line-delimited JSON-RPC. argv: <pid file> <tools csv> <prompts csv>.
const STDIO_CATALOG_SCRIPT = `
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [pidFile, toolCsv = '', promptCsv = ''] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
const split = csv => csv.split(',').filter(Boolean)
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\\n')
const methods = {
  initialize: p => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'rig-stdio', version: '1.0.0' } }),
  'tools/list': () => ({ tools: split(toolCsv).map(name => ({ name, inputSchema: { type: 'object' } })) }),
  'prompts/list': () => ({ prompts: split(promptCsv).map(name => ({ name })) }),
  ping: () => ({}),
}
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  const run = methods[msg.method]
  reply(msg.id, run ? { result: run(msg.params ?? {}) } : { error: { code: -32601, message: 'no ' + msg.method } })
})
`

export type StdioServer = {
  config: ScopedMcpServerConfig
  /** The child's pid once it has started, else undefined. */
  pid: () => number | undefined
  kill: () => void
}

const children: StdioServer[] = []

/** Writes a stdio server into `dir`; it spawns only when someone connects. */
export function stdioServer(dir: string, label: string, catalog: { tools?: string[]; prompts?: string[] } = {}): StdioServer {
  const script = join(dir, `rig-stdio-${label}.mjs`)
  const pidFile = join(dir, `rig-stdio-${label}.pid`)
  writeFileSync(script, STDIO_CATALOG_SCRIPT)
  const pid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined)
  const server: StdioServer = {
    config: {
      command: process.execPath,
      args: [script, pidFile, (catalog.tools ?? []).join(','), (catalog.prompts ?? []).join(',')],
      scope: 'user',
    } as ScopedMcpServerConfig,
    pid,
    kill: () => {
      const p = pid()
      if (p === undefined) return
      try {
        process.kill(p, 'SIGKILL')
      } catch {
        // already gone
      }
    },
  }
  children.push(server)
  return server
}

export function killAllStdioServers(): void {
  while (children.length) children.pop()?.kill()
}

// ---------------------------------------------------------------------------
// The clock for backoff

export type HeldClock = {
  /** Every parked delay, in the order it was asked for. */
  asked: () => number[]
  /** Delays still parked. */
  parked: () => number[]
  /** How many parked timers were cleared before they elapsed. */
  cancelled: () => number
  /** Lets the oldest parked timer elapse now. */
  elapse: () => void
  release: () => void
}

const FLOOR_MS = 1_000
const CEILING_MS = 30_000

export function holdBackoffTimers(): HeldClock {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const parked = new Map<object, { delay: number; run: () => void }>()
  const asked: number[] = []
  let cancelled = 0

  const fakeSet = (run: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (typeof delay === 'number' && delay >= FLOOR_MS && delay <= CEILING_MS) {
      const handle: Record<string, unknown> = {}
      Object.assign(handle, {
        ref: () => handle,
        unref: () => handle,
        hasRef: () => false,
        refresh: () => handle,
      })
      parked.set(handle, { delay, run: () => run(...args) })
      asked.push(delay)
      return handle
    }
    return realSet(run, delay, ...args)
  }
  const fakeClear = (handle: unknown) => {
    if (handle && typeof handle === 'object' && parked.has(handle)) {
      parked.delete(handle)
      cancelled++
      return
    }
    realClear(handle as never)
  }
  globalThis.setTimeout = fakeSet as unknown as typeof setTimeout
  globalThis.clearTimeout = fakeClear as unknown as typeof clearTimeout

  return {
    asked: () => [...asked],
    parked: () => [...parked.values()].map(p => p.delay),
    cancelled: () => cancelled,
    elapse: () => {
      const first = parked.entries().next()
      if (first.done) throw new Error('no parked timer to elapse')
      const [handle, timer] = first.value
      parked.delete(handle)
      timer.run()
    },
    release: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}
