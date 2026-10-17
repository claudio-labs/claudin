/**
 * Characterization tests for DirectConnectSessionManager, driven against a real
 * local Bun WebSocket server. They pin today's behavior (headers on the
 * upgrade, newline-delimited JSON dispatch, the exact frames each sender
 * writes, close/error callbacks) so the move to the shared WebSocket opener
 * can be proven behavior-preserving.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from 'src/platform/entrypoints/sdk/controlTypes.js'
import {
  type DirectConnectCallbacks,
  DirectConnectSessionManager,
} from 'src/platform/server/directConnectManager.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Harness = {
  wsUrl: string
  /** `authorization` header of each upgrade request, null when absent. */
  authHeaders: Array<string | null>
  /** Text frames the server received, parsed. */
  received: unknown[]
  /** The server side of the most recent connection. */
  peer: () => ServerWebSocket<unknown>
  serverClosed: () => boolean
}

const servers: Array<{ stop: (force?: boolean) => void }> = []
const managers: DirectConnectSessionManager[] = []

afterEach(() => {
  for (const m of managers.splice(0)) m.disconnect()
  for (const s of servers.splice(0)) s.stop(true)
})

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(2)
  }
}

function startServer(): Harness {
  const authHeaders: Array<string | null> = []
  const received: unknown[] = []
  let peer: ServerWebSocket<unknown> | null = null
  let closed = false
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      authHeaders.push(req.headers.get('authorization'))
      if (srv.upgrade(req)) return undefined
      return new Response('expected websocket', { status: 400 })
    },
    websocket: {
      open(ws) {
        peer = ws
      },
      message(_ws, msg) {
        received.push(JSON.parse(String(msg)))
      },
      close() {
        closed = true
      },
    },
  })
  servers.push(server)
  return {
    wsUrl: `ws://127.0.0.1:${server.port}/sessions/s1/ws`,
    authHeaders,
    received,
    peer: () => {
      if (!peer) throw new Error('no peer connected')
      return peer
    },
    serverClosed: () => closed,
  }
}

function makeCallbacks() {
  return {
    onMessage: mock((_m: SDKMessage) => {}),
    onPermissionRequest: mock(
      (_r: SDKControlPermissionRequest, _id: string) => {},
    ),
    onConnected: mock(() => {}),
    onDisconnected: mock(() => {}),
    onError: mock((_e: Error) => {}),
  } satisfies DirectConnectCallbacks
}

function makeManager(
  wsUrl: string,
  callbacks: DirectConnectCallbacks,
  authToken?: string,
): DirectConnectSessionManager {
  const manager = new DirectConnectSessionManager(
    { serverUrl: 'http://127.0.0.1', sessionId: 's1', wsUrl, authToken },
    callbacks,
  )
  managers.push(manager)
  return manager
}

async function connected(
  authToken?: string,
): Promise<{
  h: Harness
  cb: ReturnType<typeof makeCallbacks>
  manager: DirectConnectSessionManager
}> {
  const h = startServer()
  const cb = makeCallbacks()
  const manager = makeManager(h.wsUrl, cb, authToken)
  manager.connect()
  await waitFor(() => cb.onConnected.mock.calls.length === 1, 'onConnected')
  await waitFor(() => {
    try {
      h.peer()
      return true
    } catch {
      return false
    }
  }, 'server peer')
  return { h, cb, manager }
}

const SENTINEL = { type: 'assistant', sentinel: true }

/** Sends the frames, then a sentinel, and waits until the sentinel arrives. */
async function deliver(
  h: Harness,
  cb: ReturnType<typeof makeCallbacks>,
  ...frames: Array<string | Uint8Array>
): Promise<void> {
  for (const f of frames) h.peer().send(f)
  h.peer().send(JSON.stringify(SENTINEL))
  await waitFor(
    () =>
      cb.onMessage.mock.calls.some(
        ([m]) => (m as { sentinel?: boolean }).sentinel === true,
      ),
    'sentinel',
  )
}

