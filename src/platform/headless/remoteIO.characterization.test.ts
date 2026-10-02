/**
 * Pins RemoteIO, the stream-json transport behind the hidden `--sdk-url`
 * flag, before the CCR cut edits remoteIO.ts.
 *
 * Every test talks to a real WebSocket server that it starts on an ephemeral
 * port of 127.0.0.1, and observes what a remote endpoint would see: the
 * upgrade headers, the frames that arrive, and how the session ends.
 *
 * Not pinned: the CLAUDE_CODE_USE_CCR_V2 branch (it goes with ccrClient.ts)
 * and the bridge-topology echo and keep-alive (they go with platform/bridge).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RemoteIO } from 'src/platform/headless/remoteIO.js'
import { getStructuredIO } from 'src/platform/headless/print/structuredIOFactory.js'

const ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
] as const
const envBefore = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

type Endpoint = {
  url: string
  upgrades: Headers[]
  frames: string[]
  closes: number[]
  sockets: ServerWebSocket<unknown>[]
  server: Server<unknown>
}

/** A session endpoint; `greet` is sent to each client as soon as it connects. */
function startEndpoint(greet?: string): Endpoint {
  const endpoint = { upgrades: [], frames: [], closes: [], sockets: [] } as unknown as Endpoint
  endpoint.server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      endpoint.upgrades.push(request.headers)
      if (server.upgrade(request, { data: undefined })) return undefined
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(ws) {
        endpoint.sockets.push(ws)
        if (greet) ws.send(greet)
      },
      message(_ws, data) {
        endpoint.frames.push(String(data))
      },
      close(_ws, code) {
        endpoint.closes.push(code)
      },
    },
  })
  endpoint.url = `ws://127.0.0.1:${endpoint.server.port}/v1/sessions/char-session`
  return endpoint
}

async function until(what: string, check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The smallest user turn the stream-json reader accepts, as one line. */
function userLine(text: string): string {
  const turn = { content: text, role: 'user' }
  return JSON.stringify({ type: 'user', message: turn })
}

/** Reads `count` messages off the input, failing rather than hanging. */
async function take(io: RemoteIO, count: number): Promise<unknown[]> {
  const out: unknown[] = []
  for (let i = 0; i < count; i++) {
    const next = await Promise.race([
      io.structuredInput.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`message ${i + 1} never arrived`)), 4000)),
    ])
    if (next.done) throw new Error(`input ended after ${i} message(s)`)
    out.push(next.value)
  }
  return out
}

async function inputEnds(io: RemoteIO): Promise<boolean> {
  for (;;) {
    const next = await Promise.race([
      io.structuredInput.next(),
      new Promise<'stuck'>(resolve => setTimeout(() => resolve('stuck'), 4000)),
    ])
    if (next === 'stuck') return false
    if (next.done) return true
  }
}

let scratch = ''
const opened: RemoteIO[] = []
const endpoints: Endpoint[] = []

function connect(url: string, prompt?: AsyncIterable<string>): RemoteIO {
  const io = new RemoteIO(url, prompt)
  opened.push(io)
  return io
}

function endpoint(greet?: string): Endpoint {
  const e = startEndpoint(greet)
  endpoints.push(e)
  return e
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'remote-io-char-'))
  for (const key of ENV_KEYS) delete process.env[key]
  // No token file: the well-known path must not be read from the real disk.
  process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE = join(scratch, 'no-token')
})

afterEach(() => {
  for (const io of opened.splice(0)) io.close()
  for (const e of endpoints.splice(0)) e.server.stop(true)
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key]
    else process.env[key] = envBefore[key]
  }
  rmSync(scratch, { recursive: true, force: true })
})

describe('connecting', () => {
  const headerCases = [
    {
      name: 'a session token and a runner version become upgrade headers',
      env: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'tok-123', CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION: '7.1' },
      authorization: 'Bearer tok-123',
      runner: '7.1',
    },
    {
      name: 'without them the upgrade carries neither header',
      env: {},
      authorization: null,
      runner: null,
    },
  ]
  for (const { name, env, authorization, runner } of headerCases) {
    test(name, async () => {
      Object.assign(process.env, env)
      const e = endpoint()
      connect(e.url)
      await until('the upgrade', () => e.upgrades.length === 1)
      const headers = e.upgrades[0]!
      expect({
        authorization: headers.get('authorization'),
        runner: headers.get('x-environment-runner-version'),
      }).toEqual({ authorization, runner })
    })
  }

  test('an URL that is not ws: or wss: is refused', () => {
    for (const url of ['http://127.0.0.1:9/session', 'https://example.invalid/session']) {
      expect(() => new RemoteIO(url)).toThrow(/^Unsupported protocol: https?:$/)
    }
  })

  test('the print factory picks RemoteIO only when an sdk URL is given', async () => {
    const e = endpoint()
    const remote = getStructuredIO('', { sdkUrl: e.url })
    opened.push(remote as RemoteIO)
    const local = getStructuredIO('', { sdkUrl: undefined })
    expect(remote).toBeInstanceOf(RemoteIO)
    expect(local).not.toBeInstanceOf(RemoteIO)
    await until('the upgrade', () => e.upgrades.length === 1)
  })

  test('there is never an internal event queue to flush', async () => {
    const e = endpoint()
    const io = connect(e.url)
    expect(io.internalEventsPending).toBe(0)
    expect(await io.flushInternalEvents()).toBeUndefined()
  })
})

