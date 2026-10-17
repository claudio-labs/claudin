/**
 * Characterization of the CONNECT-over-WebSocket relay, end to end over real
 * local sockets: a `Bun.serve` WebSocket server stands in for the CCR
 * upstreamproxy, the relay listens on an ephemeral port, and a `node:net`
 * client speaks HTTP CONNECT to it. Written before the WebSocket construction
 * moves to the shared opener, so these must keep passing unchanged after it.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { connect, type Socket } from 'node:net'
import type { Server, ServerWebSocket } from 'bun'
import {
  decodeChunk,
  encodeChunk,
  startNodeRelay,
  startUpstreamProxyRelay,
  type UpstreamProxyRelay,
} from 'src/platform/upstreamproxy/relay.ts'

const SESSION_ID = 'sess-123'
const TOKEN = 'tok-abc'
const BASIC = 'Basic ' + Buffer.from(`${SESSION_ID}:${TOKEN}`).toString('base64')
const CONNECT_LINE = 'CONNECT example.com:443 HTTP/1.1'
const CONNECT_REQ = `${CONNECT_LINE}\r\nHost: example.com:443\r\n\r\n`
const TUNNEL_HEAD = `${CONNECT_LINE}\r\nProxy-Authorization: ${BASIC}\r\n\r\n`
const ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n'

// ── harness ──────────────────────────────────────────────────────────────

type UpstreamConn = {
  headers: Headers
  messages: Buffer[]
  closed: boolean
  ws: ServerWebSocket<{ id: number }>
}

type Upstream = {
  url: string
  server: Server<{ id: number }>
  requests: Headers[]
  conns: UpstreamConn[]
  release: () => void
}

type UpstreamOpts = {
  // Hold the upgrade until release() — lets a test write while the relay's
  // WS is still CONNECTING.
  gated?: boolean
  // Answer the upgrade with a plain HTTP status instead of 101.
  refuseWith?: number
  onMessage?: (conn: UpstreamConn, msg: Buffer) => void
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!()
    } catch {
      // best-effort teardown; a resource already closed by the test is fine
    }
  }
})

function startUpstream(opts: UpstreamOpts = {}): Upstream {
  const requests: Headers[] = []
  const conns: UpstreamConn[] = []
  const pendingHeaders = new Map<number, Headers>()
  let nextId = 0
  let release = () => {}
  const gate = opts.gated
    ? new Promise<void>(r => {
        release = r
      })
    : Promise.resolve()

  const server = Bun.serve<{ id: number }, never>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      requests.push(req.headers)
      if (opts.refuseWith) {
        return new Response('nope', { status: opts.refuseWith })
      }
      await gate
      const id = nextId++
      pendingHeaders.set(id, req.headers)
      if (srv.upgrade(req, { data: { id } })) return undefined
      return new Response('upgrade failed', { status: 500 })
    },
    websocket: {
      open(ws) {
        conns.push({
          headers: pendingHeaders.get(ws.data.id)!,
          messages: [],
          closed: false,
          ws,
        })
      },
      message(ws, msg) {
        const conn = conns.find(c => c.ws === ws)!
        const buf = typeof msg === 'string' ? Buffer.from(msg) : Buffer.from(msg)
        conn.messages.push(buf)
        opts.onMessage?.(conn, buf)
      },
      close(ws) {
        const conn = conns.find(c => c.ws === ws)
        if (conn) conn.closed = true
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    url: `ws://127.0.0.1:${server.port}/v1/upstreamproxy/ws`,
    server,
    requests,
    conns,
    release: () => release(),
  }
}

async function startRelay(
  wsUrl: string,
  start: 'dispatch' | 'node' = 'dispatch',
): Promise<UpstreamProxyRelay> {
  const relay =
    start === 'node'
      ? await startNodeRelay(wsUrl, BASIC, `Bearer ${TOKEN}`)
      : await startUpstreamProxyRelay({
          wsUrl,
          sessionId: SESSION_ID,
          token: TOKEN,
        })
  cleanups.push(() => relay.stop())
  return relay
}

type Client = {
  sock: Socket
  received: () => Buffer
  closed: Promise<void>
  isClosed: () => boolean
}

async function connectClient(port: number): Promise<Client> {
  const chunks: Buffer[] = []
  let isClosed = false
  const sock = connect({ host: '127.0.0.1', port })
  const closed = new Promise<void>(resolve => {
    sock.on('close', () => {
      isClosed = true
      resolve()
    })
  })
  sock.on('data', d => chunks.push(Buffer.from(d)))
  sock.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve())
    sock.once('error', reject)
  })
  cleanups.push(() => sock.destroy())
  return {
    sock,
    received: () => Buffer.concat(chunks),
    closed,
    isClosed: () => isClosed,
  }
}

async function waitFor(
  pred: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

function decoded(msg: Buffer): string {
  const payload = decodeChunk(new Uint8Array(msg))
  if (payload === null) throw new Error('upstream got a malformed chunk')
  return Buffer.from(payload).toString('utf8')
}

/** CONNECT through the relay and wait until the upstream sees the head chunk. */
async function openTunnel(relay: UpstreamProxyRelay, up: Upstream, extra = '') {
  const client = await connectClient(relay.port)
  client.sock.write(CONNECT_REQ + extra)
  await waitFor(
    () => (up.conns[0]?.messages.length ?? 0) >= 1,
    'upstream to receive the CONNECT head',
  )
  return { client, conn: up.conns[0]! }
}

