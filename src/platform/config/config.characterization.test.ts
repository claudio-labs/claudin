/**
 * Characterization suite for `src/platform/config/config.ts`, written BEFORE
 * the barrel split and kept BYTE-IDENTICAL across every extraction commit.
 *
 * An untouched suite that stays green is the only cheap proof that a
 * relocation preserved behavior — `bun run build` and `tsc` both pass over an
 * over-trimmed re-export, and the failure surfaces at runtime instead.
 *
 * Every assertion imports through the `src/platform/config/config.js`
 * specifier on purpose: that is the specifier all ~250 importers use, so the
 * suite fails the moment the barrel stops re-exporting something, or the
 * moment a module-level cache ends up duplicated across two siblings.
 *
 * The pieces most at risk in this split, and the test that pins each:
 *   - `globalConfigChangeListeners` — one Set, reached from both the global
 *     and the project write paths ('notifies on a project write' below)
 *   - `_trustAccepted` — one latch, shared by the getter and the reset
 *   - `projectPathCache` — one Map
 *   - the `_*ForTesting` escape hatches, which are easy to drop from a barrel
 */
import { afterEach, describe, expect, test } from 'bun:test'

import * as configModule from 'src/platform/config/config.js'
import {
  _buildWrittenGlobalConfig,
  CONFIG_WRITE_DISPLAY_THRESHOLD,
  checkHasTrustDialogAccepted,
  DEFAULT_GLOBAL_CONFIG,
  getCurrentProjectConfig,
  getGlobalConfig,
  getGlobalConfigWriteCount,
  getProjectPathForConfig,
  GLOBAL_CONFIG_KEYS,
  type GlobalConfig,
  isGlobalConfigKey,
  isPathTrusted,
  isProjectConfigKey,
  onGlobalConfigChange,
  type ProjectConfig,
  PROJECT_CONFIG_KEYS,
  resetGlobalConfigForTests,
  resetProjectConfigForTests,
  resetTrustDialogAcceptedCacheForTesting,
  saveCurrentProjectConfig,
  saveGlobalConfig,
  SHOW_CACHE_STATS_MODES,
} from 'src/platform/config/config.js'

/**
 * `saveGlobalConfig` uses `Object.assign` onto the test singleton, and so does
 * `resetGlobalConfigForTests` — neither deletes a key. So a test that adds
 * `projects` has to clear it explicitly, or the entry leaks into every file
 * that runs after this one in the same Bun worker.
 */
function restoreConfigSingletons(): void {
  saveGlobalConfig(current => ({ ...current, projects: {} }))
  resetGlobalConfigForTests()
  resetProjectConfigForTests()
  resetTrustDialogAcceptedCacheForTesting()
}

afterEach(restoreConfigSingletons)

// ───────────────────────────────────────────────────────────────────────────
// The barrel's own gate. A split that over-trims one re-export fails here and
// nowhere else — the behavior tests below only reach the symbols they name.
// ───────────────────────────────────────────────────────────────────────────

