import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from 'src/platform/bootstrap/state.js'
import { getAutoMemEntrypoint } from 'src/memory/memdir/paths.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getClaudinConfigHomeDir, isEnvTruthy } from 'src/shared/envUtils.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { normalizePathForConfigKey } from 'src/shared/fs/path.js'
import {
  getEssentialTrafficOnlyReason,
  getExplicitEssentialTrafficOnlyReason,
} from 'src/platform/config/privacyLevel.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { PRIMARY_PROJECT_INSTRUCTION_FILE } from 'src/memory/instructions/projectInstructions.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('src/memory/memdir/teamMemPaths.js') as typeof import('src/memory/memdir/teamMemPaths.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { AutoUpdaterDisabledReason } from 'src/platform/config/config/types.js'

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
import {
  getGlobalConfig,
  saveGlobalConfig,
} from 'src/platform/config/config/globalConfig.js'

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
import { getProjectPathForConfig } from 'src/platform/config/config/projectConfig.js'

export {
  getCurrentProjectConfig,
  getProjectPathForConfig,
  resetProjectConfigForTests,
  saveCurrentProjectConfig,
} from 'src/platform/config/config/projectConfig.js'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from 'src/platform/config/configConstants.js'

/**
 * Check if the user has already accepted the trust dialog for the cwd.
 *
 * This function traverses parent directories to check if a parent directory
 * had approval. Accepting trust for a directory implies trust for child
 * directories.
 *
 * @returns Whether the trust dialog has been accepted (i.e. "should not be shown")
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // Trust only transitions false→true during a session (never the reverse),
  // so once true we can latch it. false is not cached — it gets re-checked
  // on every call so that trust dialog acceptance is picked up mid-session.
  // (lodash memoize doesn't fit here because it would also cache false.)
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // Check session-level trust (for home directory case where trust is not persisted)
  // When running from home dir, trust dialog is shown but acceptance is stored
  // in memory only. This allows hooks and other features to work during the session.
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // Always check where trust would be saved (git root or original cwd)
  // This is the primary location where trust is persisted by saveCurrentProjectConfig
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // Now check from current working directory and its parents
  // Normalize paths for consistent JSON key lookup
  let currentPath = normalizePathForConfigKey(getCwd())

  // Traverse all parent directories
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // Stop if we've reached the root (when parent is same as current)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * Check trust for an arbitrary directory (not the session cwd).
 * Walks up from `dir`, returning true if any ancestor has trust persisted.
 * Unlike checkHasTrustDialogAccepted, this does NOT consult session trust or
 * the memoized project path — use when the target dir differs from cwd (e.g.
 * /assistant installing into a user-typed path).
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * Returns true if plugin autoupdate should be skipped.
 * This checks if the auto-updater is disabled AND the FORCE_AUTOUPDATE_PLUGINS
 * env var is not set to 'true'. The env var allows forcing plugin autoupdate
 * even when the auto-updater is otherwise disabled.
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(options?: {
  /**
   * Treat the Claudin-default essential-traffic privacy level as NOT
   * disabling. Explicitly-set *_DISABLE_NONESSENTIAL_TRAFFIC env vars still
   * disable. Used by the startup version notice, which never installs
   * anything: the default privacy level exists to suppress Anthropic-backend
   * startup probes, and gating the throttled npm version check on it made
   * the "new version available" banner dead code for every default-config
   * user. Note this also un-shadows the `autoUpdates: false` config check
   * below, which the default reason used to short-circuit past.
   */
  ignoreClaudinDefaultPrivacy?: boolean
}): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = options?.ignoreClaudinDefaultPrivacy
    ? getExplicitEssentialTrafficOnlyReason()
    : getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudinConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, PRIMARY_PROJECT_INSTRUCTION_FILE)
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem is only a valid MemoryType when feature('TEAMMEM') is true
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // unreachable in external builds where TeamMem is not in MemoryType
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claudin', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudinConfigHomeDir(), 'rules')
}
