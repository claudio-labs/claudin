// Pure snapshot → patch reducer for the MCP server rows.
//
// Deliberately free of AppState writes, of React and of any MCP client call, so
// the corner cases that actually bite — a server that connects after two
// retries, one the user disconnects mid-session, a plugin server that vanishes
// on /reload-plugins — are testable without a single subprocess.
//
// Mirrors src/agent/tasks/ContainerTask/reconcile.ts, including its founding
// rule: a server that was ALREADY off when we first looked is history, not an
// event, and never gets a row. That rule is what makes `disabled` unambiguous
// everywhere downstream — any `disabled` row was disconnected during this
// session, so the footer can honestly call it "disconnected".

import type { TaskState } from 'src/agent/tasks/types.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import { isMcpServerTask } from 'src/agent/tasks/McpServerTask/types.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'

/** Deterministic task id, so the same server reconciles to the same row across
 * snapshots without keeping a side table. */
export function mcpServerTaskId(serverName: string): string {
  return `mcp_${serverName}`
}

/**
 * Tools each server currently contributes to the pool.
 *
 * Counted by the same `mcp__<server>__` prefix the tool pool itself is keyed on
 * (`resolveUpdatedTools` in `src/mcp/useManageMCPConnections.ts`), so the number
 * on the row is the number of tools the model can actually call — not what the
 * server announced at some point.
 */
export function countToolsByServer(
  tools: readonly { name?: string }[],
  serverNames: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  const prefixes = serverNames.map(
    name => [name, getMcpPrefix(name)] as const,
  )
  for (const [name] of prefixes) counts.set(name, 0)
  for (const tool of tools) {
    const toolName = tool.name
    if (toolName === undefined) continue
    for (const [name, prefix] of prefixes) {
      if (toolName.startsWith(prefix)) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        break
      }
    }
  }
  return counts
}

export type McpReconcilePatch = {
  /** Rows that did not exist before. */
  register: McpServerTaskState[]
  /** Rows whose server changed. Only present when something actually moved. */
  update: McpServerTaskState[]
  /** Task ids to drop from AppState. */
  remove: string[]
}

export const EMPTY_PATCH: McpReconcilePatch = {
  register: [],
  update: [],
  remove: [],
}

/** What the config declares the transport to be. `stdio` is the default because
 * `McpStdioServerConfigSchema` makes its own `type` optional for backwards
 * compatibility — an entry with just `command` is a stdio server. */
function transportOf(client: MCPServerConnection): string {
  return client.config.type ?? 'stdio'
}

function serverInfoOf(
  client: MCPServerConnection,
): { name: string; version: string } | null {
  return client.type === 'connected' ? (client.serverInfo ?? null) : null
}

function errorOf(client: MCPServerConnection): string | null {
  return client.type === 'failed' ? (client.error ?? null) : null
}

/**
 * Build the row a client currently deserves. `prior` carries the identity a row
 * keeps across snapshots — its id, when it first appeared — so a reconnect does
 * not re-sort the tree under the user's cursor.
 */
function rowFor(
  client: MCPServerConnection,
  toolCount: number,
  resourceCount: number,
  now: number,
  prior: McpServerTaskState | undefined,
): McpServerTaskState {
  return {
    id: prior?.id ?? mcpServerTaskId(client.name),
    type: 'mcp_server',
    // Always `running`: the TASK status says "this row is live", and the
    // connection state lives in `connectionType`. A failed server must keep a
    // row — `isBackgroundTask` drops anything that is not running or pending,
    // so spelling the failure here would delete the row that reports it.
    status: 'running',
    description: client.name,
    startTime: prior?.startTime ?? now,
    // No output spool: an MCP server writes nothing we tail. The empty path is
    // what `taskSpoolsOutput` reads to skip the per-turn delta disk read.
    outputFile: '',
    outputOffset: 0,
    notified: false,
    serverName: client.name,
    connectionType: client.type,
    transport: transportOf(client),
    scope: client.config.scope,
    toolCount,
    resourceCount,
    serverInfo: serverInfoOf(client),
    error: errorOf(client),
    reconnectAttempt:
      client.type === 'pending' ? client.reconnectAttempt : undefined,
    maxReconnectAttempts:
      client.type === 'pending' ? client.maxReconnectAttempts : undefined,
  }
}

/** Everything a row paints. Compared field by field rather than by object
 * identity because the MCP slice rebuilds its client array on every batched
 * flush, so identity changes constantly while the row does not. */
function sameRow(a: McpServerTaskState, b: McpServerTaskState): boolean {
  return (
    a.connectionType === b.connectionType &&
    a.transport === b.transport &&
    a.scope === b.scope &&
    a.toolCount === b.toolCount &&
    a.resourceCount === b.resourceCount &&
    a.error === b.error &&
    a.reconnectAttempt === b.reconnectAttempt &&
    a.maxReconnectAttempts === b.maxReconnectAttempts &&
    a.serverInfo?.name === b.serverInfo?.name &&
    a.serverInfo?.version === b.serverInfo?.version
  )
}

/**
 * Fold a fresh view of `AppState.mcp` into the existing rows.
 *
 * `clients` is the whole connection list; the filtering rule lives here so the
 * caller stays a dumb shell.
 */
export function reconcileMcpServers(
  tasks: Readonly<Record<string, TaskState>>,
  clients: readonly MCPServerConnection[],
  toolCounts: ReadonlyMap<string, number>,
  resourceCounts: ReadonlyMap<string, number>,
  now: number,
): McpReconcilePatch {
  const existing = new Map<string, McpServerTaskState>()
  for (const t of Object.values(tasks)) {
    if (isMcpServerTask(t)) existing.set(t.id, t)
  }

  const register: McpServerTaskState[] = []
  const update: McpServerTaskState[] = []
  const keptIds = new Set<string>()

  for (const client of clients) {
    const id = mcpServerTaskId(client.name)
    const prior = existing.get(id)

    if (!prior) {
      // Disabled in settings before we ever looked: the user turned it off, and
      // opening every session with a row for it would make the panel a list of
      // what is NOT running.
      if (client.type === 'disabled') continue
      register.push(
        rowFor(
          client,
          toolCounts.get(client.name) ?? 0,
          resourceCounts.get(client.name) ?? 0,
          now,
          undefined,
        ),
      )
      keptIds.add(id)
      continue
    }

    keptIds.add(id)
    const next = rowFor(
      client,
      toolCounts.get(client.name) ?? 0,
      resourceCounts.get(client.name) ?? 0,
      now,
      prior,
    )
    if (!sameRow(prior, next)) update.push(next)
  }

  // Gone from the connection list entirely — the server left the config, or a
  // plugin that provided it was disabled.
  const remove: string[] = []
  for (const id of existing.keys()) {
    if (!keptIds.has(id)) remove.push(id)
  }

  if (register.length === 0 && update.length === 0 && remove.length === 0) {
    return EMPTY_PATCH
  }
  return { register, update, remove }
}
