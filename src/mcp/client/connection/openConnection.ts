import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import { maybeNotifyIDEConnected } from 'src/platform/ide/ide.js'
import type { ConnectedMCPServer, MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { setMcpAuthCacheEntry } from 'src/mcp/client/authCache.js'
import { getConnectionTimeoutMs } from 'src/mcp/client/fetch.js'
import { createTransport, type InProcessMcpServer } from 'src/mcp/client/transport.js'
import { capInstructions, createMcpClient } from 'src/mcp/client/connection/handshake.js'
import { stopProcess } from 'src/mcp/client/connection/processStopper.js'
import { closeOnTerminalErrors, remoteTransportType } from 'src/mcp/client/connection/remoteErrors.js'

type Built = { transport: Transport; inProcessServer?: InProcessMcpServer }

export type OpenConnectionDeps = {
  createTransport: (name: string, config: ScopedMcpServerConfig) => Promise<Built>
  createClient: () => Client
  stopProcess: (pid: number) => Promise<void>
  connectTimeoutMs: () => number
}

export const defaultOpenConnectionDeps: OpenConnectionDeps = {
  createTransport,
  createClient: createMcpClient,
  stopProcess,
  connectTimeoutMs: getConnectionTimeoutMs,
}

const UNAUTHORIZED = 401

function failed(name: string, config: ScopedMcpServerConfig, error: unknown): MCPServerConnection {
  return { name, type: 'failed', config, error: errorMessage(error) }
}

/** A login request from the OAuth client, or a 401 from the claude.ai proxy (which has no OAuth client). */
function asksForLogin(error: unknown, config: ScopedMcpServerConfig): boolean {
  if (error instanceof UnauthorizedError) return true
  return config.type === 'claudeai-proxy' && error instanceof StreamableHTTPError && error.code === UNAUTHORIZED
}

function isIdeServer(config: ScopedMcpServerConfig): boolean {
  return config.type === 'sse-ide' || config.type === 'ws-ide'
}

function logStderr(name: string, transport: StdioClientTransport): void {
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    logMCPDebug(name, `Server stderr: ${chunk.toString().trimEnd()}`)
  })
}

async function connectWithin(client: Client, transport: Transport, name: string, ms: number): Promise<void> {
  const connecting = client.connect(transport)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP server "${name}" connection timed out after ${ms}ms`)), ms)
  })
  try {
    await Promise.race([connecting, deadline])
  } catch (error) {
    // After a timeout the handshake still settles, usually as the transport closes.
    connecting.catch((late: unknown) => logMCPDebug(name, `Handshake ended after giving up: ${errorMessage(late)}`))
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Closes the in-process server first, then the transport; waits for both and only logs their errors. */
export async function closeQuietly(
  transport: Pick<Transport, 'close'>,
  inProcessServer?: Pick<InProcessMcpServer, 'close'>,
): Promise<void> {
  const attempts: Array<[string, Pick<Transport, 'close'> | undefined]> = [
    ['in-process server', inProcessServer],
    ['transport', transport],
  ]
  for (const [what, closable] of attempts) {
    if (!closable) continue
    try {
      await closable.close()
    } catch (error) {
      logMCPDebug('mcp', `Closing the ${what} of a failed connection failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * Connects one server and resolves to its record; never rejects. `onClosed`
 * runs when a live connection closes, whatever closed it.
 */
export async function openConnection(
  name: string,
  config: ScopedMcpServerConfig,
  onClosed: () => void,
  deps: OpenConnectionDeps = defaultOpenConnectionDeps,
): Promise<MCPServerConnection> {
  let built: Built
  try {
    built = await deps.createTransport(name, config)
  } catch (error) {
    logMCPError(name, error)
    return failed(name, config, error)
  }
  const { transport, inProcessServer } = built
  const stdio = transport instanceof StdioClientTransport ? transport : undefined
  if (stdio) logStderr(name, stdio)

  const client = deps.createClient()
  try {
    await connectWithin(client, transport, name, deps.connectTimeoutMs())
  } catch (error) {
    if (asksForLogin(error, config)) {
      logMCPDebug(name, 'The server asks for a login')
      setMcpAuthCacheEntry(name)
      return { name, type: 'needs-auth', config }
    }
    logMCPError(name, error)
    // Every type, so no transport (or child) of a failed connection stays open.
    const pid = stdio?.pid
    if (pid) await deps.stopProcess(pid)
    await closeQuietly(transport, inProcessServer)
    return failed(name, config, error)
  }

  return connected(name, config, client, stdio?.pid ?? undefined, onClosed, deps)
}

async function connected(
  name: string,
  config: ScopedMcpServerConfig,
  client: Client,
  pid: number | undefined,
  onClosed: () => void,
  deps: OpenConnectionDeps,
): Promise<ConnectedMCPServer> {
  client.onclose = () => {
    logMCPDebug(name, 'Connection closed')
    onClosed()
  }
  const remoteType = remoteTransportType(config)
  if (remoteType) closeOnTerminalErrors(client, name, remoteType)
  if (isIdeServer(config)) {
    await maybeNotifyIDEConnected(client).catch((error: unknown) => {
      logMCPDebug(name, `Telling the IDE it is connected failed: ${errorMessage(error)}`)
    })
  }

  let unregister: () => void = () => {}
  const cleanup = async (): Promise<void> => {
    unregister()
    try {
      if (pid) await deps.stopProcess(pid)
    } finally {
      await client.close().catch((error: unknown) => {
        logMCPDebug(name, `Closing the client failed: ${errorMessage(error)}`)
      })
    }
  }
  unregister = registerCleanup(cleanup)

  const version = client.getServerVersion()
  return {
    name,
    client,
    type: 'connected',
    capabilities: client.getServerCapabilities() ?? {},
    serverInfo: version ? { name: version.name, version: version.version } : undefined,
    instructions: capInstructions(client.getInstructions()),
    config,
    cleanup,
  }
}
