/**
 * Characterization tests for the headless WebSocketTransport, driven against a
 * real local Bun WebSocket server. They pin today's behavior on the Bun path
 * (upgrade headers, X-Last-Request-Id, ndjson framing, buffering and replay,
 * backoff and its time budget, permanent close codes, the 4003 token refresh,
 * the ping/pong watchdog, both sleep detectors, keep_alive frames and listener
 * cleanup) so the move to the shared WebSocket opener can be proven
 * behavior-preserving by this file passing unchanged.
 *
 * Timing is controlled without module mocks: the reconnect `setTimeout` is
 * intercepted on globalThis and fired at 0 ms (its requested delay is
 * recorded), the ping/keep_alive `setInterval` callbacks are captured and
 * invoked by hand, and `Date.now` is offset where a test needs the wall clock
 * to jump.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import { sendSessionActivitySignal } from 'src/sessions/sessionActivity.js'
import { WebSocketTransport } from './WebSocketTransport.js'

type Conn = {
  headers: Headers
  /** Text frames the server received on this connection, in order. */
  received: string[]
  ws?: ServerWebSocket<Conn>
}

type Harness = {
  url: URL
  conns: Conn[]
  /** HTTP requests that reached fetch() (upgrades and rejections). */
  attempts: () => number
}

type PrivateView = {
  ws: (WebSocket & { ping?: () => void }) | null
}

const servers: Array<Server<Conn>> = []
const transports: WebSocketTransport[] = []
const ENV_KEYS = [
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES',
] as const
const savedEnv = new Map<string, string | undefined>()

const realSetTimeout = globalThis.setTimeout
const realNow = Date.now.bind(Date)

/** Requested delays of every reconnect timer, in scheduling order. */
let reconnectDelays: number[] = []
/** Wall-clock jump applied just before each reconnect timer fires. */
let advanceOnFire: (attempt: number) => number = () => 0
/** When true, reconnect timers are held (never fire) instead of firing at 0 ms. */
let holdReconnects = false
let clockOffset = 0
let timeoutSpy: Mock<typeof setTimeout> | null = null
let intervalSpy: Mock<typeof setInterval> | null = null
let nowSpy: Mock<typeof Date.now> | null = null

// The reconnect delay is base × 2^(n-1) ± 25%, never exactly 1000 (the
// debug/error-log writers' flush interval, which must pass through untouched).
function isReconnectDelay(ms: unknown): ms is number {
  return typeof ms === 'number' && ms >= 700 && ms !== 1000
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  reconnectDelays = []
  advanceOnFire = () => 0
  holdReconnects = false
  clockOffset = 0
  timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (!isReconnectDelay(ms)) return realSetTimeout(fn, ms, ...rest)
    reconnectDelays.push(ms)
    if (holdReconnects) return realSetTimeout(fn, 1e9)
    const attempt = reconnectDelays.length
    return realSetTimeout(() => {
      clockOffset += advanceOnFire(attempt)
      fn()
    }, 0)
  }) as unknown as typeof setTimeout)
  intervalSpy = spyOn(globalThis, 'setInterval')
})

afterEach(() => {
  for (const t of transports.splice(0)) t.close()
  for (const s of servers.splice(0)) s.stop(true)
  timeoutSpy?.mockRestore()
  intervalSpy?.mockRestore()
  nowSpy?.mockRestore()
  timeoutSpy = intervalSpy = nowSpy = null
  for (const key of ENV_KEYS) {
    const v = savedEnv.get(key)
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
})

function offsetClock(): void {
  nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  // performance.now, not Date.now: some tests offset Date.now.
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await Bun.sleep(2)
  }
}

function startServer(opts: { reject?: boolean } = {}): Harness {
  const conns: Conn[] = []
  let attempts = 0
  const server = Bun.serve<Conn>({
    port: 0,
    fetch(req, srv) {
      attempts++
      if (opts.reject) return new Response('unauthorized', { status: 401 })
      const conn: Conn = { headers: req.headers, received: [] }
      if (srv.upgrade(req, { data: conn })) return undefined
      return new Response('expected websocket', { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.data.ws = ws
        conns.push(ws.data)
      },
      message(ws, msg) {
        ws.data.received.push(typeof msg === 'string' ? msg : msg.toString())
      },
    },
  })
  servers.push(server)
  return {
    url: new URL(`ws://localhost:${server.port}/v1/session/abc`),
    conns,
    attempts: () => attempts,
  }
}

/** A URL on a port nothing listens on: every connect fails with 1006. */
function deadUrl(): URL {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port
  s.stop(true)
  return new URL(`ws://localhost:${port}/dead`)
}

function make(
  url: URL,
  headers: Record<string, string> = {},
  refreshHeaders?: () => Record<string, string>,
  options?: { autoReconnect?: boolean },
): WebSocketTransport {
  const t = new WebSocketTransport(url, headers, 'sess-1', refreshHeaders, options)
  transports.push(t)
  return t
}

function msg(uuid: string, text = uuid): StdoutMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as StdoutMessage
}

