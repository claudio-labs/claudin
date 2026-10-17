import { describe, expect, test } from 'bun:test'
import { ResponsesSocketPool, SocketUnavailableError, type PooledSocket } from 'src/providers/transport/responsesSocket/pool.js'
import { WS_CONNECTING, WS_OPEN, type WebSocketHandlers, type openWebSocket } from 'src/providers/transport/webSocket.js'

// An opener that never touches the network: each socket it "opens" exposes
// its handlers, so a test plays the server's side by calling them.
type FakeSocket = { url: string; headers: Record<string, string>; handlers: WebSocketHandlers; state: number; sent: string[]; closedWith?: number }

function fakeOpener(): { open: typeof openWebSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const open: typeof openWebSocket = (url, options = {}) => {
    const fake: FakeSocket = { url, headers: options.headers ?? {}, handlers: options.handlers ?? {}, state: WS_CONNECTING, sent: [] }
    sockets.push(fake)
    return {
      url,
      get readyState() {
        return fake.state
      },
      listen: h => (fake.handlers = h),
      send: text => {
        fake.sent.push(String(text))
        return Promise.resolve()
      },
      ping: () => {},
      close: code => {
        fake.closedWith = code
        fake.state = 3
        fake.handlers.onClose?.(code ?? 1000, '')
      },
      detach: () => {},
    }
  }
  return { open, sockets }
}

const limits = { maxSockets: 2, idleMs: 60_000, maxAgeMs: 60_000 }
const body = (...input: unknown[]) => ({ model: 'm', input })
const msg = (text: string) => ({ type: 'message', role: 'user', content: text })

function openFake(fake: FakeSocket): void {
  fake.state = WS_OPEN
  fake.handlers.onOpen?.()
}

describe('ResponsesSocketPool.acquire', () => {
  test('prefers the idle socket whose chain the request extends', async () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    const a = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    const b = pool.acquire('k', 'ws://x', {}, body(msg('b')))!
    sockets.forEach(openFake)
    a.socket.chain = { settingsKey: a.plan.settingsKey, inputKeys: a.plan.inputKeys, responseId: 'resp_a', outputIds: [] }
    b.socket.chain = { settingsKey: b.plan.settingsKey, inputKeys: b.plan.inputKeys, responseId: 'resp_b', outputIds: [] }
    pool.release(a.socket)
    pool.release(b.socket)
    const next = pool.acquire('k', 'ws://x', {}, body(msg('b'), msg('more')))!
    expect(next.socket).toBe(b.socket)
    expect(next.plan.frame.previous_response_id).toBe('resp_b')
  })

  test('takes an idle socket with no chain before opening a new one', () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    const a = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    pool.release(a.socket)
    const again = pool.acquire('k', 'ws://x', {}, body(msg('z')))!
    expect(again.socket).toBe(a.socket)
    expect(sockets).toHaveLength(1)
  })

  test('at the cap, the least recently used idle socket loses its chain and serves a full frame', () => {
    let now = 0
    const { open } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open, now: () => now })
    const a = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    const b = pool.acquire('k', 'ws://x', {}, body(msg('b')))!
    for (const s of [a, b]) s.socket.chain = { settingsKey: s.plan.settingsKey, inputKeys: s.plan.inputKeys, responseId: 'r', outputIds: [] }
    now = 1
    pool.release(b.socket)
    now = 2
    pool.release(a.socket)
    const third = pool.acquire('k', 'ws://x', {}, body(msg('c')))!
    expect(third.socket).toBe(b.socket)
    expect(third.plan.incremental).toBe(false)
    expect(b.socket.chain).toBeUndefined()
  })

  test('every socket busy at the cap: no socket', () => {
    const { open } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    pool.acquire('k', 'ws://x', {}, body(msg('a')))
    pool.acquire('k', 'ws://x', {}, body(msg('b')))
    expect(pool.acquire('k', 'ws://x', {}, body(msg('c')))).toBeUndefined()
  })

  test('sockets of another key are never handed out', () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool({ ...limits, maxSockets: 4 }, { open })
    const a = pool.acquire('k1', 'ws://x', { Authorization: 'one' }, body(msg('a')))!
    pool.release(a.socket)
    const b = pool.acquire('k2', 'ws://x', { Authorization: 'two' }, body(msg('a')))!
    expect(b.socket).not.toBe(a.socket)
    expect(sockets.map(s => s.headers.Authorization)).toEqual(['one', 'two'])
  })

  test('a socket the server closed is skipped and forgotten', () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    const a = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    openFake(sockets[0]!)
    pool.release(a.socket)
    sockets[0]!.handlers.onClose?.(1001, 'going away')
    expect(pool.size).toBe(0)
    const b = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    expect(b.socket).not.toBe(a.socket)
  })

  test('release of a socket that already closed drops it', () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    const a = pool.acquire('k', 'ws://x', {}, body(msg('a')))!
    sockets[0]!.handlers.onClose?.(1006, '')
    pool.release(a.socket)
    expect(pool.size).toBe(0)
  })

  test('closeAll closes every socket', () => {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    pool.acquire('k', 'ws://x', {}, body(msg('a')))
    pool.acquire('k', 'ws://x', {}, body(msg('b')))
    pool.closeAll()
    expect(sockets.map(s => s.closedWith)).toEqual([1000, 1000])
    expect(pool.size).toBe(0)
  })
})

