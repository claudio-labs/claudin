import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { connectToServer } from 'src/mcp/client/connection.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'

/*
 * connectToServer against real local MCP endpoints: a Streamable HTTP server
 * that answers initialize as JSON, and an SSE server whose message endpoint
 * fails. Each test uses its own server name, since connectToServer memoizes
 * by name and config.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
const servers: Server<unknown>[] = []
const connections: MCPServerConnection[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => ({}),
    readAsync: async () => ({}),
    update: () => ({ success: true }),
    delete: () => true,
  })
})

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup()
  }
  for (const srv of servers.splice(0)) srv.stop(true)
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

async function connect(name: string, config: ScopedMcpServerConfig): Promise<MCPServerConnection> {
  const connection = await connectToServer(name, config)
  connections.push(connection)
  return connection
}

// Answers initialize with `statuses` in turn (200 once they run out).
function startHttpServer(statuses: number[]): { url: string; initializes: () => number } {
  let initializes = 0
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const message = (await req.json()) as { id?: number; method: string }
      if (message.method !== 'initialize') return new Response(null, { status: 202 })
      const status = statuses[initializes++] ?? 200
      if (status !== 200) return new Response('unavailable', { status })
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'probe', version: '1' } },
      })
    },
  })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}/mcp`, initializes: () => initializes }
}

describe('connectToServer — transient failures', () => {
  test('control: a server that answers connects in one attempt', async () => {
    const server = startHttpServer([])
    const connection = await connect('http-ok', { type: 'http', url: server.url, scope: 'user' })
    expect(connection.type).toBe('connected')
    expect(server.initializes()).toBe(1)
  })

  test('a 503 on the first initialize is retried and the server connects', async () => {
    const server = startHttpServer([503])
    const connection = await connect('http-503-once', { type: 'http', url: server.url, scope: 'user' })
    expect(connection.type).toBe('connected')
    expect(server.initializes()).toBe(2)
  })

  test('gives up after two retries', async () => {
    const server = startHttpServer([503, 502, 503, 503])
    const connection = await connect('http-503-always', { type: 'http', url: server.url, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(server.initializes()).toBe(3)
  })

  test('a failure that is not transient is not retried', async () => {
    const server = startHttpServer([400])
    const connection = await connect('http-400', { type: 'http', url: server.url, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(server.initializes()).toBe(1)
  })

  test('no retry waits past the server’s startupTimeout', async () => {
    const server = startHttpServer([503, 503, 503])
    const connection = await connect('http-503-short', {
      type: 'http',
      url: server.url,
      startupTimeout: 200,
      scope: 'user',
    })
    expect(connection.type).toBe('failed')
    expect(server.initializes()).toBe(1)
  })
})

describe('connectToServer — transient failures over ws and sse', () => {
  // A port nothing listens on: bind one, read its number, close it.
  function closedPort(): number {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)
    return port!
  }

  test('ws: a 503 on the upgrade is retried like the http 503', async () => {
    let upgrades = 0
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        upgrades++
        return new Response('unavailable', { status: 503 })
      },
    })
    servers.push(srv)
    const connection = await connect('ws-503', { type: 'ws', url: `ws://127.0.0.1:${srv.port}/mcp`, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(upgrades).toBe(3)
  })

  test('ws: a 400 on the upgrade is not retried', async () => {
    let upgrades = 0
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        upgrades++
        return new Response('bad', { status: 400 })
      },
    })
    servers.push(srv)
    const connection = await connect('ws-400', { type: 'ws', url: `ws://127.0.0.1:${srv.port}/mcp`, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(upgrades).toBe(1)
  })

  test('control: http retries a refused port', async () => {
    const started = Date.now()
    const connection = await connect('http-refused', { type: 'http', url: `http://127.0.0.1:${closedPort()}/mcp`, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1250)
  })

  test('sse: a refused port is retried like http', async () => {
    const started = Date.now()
    const connection = await connect('sse-refused', { type: 'sse', url: `http://127.0.0.1:${closedPort()}/sse`, scope: 'user' })
    expect(connection.type).toBe('failed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1250)
  })
})

describe('connectToServer — a failed remote connect', () => {
  test('closes the event stream it opened', async () => {
    let streamClosed: Promise<void> = Promise.resolve()
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (req.method === 'POST') return new Response('broken', { status: 500 })
        streamClosed = new Promise(resolve => req.signal.addEventListener('abort', () => resolve()))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'))
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
    })
    servers.push(srv)

    const connection = await connect('sse-broken', {
      type: 'sse',
      url: `http://127.0.0.1:${srv.port}/sse`,
      scope: 'user',
    })

    expect(connection.type).toBe('failed')
    const closed = await Promise.race([streamClosed.then(() => true), Bun.sleep(1000).then(() => false)])
    expect(closed).toBe(true)
  })
})