function priv(t: WebSocketTransport): PrivateView {
  return t as unknown as PrivateView
}

function intervalCallback(ms: number): () => void {
  const calls = intervalSpy!.mock.calls.filter(c => c[1] === ms)
  const last = calls.at(-1)
  if (!last) throw new Error(`no setInterval(${ms}) was scheduled`)
  return last[0] as () => void
}

async function connected(h: Harness, t: WebSocketTransport, n = 1) {
  await waitFor(
    () => t.isConnectedStatus() && h.conns.length >= n,
    `connection #${n}`,
  )
  return h.conns[n - 1]!
}

function uuidsOf(lines: string[]): string[] {
  return lines.map(l => (JSON.parse(l) as { uuid?: string }).uuid ?? '-')
}

describe('connect', () => {
  test('opens the socket, sends the given headers and fires onConnect', async () => {
    const h = startServer()
    const t = make(h.url, { Authorization: 'Bearer t1', 'X-Extra': 'e' })
    let connects = 0
    t.setOnConnect(() => connects++)
    expect(t.getStateLabel()).toBe('idle')

    const pending = t.connect()
    expect(t.getStateLabel()).toBe('reconnecting')
    await pending
    const conn = await connected(h, t)

    expect(t.getStateLabel()).toBe('connected')
    expect(t.isClosedStatus()).toBe(false)
    expect(connects).toBe(1)
    expect(conn.headers.get('authorization')).toBe('Bearer t1')
    expect(conn.headers.get('x-extra')).toBe('e')
    expect(conn.headers.get('x-last-request-id')).toBeNull()
  })

  test('connect() while already connected is a no-op', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)

    await t.connect()
    await Bun.sleep(20)
    expect(h.attempts()).toBe(1)
    expect(t.isConnectedStatus()).toBe(true)
  })
})

describe('inbound', () => {
  test('delivers text frames to onData and stringifies binary frames', async () => {
    const h = startServer()
    const t = make(h.url)
    const got: string[] = []
    t.setOnData(d => got.push(d))
    await t.connect()
    const conn = await connected(h, t)

    conn.ws!.send('{"type":"user"}\n')
    conn.ws!.send(new TextEncoder().encode('binary-frame'))
    await waitFor(() => got.length === 2, 'two frames')

    expect(got).toEqual(['{"type":"user"}\n', 'binary-frame'])
  })

  test('frames are dropped without error when no onData is set', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const conn = await connected(h, t)
    conn.ws!.send('ignored')
    await Bun.sleep(20)
    expect(t.isConnectedStatus()).toBe(true)
  })
})

describe('write', () => {
  test('sends each message as one ndjson line while connected', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const conn = await connected(h, t)

    await t.write(msg('u1'))
    await t.write({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
    } as unknown as StdoutMessage)
    await t.write({
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'interrupt' },
    } as unknown as StdoutMessage)
    await t.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r3' },
    } as unknown as StdoutMessage)
    await waitFor(() => conn.received.length === 4, 'four lines')

    for (const line of conn.received) expect(line.endsWith('\n')).toBe(true)
    expect(conn.received.map(l => JSON.parse(l).type)).toEqual([
      'assistant',
      'control_request',
      'control_request',
      'control_response',
    ])
    expect(JSON.parse(conn.received[0]!)).toEqual(
      JSON.parse(JSON.stringify(msg('u1'))),
    )
  })

  test('before connect, uuid messages are buffered and replayed on open; others are dropped', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.write(msg('u1'))
    await t.write({ type: 'keep_alive' } as unknown as StdoutMessage)
    await t.write(msg('u2'))

    await t.connect()
    const conn = await connected(h, t)
    await waitFor(() => conn.received.length === 2, 'replay')

    expect(uuidsOf(conn.received)).toEqual(['u1', 'u2'])
    // The first connect already carries the last buffered id.
    expect(conn.headers.get('x-last-request-id')).toBe('u2')
  })

  test('an open with nothing ever written replays nothing', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.write({ type: 'keep_alive' } as unknown as StdoutMessage)
    await t.connect()
    const conn = await connected(h, t)
    await Bun.sleep(20)
    expect(conn.received).toEqual([])
  })

  test('a send that throws tears the socket down and schedules a reconnect', async () => {
    const h = startServer()
    const t = make(h.url)
    holdReconnects = true
    await t.connect()
    await connected(h, t)

    priv(t).ws!.send = () => {
      throw new Error('boom')
    }
    await t.write(msg('u1'))

    expect(priv(t).ws).toBeNull()
    expect(t.getStateLabel()).toBe('reconnecting')
    expect(reconnectDelays).toHaveLength(1)
  })
})