function forwarded(cb: ReturnType<typeof makeCallbacks>): unknown[] {
  return cb.onMessage.mock.calls
    .map(([m]) => m)
    .filter(m => (m as { sentinel?: boolean }).sentinel !== true)
}

describe('connect', () => {
  test('sends authorization: Bearer <token> on the upgrade when a token is set', async () => {
    const { h, cb, manager } = await connected('tok-123')
    expect(h.authHeaders).toEqual(['Bearer tok-123'])
    expect(cb.onConnected).toHaveBeenCalledTimes(1)
    expect(manager.isConnected()).toBe(true)
  })

  test('sends no authorization header without a token', async () => {
    const { h } = await connected()
    expect(h.authHeaders).toEqual([null])
  })

  test('an empty token is treated as no token', async () => {
    const { h } = await connected('')
    expect(h.authHeaders).toEqual([null])
  })

  test('isConnected is false before connect and while the socket is connecting', () => {
    const h = startServer()
    const manager = makeManager(h.wsUrl, makeCallbacks())
    expect(manager.isConnected()).toBe(false)
    manager.connect()
    expect(manager.isConnected()).toBe(false)
  })

  test('works without the optional callbacks', async () => {
    const h = startServer()
    const onMessage = mock((_m: SDKMessage) => {})
    const manager = makeManager(h.wsUrl, {
      onMessage,
      onPermissionRequest: () => {},
    })
    manager.connect()
    await waitFor(() => manager.isConnected(), 'open')
    await waitFor(() => {
      try {
        h.peer()
        return true
      } catch {
        return false
      }
    }, 'peer')
    h.peer().send(JSON.stringify({ type: 'assistant', n: 1 }))
    await waitFor(() => onMessage.mock.calls.length === 1, 'message')
    h.peer().close(1000, 'bye')
    await waitFor(() => !manager.isConnected(), 'closed')
  })
})

describe('message dispatch', () => {
  test('forwards SDK messages, one per line, skipping blank lines', async () => {
    const { h, cb } = await connected()
    const a = { type: 'assistant', message: { content: 'hi' } }
    const r = { type: 'result', subtype: 'success' }
    const init = { type: 'system', subtype: 'init' }
    await deliver(
      h,
      cb,
      `${JSON.stringify(a)}\n\n   \n${JSON.stringify(r)}\n`,
      JSON.stringify(init),
    )
    expect(forwarded(cb)).toEqual([a, r, init])
  })

  test('skips invalid JSON lines and keeps the rest of the frame', async () => {
    const { h, cb } = await connected()
    const good = { type: 'user', message: { content: 'x' } }
    await deliver(h, cb, `{not json\n${JSON.stringify(good)}\n}{`)
    expect(forwarded(cb)).toEqual([good])
  })

  test('skips values that are not stdout messages', async () => {
    const { h, cb } = await connected()
    await deliver(
      h,
      cb,
      ['null', '42', '"str"', '[1,2]', '{"foo":1}', '{"type":5}'].join('\n'),
    )
    expect(forwarded(cb)).toEqual([])
    expect(cb.onPermissionRequest).not.toHaveBeenCalled()
  })

  test('ignores binary frames', async () => {
    const { h, cb } = await connected()
    await deliver(
      h,
      cb,
      new TextEncoder().encode(JSON.stringify({ type: 'assistant', bin: 1 })),
    )
    expect(forwarded(cb)).toEqual([])
  })

  test('does not forward control/keep-alive/streamlined/post_turn_summary messages', async () => {
    const { h, cb } = await connected()
    const dropped = [
      { type: 'control_response', response: { subtype: 'success' } },
      { type: 'keep_alive' },
      { type: 'control_cancel_request', request_id: 'r0' },
      { type: 'streamlined_text', text: 't' },
      { type: 'streamlined_tool_use_summary', summary: 's' },
      { type: 'system', subtype: 'post_turn_summary' },
    ]
    const kept = { type: 'system', subtype: 'status' }
    await deliver(
      h,
      cb,
      [...dropped, kept].map(m => JSON.stringify(m)).join('\n'),
    )
    expect(forwarded(cb)).toEqual([kept])
  })

  test('can_use_tool control requests go to onPermissionRequest and are not forwarded', async () => {
    const { h, cb } = await connected()
    const request = {
      subtype: 'can_use_tool' as const,
      tool_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'tu_1',
    }
    await deliver(
      h,
      cb,
      JSON.stringify({ type: 'control_request', request_id: 'req-1', request }),
    )
    expect(cb.onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(cb.onPermissionRequest.mock.calls[0]).toEqual([request, 'req-1'])
    expect(forwarded(cb)).toEqual([])
    expect(h.received).toEqual([])
  })

  test('unsupported control request subtypes get an error control_response', async () => {
    const { h, cb } = await connected()
    await deliver(
      h,
      cb,
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-9',
        request: { subtype: 'set_model', model: 'x' },
      }),
    )
    await waitFor(() => h.received.length === 1, 'error response')
    expect(h.received[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-9',
        error: 'Unsupported control request subtype: set_model',
      },
    })
    expect(cb.onPermissionRequest).not.toHaveBeenCalled()
    expect(forwarded(cb)).toEqual([])
  })
})

