import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import {
  createResponsesSocketTransport,
  type ResponsesSocketLimits,
  type ResponsesSocketRequest,
  type TransportDeps,
} from 'src/providers/transport/responsesSocket/transport.js'

// A Responses-over-WebSocket server that behaves like the backend where it
// matters: one response at a time per connection, and only the last response
// remembered, per connection (store: false).
type Conn = { id: number; last?: string; forget?: boolean }
type Frame = Record<string, unknown> & { conn: number }
type Script = (frame: Frame, ws: ServerWebSocket<Conn>) => boolean | void

let server: Server<Conn>
let frames: Frame[]
let opened: number
let closed: number[]
let script: Script | undefined
let responseCount: number

function events(id: string, outputId: string): object[] {
  const item = { type: 'message', id: outputId, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
  return [
    { type: 'response.created', response: { id } },
    { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 1 } } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 10 } } },
  ]
}

beforeEach(() => {
  frames = []
  opened = 0
  closed = []
  script = undefined
  responseCount = 0
  server = Bun.serve<Conn>({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/refuse') return new Response('no', { status: 403 })
      if (srv.upgrade(req, { data: { id: ++opened } })) return
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      message(ws, message) {
        const frame: Frame = { ...(JSON.parse(String(message)) as Record<string, unknown>), conn: ws.data.id }
        frames.push(frame)
        if (script?.(frame, ws)) return
        const prev = frame.previous_response_id
        if (prev && (ws.data.forget || prev !== ws.data.last)) {
          ws.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'previous_response_not_found', message: 'gone' } }))
          ws.data.forget = false
          return
        }
        const n = ++responseCount
        ws.data.last = `resp_${n}`
        for (const event of events(`resp_${n}`, `msg_${n}`)) ws.send(JSON.stringify(event))
      },
      close(ws) {
        closed.push(ws.data.id)
      },
    },
  })
})

afterEach(() => {
  server.stop(true)
})

const lifecycle = () => {
  const hooks: { switch?: () => void; cleanup?: () => Promise<void> } = {}
  return {
    hooks,
    deps: {
      lifecycle: {
        onSessionSwitch: (cb: () => void) => (hooks.switch = cb),
        registerCleanup: (cb: () => Promise<void>) => (hooks.cleanup = cb),
      },
    } satisfies TransportDeps,
  }
}

function make(limits: Partial<ResponsesSocketLimits> = {}, deps: TransportDeps = lifecycle().deps) {
  return createResponsesSocketTransport(limits, deps)
}

const settings = { model: 'gpt-5.6-terra', stream: true, store: false, instructions: 'x' }
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const reply = (n: number) => ({ type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] })

type HttpSpy = { calls: number; status: number; fn: () => Promise<Response> }
function httpSpy(status = 200): HttpSpy {
  const spy: HttpSpy = {
    calls: 0,
    status,
    fn: async () => {
      spy.calls += 1
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { status: spy.status })
    },
  }
  return spy
}

function req(body: Record<string, unknown>, http: HttpSpy, extra: Partial<ResponsesSocketRequest> = {}): ResponsesSocketRequest {
  return {
    url: `http://127.0.0.1:${server.port}/backend-api/codex/responses`,
    socketUrl: `ws://127.0.0.1:${server.port}/backend-api/codex/responses`,
    headers: { Authorization: 'Bearer a' },
    body,
    http: http.fn,
    ...extra,
  }
}

async function sse(response: Response): Promise<string[]> {
  const text = await response.text()
  return text.split('\n\n').filter(Boolean).map(chunk => chunk.split('\n')[0]!.slice('event: '.length))
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}

describe('one conversation on one socket', () => {
  test('the first request goes out whole; the answer is the SSE a POST would stream', async () => {
    const transport = make()
    const http = httpSpy()
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, http))
    expect(response.status).toBe(200)
    expect(response.url).toContain('/backend-api/codex/responses')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await sse(response)).toEqual(['response.created', 'codex.rate_limits', 'response.output_item.done', 'response.completed'])
    expect(frames[0]).toMatchObject({ type: 'response.create', stream: true, input: [user('hi')] })
    expect(frames[0]!.previous_response_id).toBeUndefined()
    expect(http.calls).toBe(0)
    transport.closeAll()
  })

  test('the next request that extends it is a delta on the same socket', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http))).text()
    expect(opened).toBe(1)
    expect(frames[1]).toMatchObject({ previous_response_id: 'resp_1', input: [user('more')] })
    transport.closeAll()
  })

  test('a rewritten history goes out whole, on a new socket, leaving the chained one alone', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    await (await transport.request(req({ ...settings, input: [user('[stub]'), reply(1), user('more')] }, http))).text()
    expect(frames[1]!.previous_response_id).toBeUndefined()
    expect(frames[1]!.conn).toBe(2)
    transport.closeAll()
  })

  test('two requests in flight at once get two sockets', async () => {
    const transport = make()
    const http = httpSpy()
    const [a, b] = await Promise.all([
      transport.request(req({ ...settings, input: [user('a')] }, http)),
      transport.request(req({ ...settings, input: [user('b')] }, http)),
    ])
    await Promise.all([a.text(), b.text()])
    expect(new Set(frames.map(f => f.conn)).size).toBe(2)
    transport.closeAll()
  })

  test('another Authorization gets its own socket', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http, { headers: { Authorization: 'Bearer b' } }))).text()
    expect(opened).toBe(2)
    expect(frames[1]!.previous_response_id).toBeUndefined()
    transport.closeAll()
  })
})

