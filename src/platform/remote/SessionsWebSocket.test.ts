/**
 * Characterization tests for src/platform/remote/SessionsWebSocket.ts, written
 * before its WebSocket construction moves to the shared opener. The suite
 * must pass unchanged after that migration.
 *
 * The client runs against a real local `Bun.serve` WebSocket server. The
 * class has no seam for its URL: it is built from `getOauthConfig()`, which
 * always resolves to wss://api.anthropic.com (the only override accepts an
 * allowlisted FedStart host). So `globalThis.WebSocket` is swapped for a
 * subclass of the real one that records the URL and options it was given and
 * dials the local server instead. Everything after the dial (handshake,
 * headers, frames, close codes, ping/pong) is the real Bun socket.
 *
 * Only the Bun branch of `connect()` runs here. The Node branch (`import('ws')`)
 * is unreachable under `bun test`.
 *
 * Timers are faked so the 2 s reconnect delays and the 30 s ping run instantly.
 * Waits are event-driven (no sleeps), because under Bun's fake timers every
 * timer stays held back: `Bun.sleep`, a captured `setTimeout`, and the
 * runner's own per-test timeout too. So a wait that never resolves would hang
 * the run instead of failing. A watchdog subprocess (real time, measured
 * outside the faked timer system) rejects every pending wait after 4 s.
 *
 * Nothing here reads the error log: `src/shared/log.js` is mocked by sibling
 * suites, which leaks across the whole run (testing.md, cross-file mock
 * leaks), so what is asserted is what the caller and the server can see.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { Server, ServerWebSocket, Subprocess, TCPSocketListener } from 'bun'

import type { SDKControlResponse } from 'src/platform/entrypoints/sdk/controlTypes.js'

import {
  SessionsWebSocket,
  type SessionsWebSocketCallbacks,
} from './SessionsWebSocket.js'

const SESSION_ID = 'sess_123'
const ORG_UUID = 'org-abc'
const PRODUCTION_URL = `wss://api.anthropic.com/v1/sessions/ws/${SESSION_ID}/subscribe?organization_uuid=${ORG_UUID}`

const ENV_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'no_proxy',
  'NO_PROXY',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_ERROR_REPORTING',
] as const

// ── Event-driven waiting ─────────────────────────────────────────────────

const WATCHDOG_MS = 2000

// [sws-diag] TEMPORARY CI instrumentation: which wait hangs, and in what state.
// Bun's fake timers move every in-process clock (Date, performance, hrtime,
// Bun.nanoseconds), so real time is read from /proc/uptime (10 ms steps).
function realMs(): number {
  return Number(require('fs').readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000
}
const T0 = realMs()
function diag(msg: string): void {
  process.stderr.write(`[sws-diag] +${(realMs() - T0).toFixed(0)}ms ${msg}\n`)
}
let lastRecorder: { counts: Record<string, number> } | null = null
function snapshot(): string {
  const sockets = clientSockets.map(s => `${s.readyState}/buf${s.bufferedAmount}`).join(',')
  const conns = (testServer?.conns ?? []).map(c => `closedWith=${c.closedWith} pings=${c.pings}`).join('; ')
  return `dials=${dials.length} sockets=[${sockets}] conns=[${conns}] recorder=${JSON.stringify(lastRecorder?.counts)} timers=${jest.getTimerCount()} fake=${jest.isFakeTimers()}`
}
const pendingLabels = new Set<string>()

let listeners: Array<() => void> = []
let pendingRejects = new Set<(error: Error) => void>()
let watchdog: Subprocess | null = null

function armWatchdog(): void {
  const proc = Bun.spawn(
    [process.execPath, '-e', `setTimeout(() => {}, ${WATCHDOG_MS})`],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  )
  watchdog = proc
  void proc.exited.then(() => {
    if (watchdog !== proc) return
    diag(`watchdog fired, pending=[${[...pendingLabels].join(', ')}] ${snapshot()}`)
    const rejects = [...pendingRejects]
    pendingRejects.clear()
    listeners = []
    for (const reject of rejects) {
      reject(new Error(`until() timed out after ${WATCHDOG_MS} ms waiting for [${[...pendingLabels].join(', ')}]: ${snapshot()}`))
    }
  })
}

function disarmWatchdog(): void {
  const proc = watchdog
  watchdog = null
  proc?.kill()
  pendingRejects.clear()
}

function notify(): void {
  const current = listeners
  listeners = []
  for (const listener of current) listener()
}

function until<T>(read: () => T | undefined | false, label = 'until'): Promise<T> {
  return new Promise((resolve, reject) => {
    pendingRejects.add(reject)
    pendingLabels.add(label)
    const check = (): void => {
      const value = read()
      if (value !== undefined && value !== false) {
        pendingRejects.delete(reject)
        pendingLabels.delete(label)
        resolve(value)
      } else {
        listeners.push(check)
      }
    }
    check()
  })
}

// ── Local server ─────────────────────────────────────────────────────────

type ConnData = {
  headers: Headers
  path: string
  conn?: ServerConn
}

type ServerConn = {
  ws: ServerWebSocket<ConnData>
  headers: Headers
  path: string
  received: string[]
  pings: number
  closedWith?: number
}

type TestServer = {
  server: Server<ConnData>
  conns: ServerConn[]
  rejectWith?: number
}

let testServer: TestServer | null = null

function startServer(): TestServer {
  const conns: ServerConn[] = []
  let rejectWith: number | undefined
  const server = Bun.serve<ConnData, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      if (rejectWith) {
        return new Response('denied', { status: rejectWith })
      }
      const url = new URL(req.url)
      const upgraded = srv.upgrade(req, {
        data: { headers: req.headers, path: url.pathname + url.search },
      })
      return upgraded ? undefined : new Response('no upgrade', { status: 426 })
    },
    websocket: {
      open(ws) {
        const conn: ServerConn = {
          ws,
          headers: ws.data.headers,
          path: ws.data.path,
          received: [],
          pings: 0,
        }
        ws.data.conn = conn
        conns.push(conn)
        notify()
      },
      message(ws, message) {
        ws.data.conn?.received.push(String(message))
        notify()
      },
      ping(ws) {
        if (ws.data.conn) ws.data.conn.pings++
        notify()
      },
      close(ws, code) {
        if (ws.data.conn) ws.data.conn.closedWith = code
        notify()
      },
    },
  })
  const state: TestServer = {
    server,
    conns,
    get rejectWith() {
      return rejectWith
    },
    set rejectWith(status) {
      rejectWith = status
    },
  }
  testServer = state
  return state
}

function connAt(server: TestServer, index: number): Promise<ServerConn> {
  return until(() => server.conns[index], `server conn ${index}`)
}

// ── Redirecting WebSocket ────────────────────────────────────────────────

const RealWebSocket = globalThis.WebSocket

type Dial = { url: string; options: Record<string, unknown> }

let dials: Dial[] = []
let clientSockets: RedirectingWebSocket[] = []
let pingThrows = false

/** A TCP listener that accepts and never answers, so a dial stays pending. */
let blackHole: TCPSocketListener | null = null

