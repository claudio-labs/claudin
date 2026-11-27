// The connections hook on a real 2026-07-28 server: a tools/list_changed sent
// on the subscriptions/listen stream reaches the handler the hook registers,
// and the pool picks up the new tool, as an unsolicited notification does on
// a 2025 connection.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connectToServer, getServerCacheKey } from 'src/mcp/client/connection.js'
import { fetchToolsForClient } from 'src/mcp/client/fetchCapabilities.js'
import { getMcpSubscriptions } from 'src/mcp/client/subscriptions.js'
import {
  clientTypes,
  type Fakes,
  type Harness,
  httpConfig,
  installMcpFakes,
  mountConnections,
} from 'src/mcp/__testutils__/mcpConnectionsHarness.js'
import { type ModernFixture, serveModern } from 'src/mcp/__testutils__/eraServers.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'

const macroHost = globalThis as Record<string, unknown>
let savedMacro: unknown
let installed: Fakes
let ui: Harness | undefined
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
  installed = installMcpFakes()
  // Real requests run here: their 60 s timeouts must not shrink to 1 ms.
  installed.fakes.shrinkBackoff = false
})

afterEach(async () => {
  await ui?.cleanup()
  ui = undefined
  for (const connection of connections.splice(0)) {
    if (connection.type === 'connected') await connection.cleanup().catch(() => {})
    connectToServer.cache.delete(getServerCacheKey(connection.name, connection.config))
  }
  await fixture?.stop()
  fixture = undefined
  installed.restore()
  _setSecureStorageForTesting(null)
  if (savedMacro === undefined) delete macroHost.MACRO
  else macroHost.MACRO = savedMacro
})

test('a tools/list_changed on the listen stream refreshes the pool', async () => {
  let toolNames = ['ping']
  fixture = serveModern(server => {
    for (const tool of toolNames) {
      server.registerTool(tool, { description: tool }, async () => ({ content: [{ type: 'text', text: tool }] }))
    }
  })
  const config = httpConfig(fixture.url)
  installed.fakes.connect = async (name, scoped) => {
    const connection = await connectToServer(name, scoped)
    connections.push(connection)
    if (connection.type !== 'connected') throw new Error(`not connected: ${connection.type}`)
    return { client: connection, tools: await fetchToolsForClient(connection), commands: [] }
  }

  ui = await mountConnections({ live: config })
  await ui.until(s => clientTypes(s).live === 'connected', 'live connected')
  expect(ui.state().mcp.tools.map(t => t.name)).toEqual(['mcp__live__ping'])
  const connection = connections[0]!
  if (connection.type !== 'connected') throw new Error('not connected')
  expect(getMcpSubscriptions(connection.client)).toBeDefined()
  await ui.until(() => fixture!.listens() === 1, 'the listen stream')

  toolNames = ['ping', 'pong']
  // The ack lands before a notification is routed to the stream.
  await Bun.sleep(50)
  fixture.notify.toolsChanged()
  await ui.until(
    s => s.mcp.tools.some(t => t.name === 'mcp__live__pong'),
    'the new tool',
  )
})
