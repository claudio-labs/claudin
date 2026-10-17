import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, connect, type Server as NetServer, type Socket } from 'node:net'
import type { Server } from 'bun'
import {
  openWebSocket,
  WS_CLOSED,
  WS_CONNECTING,
  WS_OPEN,
  type WebSocketHandle,
  type WebSocketHandlers,
  type WebSocketOpenerDeps,
} from 'src/providers/transport/webSocket.js'

// Under bun test the name `ws` is Bun's shim: it drives the Node branch's
// wiring (open, message, close, send callback) but never emits `upgrade` or
// `unexpected-response`. webSocket.node.test.ts covers those under node.
const RUNTIMES: Array<[string, WebSocketOpenerDeps]> = [
  ['bun', { runtime: 'bun' }],
  ['node', { runtime: 'node', loadWs: async () => (await import('ws')).default }],
]

type Seen = { headers: Record<string, string>; protocol: string | null; frames: Array<string | Uint8Array> }

let server: Server<undefined>
let seen: Seen[]
let handles: WebSocketHandle[]

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    register(value => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

beforeEach(() => {
  seen = []
  handles = []
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const path = new URL(req.url).pathname
      if (path === '/refuse') return new Response('go away', { status: 403 })
      const entry: Seen = {
        headers: Object.fromEntries(req.headers),
        protocol: req.headers.get('sec-websocket-protocol'),
        frames: [],
      }
      seen.push(entry)
      const protocol = entry.protocol?.split(',')[0]?.trim()
      const upgraded = protocol
        ? srv.upgrade(req, { data: undefined, headers: { 'Sec-WebSocket-Protocol': protocol } })
        : srv.upgrade(req, { data: undefined })
      if (upgraded) return
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      message(ws, message) {
        seen.at(-1)?.frames.push(typeof message === 'string' ? message : new Uint8Array(message))
        if (message === 'echo') ws.send('echo:ok')
        if (message === 'bytes') ws.send(new Uint8Array([1, 2, 3]))
        if (message === 'bye') ws.close(4001, 'bye now')
      },
    },
  })
})

afterEach(() => {
  for (const h of handles) h.close()
  server.stop(true)
})

function open(path: string, deps: WebSocketOpenerDeps, handlers: WebSocketHandlers, extra: { headers?: Record<string, string>; protocols?: string[] } = {}): WebSocketHandle {
  const h = openWebSocket(`ws://127.0.0.1:${server.port}${path}`, { ...extra, handlers }, deps)
  handles.push(h)
  return h
}

