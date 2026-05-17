import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ORIGINAL_CLAUDIO_CONFIG_DIR = process.env.CLAUDIO_CONFIG_DIR

// Spread into a plain object so afterAll restores the original bindings, not
// the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('../../utils/config.js')) }
let testConfigState: Record<string, unknown> = {}

mock.module('../../utils/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => testConfigState,
  saveGlobalConfig: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
    testConfigState = updater(testConfigState)
  },
}))

afterAll(() => {
  mock.module('../../utils/config.js', () => realConfig)
  realConfig.resetGlobalConfigForTests?.()
})

import { parseMigrateArgs, runProviderMigrate } from './migrate.js'

function makeTempHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), 'claudio-migrate-cmd-'))
  return {
    home,
    legacy: join(home, '.claude'),
    next: join(home, '.claudio'),
  }
}

function resetConfig(): void {
  testConfigState = {}
}

describe('parseMigrateArgs', () => {
  test('extracts --force flag', () => {
    expect(parseMigrateArgs('').force).toBe(false)
    expect(parseMigrateArgs('--force').force).toBe(true)
    expect(parseMigrateArgs('-f').force).toBe(true)
    expect(parseMigrateArgs(' --force ').force).toBe(true)
  })
})

describe('runProviderMigrate', () => {
  let dirs: { home: string; legacy: string; next: string }

  beforeEach(() => {
    dirs = makeTempHome()
    process.env.HOME = dirs.home
    process.env.CLAUDIO_CONFIG_DIR = dirs.next
    resetConfig()
  })

  afterEach(() => {
    if (ORIGINAL_CLAUDIO_CONFIG_DIR === undefined) {
      delete process.env.CLAUDIO_CONFIG_DIR
    } else {
      process.env.CLAUDIO_CONFIG_DIR = ORIGINAL_CLAUDIO_CONFIG_DIR
    }
    resetConfig()
    try {
      rmSync(dirs.home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('reports the summary on the first run', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
    )

    const message = await runProviderMigrate('', {
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(message).toContain('1 settings key')
    expect(message).toContain('kept untouched')
  })

  test('on second run reports nothing to do', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
    )

    await runProviderMigrate('', { homeDir: dirs.home, newDir: dirs.next })
    const second = await runProviderMigrate('', {
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    expect(second).toContain('nothing to do')
    expect(second).toContain('--force')
  })

  test('--force re-runs even when already migrated', async () => {
    mkdirSync(dirs.legacy, { recursive: true })
    writeFileSync(
      join(dirs.legacy, 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
    )

    await runProviderMigrate('', { homeDir: dirs.home, newDir: dirs.next })
    const forced = await runProviderMigrate('--force', {
      homeDir: dirs.home,
      newDir: dirs.next,
    })
    // Forced re-run does not produce "nothing to do" — it copies again. The
    // settings merge is non-destructive so the dest is untouched (0 keys), but
    // the alreadyMigrated short-circuit must be bypassed.
    expect(forced).not.toContain('nothing to do')
  })
})