function useBlackHole(): void {
  blackHole = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
}

class RedirectingWebSocket extends RealWebSocket {
  constructor(url: string | URL, options?: unknown) {
    const port = blackHole?.port ?? testServer?.server.port
    const target = String(url).replace(
      'wss://api.anthropic.com',
      `ws://127.0.0.1:${port}`,
    )
    dials.push({
      url: String(url),
      options: (options ?? {}) as Record<string, unknown>,
    })
    super(target, options as string[])
    clientSockets.push(this)
  }

  ping(): void {
    if (pingThrows) throw new Error('ping failed')
    ;(RealWebSocket.prototype as unknown as { ping(): void }).ping.call(this)
  }
}

// ── Callback recorder ────────────────────────────────────────────────────

type Recorder = {
  callbacks: SessionsWebSocketCallbacks
  messages: unknown[]
  errors: Error[]
  counts: {
    connected: number
    close: number
    reconnecting: number
  }
}

function makeRecorder(): Recorder {
  const recorder: Recorder = {
    messages: [],
    errors: [],
    counts: { connected: 0, close: 0, reconnecting: 0 },
    callbacks: {
      onMessage: message => {
        recorder.messages.push(message)
        notify()
      },
      onConnected: () => {
        recorder.counts.connected++
        notify()
      },
      onClose: () => {
        recorder.counts.close++
        notify()
      },
      onReconnecting: () => {
        recorder.counts.reconnecting++
        notify()
      },
      onError: error => {
        recorder.errors.push(error)
        notify()
      },
    },
  }
  lastRecorder = recorder
  return recorder
}