describe.each(RUNTIMES)('openWebSocket (%s branch)', (_name, deps) => {
  test('sends the headers and subprotocol, opens, and round-trips a text frame', async () => {
    let onMessage: (data: string) => void = () => {}
    const reply = waitFor<string>(resolve => (onMessage = resolve))
    const opened = waitFor<void>(resolve => {
      open('/', deps, { onOpen: () => resolve(), onMessage: data => onMessage(data) }, {
        headers: { authorization: 'Bearer t0k', 'x-extra': 'yes' },
        protocols: ['mcp'],
      })
    })
    const handle = handles[0]!
    expect(handle.readyState).toBe(WS_CONNECTING)
    await opened
    expect(handle.readyState).toBe(WS_OPEN)
    await handle.send('echo')
    expect(await reply).toBe('echo:ok')
    expect(seen[0]!.headers.authorization).toBe('Bearer t0k')
    expect(seen[0]!.headers['x-extra']).toBe('yes')
    expect(seen[0]!.protocol).toBe('mcp')
    expect(handle.url).toBe(`ws://127.0.0.1:${server.port}/`)
  })

  test('onBinary takes every frame as bytes, text frames included', async () => {
    const got: Uint8Array[] = []
    const two = waitFor<void>(resolve => {
      open('/', deps, {
        onOpen: () => {
          void handles[0]!.send('echo')
          void handles[0]!.send('bytes')
        },
        onBinary: data => {
          got.push(data)
          if (got.length === 2) resolve()
        },
        onMessage: () => {
          throw new Error('onMessage must not run when onBinary is set')
        },
      })
    })
    await two
    expect(new TextDecoder().decode(got[0])).toBe('echo:ok')
    expect([...got[1]!]).toEqual([1, 2, 3])
  })

  test('a binary frame reaches onMessage as text when there is no onBinary', async () => {
    const text = waitFor<string>(resolve => {
      open('/', deps, { onOpen: () => void handles[0]!.send('bytes'), onMessage: resolve })
    })
    expect(await text).toBe('\u0001\u0002\u0003')
  })

  test('sends bytes', async () => {
    await waitFor<void>(resolve => {
      open('/', deps, { onOpen: () => resolve() })
    })
    await handles[0]!.send(new Uint8Array([9, 8]))
    await waitFor<void>(resolve => {
      const poll = setInterval(() => {
        if (seen[0]!.frames.length > 0) {
          clearInterval(poll)
          resolve()
        }
      }, 5)
    })
    expect([...(seen[0]!.frames[0] as Uint8Array)]).toEqual([9, 8])
  })

  test('reports the close code and reason the server sent', async () => {
    const closed = waitFor<[number, string]>(resolve => {
      open('/', deps, { onOpen: () => void handles[0]!.send('bye'), onClose: (code, reason) => resolve([code, reason]) })
    })
    expect(await closed).toEqual([4001, 'bye now'])
    expect(handles[0]!.readyState).toBe(WS_CLOSED)
  })

  test('ping gets a pong', async () => {
    const pong = waitFor<void>(resolve => {
      open('/', deps, { onOpen: () => handles[0]!.ping(), onPong: () => resolve() })
    })
    await pong
  })

  test('listen replaces the handlers, and detach drops every later event', async () => {
    const first: string[] = []
    const second: string[] = []
    await waitFor<void>(resolve => {
      open('/', deps, { onOpen: () => resolve(), onMessage: d => first.push(d) })
    })
    const handle = handles[0]!
    const reply = waitFor<void>(resolve => handle.listen({ onMessage: d => {
      second.push(d)
      resolve()
    } }))
    await handle.send('echo')
    await reply
    expect(first).toEqual([])
    expect(second).toEqual(['echo:ok'])

    handle.detach()
    let closeSeen = false
    handle.listen({ onClose: () => (closeSeen = true) })
    await handle.send('echo')
    await Bun.sleep(50)
    expect(second).toEqual(['echo:ok'])
    handle.close()
    await Bun.sleep(50)
    // listen after detach still sets handlers, but the runtime listeners are gone
    expect(closeSeen).toBe(false)
  })

  test('a refused upgrade arrives as an error and a close', async () => {
    const events: string[] = []
    const closed = waitFor<void>(resolve => {
      open('/refuse', deps, {
        onOpen: () => events.push('open'),
        onError: () => events.push('error'),
        onRefused: status => events.push(`refused:${status}`),
        onClose: () => {
          events.push('close')
          resolve()
        },
      })
    })
    await closed
    expect(events).not.toContain('open')
    expect(events.at(-1)).toBe('close')
    // Neither Bun nor its ws shim reports the status; the node test does.
    expect(events.some(e => e === 'error' || e.startsWith('refused:'))).toBe(true)
  })
})

describe('detach removes every listener the opener attached', () => {
  test('bun branch', async () => {
    const Real = globalThis.WebSocket
    const added: string[] = []
    const removed: string[] = []
    class Recording extends Real {
      override addEventListener(type: string, ...rest: unknown[]): void {
        added.push(type)
        ;(super.addEventListener as (...a: unknown[]) => void)(type, ...rest)
      }
      override removeEventListener(type: string, ...rest: unknown[]): void {
        removed.push(type)
        ;(super.removeEventListener as (...a: unknown[]) => void)(type, ...rest)
      }
    }
    globalThis.WebSocket = Recording as typeof WebSocket
    try {
      await waitFor<void>(resolve => {
        open('/', { runtime: 'bun' }, { onOpen: () => resolve() })
      })
      handles[0]!.detach()
      expect(added.length).toBeGreaterThanOrEqual(5)
      expect(removed.sort()).toEqual(added.sort())
    } finally {
      globalThis.WebSocket = Real
    }
  })

  test('node branch', async () => {
    const { default: Shim } = await import('ws')
    let instance: InstanceType<typeof Shim> | undefined
    class Recording extends Shim {
      constructor(...args: ConstructorParameters<typeof Shim>) {
        super(...args)
        instance = this
      }
    }
    const events = ['open', 'upgrade', 'message', 'error', 'close', 'pong', 'unexpected-response']
    await waitFor<void>(resolve => {
      open('/', { runtime: 'node', loadWs: async () => Recording as unknown as typeof Shim }, { onOpen: () => resolve() })
    })
    expect(events.map(e => instance!.listenerCount(e)).every(n => n >= 1)).toBe(true)
    handles[0]!.detach()
    expect(events.map(e => instance!.listenerCount(e))).toEqual(events.map(() => 0))
  })
})

