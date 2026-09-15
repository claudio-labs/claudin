/**
 * The global config: its in-memory cache, the write path that keeps that cache
 * and the on-disk file in step, and the change-listener Set every writer
 * notifies.
 *
 * The listener Set lives here and nowhere else — `saveCurrentProjectConfig`
 * sits in projectConfig.ts and still has to reach THIS Set, which is exactly
 * what the characterization suite's 'notifies on a project write' pins.
 *
 * This module and fileStore.ts import each other: `getGlobalConfig` reads
 * through `getConfig`, and `saveConfigWithLock` calls `wouldLoseAuthState`
 * back. Both ends are hoisted `function` declarations reached at call time,
 * and nothing here touches fileStore at module-init, so the cycle resolves the
 * same way bashSecurity/heredoc.ts ↔ dispatch.ts does.
 */
import { feature } from 'bun:bundle'
import { unwatchFile, watchFile } from 'fs'
import { logEvent } from 'src/platform/analytics/index.js'
import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
} from 'src/platform/config/config/defaults.js'
import {
  getConfig,
  saveConfig,
  saveConfigWithLock,
  setLastReadFileStats,
} from 'src/platform/config/config/fileStore.js'
import type {
  GlobalConfig,
  InstallMethod,
  ProjectConfig,
} from 'src/platform/config/config/types.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { safeParseJSON } from 'src/shared/data/json.js'
import { stripBOM } from 'src/shared/data/jsonRead.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('src/platform/bridge/bridgeEnabled.js') as typeof import('src/platform/bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

// We have to put this test code here because Jest doesn't support mocking ES modules :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
  knowledgeGraphEnabled: true,
}

/** Call this in afterEach/afterAll when a test modifies the global config, to prevent state leaking into sibling test files that share the same Bun worker. */
export function resetGlobalConfigForTests(): void {
  if (process.env.NODE_ENV !== 'test') return
  Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, {
    ...DEFAULT_GLOBAL_CONFIG,
    autoUpdates: false,
    knowledgeGraphEnabled: true,
  })
}

/**
 * Detect whether writing `fresh` would lose auth/onboarding state that the
 * in-memory cache still has. This happens when `getConfig` hits a corrupted
 * or truncated file mid-write (from another process or a non-atomic fallback)
 * and returns DEFAULT_GLOBAL_CONFIG. Writing that back would permanently
 * wipe auth. See GH #3117.
 */
export function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

type GlobalConfigChangeListener = () => void
const globalConfigChangeListeners = new Set<GlobalConfigChangeListener>()

export function onGlobalConfigChange(
  listener: GlobalConfigChangeListener,
): () => void {
  globalConfigChangeListeners.add(listener)
  return () => globalConfigChangeListeners.delete(listener)
}

export function notifyGlobalConfigListeners(): void {
  for (const listener of globalConfigChangeListeners) {
    try {
      listener()
    } catch {
      // listener errors must not block writes
    }
  }
}

/**
 * Assembles the config that saveGlobalConfig persists from an updater result.
 * MUST derive `projects` from the updater result itself: building it from the
 * pre-updater snapshot silently discards any project edits the updater made
 * (this clobber is why deleteProviderProfile's project-override cleanup never
 * persisted in production). Exported for tests via _buildWrittenGlobalConfig.
 */
function buildWrittenGlobalConfig(config: GlobalConfig): GlobalConfig {
  return {
    ...config,
    projects: removeProjectHistory(config.projects),
  }
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    notifyGlobalConfigListeners()
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // Skip if no changes (same reference returned)
        if (config === current) {
          return current
        }
        written = buildWrittenGlobalConfig(config)
        return written
      },
    )
    // Only write-through if we actually wrote. If the auth-loss guard
    // tripped (or the updater made no changes), the file is untouched and
    // the cache is still valid -- touching it would corrupt the guard.
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
      notifyGlobalConfigListeners()
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      logForDebugging(
        `Skipping global config write due to permission error: ${error}`,
        { level: 'error' },
      )
      return
    }
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // Fall back to non-locked version on error. This fallback is a race
    // window: if another process is mid-write (or the file got truncated),
    // getConfig returns defaults. Refuse to write those over a good cached
    // config to avoid wiping auth. See GH #3117.
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // Skip if no changes (same reference returned)
    if (config === currentConfig) {
      return
    }
    written = buildWrittenGlobalConfig(config)
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
    notifyGlobalConfigListeners()
  }
}

// Cache for global config
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// Tracking for config file operations (telemetry)
let configCacheHits = 0
let configCacheMisses = 0

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// Register cleanup to report cache stats at session end
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * Migrates old autoUpdaterStatus to new installMethod and autoUpdates fields
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // Already migrated
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus is removed from the type but may exist in old configs
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // Determine install method and auto-update preference from old field
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // Default to enabled unless explicitly disabled

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // When disabled, we don't know the install method
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // These imply global installation
      installMethod = 'global'
      break
    case undefined:
      // No old status, keep defaults
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * Removes history field from projects (migrated to history.jsonl)
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history is removed from the type but may exist in old configs
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile poll interval for detecting writes from other instances (ms)
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile polls stat on the libuv threadpool and only calls us when mtime
// changed — a stalled stat never blocks the main thread.
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // Our own writes fire this too — the write-through's Date.now()
      // overshoot makes cache.mtime > file mtime, so we skip the re-read.
      // Bun/Node also fire with curr.mtimeMs=0 when the file doesn't exist
      // (initial callback or deletion) — the <= handles that too.
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // A write-through may have advanced the cache while we were reading;
          // don't regress to the stale snapshot watchFile stat'd.
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          setLastReadFileStats({ mtime: curr.mtimeMs, size: curr.size })
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through: what we just wrote IS the new config. cache.mtime overshoots
// the file's real mtime (Date.now() is recorded after the write) so the
// freshness watcher skips re-reading our own write on its next tick.
export function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  setLastReadFileStats(null)
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // Fast path: pure memory read. After startup, this always hits — our own
  // writes go write-through and other instances' writes are picked up by the
  // background freshness watcher (never blocks this path).
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // Slow path: startup load. Sync I/O here is acceptable because it runs
  // exactly once, before any UI is rendered. Stat before read so any race
  // self-corrects (old mtime + new content → watcher re-reads next tick).
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // File doesn't exist
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    setLastReadFileStats(
      stats ? { mtime: stats.mtimeMs, size: stats.size } : null,
    )
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // If anything goes wrong, fall back to uncached behavior
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/**
 * Returns the effective value of remoteControlAtStartup. Precedence:
 *   1. User's explicit config value (always wins — honors opt-out)
 *   2. CCR auto-connect default (internal-only build, GrowthBook-gated)
 *   3. false (Remote Control must be explicitly opted into)
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

// Exported for testing only
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export const _buildWrittenGlobalConfig = buildWrittenGlobalConfig
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
