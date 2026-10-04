import { clearServerCache, getMcpToolsCommandsAndResources } from 'src/mcp/client.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from 'src/mcp/claudeai.js'
import {
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
} from 'src/mcp/config.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPError } from 'src/shared/log.js'
import type { PluginError } from 'src/shared/types/plugin.js'
import { dialable, newEntries, planStart } from 'src/mcp/connectionManager/plan.js'
import { mergePluginErrors, removeServers } from 'src/mcp/connectionManager/poolUpdate.js'
import { isServerOff, type ConnectionRuntime } from 'src/mcp/connectionManager/runtime.js'
import type { ServerConfigs } from 'src/mcp/connectionManager/types.js'

type StartInput = {
  dynamicMcpConfig: ServerConfigs | undefined
  isStrictMcpConfig: boolean
  /** The login changed since the last run: the connector listing is stale. */
  loginChanged: boolean
}

const NONE: Promise<ServerConfigs> = Promise.resolve({})

function reportConfigErrors(runtime: ConnectionRuntime, errors: PluginError[]): void {
  runtime.store.setState(prev => {
    const merged = mergePluginErrors(prev.plugins.errors, errors)
    return merged === prev.plugins.errors ? prev : { ...prev, plugins: { ...prev.plugins, errors: merged } }
  })
}

/** Removes the stale servers and lists the new ones, in one state change. */
function relist(runtime: ConnectionRuntime, configs: ServerConfigs) {
  // A queued update for a server about to go would otherwise list it again.
  runtime.flush()
  const plan = planStart(configs, runtime.store.getState().mcp.clients, isServerOff)
  for (const { name } of plan.stale) {
    runtime.redial.cancel(name)
    runtime.retire(name)
  }
  runtime.store.setState(prev => {
    const mcp = removeServers(prev.mcp, plan.stale.map(server => server.name))
    return { ...prev, mcp: { ...mcp, clients: [...mcp.clients, ...plan.add] } }
  })
  return plan
}

function listConnectors(runtime: ConnectionRuntime, connectors: ServerConfigs): void {
  runtime.store.setState(prev => {
    const listed = new Set(prev.mcp.clients.map(client => client.name))
    const add = newEntries(connectors, listed, isServerOff)
    return add.length === 0 ? prev : { ...prev, mcp: { ...prev.mcp, clients: [...prev.mcp.clients, ...add] } }
  })
}

/** Never after unmount; servers in a redial loop are left to it. */
async function dialAll(runtime: ConnectionRuntime, configs: ServerConfigs): Promise<void> {
  if (runtime.isDisposed()) return
  const targets = Object.fromEntries(Object.entries(configs).filter(([name]) => !runtime.redial.isActive(name)))
  await getMcpToolsCommandsAndResources(runtime.adopt, targets)
}

async function closeAll(servers: readonly MCPServerConnection[]): Promise<void> {
  await Promise.all(
    servers
      .filter(server => server.type === 'connected')
      .map(server =>
        clearServerCache(server.name, server.config).catch((error: unknown) =>
          logMCPError(server.name, `Failed to close a stale connection: ${errorMessage(error)}`),
        ),
      ),
  )
}

/** The claude.ai connectors, second: opt-in, under the policy, and never twins of a manual server. */
async function startConnectors(
  runtime: ConnectionRuntime,
  pending: Promise<ServerConfigs>,
  manual: ServerConfigs,
): Promise<void> {
  const listing = await pending
  const { servers } = dedupClaudeAiMcpServers(filterMcpServersByPolicy(listing).allowed, manual)
  listConnectors(runtime, servers)
  await dialAll(runtime, dialable(servers, isServerOff))
}

/**
 * One start-up run: list the configured servers, drop the stale ones, dial
 * the rest, then the connectors. Every dial result reaches app state as it
 * arrives.
 */
export async function startServers(runtime: ConnectionRuntime, input: StartInput): Promise<void> {
  const dynamic = input.dynamicMcpConfig ?? {}
  const withConnectors = !input.isStrictMcpConfig && !doesEnterpriseMcpConfigExist()
  if (withConnectors && input.loginChanged) clearClaudeAIMcpConfigsCache()
  const connectors = withConnectors ? fetchClaudeAIMcpConfigsIfEligible() : NONE

  const loaded = input.isStrictMcpConfig
    ? { servers: {}, errors: [] }
    : await getClaudeCodeMcpConfigs(dynamic, connectors)
  const configs: ServerConfigs = { ...loaded.servers, ...dynamic }
  reportConfigErrors(runtime, loaded.errors)

  const plan = relist(runtime, configs)
  await closeAll(plan.stale)
  await Promise.all([dialAll(runtime, plan.dial), startConnectors(runtime, connectors, configs)])
}