// ── chunk codec ──────────────────────────────────────────────────────────

describe('encodeChunk / decodeChunk', () => {
  test('encodes field 1 as length-delimited bytes with a varint length', () => {
    expect([...encodeChunk(new Uint8Array([1, 2, 3]))]).toEqual([0x0a, 3, 1, 2, 3])
    expect([...encodeChunk(new Uint8Array(0))]).toEqual([0x0a, 0])
    // 300 = 0b1_0010_1100 → 0xac 0x02
    const big = encodeChunk(new Uint8Array(300))
    expect([...big.subarray(0, 3)]).toEqual([0x0a, 0xac, 0x02])
    expect(big.length).toBe(303)
  })

  test('round-trips payloads across varint widths', () => {
    for (const size of [0, 1, 127, 128, 16_383, 16_384, 600_000]) {
      const data = new Uint8Array(size).map((_, i) => i % 251)
      const out = decodeChunk(encodeChunk(data))
      expect(out).not.toBeNull()
      expect(out!.length).toBe(size)
      expect(Buffer.from(out!).equals(Buffer.from(data))).toBe(true)
    }
  })

  test('treats a zero-length frame as an empty keepalive', () => {
    expect(decodeChunk(new Uint8Array(0))).toEqual(new Uint8Array(0))
  })

  test('rejects a wrong tag, a length past the buffer, and an overlong varint', () => {
    expect(decodeChunk(new Uint8Array([0x12, 1, 0]))).toBeNull()
    expect(decodeChunk(new Uint8Array([0x0a, 5, 1, 2]))).toBeNull()
    expect(
      decodeChunk(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])),
    ).toBeNull()
  })
})

// ── Bun relay (the branch startUpstreamProxyRelay picks under bun test) ──