describe('openWebSocket (node branch, before ws has loaded)', () => {
  test('close before the socket exists reports closed and never connects', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const deps: WebSocketOpenerDeps = {
      runtime: 'node',
      loadWs: async () => {
        await gate
        return (await import('ws')).default
      },
    }
    const closed = waitFor<[number, string]>(resolve => {
      open('/', deps, { onOpen: () => { throw new Error('must not open') }, onClose: (c, r) => resolve([c, r]) })
    })
    const handle = handles[0]!
    expect(handle.readyState).toBe(WS_CONNECTING)
    expect(() => handle.send('x')).toThrow('not open')
    handle.ping()
    handle.close(1000, 'done')
    expect(handle.readyState).toBe(WS_CLOSED)
    release()
    expect(await closed).toEqual([1000, 'done'])
    expect(seen).toHaveLength(0)
  })

  test('detach before the socket exists never connects', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const deps: WebSocketOpenerDeps = { runtime: 'node', loadWs: async () => { await gate; return (await import('ws')).default } }
    const events: string[] = []
    open('/', deps, { onOpen: () => events.push('open'), onClose: () => events.push('close') })
    handles[0]!.detach()
    release()
    await Bun.sleep(50)
    expect(events).toEqual([])
    expect(seen).toHaveLength(0)
  })

  test('a failed load reports an error and a 1006 close', async () => {
    const events: string[] = []
    const closed = waitFor<void>(resolve => {
      open('/', { runtime: 'node', loadWs: () => Promise.reject(new Error('no ws here')) }, {
        onError: e => events.push(`error:${e.message}`),
        onClose: code => {
          events.push(`close:${code}`)
          resolve()
        },
      })
    })
    await closed
    expect(events).toEqual(['error:no ws here', 'close:1006'])
  })
})

describe('openWebSocket honors HTTPS_PROXY', () => {
  let proxy: NetServer
  let connects: string[]
  let sockets: Socket[]
  const saved = { https: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY, lowerNoProxy: process.env.no_proxy, lowerHttps: process.env.https_proxy }

  beforeEach(async () => {
    connects = []
    sockets = []
    proxy = createServer((client: Socket) => {
      sockets.push(client)
      client.once('data', chunk => {
        const head = chunk.toString('latin1')
        const target = head.match(/^CONNECT ([^ ]+) HTTP/)?.[1]
        if (!target) return void client.destroy()
        connects.push(target)
        const [host, port] = target.split(':')
        const upstream = connect(Number(port), host, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(client)
          client.pipe(upstream)
        })
        sockets.push(upstream)
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      })
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address() as { port: number }
    delete process.env.https_proxy
    delete process.env.no_proxy
    delete process.env.NO_PROXY
    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    for (const [key, value] of [['HTTPS_PROXY', saved.https], ['NO_PROXY', saved.noProxy], ['no_proxy', saved.lowerNoProxy], ['https_proxy', saved.lowerHttps]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const s of sockets) s.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
  })

  test('the bun branch tunnels the upgrade through the proxy', async () => {
    await waitFor<void>(resolve => {
      open('/', { runtime: 'bun' }, { onOpen: () => resolve() })
    }, 4000)
    expect(connects).toEqual([`127.0.0.1:${server.port}`])
  })
})