describe('senders', () => {
  test('sendMessage writes an SDKUserMessage and returns true', async () => {
    const { h, manager } = await connected()
    expect(manager.sendMessage('hello')).toBe(true)
    const blocks = [{ type: 'text', text: 'hi' }]
    expect(manager.sendMessage(blocks)).toBe(true)
    await waitFor(() => h.received.length === 2, 'user messages')
    expect(h.received).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
        session_id: '',
      },
      {
        type: 'user',
        message: { role: 'user', content: blocks },
        parent_tool_use_id: null,
        session_id: '',
      },
    ])
  })

  test('respondToPermissionRequest writes allow with updatedInput', async () => {
    const { h, manager } = await connected()
    manager.respondToPermissionRequest('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    })
    await waitFor(() => h.received.length === 1, 'allow')
    expect(h.received[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      },
    })
  })

  test('respondToPermissionRequest writes deny with message', async () => {
    const { h, manager } = await connected()
    manager.respondToPermissionRequest('req-2', {
      behavior: 'deny',
      message: 'nope',
    })
    await waitFor(() => h.received.length === 1, 'deny')
    expect(h.received[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-2',
        response: { behavior: 'deny', message: 'nope' },
      },
    })
  })

  test('sendInterrupt writes an interrupt control_request with a fresh UUID', async () => {
    const { h, manager } = await connected()
    manager.sendInterrupt()
    manager.sendInterrupt()
    await waitFor(() => h.received.length === 2, 'interrupts')
    const [a, b] = h.received as Array<{
      type: string
      request_id: string
      request: unknown
    }>
    for (const msg of [a!, b!]) {
      expect(msg.type).toBe('control_request')
      expect(msg.request).toEqual({ subtype: 'interrupt' })
      expect(msg.request_id).toMatch(UUID_RE)
      expect(Object.keys(msg).sort()).toEqual(['request', 'request_id', 'type'])
    }
    expect(a!.request_id).not.toBe(b!.request_id)
  })

  test('every sender is a no-op before connect', () => {
    const h = startServer()
    const manager = makeManager(h.wsUrl, makeCallbacks())
    expect(manager.sendMessage('x')).toBe(false)
    manager.respondToPermissionRequest('r', { behavior: 'deny', message: 'm' })
    manager.sendInterrupt()
    expect(h.authHeaders).toEqual([])
  })

  test('every sender is a no-op while the socket is still connecting', async () => {
    const h = startServer()
    const cb = makeCallbacks()
    const manager = makeManager(h.wsUrl, cb)
    manager.connect()
    expect(manager.sendMessage('x')).toBe(false)
    manager.respondToPermissionRequest('r', { behavior: 'deny', message: 'm' })
    manager.sendInterrupt()
    await waitFor(() => cb.onConnected.mock.calls.length === 1, 'open')
    expect(h.received).toEqual([])
  })

  test('every sender is a no-op after the server closes the socket', async () => {
    const { h, cb, manager } = await connected()
    h.peer().close(1000, 'done')
    await waitFor(() => cb.onDisconnected.mock.calls.length === 1, 'close')
    expect(manager.isConnected()).toBe(false)
    expect(manager.sendMessage('x')).toBe(false)
    manager.respondToPermissionRequest('r', { behavior: 'deny', message: 'm' })
    manager.sendInterrupt()
    expect(h.received).toEqual([])
  })
})