describe('the module export surface', () => {
  test('exports exactly these runtime symbols', () => {
    expect(Object.keys(configModule).sort()).toEqual([
      'CONFIG_WRITE_DISPLAY_THRESHOLD',
      'DEFAULT_GLOBAL_CONFIG',
      // Re-exported from configConstants.js — a pass-through the barrel has to
      // carry too, and the easiest line to lose in a split.
      'EDITOR_MODES',
      'GLOBAL_CONFIG_KEYS',
      'NOTIFICATION_CHANNELS',
      'PROJECT_CONFIG_KEYS',
      'SHOW_CACHE_STATS_MODES',
      '_buildWrittenGlobalConfig',
      '_getConfigForTesting',
      '_setGlobalConfigCacheForTesting',
      '_wouldLoseAuthStateForTesting',
      'checkHasTrustDialogAccepted',
      'enableConfigs',
      'formatAutoUpdaterDisabledReason',
      'getAutoUpdaterDisabledReason',
      'getCurrentProjectConfig',
      'getCustomApiKeyStatus',
      'getGlobalConfig',
      'getGlobalConfigWriteCount',
      'getManagedClaudeRulesDir',
      'getMemoryPath',
      'getOrCreateUserID',
      'getProjectPathForConfig',
      'getRemoteControlAtStartup',
      'getUserClaudeRulesDir',
      'isAutoUpdaterDisabled',
      'isConfigReadingAllowed',
      'isGlobalConfigKey',
      'isPathTrusted',
      'isProjectConfigKey',
      'onGlobalConfigChange',
      'recordFirstStartTime',
      'resetGlobalConfigForTests',
      'resetProjectConfigForTests',
      'resetTrustDialogAcceptedCacheForTesting',
      'saveCurrentProjectConfig',
      'saveGlobalConfig',
      'shouldSkipPluginAutoupdate',
    ])
  })

  test('every exported symbol is callable or a value, never undefined', () => {
    for (const [name, value] of Object.entries(configModule)) {
      expect(value, `${name} is undefined`).toBeDefined()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Global config. Under NODE_ENV=test both the read and the write short-circuit
// to an in-memory singleton, so these never touch ~/.claudin/config.json.
// ───────────────────────────────────────────────────────────────────────────

describe('global config read/write', () => {
  test('a write is visible to the next read', () => {
    saveGlobalConfig(current => ({ ...current, numStartups: 4242 }))
    expect(getGlobalConfig().numStartups).toBe(4242)
  })

  test('returning the same reference is a no-op', () => {
    let called = 0
    const unsubscribe = onGlobalConfigChange(() => {
      called++
    })
    saveGlobalConfig(current => current)
    unsubscribe()
    expect(called).toBe(0)
  })

  test('resetGlobalConfigForTests restores the test defaults', () => {
    saveGlobalConfig(current => ({
      ...current,
      autoUpdates: true,
      knowledgeGraphEnabled: false,
    }))
    resetGlobalConfigForTests()
    expect(getGlobalConfig().autoUpdates).toBe(false)
    expect(getGlobalConfig().knowledgeGraphEnabled).toBe(true)
  })

  test('getGlobalConfigWriteCount reports disk writes only', () => {
    // Under NODE_ENV=test saveGlobalConfig never reaches the file, so the
    // counter must not move. This pins the counter to the same module as the
    // write path: split them and the accessor reads a second, frozen copy.
    const before = getGlobalConfigWriteCount()
    saveGlobalConfig(current => ({ ...current, numStartups: 7 }))
    expect(getGlobalConfigWriteCount()).toBe(before)
    expect(CONFIG_WRITE_DISPLAY_THRESHOLD).toBe(20)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The listener Set. `saveCurrentProjectConfig` lives in a different cluster
// from `onGlobalConfigChange` after the split and still has to reach the SAME
// Set — a duplicated Set makes 'notifies on a project write' fail and nothing
// else in the repo notice.
// ───────────────────────────────────────────────────────────────────────────

describe('global config change listeners', () => {
  test('a global write notifies, and unsubscribing stops it', () => {
    let called = 0
    const unsubscribe = onGlobalConfigChange(() => {
      called++
    })
    saveGlobalConfig(current => ({ ...current, numStartups: 1 }))
    expect(called).toBe(1)

    unsubscribe()
    saveGlobalConfig(current => ({ ...current, numStartups: 2 }))
    expect(called).toBe(1)
  })

  test('notifies on a project write, not only on a global one', () => {
    let called = 0
    const unsubscribe = onGlobalConfigChange(() => {
      called++
    })
    saveCurrentProjectConfig(current => ({ ...current, exampleFiles: ['a.ts'] }))
    unsubscribe()
    expect(called).toBe(1)
  })

  test('a throwing listener does not block the write', () => {
    const unsubscribe = onGlobalConfigChange(() => {
      throw new Error('listener blew up')
    })
    expect(() => {
      saveGlobalConfig(current => ({ ...current, numStartups: 99 }))
    }).not.toThrow()
    unsubscribe()
    expect(getGlobalConfig().numStartups).toBe(99)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Project config.
// ───────────────────────────────────────────────────────────────────────────

describe('project config read/write', () => {
  test('a write is visible to the next read', () => {
    saveCurrentProjectConfig(current => ({
      ...current,
      exampleFiles: ['src/one.ts'],
    }))
    expect(getCurrentProjectConfig().exampleFiles).toEqual(['src/one.ts'])
  })

  test('returning the same reference is a no-op', () => {
    let called = 0
    const unsubscribe = onGlobalConfigChange(() => {
      called++
    })
    saveCurrentProjectConfig(current => current)
    unsubscribe()
    expect(called).toBe(0)
  })

  test('a structurally identical fresh object does not notify', () => {
    // The immutable-style `{...current}` that changed nothing. Notifying here
    // invalidates downstream caches for free and leaks state across the files
    // that share this singleton, so the deep compare is load-bearing.
    saveCurrentProjectConfig(current => ({ ...current, exampleFiles: ['x.ts'] }))
    let called = 0
    const unsubscribe = onGlobalConfigChange(() => {
      called++
    })
    saveCurrentProjectConfig(current => ({
      ...current,
      exampleFiles: [...(current.exampleFiles ?? [])],
    }))
    unsubscribe()
    expect(called).toBe(0)
  })

  test('resetProjectConfigForTests drops keys the test added', () => {
    saveCurrentProjectConfig(current => ({
      ...current,
      exampleFiles: ['leaked.ts'],
    }))
    resetProjectConfigForTests()
    expect(getCurrentProjectConfig().exampleFiles).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The trust latch. One `let` shared by the getter and the reset.
// ───────────────────────────────────────────────────────────────────────────

describe('trust dialog acceptance', () => {
  test('latches true and only the reset clears it', () => {
    resetTrustDialogAcceptedCacheForTesting()
    const projectPath = getProjectPathForConfig()

    saveGlobalConfig(current => ({
      ...current,
      projects: { [projectPath]: { hasTrustDialogAccepted: true } as ProjectConfig },
    }))
    expect(checkHasTrustDialogAccepted()).toBe(true)

    // Trust only ever goes false→true within a session, so removing the entry
    // must NOT flip the answer back until the cache is explicitly reset.
    saveGlobalConfig(current => ({ ...current, projects: {} }))
    expect(checkHasTrustDialogAccepted()).toBe(true)

    resetTrustDialogAcceptedCacheForTesting()
    expect(checkHasTrustDialogAccepted()).toBe(false)
  })

  test('isPathTrusted walks up from an arbitrary directory', () => {
    saveGlobalConfig(current => ({
      ...current,
      projects: {
        '/tmp/claudin-trust-fixture': {
          hasTrustDialogAccepted: true,
        } as ProjectConfig,
      },
    }))
    expect(isPathTrusted('/tmp/claudin-trust-fixture/deep/child')).toBe(true)
    expect(isPathTrusted('/tmp/claudin-untrusted-fixture')).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Pure predicates and the key lists.
// ───────────────────────────────────────────────────────────────────────────

describe('config key predicates', () => {
  test('isGlobalConfigKey accepts a listed key and rejects anything else', () => {
    expect(isGlobalConfigKey(GLOBAL_CONFIG_KEYS[0]!)).toBe(true)
    expect(isGlobalConfigKey('definitelyNotAGlobalConfigKey')).toBe(false)
  })

  test('isProjectConfigKey accepts a listed key and rejects anything else', () => {
    expect(isProjectConfigKey(PROJECT_CONFIG_KEYS[0]!)).toBe(true)
    expect(isProjectConfigKey('definitelyNotAProjectConfigKey')).toBe(false)
  })

  test('neither key list carries a duplicate', () => {
    expect(new Set(GLOBAL_CONFIG_KEYS).size).toBe(GLOBAL_CONFIG_KEYS.length)
    expect(new Set(PROJECT_CONFIG_KEYS).size).toBe(PROJECT_CONFIG_KEYS.length)
  })
})

describe('defaults', () => {
  test('auto-background agents are off by default', () => {
    // Pinned as a VALUE here. `autoBackground.test.ts` pins the same fact by
    // reading this module's source text, which a relocation moves out from
    // under it — this assertion survives the move.
    expect(DEFAULT_GLOBAL_CONFIG.autoBackgroundAgentsEnabled).toBe(false)
  })

  test('the cache-stats modes are the three the UI cycles through', () => {
    expect([...SHOW_CACHE_STATS_MODES]).toEqual(['off', 'compact', 'full'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The project-path cache (one Map) and the write assembler.
// ───────────────────────────────────────────────────────────────────────────

describe('getProjectPathForConfig', () => {
  test('is stable across calls and returns a normalized absolute path', () => {
    const first = getProjectPathForConfig()
    expect(getProjectPathForConfig()).toBe(first)
    expect(first).not.toContain('\\')
    expect(first.length).toBeGreaterThan(0)
  })
})

describe('_buildWrittenGlobalConfig', () => {
  test('derives projects from the updater result, not from the snapshot', () => {
    const updaterResult: GlobalConfig = {
      ...DEFAULT_GLOBAL_CONFIG,
      projects: {
        '/proj/healed': { hasTrustDialogAccepted: true } as ProjectConfig,
      },
    }
    expect(_buildWrittenGlobalConfig(updaterResult).projects).toEqual({
      '/proj/healed': { hasTrustDialogAccepted: true } as ProjectConfig,
    })
  })
})