describe('startUpstreamProxyRelay (Bun relay)', () => {
  test('tunnels a CONNECT both ways with the upgrade auth and proto framing', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    expect(relay.port).toBeGreaterThan(0)

    // Bytes coalesced with the CONNECT header ride the pending buffer.
    const { client, conn } = await openTunnel(relay, up, 'early-bytes')

    expect(conn.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(conn.headers.get('content-type')).toBe('application/proto')
    expect(decoded(conn.messages[0]!)).toBe(TUNNEL_HEAD)
    await waitFor(() => conn.messages.length >= 2, 'trailing bytes')
    expect(decoded(conn.messages[1]!)).toBe('early-bytes')

    // Upstream → client: the server's 200 is piped verbatim (binary frame).
    conn.ws.send(encodeChunk(Buffer.from(ESTABLISHED)))
    await waitFor(() => client.received().length >= ESTABLISHED.length, '200')
    expect(client.received().toString()).toBe(ESTABLISHED)

    // Keepalive and malformed frames from the server produce no client bytes;
    // a text frame carrying a chunk is decoded like a binary one.
    conn.ws.send(encodeChunk(new Uint8Array(0)))
    conn.ws.send(new Uint8Array([0xff, 0x00]))
    conn.ws.send('\n\x04text')
    await waitFor(
      () => client.received().length >= ESTABLISHED.length + 4,
      'text frame',
    )
    expect(client.received().toString()).toBe(ESTABLISHED + 'text')

    // Client → upstream after the tunnel is open: one chunk per write.
    client.sock.write('client-payload')
    await waitFor(() => conn.messages.length >= 3, 'client payload')
    expect(decoded(conn.messages[2]!)).toBe('client-payload')
    expect(client.isClosed()).toBe(false)
  })

  test('accumulates a CONNECT split across packets', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write('CONNECT example.com')
    await Bun.sleep(20)
    expect(up.requests).toHaveLength(0)
    client.sock.write(':443 HTTP/1.1\r\nHost: example.com:443\r\n')
    await Bun.sleep(20)
    expect(up.requests).toHaveLength(0)
    client.sock.write('\r\n')

    await waitFor(() => (up.conns[0]?.messages.length ?? 0) >= 1, 'head')
    expect(decoded(up.conns[0]!.messages[0]!)).toBe(TUNNEL_HEAD)
  })

  test('buffers client bytes written while the WS handshake is in flight', async () => {
    const up = startUpstream({ gated: true })
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write(CONNECT_REQ)
    await waitFor(() => up.requests.length === 1, 'upgrade request')
    client.sock.write('during-handshake-1')
    await Bun.sleep(20)
    client.sock.write('during-handshake-2')
    await Bun.sleep(20)
    expect(up.conns).toHaveLength(0)

    up.release()
    await waitFor(() => (up.conns[0]?.messages.length ?? 0) >= 3, 'flush')
    const msgs = up.conns[0]!.messages.map(decoded)
    expect(msgs[0]).toBe(TUNNEL_HEAD)
    expect(msgs.slice(1).join('')).toBe('during-handshake-1during-handshake-2')
  })

  test('splits client writes larger than 512 KiB into several chunks', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    const size = 512 * 1024 + 1000
    const payload = Buffer.alloc(size, 0x61)
    client.sock.write(payload)
    await waitFor(
      () =>
        conn.messages
          .slice(1)
          .reduce((n, m) => n + decodeChunk(new Uint8Array(m))!.length, 0) >=
        size,
      'large payload',
      4000,
    )
    const sizes = conn.messages
      .slice(1)
      .map(m => decodeChunk(new Uint8Array(m))!.length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(512 * 1024)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(size)
    expect(sizes.length).toBeGreaterThanOrEqual(2)
  })

  test('delivers a large upstream burst intact while the client is not reading', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    // Stall the reader so the relay's sock.write() comes up short and the
    // tail goes through writeBuf + drain.
    client.sock.pause()
    const parts = 24
    const partSize = 256 * 1024
    const expected: Buffer[] = []
    for (let i = 0; i < parts; i++) {
      const part = Buffer.alloc(partSize, i)
      expected.push(part)
      conn.ws.send(encodeChunk(part))
    }
    await Bun.sleep(100)
    client.sock.resume()

    const total = parts * partSize
    await waitFor(() => client.received().length >= total, 'burst', 4000)
    expect(client.received().equals(Buffer.concat(expected))).toBe(true)
  })

  test('answers a non-CONNECT request with 405 and never dials upstream', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')
    await client.closed
    expect(client.received().toString()).toBe(
      'HTTP/1.1 405 Method Not Allowed\r\n\r\n',
    )
    expect(up.requests).toHaveLength(0)
  })

  test('answers 400 when the header grows past 8 KiB without CRLFCRLF', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write('CONNECT ' + 'a'.repeat(9000))
    await client.closed
    expect(client.received().toString()).toStartWith(
      'HTTP/1.1 400 Bad Request\r\n\r\n',
    )
    expect(up.requests).toHaveLength(0)
  })

  test('answers 502 when the upstream refuses the upgrade', async () => {
    const up = startUpstream({ refuseWith: 403 })
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write(CONNECT_REQ)
    await client.closed
    expect(up.requests).toHaveLength(1)
    expect(up.requests[0]!.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(client.received().toString()).toBe('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })

  test('ends the client without a 502 when the upstream closes after the 200', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    conn.ws.send(encodeChunk(Buffer.from(ESTABLISHED)))
    await waitFor(() => client.received().length > 0, '200')
    conn.ws.close(1000, 'done')
    await client.closed
    expect(client.received().toString()).toBe(ESTABLISHED)
  })

  test('ends the client without a 502 when the upstream closes before any data', async () => {
    // Characterization: only onerror writes the 502; a clean close before the
    // tunnel is established just ends the client socket.
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    conn.ws.close(1000, 'bye')
    await client.closed
    expect(client.received().length).toBe(0)
  })

  test('ends the client when the upstream connection drops after the 200', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    conn.ws.send(encodeChunk(Buffer.from(ESTABLISHED)))
    await waitFor(() => client.received().length > 0, '200')
    up.server.stop(true)
    await client.closed
    // Whatever close path the drop takes, the TLS stream is never corrupted
    // with a plaintext status line.
    expect(client.received().toString()).toBe(ESTABLISHED)
  })

  test('closes the upstream WS and stops the keepalive when the client hangs up', async () => {
    const clearSpy = spyOn(globalThis, 'clearInterval')
    cleanups.push(() => clearSpy.mockRestore())
    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    client.sock.end()
    await waitFor(() => conn.closed, 'upstream close')
    expect(clearSpy).toHaveBeenCalled()
  })

  test('closes a still-connecting upstream WS when the client hangs up mid-handshake', async () => {
    const up = startUpstream({ gated: true })
    const relay = await startRelay(up.url)
    const client = await connectClient(relay.port)

    client.sock.write(CONNECT_REQ)
    await waitFor(() => up.requests.length === 1, 'upgrade request')
    client.sock.destroy()
    await client.closed
    await Bun.sleep(20)
    up.release()
    // The relay gave up on the socket; if the server finishes the upgrade the
    // relay must not push the CONNECT head through it.
    await Bun.sleep(50)
    for (const c of up.conns) expect(c.messages).toHaveLength(0)
  })

  test('sends an empty chunk every 30 s while open, and nothing once closed', async () => {
    type Keepalive = (ws: unknown) => void
    const realSetInterval = globalThis.setInterval
    const armed: Array<{ fn: Keepalive; ms: number; ws: unknown }> = []
    const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: Keepalive,
      ms: number,
      ...args: unknown[]
    ) => {
      armed.push({ fn, ms, ws: args[0] })
      return realSetInterval(() => {}, 1 << 30)
    }) as unknown as typeof setInterval)
    cleanups.push(() => setSpy.mockRestore())

    const up = startUpstream()
    const relay = await startRelay(up.url)
    const { client, conn } = await openTunnel(relay, up)

    const keepalive = armed.find(a => a.ms === 30_000)
    expect(keepalive).toBeDefined()
    const before = conn.messages.length
    keepalive!.fn(keepalive!.ws)
    await waitFor(() => conn.messages.length > before, 'keepalive')
    expect([...conn.messages[before]!]).toEqual([0x0a, 0x00])

    client.sock.end()
    await waitFor(() => conn.closed, 'upstream close')
    const after = conn.messages.length
    keepalive!.fn(keepalive!.ws)
    await Bun.sleep(20)
    expect(conn.messages.length).toBe(after)
  })

  test('stop() closes the listener', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url)
    relay.stop()
    await expect(connectClient(relay.port)).rejects.toThrow()
  })
})

