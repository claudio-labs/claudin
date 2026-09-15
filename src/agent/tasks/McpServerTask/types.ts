// Pure type + guard for the MCP server row, kept apart from the task module so
// the reconcile reducer and the footer geometry can import it without pulling in
// the MCP client or React.
//
// Mirrors src/agent/tasks/ContainerTask/types.ts, for the same reason: the row
// is a flattened SNAPSHOT of the server, not a handle on the live connection.
// Holding an `MCPServerConnection` here would put an SDK `Client` — and its
// transport — inside AppState, where every selector would have to walk past it.

import type { TaskStateBase } from 'src/agent/Task.js'
import type { ConfigScope, MCPServerConnection } from 'src/mcp/types.js'
import type { McpStatusInput } from 'src/mcp/serverStatus.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'

export type McpServerTaskState = TaskStateBase & {
  type: 'mcp_server'
  /** The server's name in `.mcp.json` / settings — the key the rest of the MCP
   * slice addresses it by, and what reconnect and disconnect take. */
  serverName: string
  /** Latest connection state. `disabled` here always means "disconnected during
   * this session": a server that was already disabled when the session started
   * never gets a row (see `reconcile.ts`). */
  connectionType: MCPServerConnection['type']
  /** `stdio`, `http`, `sse`, `ws`, `sdk`, … as declared in the config. */
  transport: string
  scope: ConfigScope
  /** Tools this server contributes to the pool right now. */
  toolCount: number
  /** Resources it exposes, or 0 when it exposes none. */
  resourceCount: number
  /** From the MCP handshake, when there was one. */
  serverInfo: { name: string; version: string } | null
  /** Why the connection failed, verbatim. Null unless `connectionType` is
   * `failed`. */
  error: string | null
  /** Reconnect bookkeeping, present only while `connectionType` is `pending`
   * AND a retry is actually under way. */
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

export function isMcpServerTask(task: unknown): task is McpServerTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'mcp_server'
  )
}

/**
 * The shape `src/mcp/serverStatus.ts` reads, projected out of a row.
 *
 * A row cannot BE an `McpStatusInput` because `type` already names the task
 * type, so every caller that wants the wording or the bucket goes through here
 * rather than assembling the object itself.
 */
export function mcpTaskStatusInput(
  task: DeepImmutable<McpServerTaskState>,
): McpStatusInput {
  return {
    type: task.connectionType,
    reconnectAttempt: task.reconnectAttempt,
    maxReconnectAttempts: task.maxReconnectAttempts,
  }
}

/**
 * Whether disconnecting this row means anything.
 *
 * NOT the same question as `task.status === 'running'`, which every other task
 * type answers with: an MCP row keeps a `running` TASK status through every
 * connection state, so that check would offer `x` on a server that is already
 * disconnected or still dialling.
 */
export function isMcpServerDisconnectable(
  task: DeepImmutable<McpServerTaskState>,
): boolean {
  return task.connectionType === 'connected'
}
