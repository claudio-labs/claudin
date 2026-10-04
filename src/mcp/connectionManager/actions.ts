import { clearServerCache } from 'src/mcp/client.js'
import { setMcpServerEnabled } from 'src/mcp/config.js'
import { clearSessionDisconnected, markSessionDisconnected } from 'src/mcp/sessionDisconnects.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import type { ConnectionRuntime } from 'src/mcp/connectionManager/runtime.js'
import type { ConnectionResult } from 'src/mcp/connectionManager/types.js'

/** Actions decide from app state, so they see what the last batch applied. */
function listedServer(runtime: ConnectionRuntime, name: string): MCPServerConnection {
  const server = runtime.store.getState().mcp.clients.find(client => client.name === name)
  if (!server) throw new Error(`MCP server ${name} not found`)
  return server
}

/** Dialling a server by hand takes back a session disconnect. */
async function dialByHand(runtime: ConnectionRuntime, server: MCPServerConnection): Promise<ConnectionResult> {
  runtime.redial.cancel(server.name)
  clearSessionDisconnected(server.name)
  runtime.retire(server.name)
  const result = await runtime.dial(server.name, server.config)
  runtime.adopt(result)
  return result
}

/**
 * `record` runs before the connection closes: the close handler reads it to
 * know the close was wanted and must not be redialled.
 */
async function takeOffline(
  runtime: ConnectionRuntime,
  server: MCPServerConnection,
  record: (name: string) => void,
): Promise<void> {
  const { name, config } = server
  record(name)
  runtime.redial.cancel(name)
  if (server.type === 'connected') await clearServerCache(name, config)
  runtime.report({ name, type: 'disabled', config })
}

export async function reconnectServer(runtime: ConnectionRuntime, name: string): Promise<ConnectionResult> {
  return dialByHand(runtime, listedServer(runtime, name))
}

/** Persisted in the project's config, unlike a disconnect. */
export async function toggleServer(runtime: ConnectionRuntime, name: string): Promise<void> {
  const server = listedServer(runtime, name)
  if (server.type !== 'disabled') {
    await takeOffline(runtime, server, off => setMcpServerEnabled(off, false))
    return
  }
  setMcpServerEnabled(name, true)
  runtime.report({ name, type: 'pending', config: server.config })
  await dialByHand(runtime, server)
}

/** For this session only: nothing is written to disk. */
export async function disconnectServer(runtime: ConnectionRuntime, name: string): Promise<void> {
  await takeOffline(runtime, listedServer(runtime, name), markSessionDisconnected)
}
