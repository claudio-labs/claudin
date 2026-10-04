import type { Command } from 'src/commands/commands.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from 'src/mcp/types.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { Tool } from 'src/tools/Tool.js'

export type ServerConfigs = Record<string, ScopedMcpServerConfig>

/** The `mcp` slice of app state this unit owns. */
export type McpState = AppState['mcp']

/** What `mcp/client` hands back for one dial. */
export type ConnectionResult = {
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}

/**
 * One server's new entry, plus the lists it brings. A list left out means
 * the update says nothing about that list (see `applyServerUpdate`).
 */
export type ServerUpdate = MCPServerConnection & {
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

/** What one start-up run does to `mcp.clients`, and whom it dials. */
export type StartPlan = {
  /** Servers not listed yet, as `pending` or `disabled`. */
  add: MCPServerConnection[]
  /** Listed servers whose config is gone or changed. */
  stale: MCPServerConnection[]
  dial: ServerConfigs
}

export type RedialSchedule = {
  maxAttempts: number
  /** The wait before attempt `attempt` (2 and up); the first is immediate. */
  delayBeforeAttempt: (attempt: number) => number
}

export type ConnectionActions = {
  reconnectMcpServer: (serverName: string) => Promise<ConnectionResult>
  toggleMcpServer: (serverName: string) => Promise<void>
  disconnectMcpServer: (serverName: string) => Promise<void>
}