describe('reconnect', () => {
  test('after a non-permanent close it reconnects with X-Last-Request-Id and replays the whole buffer', async () => {
    const h = startServer()
    let refreshes = 0
    const t = make(h.url, { Authorization: 'Bearer old' }, () => {
      refreshes++
      return { Authorization: 'Bearer new' }
    })
    const closes: Array<number | undefined> = []
    t.setOnClose(c => closes.push(c))
    await t.connect()
    const first = await connected(h, t)
    await t.write(msg('u1'))
    await t.write(msg('u2'))
    await waitFor(() => first.received.length === 2, 'two lines')

    first.ws!.close(1011, 'server restart')
    const second = await connected(h, t, 2)
    await waitFor(() => second.received.length === 2, 'replay')

    expect(reconnectDelays).toHaveLength(1)
    expect(reconnectDelays[0]).toBeGreaterThanOrEqual(750)
    expect(reconnectDelays[0]).toBeLessThanOrEqual(1250)
    expect(second.headers.get('x-last-request-id')).toBe('u2')
    expect(refreshes).toBe(1)
    expect(second.headers.get('authorization')).toBe('Bearer new')
    // Bun cannot read the upgrade response, so it replays everything and
    // relies on the server deduplicating by uuid.
    expect(uuidsOf(second.received)).toEqual(['u1', 'u2'])
    expect(closes).toEqual([])
  })

  test('the buffer is kept after replay, so a second drop replays it again', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const first = await connected(h, t)
    await t.write(msg('u1'))
    await waitFor(() => first.received.length === 1, 'line')

    first.ws!.close(1011)
    const second = await connected(h, t, 2)
    await waitFor(() => second.received.length === 1, 'replay 1')
    second.ws!.close(1011)
    const third = await connected(h, t, 3)
    await waitFor(() => third.received.length === 1, 'replay 2')

    expect(uuidsOf(third.received)).toEqual(['u1'])
  })

  test('backoff doubles per failed attempt and caps at 30 s (±25% jitter)', async () => {
    const t = make(deadUrl())
    await t.connect()
    await waitFor(() => reconnectDelays.length >= 7, 'seven attempts')
    t.close()

    const bases = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    bases.forEach((base, i) => {
      expect(reconnectDelays[i]).toBeGreaterThanOrEqual(base * 0.75)
      expect(reconnectDelays[i]).toBeLessThanOrEqual(base * 1.25)
    })
  })

  test('gives up and fires onClose once the 10-minute budget is spent', async () => {
    offsetClock()
    advanceOnFire = () => 59_000 // under the 60 s sleep threshold
    const t = make(deadUrl())
    const closes: Array<number | undefined> = []
    t.setOnClose(c => closes.push(c))
    await t.connect()
    await waitFor(() => t.isClosedStatus(), 'closed')

    // Drops land at 0, 59, …, 590 s (11 reconnects scheduled); the 12th, at
    // 649 s, is past the 600 s budget and is not rescheduled.
    expect(reconnectDelays).toHaveLength(11)
    expect(closes).toEqual([1006])
    expect(t.getStateLabel()).toBe('closed')
  })

  test('a >60 s gap between attempts is treated as sleep and resets the backoff', async () => {
    offsetClock()
    advanceOnFire = attempt => (attempt === 2 ? 61_000 : 10)
    const t = make(deadUrl())
    await t.connect()
    await waitFor(() => reconnectDelays.length >= 4, 'four attempts')
    t.close()

    const inRange = (d: number, base: number) =>
      d >= base * 0.75 && d <= base * 1.25
    expect(inRange(reconnectDelays[0]!, 1000)).toBe(true)
    expect(inRange(reconnectDelays[1]!, 2000)).toBe(true)
    // Reset: attempt counter back to 1.
    expect(inRange(reconnectDelays[2]!, 1000)).toBe(true)
    expect(inRange(reconnectDelays[3]!, 2000)).toBe(true)
  })

  test('close() while a reconnect is pending cancels the timer', async () => {
    holdReconnects = true
    const clearSpy = spyOn(globalThis, 'clearTimeout')
    try {
      const h = startServer()
      const t = make(h.url)
      await t.connect()
      const conn = await connected(h, t)
      conn.ws!.close(1011)
      await waitFor(() => reconnectDelays.length === 1, 'reconnect scheduled')
      const timer = timeoutSpy!.mock.results.at(-1)!.value

      t.close()

      expect(clearSpy.mock.calls.some(c => c[0] === timer)).toBe(true)
      expect(t.getStateLabel()).toBe('closing')
    } finally {
      clearSpy.mockRestore()
    }
  })
})