let clients: SessionsWebSocket[] = []

function makeClient(
  recorder: Recorder,
  getAccessToken: () => string = () => 'token-1',
): SessionsWebSocket {
  const client = new SessionsWebSocket(
    SESSION_ID,
    ORG_UUID,
    getAccessToken,
    recorder.callbacks,
  )
  clients.push(client)
  return client
}

async function connectedClient(
  server: TestServer,
  recorder: Recorder,
  getAccessToken?: () => string,
): Promise<{ client: SessionsWebSocket; conn: ServerConn }> {
  const client = makeClient(recorder, getAccessToken)
  const index = server.conns.length
  const connectedBefore = recorder.counts.connected
  await client.connect()
  const conn = await connAt(server, index)
  await until(() => recorder.counts.connected > connectedBefore, 'client onConnected')
  return { client, conn }
}

/** Server closes the current connection; resolves once the client handled it. */
async function serverClose(
  recorder: Recorder,
  conn: ServerConn,
  code: number,
): Promise<void> {
  const before = recorder.counts.close + recorder.counts.reconnecting
  conn.ws.close(code, 'test')
  await until(
    () => recorder.counts.close + recorder.counts.reconnecting > before,
    `client sees server close ${code}`,
  )
}

// ── Lifecycle ────────────────────────────────────────────────────────────

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

beforeEach(() => {
  pendingLabels.clear()
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  dials = []
  clientSockets = []
  clients = []
  listeners = []
  pendingRejects = new Set()
  pingThrows = false
  globalThis.WebSocket = RedirectingWebSocket as unknown as typeof WebSocket
  armWatchdog()
  jest.useFakeTimers()
})

afterEach(() => {
  disarmWatchdog()
  for (const client of clients) client.close()
  for (const socket of clientSockets) socket.close()
  jest.useRealTimers()
  globalThis.WebSocket = RealWebSocket
  testServer?.server.stop(true)
  testServer = null
  blackHole?.stop(true)
  blackHole = null
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('SessionsWebSocket connect', () => {
  test('dials the production subscribe URL and authenticates with headers', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    expect(dials).toHaveLength(1)
    expect(dials[0]!.url).toBe(PRODUCTION_URL)
    expect(dials[0]!.options.headers).toEqual({
      Authorization: 'Bearer token-1',
      'anthropic-version': '2023-06-01',
    })
    expect(dials[0]!.options.proxy).toBeUndefined()

    expect(conn.path).toBe(
      `/v1/sessions/ws/${SESSION_ID}/subscribe?organization_uuid=${ORG_UUID}`,
    )
    expect(conn.headers.get('authorization')).toBe('Bearer token-1')
    expect(conn.headers.get('anthropic-version')).toBe('2023-06-01')

    expect(recorder.counts.connected).toBe(1)
    expect(client.isConnected()).toBe(true)
  })

  test('isConnected is false before connect and while the handshake is pending', async () => {
    startServer()
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    expect(client.isConnected()).toBe(false)
    await client.connect()
    expect(client.isConnected()).toBe(false)
    await until(() => recorder.counts.connected > 0)
    expect(client.isConnected()).toBe(true)
  })

  test('a second connect() while connecting is ignored', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    await Promise.all([client.connect(), client.connect()])
    await until(() => recorder.counts.connected > 0)
    expect(dials).toHaveLength(1)
    expect(server.conns).toHaveLength(1)
  })

  test('passes the proxy from HTTPS_PROXY to the Bun socket', async () => {
    startServer()
    process.env.HTTPS_PROXY = 'http://proxy.invalid:3128'
    const client = makeClient(makeRecorder())
    await client.connect()
    expect(dials[0]!.options.proxy).toBe('http://proxy.invalid:3128')
    client.close()
  })

  test('NO_PROXY covering the API host drops the proxy', async () => {
    startServer()
    process.env.HTTPS_PROXY = 'http://proxy.invalid:3128'
    process.env.NO_PROXY = 'api.anthropic.com'
    const client = makeClient(makeRecorder())
    await client.connect()
    expect(dials[0]!.options.proxy).toBeUndefined()
    client.close()
  })

  test('reads a fresh token for every connection attempt', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    let n = 0
    const { conn } = await connectedClient(server, recorder, () => `token-${++n}`)
    expect(conn.headers.get('authorization')).toBe('Bearer token-1')

    await serverClose(recorder, conn, 1011)
    jest.advanceTimersByTime(2000)
    const second = await connAt(server, 1)
    expect(second.headers.get('authorization')).toBe('Bearer token-2')
  })
})

