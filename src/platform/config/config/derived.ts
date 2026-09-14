/**
 * Values derived from the global config rather than stored in it: whether the
 * auto-updater is disabled and why, the lazily-minted user id and first-start
 * stamp, and the memory/rules paths.
 *
 * teamMemPaths moves here with getMemoryPath, its only caller, and keeps the
 * ternary form feature() requires — any other shape throws under bun test
 * while the build folds it silently.
 */
import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getAutoMemEntrypoint } from 'src/memory/memdir/paths.js'
import { getClaudinConfigHomeDir, isEnvTruthy } from 'src/shared/envUtils.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import {
  getEssentialTrafficOnlyReason,
  getExplicitEssentialTrafficOnlyReason,
} from 'src/platform/config/privacyLevel.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from 'src/platform/config/config/globalConfig.js'
import type { AutoUpdaterDisabledReason } from 'src/platform/config/config/types.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { PRIMARY_PROJECT_INSTRUCTION_FILE } from 'src/memory/instructions/projectInstructions.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('src/memory/memdir/teamMemPaths.js') as typeof import('src/memory/memdir/teamMemPaths.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

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