describe('permanent close codes', () => {
  for (const code of [1002, 4001, 4003]) {
    test(`server close ${code} → closed, onClose(${code}), no reconnect`, async () => {
      const h = startServer()
      const t = make(h.url)
      const closes: Array<number | undefined> = []
      t.setOnClose(c => closes.push(c))
      await t.connect()
      const conn = await connected(h, t)

      conn.ws!.close(code)
      await waitFor(() => t.isClosedStatus(), 'closed')

      expect(closes).toEqual([code])
      expect(reconnectDelays).toEqual([])
      expect(priv(t).ws).toBeNull()
    })
  }

  test('a rejected handshake surfaces as 1002 and is permanent', async () => {
    const h = startServer({ reject: true })
    const t = make(h.url)
    const closes: Array<number | undefined> = []
    t.setOnClose(c => closes.push(c))
    await t.connect()
    await waitFor(() => t.isClosedStatus(), 'closed')

    expect(closes).toEqual([1002])
    expect(h.attempts()).toBe(1)
  })

  test('4003 reconnects when refreshHeaders yields a new Authorization', async () => {
    const h = startServer()
    let refreshes = 0
    const t = make(h.url, { Authorization: 'Bearer old' }, () => {
      refreshes++
      return { Authorization: 'Bearer fresh' }
    })
    await t.connect()
    const first = await connected(h, t)

    first.ws!.close(4003)
    const second = await connected(h, t, 2)

    expect(second.headers.get('authorization')).toBe('Bearer fresh')
    // Refreshed once by the 4003 branch, not again before the reconnect.
    expect(refreshes).toBe(1)
  })

  test('4003 stays permanent when refreshHeaders returns the same token', async () => {
    const h = startServer()
    const t = make(h.url, { Authorization: 'Bearer same' }, () => ({
      Authorization: 'Bearer same',
    }))
    const closes: Array<number | undefined> = []
    t.setOnClose(c => closes.push(c))
    await t.connect()
    const conn = await connected(h, t)

    conn.ws!.close(4003)
    await waitFor(() => t.isClosedStatus(), 'closed')
    expect(closes).toEqual([4003])
    expect(reconnectDelays).toEqual([])
  })

  test('autoReconnect: false closes on any drop and reports the code', async () => {
    const h = startServer()
    const t = make(h.url, {}, undefined, { autoReconnect: false })
    const closes: Array<number | undefined> = []
    t.setOnClose(c => closes.push(c))
    await t.connect()
    const conn = await connected(h, t)

    conn.ws!.close(1011)
    await waitFor(() => t.isClosedStatus(), 'closed')
    expect(closes).toEqual([1011])
    expect(reconnectDelays).toEqual([])
  })
})

describe('ping watchdog', () => {
  test('pings every tick and stays up while pongs come back', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    const tick = intervalCallback(10_000)
    const pingSpy = spyOn(priv(t).ws!, 'ping')

    tick()
    await Bun.sleep(30) // pong round-trip
    tick()
    await Bun.sleep(30)

    expect(pingSpy).toHaveBeenCalledTimes(2)
    expect(t.isConnectedStatus()).toBe(true)
    expect(reconnectDelays).toEqual([])
  })

  test('a tick with no pong since the last ping forces a reconnect', async () => {
    holdReconnects = true
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    const tick = intervalCallback(10_000)

    tick() // ping sent, pongReceived = false
    tick() // no event-loop turn, so no pong yet

    expect(t.getStateLabel()).toBe('reconnecting')
    expect(priv(t).ws).toBeNull()
    expect(reconnectDelays).toHaveLength(1)
  })

  test('a tick more than 60 s after the previous one forces a reconnect (process suspended)', async () => {
    holdReconnects = true
    offsetClock()
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    const tick = intervalCallback(10_000)
    const pingSpy = spyOn(priv(t).ws!, 'ping')

    clockOffset += 61_000
    tick()

    expect(pingSpy).not.toHaveBeenCalled()
    expect(t.getStateLabel()).toBe('reconnecting')
    expect(reconnectDelays).toHaveLength(1)
  })

  test('a ping that throws is logged and the connection stays up', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    const tick = intervalCallback(10_000)
    priv(t).ws!.ping = () => {
      throw new Error('ping failed')
    }

    tick()
    expect(t.isConnectedStatus()).toBe(true)
  })

  test('a tick after close does nothing', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    const tick = intervalCallback(10_000)
    t.close()
    tick()
    expect(t.getStateLabel()).toBe('closing')
    expect(reconnectDelays).toEqual([])
  })
})

