import { afterEach, describe, expect, test } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Server, ServerWebSocket } from 'bun'

import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'

/*
 * Characterization of the MCP WebSocket transport as it runs under Bun, against
 * a real local server. These pin today's behaviour before the socket
 * construction moves behind the shared opener; the Node (`ws` package) branch
 * does not run under `bun test` and is not covered here.
 */

type ServerHandle = {
  url: string
  received: string[]
  sockets: ServerWebSocket<unknown>[]
  connected: Promise<ServerWebSocket<unknown>>
  closedByClient: Promise<number>
}

const servers: Server<unknown>[] = []
const clients: WebSocket[] = []

function startServer(options: { refuse?: boolean } = {}): ServerHandle {
  const received: string[] = []
  const sockets: ServerWebSocket<unknown>[] = []
  let resolveConnected!: (ws: ServerWebSocket<unknown>) => void
  let resolveClosed!: (code: number) => void
  const connected = new Promise<ServerWebSocket<unknown>>(r => {
    resolveConnected = r
  })
  const closedByClient = new Promise<number>(r => {
    resolveClosed = r
  })
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      if (options.refuse) return new Response('nope', { status: 403 })
      if (server.upgrade(req)) return undefined
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
        resolveConnected(ws)
      },
      message(_ws, message) {
        received.push(String(message))
      },
      close(_ws, code) {
        resolveClosed(code)
      },
    },
  })
  servers.push(srv)
  return {
    url: `ws://127.0.0.1:${srv.port}`,
    received,
    sockets,
    connected,
    closedByClient,
  }
}

/** A real WebSocket that records listener churn, so the cleanup is observable. */
class RecordingWebSocket extends WebSocket {
  listenerLog: string[] = []
  sendError: Error | undefined
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.listenerLog.push(`+${type}`)
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.listenerLog.push(`-${type}`)
    super.removeEventListener(type, listener, options)
  }
  override send(data: Parameters<WebSocket['send']>[0]): void {
    if (this.sendError) throw this.sendError
    super.send(data)
  }
}

function connect(url: string): RecordingWebSocket {
  const ws = new RecordingWebSocket(url)
  clients.push(ws)
  return ws
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', e => reject(e), { once: true })
  })
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolve => {
    ws.addEventListener('close', () => resolve(), { once: true })
  })
}

function nextMessage(transport: WebSocketTransport): Promise<JSONRPCMessage> {
  return new Promise(resolve => {
    transport.onmessage = resolve
  })
}

function nextError(transport: WebSocketTransport): Promise<Error> {
  return new Promise(resolve => {
    transport.onerror = resolve
  })
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await Bun.sleep(5)
  }
  expect(predicate()).toBe(true)
}

afterEach(async () => {
  for (const ws of clients.splice(0)) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
  for (const srv of servers.splice(0)) {
    srv.stop(true)
  }
})

describe('WebSocketTransport (Bun) — opening', () => {
  test('start waits for a connecting socket, then drops its one-shot open/error listeners', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)

    // One-shot open/error from the opened promise, then the persistent three.
    expect(ws.listenerLog).toEqual([
      '+open',
      '+error',
      '+message',
      '+error',
      '+close',
    ])

    await transport.start()

    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(ws.listenerLog.slice(5)).toEqual(['-open', '-error'])
  })

  test('an already-open socket needs no one-shot listeners and starts at once', async () => {
    const server = startServer()
    const ws = connect(server.url)
    await waitForOpen(ws)
    ws.listenerLog = []

    const transport = new WebSocketTransport(ws)
    expect(ws.listenerLog).toEqual(['+message', '+error', '+close'])

    await transport.start()
    expect(ws.listenerLog).toEqual(['+message', '+error', '+close'])
  })

  test('a refused handshake rejects start with the error event and reports it through onerror and onclose', async () => {
    const server = startServer({ refuse: true })
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    const errors: Error[] = []
    let closes = 0
    transport.onerror = e => errors.push(e)
    transport.onclose = () => {
      closes++
    }

    const failure = await transport.start().then(
      () => undefined,
      (e: unknown) => e,
    )

    expect(failure).toBeInstanceOf(Event)
    expect((failure as Event).type).toBe('error')
    await waitForClose(ws)
    await until(() => closes === 1)
    expect(errors.map(e => e.message)).toEqual(['WebSocket error'])
    // The one-shot pair went on the error; the close then removed the persistent three.
    expect(ws.listenerLog.slice(5)).toEqual([
      '-open',
      '-error',
      '-message',
      '-error',
      '-close',
    ])
  })

  test('start can only be called once', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    await transport.start()

    await expect(transport.start()).rejects.toThrow(
      'Start can only be called once per transport.',
    )
  })

  test('start throws when the socket is no longer open by the time it runs', async () => {
    const server = startServer()
    const ws = connect(server.url)
    await waitForOpen(ws)
    const transport = new WebSocketTransport(ws)
    // Bun's close() on an open socket finishes synchronously.
    ws.close()
    expect(ws.readyState).toBe(WebSocket.CLOSED)

    await expect(transport.start()).rejects.toThrow(
      'WebSocket is not open. Cannot start transport.',
    )
  })
})

