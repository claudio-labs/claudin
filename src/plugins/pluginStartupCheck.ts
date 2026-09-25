import { logForDebugging } from 'src/shared/debug.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import { getAddDirEnabledPlugins } from 'src/plugins/addDirPluginSettings.js'
import {
  type ExtendedPluginScope,
  type PersistablePluginScope,
  SETTING_SOURCE_TO_SCOPE,
} from 'src/plugins/pluginIdentifier.js'

/**
 * Gets the user-editable scope that "owns" each enabled plugin.
 *
 * Used for scope tracking: determining where to write back when a user
 * enables/disables a plugin. Managed (policy) settings are processed first
 * (lowest priority) because the user cannot edit them — the scope should
 * resolve to the highest user-controllable source.
 *
 * NOTE: This is NOT the authoritative "is this plugin enabled?" check.
 * Use checkEnabledPlugins() for that — it uses merged settings where
 * policy has highest priority and can block user-enabled plugins.
 *
 * Precedence (lowest to highest):
 * 0. addDir (--add-dir directories) - session-only, lowest priority
 * 1. managed (policySettings) - not user-editable
 * 2. user (userSettings)
 * 3. project (projectSettings)
 * 4. local (localSettings)
 * 5. flag (flagSettings) - session-only, not persisted
 *
 * @returns Map of plugin ID to the user-editable scope that owns it
 */
export function getPluginEditableScopes(): Map<string, ExtendedPluginScope> {
  const result = new Map<string, ExtendedPluginScope>()

  // Process --add-dir directories FIRST (lowest priority, overridden by all standard sources)
  const addDirPlugins = getAddDirEnabledPlugins()
  for (const [pluginId, value] of Object.entries(addDirPlugins)) {
    if (!pluginId.includes('@')) {
      continue
    }
    if (value === true) {
      result.set(pluginId, 'flag') // 'flag' scope = session-only, no write-back
    } else if (value === false) {
      result.delete(pluginId)
    }
  }

  // Process standard sources in precedence order (later overrides earlier)
  const scopeSources: Array<{
    scope: ExtendedPluginScope
    source: SettingSource
  }> = [
    { scope: 'managed', source: 'policySettings' },
    { scope: 'user', source: 'userSettings' },
    { scope: 'project', source: 'projectSettings' },
    { scope: 'local', source: 'localSettings' },
    { scope: 'flag', source: 'flagSettings' },
  ]

  for (const { scope, source } of scopeSources) {
    const settings = getSettingsForSource(source)
    if (!settings?.enabledPlugins) {
      continue
    }

    for (const [pluginId, value] of Object.entries(settings.enabledPlugins)) {
      // Skip invalid format
      if (!pluginId.includes('@')) {
        continue
      }

      // Log when a standard source overrides an --add-dir plugin
      if (pluginId in addDirPlugins && addDirPlugins[pluginId] !== value) {
        logForDebugging(
          `Plugin ${pluginId} from --add-dir (${addDirPlugins[pluginId]}) overridden by ${source} (${value})`,
        )
      }

      if (value === true) {
        // Plugin enabled at this scope
        result.set(pluginId, scope)
      } else if (value === false) {
        // Explicitly disabled - remove from result
        result.delete(pluginId)
      }
      // Note: Other values (like version strings for future P2) are ignored for now
    }
  }

  logForDebugging(
    `Found ${result.size} enabled plugins with scopes: ${Array.from(
      result.entries(),
    )
      .map(([id, scope]) => `${id}(${scope})`)
      .join(', ')}`,
  )

  return result
}


/**
 * Convert SettingSource to plugin scope.
 * @param source The settings source
 * @returns The corresponding plugin scope
 */
export function settingSourceToScope(
  source: SettingSource,
): ExtendedPluginScope {
  return SETTING_SOURCE_TO_SCOPE[source]
}
