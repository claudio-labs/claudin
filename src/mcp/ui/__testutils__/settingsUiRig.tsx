/**
 * Inputs for the mcp/settingsUi characterization suites (the /mcp panel).
 *
 * The panels take plain records: a server as the panel lists it, an agent's
 * inline server, and tools as the MCP client builds them from a `tools/list`
 * answer. Tools go through the client's own `toolFromListing`, so names,
 * annotations and descriptions arrive in the shape a live server gives them.
 *
 * Mounting, keys and screen reading come from the promptFrame rig.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { until } from 'src/mcp/__testutils__/connectionRig.js'
import { toolFromListing, type ListedTool } from 'src/mcp/client/capabilities/toolFromListing.js'
import { clearServerCache } from 'src/mcp/client/connection.js'
import { MCPConnectionManager, useMcpDisconnect } from 'src/mcp/MCPConnectionManager.js'
import { resetSessionDisconnectsForTests } from 'src/mcp/sessionDisconnects.js'
import type { ConfigScope, ConnectedMCPServer, MCPServerConnection } from 'src/mcp/types.js'
import { MCPSettings } from 'src/mcp/ui/MCPSettings.js'
import type { AgentMcpServerInfo, ServerInfo } from 'src/mcp/ui/types.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Text } from 'src/terminal/ink.js'
import { type AppState, useSetAppState } from 'src/terminal/state/AppState.js'
import type { Tool } from 'src/tools/Tool.js'

export type Kind = MCPServerConnection['type']
export type Transport = ServerInfo['transport']

type Shape = {
  scope?: ConfigScope
  transport?: Transport
  kind?: Kind
  /** For a `pending` server: how far its redial has got. */
  attempt?: [number, number]
}

function configFor(transport: Transport, name: string, scope: ConfigScope): Record<string, unknown> {
  switch (transport) {
    case 'stdio':
      return { command: `run-${name}`, args: [], scope }
    case 'claudeai-proxy':
      return { type: 'claudeai-proxy', url: `https://connectors.test/${name}`, id: `id-${name}`, scope }
    default:
      return { type: transport, url: `https://${name}.test/mcp`, scope }
  }
}

/** A server the way the /mcp panel receives it. */
export function server(name: string, shape: Shape = {}): ServerInfo {
  const scope = shape.scope ?? 'user'
  const transport = shape.transport ?? 'stdio'
  const config = configFor(transport, name, scope)
  const client = { name, type: shape.kind ?? 'connected', config } as Record<string, unknown>
  if (shape.attempt) {
    client.reconnectAttempt = shape.attempt[0]
    client.maxReconnectAttempts = shape.attempt[1]
  }
  const info: Record<string, unknown> = { name, scope, transport, config, client }
  if (transport !== 'stdio') info.isAuthenticated = false
  return info as unknown as ServerInfo
}

/** A server an agent declares inline. */
export function agentServer(name: string, agents: string[], remote = false): AgentMcpServerInfo {
  return remote
    ? { name, sourceAgents: agents, transport: 'http', url: `https://${name}.test/mcp`, needsAuth: true }
    : { name, sourceAgents: agents, transport: 'stdio', command: `run-${name}`, needsAuth: false }
}

/** A tool as the MCP client builds it from one `tools/list` entry of `serverName`. */
export function listedTool(serverName: string, listed: Partial<ListedTool> & { name: string }): Tool {
  const owner = { name: serverName, type: 'connected' } as unknown as ConnectedMCPServer
  return toolFromListing(owner, { inputSchema: { type: 'object' }, ...listed } as ListedTool, { bareName: false })
}

/** What a panel told its caller through `onComplete`, in order. */
export type Completion = { result?: string; options?: unknown }

export function completions(): { log: Completion[]; onComplete: (result?: string, options?: unknown) => void } {
  const log: Completion[] = []
  return { log, onComplete: (result, options) => void log.push(options === undefined ? { result } : { result, options }) }
}

// --- the whole /mcp panel, with live connections ------------------------------

export type Settings = {
  screen: Screen
  done: ReturnType<typeof completions>
  /** The live client entry for `name`. */
  client: (name: string) => MCPServerConnection | undefined
  /** Waits until `name` is in one of `kinds`. */
  reaches: (name: string, ...kinds: Kind[]) => Promise<void>
  /** Rewrites the app state, the way another part of the app would. */
  setState: (change: (state: AppState) => AppState) => void
}

const live: Array<() => Promise<void>> = []

/**
 * Mounts `<MCPConnectionManager>` the way the REPL does and lets it bring the
 * configured servers up; only then is `<MCPSettings>` put inside it, the way
 * a user opens /mcp in a running session. `settled` names the servers to wait
 * for and the states that count as settled.
 */
export async function openSettings(settled: Record<string, Kind[]>, columns = 160): Promise<Settings> {
  const done = completions()
  const grip: { disconnect?: (name: string) => Promise<void>; set?: (change: (s: AppState) => AppState) => void } = {}
  function Grip(): React.ReactNode {
    grip.disconnect = useMcpDisconnect()
    grip.set = useSetAppState()
    return null
  }
  const tree = (panel: React.ReactNode) => (
    <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
      <Grip />
      {panel}
    </MCPConnectionManager>
  )
  const screen = await mount(tree(<Text>[manager up]</Text>), { columns })
  const client = (name: string) => screen.state().mcp.clients.find(c => c.name === name)
  const reaches = (name: string, ...kinds: Kind[]) =>
    until(`${name} to reach ${kinds.join('/')}`, () => kinds.includes(client(name)?.type as Kind))
  for (const [name, kinds] of Object.entries(settled)) await reaches(name, ...kinds)

  live.push(async () => {
    const clients = screen.state().mcp.clients
    await Promise.all(clients.filter(c => c.type !== 'disabled').map(c => grip.disconnect?.(c.name).catch(() => {})))
    await Bun.sleep(200)
    await screen.close()
    await Promise.all(clients.map(c => clearServerCache(c.name, c.config).catch(() => {})))
    // The disconnects above go into a process-wide set that start-up reads
    // (isServerOff): left there, the next panel lists the same names as
    // disabled. They only land when this file's afterEach runs before
    // promptFrameRig's, i.e. when another file loaded that rig first.
    resetSessionDisconnectsForTests()
  })

  await screen.replace(tree(<MCPSettings onComplete={done.onComplete} />))
  return { screen, done, client, reaches, setState: change => grip.set?.(change) }
}

/** For an afterEach: takes every opened panel down with its connections. */
export async function closeAllSettings(): Promise<void> {
  while (live.length) await live.pop()?.()
}

/**
 * A `secret-tool` that refuses every call and notes it, put first on PATH so
 * the credential store falls back to its plaintext file and the user's own
 * keyring is never asked. Returns the undo.
 */
export function refuseKeyring(dir: string): { undo: () => void; log: string } {
  const bin = join(dir, 'keyring-bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'keyring.log')
  const stub = join(bin, 'secret-tool')
  writeFileSync(stub, `#!/bin/sh\necho "$1" >> "${log}"\nexit 1\n`)
  chmodSync(stub, 0o755)
  const before = process.env.PATH
  process.env.PATH = `${bin}:${before ?? ''}`
  return {
    log,
    undo: () => {
      process.env.PATH = before
    },
  }
}
