import type { MCPServerConnection } from 'src/mcp/types.js'
import { hashMcpConfig } from 'src/mcp/utils.js'
import type { ServerConfigs, StartPlan } from 'src/mcp/connectionManager/types.js'

type IsOff = (name: string) => boolean

/**
 * A listed server is stale when its config changed (scope aside), or when it
 * came from a plugin or `--mcp-config` (scope `dynamic`) and is no longer
 * configured. Other scopes have their own watchers.
 */
function isStale(client: MCPServerConnection, configs: ServerConfigs): boolean {
  if (!Object.hasOwn(configs, client.name)) return client.config.scope === 'dynamic'
  return hashMcpConfig(configs[client.name]!) !== hashMcpConfig(client.config)
}

/** Entries for the servers `listed` does not name yet; one that is off is never shown pending. */
export function newEntries(
  configs: ServerConfigs,
  listed: ReadonlySet<string>,
  isOff: IsOff,
): MCPServerConnection[] {
  return Object.entries(configs)
    .filter(([name]) => !listed.has(name))
    .map(([name, config]) => ({ name, config, type: isOff(name) ? 'disabled' : 'pending' }))
}

export function dialable(configs: ServerConfigs, isOff: IsOff): ServerConfigs {
  return Object.fromEntries(Object.entries(configs).filter(([name]) => !isOff(name)))
}

export function planStart(
  configs: ServerConfigs,
  clients: readonly MCPServerConnection[],
  isOff: IsOff,
): StartPlan {
  const stale = clients.filter(client => isStale(client, configs))
  const listed = new Set(clients.filter(client => !stale.includes(client)).map(client => client.name))
  return {
    add: newEntries(configs, listed, isOff),
    stale,
    dial: dialable(configs, isOff),
  }
}
