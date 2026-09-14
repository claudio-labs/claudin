/**
 * Global and per-project config — barrel over ./config/.
 *
 * The ~250 call sites across the codebase keep importing from here; new code
 * should prefer importing directly from the relevant submodule.
 *
 * Splitting layout:
 *   types.ts         — every type and interface, incl. the 496-line GlobalConfig
 *   defaults.ts      — DEFAULT_PROJECT_CONFIG, createDefaultGlobalConfig and the
 *                      two `claudin config set` key lists
 *   fileStore.ts     — the on-disk half: getConfig, the locked and unlocked
 *                      writers, the backup/recovery walk, the enableConfigs
 *                      gate, and the two vars that straddle the seam with
 *                      globalConfig.ts (lastReadFileStats, globalConfigWriteCount)
 *   globalConfig.ts  — the in-memory cache, its freshness watcher, the write
 *                      path, and the change-listener Set every writer notifies
 *   projectConfig.ts — the projects bucket and the cwd → project-path cache
 *                      that keys it
 *   trust.ts         — the trust-dialog latch and its directory walks
 *   derived.ts       — values computed from the config rather than stored in it:
 *                      auto-updater reasons, user id, memory and rules paths
 *
 * fileStore.ts and globalConfig.ts import each other (`getGlobalConfig` reads
 * through `getConfig`; `saveConfigWithLock` calls `wouldLoseAuthState` back).
 * Both ends are hoisted `function` declarations reached at call time and
 * neither touches the other at module-init, so the cycle resolves.
 */

export type {
  AccountInfo,
  AutoUpdaterDisabledReason,
  DiffTool,
  EditorMode,
  GlobalConfig,
  GlobalConfigKey,
  HistoryEntry,
  InstallMethod,
  NotificationChannel,
  OutputStyle,
  PastedContent,
  ProjectConfig,
  ProjectConfigKey,
  ProviderProfile,
  ProviderProfileExtras,
  Providers,
  ReleaseChannel,
  SerializedStructuredHistoryEntry,
  ShowCacheStatsMode,
} from 'src/platform/config/config/types.js'
export { SHOW_CACHE_STATS_MODES } from 'src/platform/config/config/types.js'
export {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  isGlobalConfigKey,
  isProjectConfigKey,
  PROJECT_CONFIG_KEYS,
} from 'src/platform/config/config/defaults.js'
export {
  enableConfigs,
  getGlobalConfigWriteCount,
  isConfigReadingAllowed,
} from 'src/platform/config/config/fileStore.js'
export {
  _buildWrittenGlobalConfig,
  _getConfigForTesting,
  _setGlobalConfigCacheForTesting,
  _wouldLoseAuthStateForTesting,
  CONFIG_WRITE_DISPLAY_THRESHOLD,
  getCustomApiKeyStatus,
  getGlobalConfig,
  getRemoteControlAtStartup,
  onGlobalConfigChange,
  resetGlobalConfigForTests,
  saveGlobalConfig,
} from 'src/platform/config/config/globalConfig.js'
export {
  getCurrentProjectConfig,
  getProjectPathForConfig,
  resetProjectConfigForTests,
  saveCurrentProjectConfig,
} from 'src/platform/config/config/projectConfig.js'
export {
  checkHasTrustDialogAccepted,
  isPathTrusted,
  resetTrustDialogAcceptedCacheForTesting,
} from 'src/platform/config/config/trust.js'
export {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getManagedClaudeRulesDir,
  getMemoryPath,
  getOrCreateUserID,
  getUserClaudeRulesDir,
  isAutoUpdaterDisabled,
  recordFirstStartTime,
  shouldSkipPluginAutoupdate,
} from 'src/platform/config/config/derived.js'
export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from 'src/platform/config/configConstants.js'
