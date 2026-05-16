// Sanity tests for the undici pool bench harness — confirms the
// diagnostics_channel hooks and ALPN behavior we rely on for the
// measurements actually fire the way we expect.

import { describe, expect, test, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer as createH1Server, type Server as H1Server } from 'node:http'
import { createSecureServer, type Http2SecureServer } from 'node:http2'
import { AddressInfo } from 'node:net'
import diagnosticsChannel from 'node:diagnostics_channel'
import { Pool } from 'undici'

const HERE = dirname(fileURLToPath(import.meta.url))
const TLS_DIR = join(HERE, '__fixtures__', 'undici-tls')

type Disposable = { close: () => Promise<void> }
const disposables: Disposable[] = []

afterEach(async () => {
  while (disposables.length) {
    const d = disposables.pop()
    try {
      await d?.close()
    } catch {
      // ignore — best effort cleanup
    }
  }
})

async function h2Server(): Promise<{ origin: string; server: Http2SecureServer }> {
  const cert = readFileSync(join(TLS_DIR, 'cert.pem'))
  const key = readFileSync(join(TLS_DIR, 'key.pem'))
  const server = createSecureServer({ cert, key, allowHTTP1: true })
  server.on('stream', stream => {
    stream.respond({ ':status': 200 })
    stream.end('ok')
  })
  server.on('request', (_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const handle = { origin: `https://127.0.0.1:${port}`, server }
  disposables.push({ close: () => new Promise<void>(r => server.close(() => r())) })
  return handle
}

async function h1Server(): Promise<{ origin: string; server: H1Server }> {
  const server = createH1Server((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const handle = { origin: `http://127.0.0.1:${port}`, server }
  disposables.push({ close: () => new Promise<void>(r => server.close(() => r())) })
  return handle
}

describe('undici-pool-bench harness sanity', () => {
  test('h2-capable server negotiates ALPN h2 when allowH2=true', async () => {
    const { origin } = await h2Server()
    let alpn: string | undefined | null | false
    const onConnected = (msg: unknown) => {
      const m = msg as { socket?: { alpnProtocol?: string | false | null } }
      alpn = m.socket?.alpnProtocol
    }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    const pool = new Pool(origin, { allowH2: true, connect: { rejectUnauthorized: false } })
    disposables.push({ close: () => pool.close() })

    const res = await pool.request({ origin, path: '/', method: 'GET' })
    await res.body.dump()

    diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
    expect(alpn).toBe('h2')
  })

  test('h1-only origin keeps http/1.1 even if allowH2=true (no h2 over plain http)', async () => {
    const { origin } = await h1Server()
    let alpn: string | undefined | null | false = 'unset'
    const onConnected = (msg: unknown) => {
      const m = msg as { socket?: { alpnProtocol?: string | false | null } }
      alpn = m.socket?.alpnProtocol
    }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    const pool = new Pool(origin, { allowH2: true })
    disposables.push({ close: () => pool.close() })

    const res = await pool.request({ origin, path: '/', method: 'GET' })
    await res.body.dump()

    diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
    // plain http never negotiates ALPN — alpnProtocol is false/undefined.
    expect(alpn === false || alpn == null).toBe(true)
  })

  test('socket reuse — N sequential requests on connections=1 produce 1 tcp connect', async () => {
    const { origin } = await h1Server()
    let connects = 0
    let requests = 0
    const onConnected = () => {
      connects++
    }
    const onSendHeaders = () => {
      requests++
    }
    diagnosticsChannel.subscribe('undici:client:connected', onConnected)
    diagnosticsChannel.subscribe('undici:client:sendHeaders', onSendHeaders)
    const pool = new Pool(origin, {
      connections: 1,
      keepAliveTimeout: 30_000,
      pipelining: 1,
    })
    disposables.push({ close: () => pool.close() })

    for (let i = 0; i < 5; i++) {
      const res = await pool.request({ origin, path: '/', method: 'GET' })
      await res.body.dump()
    }

    diagnosticsChannel.unsubscribe('undici:client:connected', onConnected)
    diagnosticsChannel.unsubscribe('undici:client:sendHeaders', onSendHeaders)
    expect(requests).toBe(5)
    expect(connects).toBe(1)
  })
})