describe('WebSocketTransport (Bun) — messages', () => {
  test('a text frame holding JSON-RPC reaches onmessage parsed', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    await transport.start()
    const peer = await server.connected
    const got = nextMessage(transport)

    peer.send(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }))

    expect(await got).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  test('a binary frame is decoded as UTF-8 text before parsing', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    await transport.start()
    const peer = await server.connected
    const got = nextMessage(transport)

    peer.send(
      new TextEncoder().encode(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ping' }),
      ),
    )

    expect(await got).toEqual({ jsonrpc: '2.0', method: 'notifications/ping' })
  })

  test('frames keep their order', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    const seen: JSONRPCMessage[] = []
    transport.onmessage = m => seen.push(m)
    await transport.start()
    const peer = await server.connected

    for (const id of [1, 2, 3]) {
      peer.send(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
    }

    await until(() => seen.length === 3)
    expect(seen.map(m => ('id' in m ? m.id : undefined))).toEqual([1, 2, 3])
  })

  test('a frame that is not JSON goes to onerror, not onmessage', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    let messages = 0
    transport.onmessage = () => {
      messages++
    }
    await transport.start()
    const peer = await server.connected
    const error = nextError(transport)

    peer.send('not json{')

    expect(await error).toBeInstanceOf(Error)
    expect(messages).toBe(0)
  })

  test('JSON that is not a JSON-RPC message goes to onerror', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    let messages = 0
    transport.onmessage = () => {
      messages++
    }
    await transport.start()
    const peer = await server.connected
    const error = nextError(transport)

    peer.send(JSON.stringify({ hello: 'world' }))

    expect(await error).toBeInstanceOf(Error)
    expect(messages).toBe(0)
  })

  test('without handlers set, incoming frames and errors are dropped without throwing', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    await transport.start()
    const peer = await server.connected

    peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'a' }))
    peer.send('garbage')
    // A round trip proves both frames were processed before the assertion.
    const echoed = new Promise<string>(resolve => {
      ws.addEventListener('message', e => {
        if (String((e as MessageEvent).data) === 'sync') resolve('sync')
      })
    })
    peer.send('sync')

    expect(await echoed).toBe('sync')
  })
})

describe('WebSocketTransport (Bun) — send', () => {
  test('send writes the JSON-encoded message as one text frame', async () => {
    const server = startServer()
    const transport = new WebSocketTransport(connect(server.url))
    await transport.start()
    await server.connected

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

    await until(() => server.received.length === 1)
    expect(JSON.parse(server.received[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
  })

  test('send before the socket opens throws without reporting through onerror', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    const errors: Error[] = []
    transport.onerror = e => errors.push(e)
    expect(ws.readyState).toBe(WebSocket.CONNECTING)

    await expect(
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).rejects.toThrow('WebSocket is not open. Cannot send message.')
    expect(errors).toEqual([])
  })

  test('a send the socket throws on is reported through onerror and rethrown', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    await transport.start()
    const errors: Error[] = []
    transport.onerror = e => errors.push(e)
    const boom = new Error('socket send failed')
    ws.sendError = boom

    await expect(
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).rejects.toBe(boom)
    expect(errors).toEqual([boom])
  })
})

describe('WebSocketTransport (Bun) — closing', () => {
  test('close on an open socket fires onclose twice under Bun: once from the synchronous close event, once from the cleanup', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    await transport.start()
    await server.connected
    let closes = 0
    transport.onclose = () => {
      closes++
    }
    ws.listenerLog = []

    await transport.close()

    // Bun's ws.close() dispatches 'close' synchronously, so the persistent
    // listener runs the cleanup first and close() then runs it again.
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    expect(closes).toBe(2)
    expect(ws.listenerLog).toEqual([
      '-message',
      '-error',
      '-close',
      '-message',
      '-error',
      '-close',
    ])
    expect(await server.closedByClient).toBe(1000)
    expect(closes).toBe(2)
  })

  test('close on a connecting socket asks it to close and still runs the cleanup', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    let closes = 0
    transport.onclose = () => {
      closes++
    }
    expect(ws.readyState).toBe(WebSocket.CONNECTING)
    ws.listenerLog = []

    await transport.close()

    // Bun leaves a socket closed while connecting in CLOSING without events.
    expect(ws.readyState).toBe(WebSocket.CLOSING)
    expect(closes).toBe(1)
    expect(ws.listenerLog).toEqual(['-message', '-error', '-close'])
  })

  test('a server-side close fires onclose and removes the listeners; a later close() fires onclose again', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    await transport.start()
    const peer = await server.connected
    let closes = 0
    transport.onclose = () => {
      closes++
    }
    const closed = waitForClose(ws)
    ws.listenerLog = []

    peer.close(1000, 'bye')
    await closed
    await until(() => closes === 1)
    expect(ws.listenerLog).toEqual(['-message', '-error', '-close'])

    // close() does not call ws.close() on a CLOSED socket, but still runs the
    // cleanup, which calls onclose unconditionally.
    await transport.close()
    expect(closes).toBe(2)
  })

  test('send after close throws', async () => {
    const server = startServer()
    const ws = connect(server.url)
    const transport = new WebSocketTransport(ws)
    await transport.start()
    await transport.close()
    await waitForClose(ws)

    await expect(
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).rejects.toThrow('WebSocket is not open. Cannot send message.')
  })
})
