import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type Tool } from 'src/tools/Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from 'src/mcp/types.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { InProcessMcpServer } from 'src/mcp/client/transport.js'
import { INSTRUCTIONS_CAP } from 'src/mcp/client/connection/handshake.js'
import { closeQuietly, openConnection } from 'src/mcp/client/connection/openConnection.js'

// This module and fetchCapabilities.ts import each other. Both only touch the
// other's exports when a function runs, never while loading, so the cycle is
// safe as long as it stays that way.

export const MAX_MCP_DESCRIPTION_LENGTH = INSTRUCTIONS_CAP

export async function cleanupFailedConnection(
  transport: Pick<Transport, 'close'>,
  inProcessServer?: Pick<InProcessMcpServer, 'close'>,
): Promise<void> {
  await closeQuietly(transport, inProcessServer)
}

export function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return config.type === undefined || config.type === 'stdio' || config.type === 'sdk'
}

const IDE_TOOL_PREFIX = 'mcp__ide__'
/** The only tools of the IDE server the model is given. */
const KEPT_IDE_TOOLS: ReadonlySet<string> = new Set([
  'mcp__ide__executeCode',
  'mcp__ide__getDiagnostics',
])

export function isIncludedMcpTool(tool: Tool): boolean {
  return !tool.name.startsWith(IDE_TOOL_PREFIX) || KEPT_IDE_TOOLS.has(tool.name)
}

export function getServerCacheKey(
  name: string,
  serverRef: ScopedMcpServerConfig,
): string {
  return `${name}-${jsonStringify(serverRef)}`
}

type ServerStats = {
  totalServers: number
  stdioCount: number
  sseCount: number
  httpCount: number
  sseIdeCount: number
  wsIdeCount: number
}

/**
 * One record per name and config, failures included (spec Finding 7), until
 * `clearServerCache` or the connection closing forgets it.
 */
const connections = new Map<string, Promise<MCPServerConnection>>()

/** The tool, resource and command lists fetched for a server name. */
function forgetServerCapabilities(name: string): void {
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
}

function connectOnce(
  name: string,
  serverRef: ScopedMcpServerConfig,
  _serverStats?: ServerStats,
): Promise<MCPServerConnection> {
  const key = getServerCacheKey(name, serverRef)
  const known = connections.get(key)
  if (known) return known

  const opening: Promise<MCPServerConnection> = openConnection(name, serverRef, () => {
    // A cleared and reopened server has a newer entry; only this one's goes.
    if (connections.get(key) === opening) connections.delete(key)
    forgetServerCapabilities(name)
  })
  connections.set(key, opening)
  return opening
}

/** Resolves to the record for a server, connecting on first use. Never rejects. */
export const connectToServer = Object.assign(connectOnce, { cache: connections })

/**
 * Forgets a server's record and its capability lists, cleaning up a live
 * connection first. A server with no record is not connected only to be
 * closed (spec Finding 6).
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<void> {
  const key = getServerCacheKey(name, serverRef)
  const known = connections.get(key)
  connections.delete(key)
  forgetServerCapabilities(name)
  if (!known) return
  const record = await known
  if (record.type === 'connected') await record.cleanup()
}

export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  if (client.config.type === 'sdk') return client
  const current = await connectToServer(client.name, client.config)
  if (current.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server is not connected',
    )
  }
  return current
}

export function areMcpConfigsEqual(
  a: ScopedMcpServerConfig,
  b: ScopedMcpServerConfig,
): boolean {
  // The type is part of what is compared, so an untyped entry never equals a typed one.
  const { scope: _scopeA, ...restA } = a
  const { scope: _scopeB, ...restB } = b
  return jsonStringify(restA) === jsonStringify(restB)
}
