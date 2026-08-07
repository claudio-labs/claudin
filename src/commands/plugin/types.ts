// Reconstructed from its use sites — the original module was not carried into
// this fork. `ViewState`'s arms come from `getInitialViewState()` in
// `PluginSettings.tsx` (which returns the full union) plus the
// `setParentViewState({...})` calls in the child panels.

/**
 * Which panel `/plugin` is showing. Owned by `PluginSettings`; child panels
 * navigate by calling the `setViewState` prop they are handed.
 */
export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'validate'; path: string }
  | { type: 'discover-plugins'; targetPlugin?: string }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      action?: 'enable' | 'disable' | 'uninstall'
    }
  | { type: 'plugin-options'; plugin?: string; pluginId?: string }
  | { type: 'marketplace-menu' }
  | { type: 'marketplace-list' }
  | { type: 'add-marketplace'; initialValue?: string }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'remove' | 'update'
    }
  | {
      type: 'browse-marketplace'
      targetMarketplace: string
      targetPlugin?: string
    }

export type PluginSettingsProps = {
  onComplete: (result?: string) => void
  /** Raw argument string after `/plugin`, parsed by `parsePluginArgs`. */
  args?: string
  showMcpRedirectMessage?: boolean
}
