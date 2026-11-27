import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { connectToServer } from 'src/mcp/client/connection.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'

/*
 * Streamable HTTP session termination: a client that no longer needs a
 * session SHOULD end it with an HTTP DELETE carrying its Mcp-Session-Id
 * (MCP 2025-11-25, transports). Same harness as connection.remote.test.ts.
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
    if (connection.type === 'connected') await connection.cleanup().catch(() => undefined)
  }
  for (const srv of servers.splice(0)) srv.stop(true)
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

const SESSION_ID = 'sess-1234'
type Seen = { method: string; sessionId: string | null; rpc?: string }

// Issues Mcp-Session-Id on initialize and records every request, reading the
// headers while the request is live. `onDelete` answers the DELETE.
function startSessionServer(
  onDelete: () => Response | Promise<Response> = () => new Response(null, { status: 200 }),
): { url: string; requests: Seen[] } {
  const requests: Seen[] = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const seen: Seen = { method: req.method, sessionId: req.headers.get('mcp-session-id') }
      requests.push(seen)
      if (req.method === 'DELETE') return onDelete()
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const message = (await req.json()) as { id?: number; method: string }
      seen.rpc = message.method
      if (message.method !== 'initialize') return new Response(null, { status: 202 })
      return Response.json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'probe', version: '1' } },
        },
        { headers: { 'Mcp-Session-Id': SESSION_ID } },
      )
    },
  })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}/mcp`, requests }
}

describe('Streamable HTTP session termination', () => {
  test('control: the session id issued on initialize is sent on later requests', async () => {
    const server = startSessionServer()
    const connection = await connectToServer('session-ctl', { type: 'http', url: server.url, scope: 'user' })
    connections.push(connection)
    expect(connection.type).toBe('connected')
    expect(server.requests[0]).toMatchObject({ method: 'POST', rpc: 'initialize', sessionId: null })
    expect(server.requests.find(r => r.rpc === 'notifications/initialized')?.sessionId).toBe(SESSION_ID)
  })

  test('closing the connection sends DELETE with the session id', async () => {
    const server = startSessionServer()
    const connection = await connectToServer('session-del', { type: 'http', url: server.url, scope: 'user' })
    expect(connection.type).toBe('connected')
    if (connection.type !== 'connected') return
    await connection.cleanup()
    expect(server.requests.filter(r => r.method === 'DELETE')).toEqual([{ method: 'DELETE', sessionId: SESSION_ID }])
  })

  test('a server that refuses the DELETE (405) still closes cleanly', async () => {
    const server = startSessionServer(() => new Response(null, { status: 405 }))
    const connection = await connectToServer('session-405', { type: 'http', url: server.url, scope: 'user' })
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    await connection.cleanup()
    expect(server.requests.filter(r => r.method === 'DELETE')).toHaveLength(1)
  })

  test('a server that never answers the DELETE holds cleanup for at most its budget', async () => {
    const server = startSessionServer(() => new Promise<Response>(() => {}))
    const connection = await connectToServer('session-hang', { type: 'http', url: server.url, scope: 'user' })
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    const started = Date.now()
    await connection.cleanup()
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(server.requests.filter(r => r.method === 'DELETE')).toHaveLength(1)
  })
})