describe('SessionsWebSocket messages', () => {
  test('forwards any object with a string type, in order', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    conn.ws.send(JSON.stringify({ type: 'assistant', message: { id: 'm1' } }))
    conn.ws.send(
      JSON.stringify({ type: 'control_request', request_id: 'r1', request: {} }),
    )
    conn.ws.send(JSON.stringify({ type: 'brand_new_type', x: 1 }))
    await until(() => recorder.messages.length === 3)

    expect(recorder.messages).toEqual([
      { type: 'assistant', message: { id: 'm1' } },
      { type: 'control_request', request_id: 'r1', request: {} },
      { type: 'brand_new_type', x: 1 },
    ])
  })

  test('ignores JSON that is not a typed object', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    conn.ws.send('null')
    conn.ws.send('42')
    conn.ws.send('"text"')
    conn.ws.send(JSON.stringify({ no: 'type' }))
    conn.ws.send(JSON.stringify({ type: 7 }))
    conn.ws.send(JSON.stringify({ type: 'sentinel' }))
    await until(() => recorder.messages.length > 0)

    expect(recorder.messages).toEqual([{ type: 'sentinel' }])
    expect(recorder.errors).toEqual([])
  })

  test('an unparseable frame is skipped and the connection stays', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    conn.ws.send('{not json')
    conn.ws.send(JSON.stringify({ type: 'after' }))
    await until(() => recorder.messages.length > 0)

    expect(recorder.messages).toEqual([{ type: 'after' }])
    expect(recorder.errors).toEqual([])
    expect(client.isConnected()).toBe(true)
  })

  test('a binary frame is stringified before parsing', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    conn.ws.sendBinary(new TextEncoder().encode(JSON.stringify({ type: 'bin' })))
    conn.ws.send(JSON.stringify({ type: 'text' }))
    await until(() => recorder.messages.some(m => (m as { type: string }).type === 'text'))

    // Bun delivers client binary frames as a Buffer, so String() yields the
    // JSON text and the message is forwarded like a text frame.
    expect(recorder.messages).toEqual([{ type: 'bin' }, { type: 'text' }])
  })
})

describe('SessionsWebSocket sending', () => {
  test('sendControlResponse writes the response as JSON', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    const response = {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { ok: true } },
    } as SDKControlResponse
    client.sendControlResponse(response)
    await until(() => conn.received.length > 0)

    expect(JSON.parse(conn.received[0]!)).toEqual(response)
  })

  test('sendControlRequest wraps the request with a fresh request_id', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    client.sendControlRequest({ subtype: 'interrupt' })
    client.sendControlRequest({ subtype: 'interrupt' })
    await until(() => conn.received.length === 2)

    const [a, b] = conn.received.map(raw => JSON.parse(raw))
    expect(a).toEqual({
      type: 'control_request',
      request_id: expect.any(String),
      request: { subtype: 'interrupt' },
    })
    expect(a.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(b.request_id).not.toBe(a.request_id)
  })

  test('sending before connect is dropped, not queued for the connection', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    expect(() => client.sendControlRequest({ subtype: 'interrupt' })).not.toThrow()
    expect(() =>
      client.sendControlResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'r', response: {} },
      } as SDKControlResponse),
    ).not.toThrow()

    await client.connect()
    const conn = await connAt(server, 0)
    await until(() => recorder.counts.connected > 0)
    client.sendControlRequest({ subtype: 'interrupt' })
    await until(() => conn.received.length > 0)
    expect(conn.received).toHaveLength(1)
    expect(JSON.parse(conn.received[0]!).type).toBe('control_request')
  })

  test('sending while the handshake is pending is dropped', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    await client.connect()
    client.sendControlRequest({ subtype: 'interrupt' })
    await until(() => recorder.counts.connected > 0)
    const conn = await connAt(server, 0)
    client.sendControlRequest({ subtype: 'interrupt' })
    await until(() => conn.received.length > 0)
    expect(conn.received).toHaveLength(1)
  })
})

