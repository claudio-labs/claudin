import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getPluginLspServers } from '../../utils/plugins/lspPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { getBuiltinLspServers } from './builtinServers.js'
import { getUserLspSettings } from './userSettings.js'
import type { ScopedLspServerConfig } from './types.js'

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
 * Get all configured LSP servers from all sources, merged by precedence:
 *   builtin (lowest) < plugin < user (highest)
 *
 * @returns Object containing servers configuration keyed by scoped server name
 */
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}

  try {
    // 1. Built-ins (lowest precedence)
    let builtins: Record<string, ScopedLspServerConfig> = {}
    try {
      builtins = await getBuiltinLspServers()
      logForDebugging(`Loaded ${Object.keys(builtins).length} built-in LSP server(s)`)
    } catch (error) {
      logError(toError(error))
      logForDebugging(`Error loading built-in LSP servers: ${errorMessage(error)}`)
    }

    // 2. Plugin servers (override built-ins of the same name)
    let pluginServers: Record<string, ScopedLspServerConfig> = {}
    try {
      pluginServers = await loadPluginLspServers()
    } catch (error) {
      logError(toError(error))
      logForDebugging(`Error loading plugin LSP servers: ${errorMessage(error)}`)
    }

    // Merge: plugin wins over builtin on key collision
    Object.assign(allServers, builtins, pluginServers)

    // 3. User settings (highest precedence — can disable or add servers)
    const userSettings = getUserLspSettings()
    for (const [key, cfg] of Object.entries(userSettings)) {
      if (cfg.disabled) {
        delete allServers[key]
        continue
      }
      if (cfg.command && cfg.command.length > 0) {
        const [command, ...args] = cfg.command
        // Register under the bare key so user commands replace (not coexist with) a same-name builtin/plugin
        allServers[key] = {
          command: command as string,
          args,
          extensionToLanguage: Object.fromEntries(
            (cfg.extensions ?? []).map(e => [e, e.startsWith('.') ? e.slice(1) : e]),
          ),
          scope: 'dynamic',
          source: 'user',
        }
      }
    }

    logForDebugging(`Total LSP servers loaded: ${Object.keys(allServers).length}`)
  } catch (error) {
    logError(toError(error))
    logForDebugging(`Error loading LSP servers: ${errorMessage(error)}`)
  }

  return {
    servers: allServers,
  }
}
