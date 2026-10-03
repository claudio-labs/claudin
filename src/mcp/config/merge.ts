import { getPluginMcpServers } from 'src/plugins/mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from 'src/plugins/pluginLoader.js'
import { isRestrictedToPluginOnly } from 'src/platform/settings/pluginOnlyPolicy.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { getPluginErrorMessage, type LoadedPlugin, type PluginError } from 'src/shared/types/plugin.js'
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/mcp/claudeai.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getProjectMcpServerStatus } from 'src/mcp/utils.js'
import { dedupClaudeAiMcpServers, dedupPluginMcpServers } from 'src/mcp/config/dedup.js'
import { splitByPolicy } from 'src/mcp/config/policySettings.js'
import { doesEnterpriseMcpConfigExist, getMcpConfigsByScope } from 'src/mcp/config/scopes.js'
import { isMcpServerDisabled } from 'src/mcp/config/toggles.js'

type Servers = Record<string, ScopedMcpServerConfig>

export type MergedConfigs = { servers: Servers; errors: PluginError[] }

type PluginServers = {
  servers: Servers
  /** Which plugin declared each key, and the server's own name inside it. */
  origins: Map<string, { plugin: string; serverName: string }>
  errors: PluginError[]
}

/** The managed lock and the merge both judge config scopes strictly, SDK servers included. */
function passingPolicy(servers: Servers): Servers {
  return splitByPolicy(servers, { exemptSdk: false }).allowed
}

function enabledAndAllowed(servers: Servers): Servers {
  return passingPolicy(Object.fromEntries(Object.entries(servers).filter(([name]) => !isMcpServerDisabled(name))))
}

function approvedOnly(servers: Servers): Servers {
  return Object.fromEntries(Object.entries(servers).filter(([name]) => getProjectMcpServerStatus(name) === 'approved'))
}

async function serversOfPlugin(plugin: LoadedPlugin): Promise<{ servers: Servers; errors: PluginError[] }> {
  const errors: PluginError[] = []
  try {
    return { servers: (await getPluginMcpServers(plugin, errors)) ?? {}, errors }
  } catch (error) {
    logError(error)
    return { servers: {}, errors }
  }
}

async function loadPluginServers(): Promise<PluginServers> {
  const collected: PluginServers = { servers: {}, origins: new Map(), errors: [] }
  let plugins: LoadedPlugin[]
  try {
    const loaded = await loadAllPluginsCacheOnly()
    // Load failures belong to the plugin system's own report, not to MCP's.
    for (const failure of loaded.errors) logForDebugging(`MCP config: plugin not loaded: ${getPluginErrorMessage(failure)}`)
    plugins = loaded.enabled
  } catch (error) {
    logError(error)
    return collected
  }
  const perPlugin = await Promise.all(plugins.map(serversOfPlugin))
  perPlugin.forEach(({ servers, errors }, i) => {
    const plugin = plugins[i]!.name
    const prefix = `plugin:${plugin}:`
    collected.errors.push(...errors)
    for (const [key, config] of Object.entries(servers)) {
      collected.servers[key] = config
      collected.origins.set(key, { plugin, serverName: key.startsWith(prefix) ? key.slice(prefix.length) : key })
    }
  })
  return collected
}

/**
 * Every configured server a session may connect to, `dynamicServers` aside:
 * those, and the awaited `extraDedupTargets`, only suppress plugin twins.
 */
export async function getClaudeCodeMcpConfigs(
  dynamicServers: Servers = {},
  extraDedupTargets: Promise<Servers> = Promise.resolve({}),
): Promise<MergedConfigs> {
  if (doesEnterpriseMcpConfigExist()) {
    return { servers: passingPolicy(getMcpConfigsByScope('enterprise').servers), errors: [] }
  }

  const pluginsOnly = isRestrictedToPluginOnly('mcp')
  const user = pluginsOnly ? {} : getMcpConfigsByScope('user').servers
  const project = pluginsOnly ? {} : approvedOnly(getMcpConfigsByScope('project').servers)
  const local = pluginsOnly ? {} : getMcpConfigsByScope('local').servers

  const plugins = await loadPluginServers()
  const targets = enabledAndAllowed({ ...user, ...project, ...local, ...dynamicServers, ...(await extraDedupTargets) })
  // Disabled or blocked plugin servers sit the race out, and stay in the result.
  const { suppressed } = dedupPluginMcpServers(enabledAndAllowed(plugins.servers), targets)
  const losers = new Set(suppressed.map(({ name }) => name))
  const keptPlugins = Object.fromEntries(Object.entries(plugins.servers).filter(([key]) => !losers.has(key)))

  const suppressionErrors: PluginError[] = suppressed.map(({ name, duplicateOf }) => {
    const origin = plugins.origins.get(name)
    return {
      type: 'mcp-server-suppressed-duplicate',
      source: name,
      plugin: origin?.plugin ?? name,
      serverName: origin?.serverName ?? name,
      duplicateOf,
    }
  })

  return {
    servers: passingPolicy({ ...keptPlugins, ...user, ...project, ...local }),
    errors: [...plugins.errors, ...suppressionErrors],
  }
}

/** The configured servers plus the claude.ai connectors, which rank lowest. */
export async function getAllMcpConfigs(): Promise<MergedConfigs> {
  if (doesEnterpriseMcpConfigExist()) return getClaudeCodeMcpConfigs()
  const connectorsPending = fetchClaudeAIMcpConfigsIfEligible()
  const configured = await getClaudeCodeMcpConfigs({}, connectorsPending)
  const connectors = splitByPolicy(await connectorsPending, { exemptSdk: true }).allowed
  const { servers: newConnectors } = dedupClaudeAiMcpServers(connectors, configured.servers)
  return { servers: { ...newConnectors, ...configured.servers }, errors: configured.errors }
}