// ── Node relay ───────────────────────────────────────────────────────────
// startNodeRelay latches a module-level ws constructor, after which every
// tunnel in this process goes through the `ws` package. Keep it last.

describe('startNodeRelay', () => {
  test('tunnels a CONNECT both ways over node:net and the ws package', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url, 'node')
    const { client, conn } = await openTunnel(relay, up, 'early')

    expect(conn.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(conn.headers.get('content-type')).toBe('application/proto')
    expect(decoded(conn.messages[0]!)).toBe(TUNNEL_HEAD)
    await waitFor(() => conn.messages.length >= 2, 'trailing bytes')
    expect(decoded(conn.messages[1]!)).toBe('early')

    conn.ws.send(encodeChunk(Buffer.from(ESTABLISHED)))
    await waitFor(() => client.received().length >= ESTABLISHED.length, '200')
    expect(client.received().toString()).toBe(ESTABLISHED)

    client.sock.write('after')
    await waitFor(() => conn.messages.length >= 3, 'client payload')
    expect(decoded(conn.messages[2]!)).toBe('after')

    client.sock.end()
    await waitFor(() => conn.closed, 'upstream close')
  })

  test('answers 405 to a non-CONNECT request', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url, 'node')
    const client = await connectClient(relay.port)
    client.sock.write('POST / HTTP/1.1\r\n\r\n')
    await client.closed
    expect(client.received().toString()).toBe(
      'HTTP/1.1 405 Method Not Allowed\r\n\r\n',
    )
  })

  test('stop() closes the listener', async () => {
    const up = startUpstream()
    const relay = await startRelay(up.url, 'node')
    relay.stop()
    await expect(connectClient(relay.port)).rejects.toThrow()
  })
})