describe('PooledSocket', () => {
  function oneSocket(): { socket: PooledSocket; fake: FakeSocket } {
    const { open, sockets } = fakeOpener()
    const pool = new ResponsesSocketPool(limits, { open })
    const { socket } = pool.acquire('k', 'ws://x', { Authorization: 'a' }, body(msg('a')))!
    return { socket, fake: sockets[0]! }
  }

  test('ready resolves on open and keeps the upgrade headers', async () => {
    const { socket, fake } = oneSocket()
    fake.handlers.onUpgrade?.({ 'x-models-etag': 'w/1' })
    openFake(fake)
    await socket.ready
    expect(socket.upgradeHeaders).toEqual({ 'x-models-etag': 'w/1' })
    expect(socket.isOpen).toBe(true)
  })

  test('a refused upgrade rejects ready with its status', async () => {
    const { socket, fake } = oneSocket()
    fake.handlers.onRefused?.(426, 'upgrade required')
    fake.handlers.onClose?.(1006, '')
    const error = await socket.ready.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SocketUnavailableError)
    expect((error as SocketUnavailableError).status).toBe(426)
    expect((error as Error).message).toContain('426')
  })

  test('an error before open rejects ready with that error', async () => {
    const { socket, fake } = oneSocket()
    fake.handlers.onError?.(new Error('Expected 101 status code'))
    fake.handlers.onClose?.(1002, '')
    await expect(socket.ready).rejects.toThrow('WebSocket upgrade failed: Expected 101 status code')
  })

  test('a close before open with nothing said rejects ready', async () => {
    const { socket, fake } = oneSocket()
    fake.handlers.onClose?.(1006, '')
    await expect(socket.ready).rejects.toThrow('WebSocket closed before opening (1006)')
  })

  test('only JSON objects with a string type reach the sink', () => {
    const { socket, fake } = oneSocket()
    openFake(fake)
    const seen: string[] = []
    socket.sink = { event: e => seen.push(e.type), closed: () => {} }
    for (const text of ['not json', '42', 'null', '{"no":"type"}', '{"type":7}', '{"type":"response.created"}']) {
      fake.handlers.onMessage?.(text)
    }
    expect(seen).toEqual(['response.created'])
  })

  test('a frame with no request waiting is dropped', () => {
    const { fake } = oneSocket()
    openFake(fake)
    expect(() => fake.handlers.onMessage?.('{"type":"response.created"}')).not.toThrow()
  })
})