describe('recoveries the server asks for', () => {
  test('previous_response_not_found is retried once, whole, on the same socket', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    script = (_frame, ws) => {
      ws.data.forget = true
      script = undefined
    }
    // the script only flags the connection; the default handler answers the error
    const events = await sse(await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http)))
    expect(events.at(-1)).toBe('response.completed')
    expect(frames.slice(1).map(f => [f.conn, Boolean(f.previous_response_id)])).toEqual([[1, true], [1, false]])
    expect(http.calls).toBe(0)
    transport.closeAll()
  })

  test('websocket_connection_limit_reached is retried once, whole, on a new socket', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    script = (_frame, ws) => {
      script = undefined
      ws.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'websocket_connection_limit_reached' } }))
      return true
    }
    expect((await sse(await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http)))).at(-1)).toBe('response.completed')
    expect(frames.slice(1).map(f => f.conn)).toEqual([1, 2])
    await until(() => closed.includes(1))
    transport.closeAll()
  })

  test('an error frame that says its status comes back as that HTTP status, like the POST', async () => {
    const transport = make()
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    script = (_frame, ws) => {
      script = undefined
      ws.send(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 60 } }))
      return true
    }
    const response = await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http))
    expect(response.status).toBe(429)
    expect(response.url).toContain('/backend-api/codex/responses')
    expect(await response.json()).toEqual({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 60 } })
    expect(http.calls).toBe(0)
    // the socket stays usable, without its chain
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http))).text()
    expect(frames.at(-1)).toMatchObject({ conn: 1 })
    expect(frames.at(-1)!.previous_response_id).toBeUndefined()
    transport.closeAll()
  })

  test('an error frame with its fields at the top level keeps them as the body', async () => {
    const transport = make()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'error', status: 400, code: 'invalid_encrypted_content', message: 'bad' }))
      return true
    }
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_encrypted_content', message: 'bad' } })
    transport.closeAll()
  })

  test('any other error event reaches the reader, ends the response, and drops the chain', async () => {
    const transport = make()
    const http = httpSpy()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'error', error: { code: 'invalid_encrypted_content', message: 'bad' } }))
      return true
    }
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, http))
    const text = await response.text()
    expect(text).toContain('event: error')
    expect(text).toContain('invalid_encrypted_content')
    script = undefined
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('x')] }, http))).text()
    expect(frames[1]!.previous_response_id).toBeUndefined()
    expect(frames[1]!.conn).toBe(1)
    transport.closeAll()
  })
})

describe('abort, cancel and lost sockets', () => {
  test('an abort mid-response closes the socket and errors the body; the next request reconnects', async () => {
    const transport = make()
    const http = httpSpy()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_x' } }))
      return true // never completes
    }
    const controller = new AbortController()
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, http, { signal: controller.signal }))
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toBeDefined()
    await until(() => closed.includes(1))
    script = undefined
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    expect(frames.at(-1)!.conn).toBe(2)
    transport.closeAll()
  })

  test('an abort before the first event rejects the request', async () => {
    const transport = make()
    const http = httpSpy()
    script = () => true // silence
    const controller = new AbortController()
    const pending = transport.request(req({ ...settings, input: [user('hi')] }, http, { signal: controller.signal }))
    await until(() => frames.length === 1)
    controller.abort(new Error('user pressed esc'))
    await expect(pending).rejects.toThrow('user pressed esc')
    await until(() => closed.includes(1))
    transport.closeAll()
  })

  test('an already-aborted signal rejects without sending', async () => {
    const transport = make()
    const controller = new AbortController()
    controller.abort(new Error('early'))
    await expect(transport.request(req({ ...settings, input: [user('hi')] }, httpSpy(), { signal: controller.signal }))).rejects.toThrow('early')
    await Bun.sleep(30)
    expect(frames).toHaveLength(0)
    transport.closeAll()
  })

  test('cancel after the response completed keeps the socket and its chain', async () => {
    const transport = make()
    const http = httpSpy()
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, http))
    await response.text()
    await response.body?.cancel().catch(() => {})
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http))).text()
    expect(frames[1]).toMatchObject({ conn: 1, previous_response_id: 'resp_1' })
    transport.closeAll()
  })

  test('cancel mid-response closes the socket', async () => {
    const transport = make()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r' } }))
      return true
    }
    const response = await transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))
    await response.body!.cancel()
    await until(() => closed.includes(1))
    transport.closeAll()
  })

  test('a socket lost mid-response errors the body; two in a row turn WebSocket off', async () => {
    const transport = make()
    const http = httpSpy()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r' } }))
      ws.close(1011, 'boom')
      return true
    }
    await expect((await transport.request(req({ ...settings, input: [user('1')] }, http))).text()).rejects.toThrow('WebSocket closed before the response completed (')
    expect(transport.latched).toBe(false)
    await expect((await transport.request(req({ ...settings, input: [user('2')] }, http))).text()).rejects.toThrow('closed before the response completed')
    expect(transport.latched).toBe(true)
    await transport.request(req({ ...settings, input: [user('3')] }, http))
    expect(http.calls).toBe(1)
    expect(frames).toHaveLength(2)
  })

  test('a completed response between two lost ones keeps WebSocket on', async () => {
    const transport = make()
    const http = httpSpy()
    const drop: Script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r' } }))
      ws.close(1011)
      return true
    }
    script = drop
    await (await transport.request(req({ ...settings, input: [user('1')] }, http))).text().catch(() => {})
    script = undefined
    await (await transport.request(req({ ...settings, input: [user('2')] }, http))).text()
    script = drop
    await (await transport.request(req({ ...settings, input: [user('3')] }, http))).text().catch(() => {})
    expect(transport.latched).toBe(false)
    transport.closeAll()
  })

  test('a socket that closes before answering is retried once on a new socket', async () => {
    const transport = make()
    const http = httpSpy()
    let first = true
    script = (_frame, ws) => {
      if (!first) return false
      first = false
      ws.close(1011)
      return true
    }
    expect((await sse(await transport.request(req({ ...settings, input: [user('hi')] }, http)))).at(-1)).toBe('response.completed')
    expect(frames.map(f => f.conn)).toEqual([1, 2])
    transport.closeAll()
  })

  test('two closes before answering surface as an error', async () => {
    const transport = make()
    script = (_frame, ws) => {
      ws.close(1011)
      return true
    }
    await expect(transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))).rejects.toThrow('closed before the response started')
    transport.closeAll()
  })
})

