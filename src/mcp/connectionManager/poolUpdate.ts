import type { Command } from 'src/commands/commands.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'
import type { MCPServerConnection, ServerResource } from 'src/mcp/types.js'
import { commandBelongsToServer } from 'src/mcp/utils.js'
import type { PluginError } from 'src/shared/types/plugin.js'
import type { Tool } from 'src/tools/Tool.js'
import type { McpState, ServerUpdate } from 'src/mcp/connectionManager/types.js'

/**
 * Resolve the new mcp.tools array for one server update, keeping the pool
 * byte-stable for the prompt cache wherever possible. The tools array is
 * serialized into every request's cached prefix, so gratuitous churn here
 * is a full cache invalidation:
 *
 * - POSITIONAL replacement: tools the server already had in the pool keep
 *   their original indices (the VALUE is the fresh tool object, so calls
 *   route to the reconnected client); only genuinely new tools are
 *   appended; tools the server no longer announces are dropped. A
 *   reconnect with an identical tool set therefore serializes to
 *   byte-identical schemas in identical order — zero cache impact.
 *   (The old `reject(prefix) + append` moved the server's block to the
 *   END of the pool on every update — a reorder break even when nothing
 *   actually changed.)
 *
 * - KEEP schemas on 'failed': a crash/network drop is transitory; removing
 *   the tools (and re-adding them on reconnect) paid two full breaks per
 *   blip. The stale entries stay in the pool — a call against the dead
 *   client fails per-call and surfaces to the model as an is_error
 *   tool_result. 'disabled' is an explicit user action, so removal there
 *   is intentional and keeps its break.
 */
export function resolveUpdatedTools(
  current: Tool[],
  clientType: MCPServerConnection['type'],
  prefix: string,
  rawTools: Tool[] | undefined,
): Tool[] {
  // Explicit disable clears; transitory failure preserves; otherwise an
  // undefined payload means "no tool information in this update".
  const tools =
    clientType === 'disabled' ? (rawTools ?? []) : rawTools
  if (tools === undefined) return current

  const nextByName = new Map<string, Tool>()
  for (const t of tools) {
    if (t.name !== undefined) nextByName.set(t.name, t)
  }

  const out: Tool[] = []
  const consumed = new Set<string>()
  for (const t of current) {
    if (!t.name?.startsWith(prefix)) {
      out.push(t)
      continue
    }
    const replacement = nextByName.get(t.name)
    if (replacement) {
      out.push(replacement)
      consumed.add(t.name)
    }
    // else: the server no longer announces this tool — drop it.
  }
  for (const t of tools) {
    if (t.name === undefined || !consumed.has(t.name)) out.push(t)
  }
  return out
}

/** Entry types under which a server can serve no resources. */
const WITHOUT_RESOURCES: ReadonlySet<MCPServerConnection['type']> = new Set([
  'disabled',
  'failed',
  'needs-auth',
])

/**
 * Tools a server brings that are not its own (the shared resource tools)
 * join the pool once, whichever server brought them first.
 */
function dropSharedRepeats(incoming: Tool[], pool: Tool[], prefix: string): Tool[] {
  const shared = new Set<string>()
  for (const tool of pool) {
    if (!tool.name?.startsWith(prefix)) shared.add(tool.name)
  }
  return incoming.filter(tool => tool.name?.startsWith(prefix) || !shared.has(tool.name))
}

function nextTools(pool: Tool[], update: ServerUpdate): Tool[] {
  const prefix = getMcpPrefix(update.name)
  const incoming = update.tools && dropSharedRepeats(update.tools, pool, prefix)
  return resolveUpdatedTools(pool, update.type, prefix, incoming)
}

function nextCommands(commands: Command[], update: ServerUpdate): Command[] {
  const clears = update.type === 'disabled' || update.type === 'failed'
  if (update.commands === undefined && !clears) return commands
  const others = commands.filter(command => !commandBelongsToServer(command, update.name))
  return [...others, ...(update.commands ?? [])]
}

function withoutKey(
  resources: Record<string, ServerResource[]>,
  name: string,
): Record<string, ServerResource[]> {
  if (!Object.hasOwn(resources, name)) return resources
  const { [name]: _gone, ...rest } = resources
  return rest
}

function nextResources(
  resources: Record<string, ServerResource[]>,
  update: ServerUpdate,
): Record<string, ServerResource[]> {
  const list = update.resources
  if (list !== undefined && list.length > 0) return { ...resources, [update.name]: list }
  if (list !== undefined || WITHOUT_RESOURCES.has(update.type)) return withoutKey(resources, update.name)
  return resources
}

function connectionOf(update: ServerUpdate): MCPServerConnection {
  const { tools: _tools, commands: _commands, resources: _resources, ...connection } = update
  return connection as MCPServerConnection
}

function upsert(clients: MCPServerConnection[], entry: MCPServerConnection): MCPServerConnection[] {
  const at = clients.findIndex(client => client.name === entry.name)
  if (at === -1) return [...clients, entry]
  const next = [...clients]
  next[at] = entry
  return next
}

/** One server's update applied to the pool; every other server is left alone. */
export function applyServerUpdate(mcp: McpState, update: ServerUpdate): McpState {
  return {
    ...mcp,
    clients: upsert(mcp.clients, connectionOf(update)),
    tools: nextTools(mcp.tools, update),
    commands: nextCommands(mcp.commands, update),
    resources: nextResources(mcp.resources, update),
  }
}

/** Takes servers out of app state with everything they brought. */
export function removeServers(mcp: McpState, names: readonly string[]): McpState {
  if (names.length === 0) return mcp
  const gone = new Set(names)
  const prefixes = names.map(getMcpPrefix)
  const owned = (tool: Tool) => prefixes.some(prefix => tool.name?.startsWith(prefix))
  return {
    ...mcp,
    clients: mcp.clients.filter(client => !gone.has(client.name)),
    tools: mcp.tools.filter(tool => !owned(tool)),
    commands: mcp.commands.filter(command => !names.some(name => commandBelongsToServer(command, name))),
    resources: names.reduce(withoutKey, mcp.resources),
  }
}

/** Two broken servers of one plugin are two problems, so the server is part of the key. */
function errorKey(error: PluginError): string {
  const plugin = 'plugin' in error ? error.plugin : undefined
  const serverName = 'serverName' in error ? error.serverName : undefined
  return JSON.stringify([error.type, error.source, plugin ?? null, serverName ?? null])
}

/** `existing` itself when every incoming error is already listed. */
export function mergePluginErrors(existing: PluginError[], incoming: readonly PluginError[]): PluginError[] {
  const seen = new Set(existing.map(errorKey))
  const added: PluginError[] = []
  for (const error of incoming) {
    const key = errorKey(error)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(error)
  }
  return added.length === 0 ? existing : [...existing, ...added]
}