describe('close, error and disconnect', () => {
  test('server close fires onDisconnected without onError', async () => {
    const { h, cb } = await connected()
    h.peer().close(4000, 'gone')
    await waitFor(() => cb.onDisconnected.mock.calls.length === 1, 'close')
    expect(cb.onError).not.toHaveBeenCalled()
  })

  test('a refused upgrade fires onError with a generic error, then onDisconnected', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('forbidden', { status: 403 }),
    })
    servers.push(server)
    const cb = makeCallbacks()
    const manager = makeManager(`ws://127.0.0.1:${server.port}/ws`, cb, 't')
    manager.connect()
    await waitFor(() => cb.onDisconnected.mock.calls.length === 1, 'close')
    expect(cb.onConnected).not.toHaveBeenCalled()
    expect(cb.onError).toHaveBeenCalledTimes(1)
    const err = cb.onError.mock.calls[0]![0]
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('WebSocket connection error')
    expect(manager.isConnected()).toBe(false)
  })

  test('disconnect closes the socket, fires onDisconnected and is idempotent', async () => {
    const { h, cb, manager } = await connected()
    manager.disconnect()
    expect(manager.isConnected()).toBe(false)
    expect(manager.sendMessage('x')).toBe(false)
    await waitFor(() => h.serverClosed(), 'server close')
    await waitFor(() => cb.onDisconnected.mock.calls.length === 1, 'close')
    manager.disconnect()
    expect(cb.onDisconnected).toHaveBeenCalledTimes(1)
    expect(cb.onError).not.toHaveBeenCalled()
  })

  test('disconnect before connect is a no-op', () => {
    const h = startServer()
    const cb = makeCallbacks()
    const manager = makeManager(h.wsUrl, cb)
    manager.disconnect()
    expect(cb.onDisconnected).not.toHaveBeenCalled()
  })
})

describe('through the shared opener', () => {
  test('the socket goes through HTTPS_PROXY (it used to ignore it)', async () => {
    const { createServer, connect } = await import('node:net')
    const connects: string[] = []
    const sockets: Array<{ destroy(): void }> = []
    const proxy = createServer(client => {
      sockets.push(client)
      client.once('data', chunk => {
        const target = chunk.toString('latin1').match(/^CONNECT ([^ ]+) HTTP/)?.[1]
        if (!target) return void client.destroy()
        connects.push(target)
        const [host, port] = target.split(':')
        const upstream = connect(Number(port), host, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(client)
          client.pipe(upstream)
        })
        sockets.push(upstream)
      })
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const saved = { https: process.env.HTTPS_PROXY, lower: process.env.https_proxy, no: process.env.NO_PROXY, lowerNo: process.env.no_proxy }
    delete process.env.https_proxy
    delete process.env.NO_PROXY
    delete process.env.no_proxy
    process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
    try {
      const h = startServer()
      const cb = makeCallbacks()
      makeManager(h.wsUrl, cb, 'tok').connect()
      await waitFor(() => cb.onConnected.mock.calls.length === 1, 'connected through the proxy', 3000)
      expect(connects).toEqual([new URL(h.wsUrl).host])
      expect(h.authHeaders).toEqual(['Bearer tok'])
    } finally {
      for (const [key, value] of [['HTTPS_PROXY', saved.https], ['https_proxy', saved.lower], ['NO_PROXY', saved.no], ['no_proxy', saved.lowerNo]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const m of managers.splice(0)) m.disconnect()
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    }
  })
})
