// Reconstructed from its use sites — the original module was not carried into
// this fork. The four arms are the literals pushed into the
// `UnifiedInstalledItem[]` accumulators in `ManagePlugins.tsx`, and the fields
// read by `UnifiedInstalledCell.tsx`.
import type { LoadedPlugin, PluginError } from 'src/types/plugin.js'
import type { PersistablePluginScope } from 'src/services/plugins/pluginIdentifier.js'
import type { ConfigScope, MCPServerConnection } from 'src/services/mcp/types.js'

/** Scope a plugin row is grouped under in the installed list. */
export type UnifiedPluginScope =
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | 'builtin'

type UnifiedInstalledItemBase = {
  id: string
  name: string
  /** Renders the row nested under the plugin that owns it. */
  indented?: boolean
}

export type UnifiedInstalledPluginItem = UnifiedInstalledItemBase & {
  type: 'plugin'
  description?: string
  marketplace: string
  scope: UnifiedPluginScope
  isEnabled: boolean
  errorCount: number
  errors: PluginError[]
  plugin: LoadedPlugin
  pendingEnable?: boolean
  pendingUpdate?: boolean
  /** Optimistic toggle state, cleared once the settings write lands. */
  pendingToggle?: 'will-enable' | 'will-disable'
}

export type UnifiedInstalledMcpItem = UnifiedInstalledItemBase & {
  type: 'mcp'
  description: string | undefined
  scope: ConfigScope
  status: 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'
  client: MCPServerConnection
}

/**
 * A plugin that failed to load. It has no `LoadedPlugin`, so it is a separate
 * arm rather than a `plugin` row with errors.
 */
export type UnifiedInstalledFailedPluginItem = UnifiedInstalledItemBase & {
  type: 'failed-plugin'
  marketplace: string
  scope: PersistablePluginScope
  errorCount: number
  errors: PluginError[]
}

/**
 * A plugin delisted from its marketplace, surfaced from the cached security
 * messages file rather than a live `LoadedPlugin`/load failure.
 */
export type UnifiedInstalledFlaggedPluginItem = UnifiedInstalledItemBase & {
  type: 'flagged-plugin'
  marketplace: string
  scope: 'flagged'
  reason: string
  text: string
  flaggedAt: string
}

/** One row of the unified "installed" list: plugins and MCP servers together. */
export type UnifiedInstalledItem =
  | UnifiedInstalledPluginItem
  | UnifiedInstalledMcpItem
  | UnifiedInstalledFailedPluginItem
  | UnifiedInstalledFlaggedPluginItem