describe('input', () => {
  test('lines from the endpoint arrive in order, split frames joined, keep-alives dropped', async () => {
    const e = endpoint()
    const io = connect(e.url)
    await until('the connection', () => e.sockets.length === 1)
    const line = userLine('from the endpoint')
    const socket = e.sockets[0]!
    socket.send(line.slice(0, 20))
    socket.send(`${line.slice(20)}\n${JSON.stringify({ type: 'keep_alive' })}\n`)
    socket.send(`${userLine('second')}\n`)

    const messages = (await take(io, 2)) as { message: { content: string } }[]
    expect(messages.map(m => m.message.content)).toEqual(['from the endpoint', 'second'])
  })

  test('an initial prompt is fed in first, one line per chunk', async () => {
    const e = endpoint()
    async function* prompt() {
      yield userLine('chunk without a newline')
      yield Buffer.from(`${userLine('chunk with one')}\n`) as unknown as string
    }
    const io = connect(e.url, prompt())
    const messages = (await take(io, 2)) as { message: { content: string } }[]
    expect(messages.map(m => m.message.content)).toEqual(['chunk without a newline', 'chunk with one'])
  })

  test('a string prompt given to the factory becomes one user message', async () => {
    const e = endpoint()
    const io = getStructuredIO('hello over the wire', { sdkUrl: e.url }) as RemoteIO
    opened.push(io)
    const [first] = (await take(io, 1)) as { type: string; message: unknown }[]
    expect(first).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello over the wire' } })
  })
})

describe('output', () => {
  test('write sends one JSON line per message once connected', async () => {
    const e = endpoint(`${userLine('ready')}\n`)
    const io = connect(e.url)
    await take(io, 1)

    await io.write({ type: 'keep_alive' } as never)
    await io.write({ type: 'result', subtype: 'success', is_error: false, result: 'done' } as never)
    await until('two frames', () => e.frames.length >= 2)

    expect(e.frames.map(frame => frame.endsWith('\n'))).toEqual([true, true])
    expect(e.frames.map(frame => JSON.parse(frame))).toEqual([
      { type: 'keep_alive' },
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ])
  })

  test('a message with a uuid written before the socket opens is delivered after', async () => {
    const e = endpoint()
    const io = connect(e.url)
    await io.write({ type: 'user', uuid: 'early-1', message: { role: 'user', content: 'queued' } } as never)
    await until('the replayed frame', () => e.frames.length === 1)
    expect(JSON.parse(e.frames[0]!)).toMatchObject({ uuid: 'early-1', message: { content: 'queued' } })
  })
})

describe('ending the session', () => {
  test('the endpoint closing for good ends the input', async () => {
    const e = endpoint()
    const io = connect(e.url)
    await until('the connection', () => e.sockets.length === 1)
    e.sockets[0]!.close(4001, 'session gone')
    expect(await inputEnds(io)).toBe(true)
    // It does not come back.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(e.upgrades).toHaveLength(1)
  })

  test('close() hangs up and ends the input', async () => {
    const e = endpoint()
    const io = connect(e.url)
    await until('the connection', () => e.sockets.length === 1)
    io.close()
    await until('the hang-up', () => e.closes.length === 1)
    expect(await inputEnds(io)).toBe(true)
  })

  test('a dropped connection comes back with the token as it is now', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'first-token'
    process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION = '1.0'
    const e = endpoint()
    connect(e.url)
    await until('the connection', () => e.sockets.length === 1)

    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'second-token'
    process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION = '2.0'
    e.sockets[0]!.close(4500, 'transient')
    await until('the reconnect', () => e.upgrades.length === 2, 5000)

    expect(
      e.upgrades.map(h => [h.get('authorization'), h.get('x-environment-runner-version')]),
    ).toEqual([
      ['Bearer first-token', '1.0'],
      ['Bearer second-token', '2.0'],
    ])
  })
})
