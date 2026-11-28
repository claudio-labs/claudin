/**
 * One server's update to AppState's mcp slice, as a plain function: the
 * connection hook (useManageMCPConnections.ts) batches these, and the TTL
 * refresh (listTtlRefresh.ts) applies them outside React.
 */
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import type { Command } from 'src/commands/commands.js'
import type { MCPServerConnection, ServerResource } from 'src/mcp/types.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/mcp/utils.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { Tool } from 'src/tools/Tool.js'

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

/** One server's new state, with the lists that changed; an undefined list is kept as it is. */
export type McpServerUpdate = MCPServerConnection & {
  tools?: Tool[]
  commands?: Command[]
  resources?: ServerResource[]
}

/**
 * AppState's mcp slice with `update` applied. When tools, commands, or
 * resources are undefined, the existing values are preserved. When type is
 * 'disabled', tools/commands/resources are cleared; 'failed' clears
 * commands/resources but KEEPS tools (prompt-cache stability — see
 * resolveUpdatedTools).
 */
export function applyServerUpdate(
  mcp: AppState['mcp'],
  update: McpServerUpdate,
): AppState['mcp'] {
  const {
    tools: rawTools,
    commands: rawCmds,
    resources: rawRes,
    ...client
  } = update
  const commands =
    client.type === 'disabled' || client.type === 'failed'
      ? (rawCmds ?? [])
      : rawCmds
  const resources =
    client.type === 'disabled' || client.type === 'failed'
      ? (rawRes ?? [])
      : rawRes

  const prefix = getMcpPrefix(client.name)
  const existingClientIndex = mcp.clients.findIndex(
    c => c.name === client.name,
  )

  const updatedClients =
    existingClientIndex === -1
      ? [...mcp.clients, client]
      : mcp.clients.map(c => (c.name === client.name ? client : c))

  // Positional, failure-tolerant tool-pool update — see
  // resolveUpdatedTools for the prompt-cache rationale.
  const updatedTools = resolveUpdatedTools(
    mcp.tools,
    client.type,
    prefix,
    rawTools,
  )

  const updatedCommands =
    commands === undefined
      ? mcp.commands
      : [
          ...reject(mcp.commands, c =>
            commandBelongsToServer(c, client.name),
          ),
          ...commands,
        ]

  const updatedResources =
    resources === undefined
      ? mcp.resources
      : {
          ...mcp.resources,
          ...(resources.length > 0
            ? { [client.name]: resources }
            : omit(mcp.resources, client.name)),
        }

  return {
    ...mcp,
    clients: updatedClients,
    tools: updatedTools,
    commands: updatedCommands,
    resources: updatedResources,
  }
}