describe('falling back to HTTP', () => {
  const refusing = (http: HttpSpy, extra: Partial<ResponsesSocketRequest> = {}) =>
    req({ ...settings, input: [user('hi')] }, http, { socketUrl: `ws://127.0.0.1:${server.port}/refuse`, ...extra })

  test('a refused upgrade whose POST answers 2xx turns WebSocket off for the process', async () => {
    const transport = make()
    const http = httpSpy(200)
    expect((await transport.request(refusing(http))).status).toBe(200)
    expect(http.calls).toBe(1)
    expect(transport.latched).toBe(true)
    await transport.request(req({ ...settings, input: [user('again')] }, http))
    expect(http.calls).toBe(2)
    expect(frames).toHaveLength(0)
  })

  test('a refused upgrade whose POST answers 401 leaves WebSocket on', async () => {
    const transport = make()
    const http = httpSpy(401)
    expect((await transport.request(refusing(http))).status).toBe(401)
    expect(transport.latched).toBe(false)
    http.status = 200
    await (await transport.request(req({ ...settings, input: [user('again')] }, http))).text()
    expect(frames).toHaveLength(1)
    transport.closeAll()
  })

  test('a frame over the size limit goes over HTTP', async () => {
    const transport = make({ maxFrameBytes: 100 })
    const http = httpSpy()
    await transport.request(req({ ...settings, input: [user('x'.repeat(200))] }, http))
    expect(http.calls).toBe(1)
    expect(frames).toHaveLength(0)
    expect(transport.latched).toBe(false)
    transport.closeAll()
  })

  test('every socket busy at the cap sends the request over HTTP', async () => {
    const transport = make({ maxSockets: 1 })
    const http = httpSpy()
    script = (_frame, ws) => {
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r' } }))
      return true
    }
    const busy = await transport.request(req({ ...settings, input: [user('a')] }, http))
    await transport.request(req({ ...settings, input: [user('b')] }, http))
    expect(http.calls).toBe(1)
    await busy.body?.cancel()
    transport.closeAll()
  })
})

describe('socket lifetime', () => {
  test('an idle socket closes after the idle limit', async () => {
    const transport = make({ idleMs: 30 })
    await (await transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))).text()
    await until(() => closed.includes(1))
    transport.closeAll()
  })

  test('a socket past the age limit is replaced', async () => {
    let now = 1_000
    const transport = make({ maxAgeMs: 100 }, { ...lifecycle().deps, now: () => now })
    const http = httpSpy()
    await (await transport.request(req({ ...settings, input: [user('hi')] }, http))).text()
    now += 200
    await (await transport.request(req({ ...settings, input: [user('hi'), reply(1), user('more')] }, http))).text()
    expect(frames.map(f => f.conn)).toEqual([1, 2])
    expect(frames[1]!.previous_response_id).toBeUndefined()
    await until(() => closed.includes(1))
    transport.closeAll()
  })

  test('a session switch and process cleanup close every socket', async () => {
    const { hooks, deps } = lifecycle()
    const transport = make({}, deps)
    await (await transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))).text()
    hooks.switch?.()
    await until(() => closed.includes(1))
    await (await transport.request(req({ ...settings, input: [user('hi')] }, httpSpy()))).text()
    await hooks.cleanup?.()
    await until(() => closed.includes(2))
  })
})
