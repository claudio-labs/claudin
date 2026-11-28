import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { getServerKey } from 'src/mcp/auth/serverKey.js'
import { connectToServer } from 'src/mcp/client/connection.js'
import type { McpHTTPServerConfig, MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting, type SecureStorageData } from 'src/platform/secureStorage/index.js'
import { refuseDiscoverProbe } from 'src/mcp/__testutils__/connectionHarness.js'

/*
 * A server configured with a static Authorization header that also has
 * stored OAuth tokens: the configured header is what reaches the server, as
 * on SDK 1.x, where requestInit headers were merged after the auth provider's.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
const servers: Server<unknown>[] = []
const connections: MCPServerConnection[] = []

beforeEach(() => {
  savedMacro = macroHost.MACRO
  macroHost.MACRO = { ...(savedMacro as Record<string, unknown> | undefined), VERSION: '0.0.0-test' }
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

function startServer(): { url: string; authorizations: Array<string | null> } {
  const authorizations: Array<string | null> = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      authorizations.push(req.headers.get('authorization'))
      const message = (await req.json()) as { id?: number; method: string }
      const refused = refuseDiscoverProbe(message)
      if (refused) return refused
      if (message.method !== 'initialize') return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'auth', version: '1' } },
      })
    },
  })
  servers.push(srv)
  return { url: `http://127.0.0.1:${srv.port}/mcp`, authorizations }
}

function storeTokens(name: string, config: McpHTTPServerConfig): void {
  const data: SecureStorageData = {
    mcpOAuth: {
      [getServerKey(name, config)]: {
        serverName: name,
        serverUrl: config.url,
        accessToken: 'oauth-token',
        expiresAt: Date.now() + 3_600_000,
      },
    },
  }
  _setSecureStorageForTesting({
    name: 'memory',
    read: () => data,
    readAsync: async () => data,
    update: () => ({ success: true }),
    delete: () => true,
  })
}

test('control: stored OAuth tokens authorize a server with no static header', async () => {
  const server = startServer()
  const config: McpHTTPServerConfig = { type: 'http', url: server.url }
  storeTokens('auth-oauth', config)
  const connection = await connectToServer('auth-oauth', { ...config, scope: 'user' })
  connections.push(connection)
  expect(connection.type).toBe('connected')
  expect(server.authorizations[0]).toBe('Bearer oauth-token')
})

test('a configured Authorization header wins over stored OAuth tokens', async () => {
  const server = startServer()
  const config: McpHTTPServerConfig = { type: 'http', url: server.url, headers: { Authorization: 'Bearer static' } }
  storeTokens('auth-static', config)
  const connection = await connectToServer('auth-static', { ...config, scope: 'user' })
  connections.push(connection)
  expect(connection.type).toBe('connected')
  expect(server.authorizations[0]).toBe('Bearer static')
})