describe('SessionsWebSocket errors', () => {
  test('a refused handshake reports onError, then onClose without reconnecting', async () => {
    const server = startServer()
    server.rejectWith = 403
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    await client.connect()
    await until(() => recorder.counts.close > 0)

    expect(recorder.errors).toHaveLength(1)
    expect(recorder.errors[0]!.message).toBe('[SessionsWebSocket] WebSocket error')
    expect(recorder.counts.reconnecting).toBe(0)
    expect(recorder.counts.connected).toBe(0)
    expect(client.isConnected()).toBe(false)

    jest.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(1)
  })
})

describe('SessionsWebSocket handleClose', () => {
  test('4003 is permanent: onClose, no reconnect', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    await serverClose(recorder, conn, 4003)

    expect(recorder.counts.close).toBe(1)
    expect(recorder.counts.reconnecting).toBe(0)
    expect(client.isConnected()).toBe(false)
    jest.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(1)
  })

  test('a transient close reconnects after 2 s and the new socket works', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    await serverClose(recorder, conn, 1011)
    expect(recorder.counts.reconnecting).toBe(1)
    expect(recorder.counts.close).toBe(0)
    expect(client.isConnected()).toBe(false)

    jest.advanceTimersByTime(1999)
    expect(dials).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(dials).toHaveLength(2)

    const second = await connAt(server, 1)
    await until(() => recorder.counts.connected === 2)
    client.sendControlRequest({ subtype: 'interrupt' })
    await until(() => second.received.length > 0)
    expect(client.isConnected()).toBe(true)
  })

  test('4001 reconnects after 2 s, and a successful open resets its budget', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    // Every real 4001 arrives after an open, and open zeroes the 4001
    // counter, so the delay stays at 2 s and the 3-retry budget never runs
    // out. Pinned as current behavior.
    let current = conn
    for (let i = 1; i <= 5; i++) {
      await serverClose(recorder, current, 4001)
      expect(recorder.counts.reconnecting).toBe(i)
      jest.advanceTimersByTime(1999)
      expect(dials).toHaveLength(i)
      jest.advanceTimersByTime(1)
      expect(dials).toHaveLength(i + 1)
      current = await connAt(server, i)
      await until(() => recorder.counts.connected === i + 1)
    }
    expect(recorder.counts.close).toBe(0)
  })

  test('4001 without an intervening open backs off linearly and gives up after 3', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    await serverClose(recorder, conn, 4001)
    expect(recorder.counts.reconnecting).toBe(1)

    // A real 4001 always follows an open, which resets the counter. To reach
    // the budget, the redials go to a TCP listener that never answers the
    // handshake, and the 4001 is dispatched on that pending socket.
    useBlackHole()
    jest.advanceTimersByTime(2000)
    expect(dials).toHaveLength(2)

    for (const [i, delay] of [4000, 6000].entries()) {
      clientSockets.at(-1)!.dispatchEvent(new CloseEvent('close', { code: 4001 }))
      expect(recorder.counts.reconnecting).toBe(i + 2)
      jest.advanceTimersByTime(delay - 1)
      expect(dials).toHaveLength(i + 2)
      jest.advanceTimersByTime(1)
      expect(dials).toHaveLength(i + 3)
    }

    clientSockets.at(-1)!.dispatchEvent(new CloseEvent('close', { code: 4001 }))
    expect(recorder.counts.reconnecting).toBe(3)
    expect(recorder.counts.close).toBe(1)
    jest.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(4)
  })

  test('other codes reconnect again after each successful open', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    // open zeroes reconnectAttempts, so the 5-attempt cap is never reached
    // by a server that keeps accepting and dropping. Pinned as current
    // behavior.
    let current = conn
    for (let i = 1; i <= 6; i++) {
      await serverClose(recorder, current, 1001)
      jest.advanceTimersByTime(2000)
      current = await connAt(server, i)
      await until(() => recorder.counts.connected === i + 1)
    }
    expect(recorder.counts.reconnecting).toBe(6)
    expect(recorder.counts.close).toBe(0)
  })

  test('a reconnect whose handshake fails gives up with onClose', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    await serverClose(recorder, conn, 1011)
    server.rejectWith = 503
    jest.advanceTimersByTime(2000)
    await until(() => recorder.counts.close > 0)

    expect(recorder.errors).toHaveLength(1)
    expect(recorder.counts.reconnecting).toBe(1)
    expect(client.isConnected()).toBe(false)
    jest.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(2)
  })
})