describe('keep_alive', () => {
  test('the 5-minute interval sends a keep_alive data frame', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const conn = await connected(h, t)

    intervalCallback(300_000)()
    await waitFor(() => conn.received.length === 1, 'keep_alive')
    expect(conn.received).toEqual(['{"type":"keep_alive"}\n'])
  })

  test('a keep_alive send that throws is logged and the connection stays up', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    priv(t).ws!.send = () => {
      throw new Error('send failed')
    }
    intervalCallback(300_000)()
    expect(t.isConnectedStatus()).toBe(true)
  })

  test('in CCR (CLAUDE_CODE_REMOTE) no keep_alive interval is scheduled', async () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    await connected(h, t)
    expect(intervalSpy!.mock.calls.some(c => c[1] === 300_000)).toBe(false)
    expect(intervalSpy!.mock.calls.some(c => c[1] === 10_000)).toBe(true)
  })

  test('a session activity signal writes a keep_alive message', async () => {
    process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES = '1'
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const conn = await connected(h, t)

    sendSessionActivitySignal()
    await waitFor(() => conn.received.length === 1, 'keep_alive')
    expect(JSON.parse(conn.received[0]!)).toEqual({ type: 'keep_alive' })

    t.close()
    sendSessionActivitySignal() // unregistered on close
    await Bun.sleep(20)
    expect(conn.received).toHaveLength(1)
  })
})

describe('replay edge cases', () => {
  test('an onConnect that closes the transport stops the replay', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.write(msg('u1'))
    t.setOnConnect(() => t.close())
    await t.connect()
    await waitFor(() => t.getStateLabel() === 'closing', 'closing')
    await Bun.sleep(20)

    expect(h.conns.flatMap(c => c.received)).toEqual([])
    expect(reconnectDelays).toEqual([])
  })

  test('a replay send that fails stops after the first message and reconnects', async () => {
    holdReconnects = true
    const h = startServer()
    const t = make(h.url)
    await t.write(msg('u1'))
    await t.write(msg('u2'))
    let sends = 0
    t.setOnConnect(() => {
      priv(t).ws!.send = () => {
        sends++
        throw new Error('send failed')
      }
    })
    await t.connect()
    await waitFor(() => reconnectDelays.length >= 1, 'reconnect')

    expect(sends).toBe(1)
    expect(t.getStateLabel()).toBe('reconnecting')
  })
})

describe('close', () => {
  test('removes every listener it attached before closing the socket', async () => {
    const h = startServer()
    const t = make(h.url)
    const got: string[] = []
    t.setOnData(d => got.push(d))
    await t.connect()
    const conn = await connected(h, t)
    const ws = priv(t).ws! as unknown as { detach(): void; close(): void }
    // The opener owns the listeners; webSocket.test.ts proves detach() removes
    // every one of them on both runtimes.
    const order: string[] = []
    const detachSpy = spyOn(ws, 'detach').mockImplementation(function (this: typeof ws) {
      order.push('detach')
    })
    const closeSpy = spyOn(ws, 'close').mockImplementation(() => {
      order.push('close')
    })

    t.close()

    expect(detachSpy).toHaveBeenCalledTimes(1)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['detach', 'close'])
    detachSpy.mockRestore()
    closeSpy.mockRestore()
    ws.detach()
    ws.close()
    expect(priv(t).ws).toBeNull()
    expect(t.getStateLabel()).toBe('closing')
    expect(t.isConnectedStatus()).toBe(false)

    conn.ws!.send('late')
    await Bun.sleep(30)
    expect(got).toEqual([])
    expect(reconnectDelays).toEqual([])
  })

  test('writes after close are buffered, not sent', async () => {
    const h = startServer()
    const t = make(h.url)
    await t.connect()
    const conn = await connected(h, t)
    t.close()
    await t.write(msg('u1'))
    await Bun.sleep(20)
    expect(conn.received).toEqual([])
  })
})
