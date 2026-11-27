import { afterEach, beforeEach, expect, test } from 'bun:test'
import { inputRequired, inputResponse } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { registerElicitationHandler, waitsForElicitationCompletion } from 'src/mcp/elicitationHandler.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import { appStateBox, waitUntil } from 'src/mcp/__testutils__/elicitationHarness.js'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'

/*
 * URL-mode elicitation from a 2026-07-28 server (plan case 6). The server asks
 * through a multi-round-trip input_required result, which the SDK fulfils
 * with the client's registered elicitation handler, but only from a client
 * that announced `elicitation.url`: a bare `elicitation: {}` is refused up
 * front with -32021 and Claudin's handler is never reached.
 */

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
let fixture: ModernFixture | undefined
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
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
  await fixture?.stop()
  fixture = undefined
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

function serveLogin(): ModernFixture {
  return serveModern(server => {
    server.registerTool('login', { description: 'signs in', inputSchema: z.object({}) }, async (_args, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'signin')
      if (answer.kind === 'elicit' && answer.action === 'accept') {
        return { content: [{ type: 'text', text: 'signed in' }] }
      }
      return inputRequired({
        inputRequests: {
          signin: inputRequired.elicitUrl({ message: 'Sign in to continue', url: 'https://auth.example/login' }),
        },
      })
    })
  })
}

async function connect(name: string, config: ScopedMcpServerConfig): Promise<ConnectedMCPServer> {
  const connection = await connectToServer(name, config)
  connections.push(connection)
  if (connection.type !== 'connected') {
    throw new Error(`expected connected, got ${connection.type}: ${'error' in connection ? connection.error : ''}`)
  }
  return connection
}

test('a 2026-07-28 server reaches the elicitation handler with a URL request, and the call completes on accept', async () => {
  fixture = serveLogin()
  const connection = await connect('url-elicit', { type: 'http', url: fixture.url, scope: 'user' })
  const box = appStateBox()
  registerElicitationHandler(connection.client, connection.name, box.set)

  const call = connection.client.callTool({ name: 'login', arguments: {} })
  call.catch(() => {})
  await waitUntil(() => box.queue().length === 1, 'the URL elicitation to be queued')
  const event = box.queue()[0]!
  expect(event.params).toMatchObject({ mode: 'url', url: 'https://auth.example/login' })
  // No completion notice exists in 2026-07-28: the dialog does not wait for one.
  expect(waitsForElicitationCompletion(event, 'accept')).toBe(false)

  event.respond({ action: 'accept' })
  expect(await call).toMatchObject({ content: [{ type: 'text', text: 'signed in' }] })
})

test('control: a URL accept on a 2025 connection still waits for the completion notice', () => {
  const event = { params: { mode: 'url' } }
  expect(waitsForElicitationCompletion(event, 'accept')).toBe(true)
  expect(waitsForElicitationCompletion(event, 'decline')).toBe(false)
  expect(waitsForElicitationCompletion({ params: { mode: 'form' } }, 'accept')).toBe(false)
})