describe('SessionsWebSocket ping', () => {
  test('pings every 30 s while connected', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)

    jest.advanceTimersByTime(29_999)
    expect(conn.pings).toBe(0)
    jest.advanceTimersByTime(1)
    await until(() => conn.pings === 1)
    jest.advanceTimersByTime(30_000)
    await until(() => conn.pings === 2)
  })

  test('a throwing ping is swallowed and the connection stays up', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    pingThrows = true
    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow()
    expect(client.isConnected()).toBe(true)

    pingThrows = false
    jest.advanceTimersByTime(30_000)
    await until(() => conn.pings === 1)
  })

  test('stops pinging after the connection closes', async () => {
    diag(`stops pinging: start ${snapshot()}`)
    const server = startServer()
    const recorder = makeRecorder()
    const { conn } = await connectedClient(server, recorder)
    diag(`stops pinging: connected ${snapshot()}`)

    await serverClose(recorder, conn, 4003)
    diag(`stops pinging: client saw 4003 ${snapshot()}`)
    jest.advanceTimersByTime(120_000)
    diag(`stops pinging: advanced 120s ${snapshot()}`)
    expect(conn.pings).toBe(0)
  })
})

describe('SessionsWebSocket close and reconnect', () => {
  test('close() closes the socket without firing onClose or reconnecting', async () => {
    diag(`close(): start ${snapshot()}`)
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)
    diag(`close(): connected ${snapshot()}`)

    client.close()
    diag(`close(): client.close() returned ${snapshot()}`)
    expect(client.isConnected()).toBe(false)
    await until(() => conn.closedWith !== undefined, 'server sees client close')
    diag(`close(): server saw close ${snapshot()}`)

    expect(recorder.counts.close).toBe(0)
    expect(recorder.counts.reconnecting).toBe(0)
    jest.advanceTimersByTime(120_000)
    diag(`close(): advanced 120s ${snapshot()}`)
    expect(dials).toHaveLength(1)
    expect(conn.pings).toBe(0)
  })

  test('close() cancels a scheduled reconnect', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client, conn } = await connectedClient(server, recorder)

    await serverClose(recorder, conn, 1011)
    client.close()
    jest.advanceTimersByTime(60_000)
    expect(dials).toHaveLength(1)
  })

  test('close() before connect is a no-op', () => {
    const recorder = makeRecorder()
    const client = makeClient(recorder)
    expect(() => client.close()).not.toThrow()
    expect(recorder.counts.close).toBe(0)
  })

  test('reconnect() drops the socket and dials again after 500 ms', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    let n = 0
    const { client, conn } = await connectedClient(server, recorder, () => `token-${++n}`)

    client.reconnect()
    expect(client.isConnected()).toBe(false)
    await until(() => conn.closedWith !== undefined)

    jest.advanceTimersByTime(499)
    expect(dials).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(dials).toHaveLength(2)

    const second = await connAt(server, 1)
    await until(() => recorder.counts.connected === 2)
    expect(second.headers.get('authorization')).toBe('Bearer token-2')
    expect(recorder.counts.close).toBe(0)
    expect(recorder.counts.reconnecting).toBe(0)
  })

  test('close() after reconnect() cancels the pending dial', async () => {
    const server = startServer()
    const recorder = makeRecorder()
    const { client } = await connectedClient(server, recorder)

    client.reconnect()
    client.close()
    jest.advanceTimersByTime(10_000)
    expect(dials).toHaveLength(1)
  })
})
