/**
 * Per-project config: the `config.projects[<path>]` bucket, the cwd → project
 * path resolution that keys it, and the structural compare that keeps a
 * no-op updater from notifying.
 *
 * Writes go through the same locked writer and the same listener Set as a
 * global write — this module imports `notifyGlobalConfigListeners` from
 * globalConfig.ts rather than keeping a Set of its own.
 */
import { resolve } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import {
  createDefaultGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  DEFAULT_PROJECT_CONFIG,
} from 'src/platform/config/config/defaults.js'
import {
  getConfig,
  saveConfig,
  saveConfigWithLock,
} from 'src/platform/config/config/fileStore.js'
import {
  getGlobalConfig,
  notifyGlobalConfigListeners,
  wouldLoseAuthState,
  writeThroughGlobalConfigCache,
} from 'src/platform/config/config/globalConfig.js'
import type {
  GlobalConfig,
  ProjectConfig,
} from 'src/platform/config/config/types.js'
import { safeParseJSON } from 'src/shared/data/json.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { normalizePathForConfigKey } from 'src/shared/fs/path.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'

const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

function isProjectConfigValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isProjectConfigValueEqual(a[i], b[i])) return false
    }
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set<string>([...Object.keys(ao), ...Object.keys(bo)])
  for (const key of keys) {
    if (!isProjectConfigValueEqual(ao[key], bo[key])) return false
  }
  return true
}

// Structural equality for ProjectConfig — recurses into nested objects (e.g.
// `mcpServers`, `mcpServerApprovals`) so an updater that returns
// `{...current, mcpServers: {...current.mcpServers}}` without any real change
// is correctly recognized as a no-op and doesn't churn the listener cache.
function deepEqualProjectConfig(
  a: ProjectConfig,
  b: ProjectConfig,
): boolean {
  return isProjectConfigValueEqual(a, b)
}

/** Call this in afterEach/afterAll when a test modifies project config, to prevent state leaking into sibling test files that share the same Bun worker. */
export function resetProjectConfigForTests(): void {
  if (process.env.NODE_ENV !== 'test') return
  for (const key of Object.keys(TEST_PROJECT_CONFIG_FOR_TESTING)) {
    delete (TEST_PROJECT_CONFIG_FOR_TESTING as Record<string, unknown>)[key]
  }
  Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, DEFAULT_PROJECT_CONFIG)
}

// Get the project path used as the key in `config.projects[...]`.
//
// Keyed on the current originalCwd so process.chdir(), session resume into a
// different project, gRPC connections serving multiple cwds, and worktree
// enter/exit all read the right project bucket. (A naive global memoize would
// freeze on whatever cwd happened to call this first.)
// Bounded so long-lived processes (gRPC servers, daemons, sessions that
// resume into many distinct cwds) don't grow unbounded. 32 entries is enough
// to cover realistic interactive flows including worktree fan-out, and old
// entries fall off via simple FIFO eviction when the cap is reached.
const PROJECT_PATH_CACHE_MAX = 32
const projectPathCache = new Map<string, string>()
export function getProjectPathForConfig(): string {
  const originalCwd = getOriginalCwd()
  const cached = projectPathCache.get(originalCwd)
  if (cached !== undefined) {
    // Touch: move to the most-recently-used end of the Map iteration order
    // so a long-lived process cycling through >32 cwds doesn't evict hot
    // entries first (plain FIFO would). Map preserves insertion order, so
    // delete+set re-inserts at the tail.
    projectPathCache.delete(originalCwd)
    projectPathCache.set(originalCwd, cached)
    return cached
  }

  const gitRoot = findCanonicalGitRoot(originalCwd)
  // Normalize for consistent JSON keys (forward slashes on all platforms)
  // so paths like C:\Users\... and C:/Users/... map to the same key.
  const resolved = gitRoot
    ? normalizePathForConfigKey(gitRoot)
    : normalizePathForConfigKey(resolve(originalCwd))
  if (projectPathCache.size >= PROJECT_PATH_CACHE_MAX) {
    const oldest = projectPathCache.keys().next().value
    if (oldest !== undefined) projectPathCache.delete(oldest)
  }
  projectPathCache.set(originalCwd, resolved)
  return resolved
}

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // Not sure how this became a string
  // TODO: Fix upstream
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    // Even when the updater returned a fresh reference, it may be structurally
    // identical to the current singleton (an immutable-style `{...current}`
    // that didn't actually touch any field). Notifying listeners in that case
    // invalidates downstream caches (e.g. getGlobalConfig) for no reason and
    // leaks state across tests that share the singleton.
    const changed = !deepEqualProjectConfig(
      TEST_PROJECT_CONFIG_FOR_TESTING,
      config,
    )
    if (!changed) return
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    notifyGlobalConfigListeners()
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // Skip if no changes (same reference returned)
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
      notifyGlobalConfigListeners()
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // Same race window as saveGlobalConfig's fallback -- refuse to write
    // defaults over good cached config. See GH #3117.
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // Skip if no changes (same reference returned)
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
    notifyGlobalConfigListeners()
  }
}
