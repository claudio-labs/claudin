import type { PluginError } from 'src/shared/types/plugin.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getPluginLspServers } from 'src/plugins/lspPluginIntegration.js'
import { loadAllPluginsCacheOnly } from 'src/plugins/pluginLoader.js'
import type { ScopedLspServerConfig } from 'src/platform/lsp/types.js'

/**
 * Load LSP servers from all enabled plugins. Extracted from getAllLspServers
 * so it can be called independently and tested in isolation.
 */
async function loadPluginLspServers(): Promise<Record<string, ScopedLspServerConfig>> {
  const pluginServers: Record<string, ScopedLspServerConfig> = {}

  const { enabled: plugins } = await loadAllPluginsCacheOnly()

  const results = await Promise.all(
    plugins.map(async plugin => {
      const errors: PluginError[] = []
      try {
        const scopedServers = await getPluginLspServers(plugin, errors)
        return { plugin, scopedServers, errors }
      } catch (e) {
        logForDebugging(
          `Failed to load LSP servers for plugin ${plugin.name}: ${e}`,
          { level: 'error' },
        )
        return { plugin, scopedServers: undefined, errors }
      }
    }),
  )

  for (const { plugin, scopedServers, errors } of results) {
    const serverCount = scopedServers ? Object.keys(scopedServers).length : 0
    if (serverCount > 0) {
      Object.assign(pluginServers, scopedServers)
      logForDebugging(`Loaded ${serverCount} LSP server(s) from plugin: ${plugin.name}`)
    }
    if (errors.length > 0) {
      logForDebugging(`${errors.length} error(s) loading LSP servers from plugin: ${plugin.name}`)
    }
  }

  return pluginServers
}

/**
 * Get all configured LSP servers. Servers are sourced exclusively from
 * enabled plugins (matching the openclaude model — no built-in default
 * server registry and no user/project-settings server definitions).
 *
 * @returns Object containing servers configuration keyed by scoped server name
 */
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}

  try {
    Object.assign(allServers, await loadPluginLspServers())
    logForDebugging(`Total LSP servers loaded: ${Object.keys(allServers).length}`)
  } catch (error) {
    logError(toError(error))
    logForDebugging(`Error loading LSP servers: ${errorMessage(error)}`)
  }

  return {
    servers: allServers,
  }
}
