/**
 * A plugin-hook load that fails before a start's hooks run. The load's memo
 * is seeded with a rejected load, as no plugin on disk makes it throw.
 *
 * The load is driven directly rather than through the start functions: other
 * suites replace `sessionStart.js` with stubs that outlive them, and in Bun a
 * stub of a re-exporting module replaces the re-exported function as well.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { clearPluginHookCache, loadPluginHooks } from 'src/plugins/loadPluginHooks.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  loadPluginHooksBeforeStart,
  pluginLoadWarning,
} from 'src/sessions/lifecycle/startHooks/pluginHooks.js'
import { getInMemoryErrors } from 'src/shared/log.js'

const CLEARED_ENV = [
  'CLAUDIN_SIMPLE',
  'DISABLE_ERROR_REPORTING',
  'ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC',
] as const

let env: EnvSnapshot
let configDir: string

beforeAll(() => {
  env = envSnapshot(['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC', ...CLEARED_ENV])
})

beforeEach(() => {
  configDir = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-plugin-hooks-')))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  for (const key of CLEARED_ENV) delete process.env[key]
  // The in-memory error log records only while nonessential traffic is enabled.
  process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  resetSettingsCache()
  resetHooksConfigSnapshot()
})

afterEach(() => {
  clearPluginHookCache()
  env.restore()
  resetSettingsCache()
  resetHooksConfigSnapshot()
  rmSync(configDir, { recursive: true, force: true })
})

afterAll(() => env.restore())

function failPluginHookLoading(reason: unknown): void {
  const failed = Promise.reject(reason)
  failed.catch(() => {})
  loadPluginHooks.cache.set(undefined, failed)
}

const lastLoggedError = () => getInMemoryErrors().at(-1)?.error ?? ''

describe('a failed plugin-hook load', () => {
  test('an Error is logged together with the start it interrupted', async () => {
    failPluginHookLoading(new Error('marketplace offline'))

    await loadPluginHooksBeforeStart('SessionStart', 'clear')

    expect(lastLoggedError()).toContain('marketplace offline')
    expect(lastLoggedError()).toContain('SessionStart (clear)')
  })

  test('before Setup it only leaves a debug warning, never an error', async () => {
    const before = getInMemoryErrors().length
    failPluginHookLoading(new Error('EACCES: permission denied, mkdir plugins'))

    await loadPluginHooksBeforeStart('Setup', 'init')

    expect(getInMemoryErrors().length).toBe(before)
    expect(lastLoggedError()).not.toContain('mkdir plugins')
  })
})

describe('the debug warning for a failed load', () => {
  test.each([
    ['getaddrinfo ENOTFOUND github.com', 'network'],
    ['EACCES: permission denied, open plugins/cache', 'permission'],
    ['Unexpected token } in JSON at position 12', 'configuration'],
  ])('%p gets advice for a %s problem', (message, kind) => {
    const warning = pluginLoadWarning(new Error(message))

    expect(warning).toContain(message)
    expect(warning).toContain(`${kind} problem`)
  })

  test('a failure it does not recognize is reported without advice', () => {
    const warning = pluginLoadWarning('something odd')

    expect(warning).toContain('something odd')
    expect(warning).not.toContain('problem')
  })
})
