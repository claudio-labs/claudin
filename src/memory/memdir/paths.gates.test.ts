import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import {
  getIsInteractive,
  setFlagSettingsInline,
  setIsInteractive,
} from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import {
  getExtractionIdleMs,
  getExtractionTurnInterval,
  getGlobalMemPath,
  getMemoryBaseDir,
  getPrivateMemPath,
  globalMemoryOffReason,
  hasMemoryPathOverride,
  isAutoMemoryEnabled,
  isExtractMemoriesEnabled,
  isExtractModeActive,
} from 'src/memory/memdir/paths.js'

// The gates and directory resolution of paths.ts, against the real module:
// paths.test.ts drives a cache-busted copy under mocked settings, which the
// coverage of this file never sees. Env, settings and the project root are
// the inputs; each is put back after every test.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_HEADLESS',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'CLAUDIN_GLOBAL_MEMORY',
] as const

const savedEnv = new Map<string, string | undefined>()
let savedProjectRoot: string
let savedInteractive: boolean
let root: string

function setSettings(settings: Record<string, unknown> | null): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

function clearMemoized(): void {
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
}

function gitProject(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  savedProjectRoot = getProjectRoot()
  savedInteractive = getIsInteractive()
  root = mkdtempSync(join(tmpdir(), 'paths-gates-'))
})

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  setSettings(null)
  clearMemoized()
})

afterEach(() => {
  setSettings(null)
  setProjectRoot(savedProjectRoot)
  setIsInteractive(savedInteractive)
  clearMemoized()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearMemoized()
  rmSync(root, { recursive: true, force: true })
})

describe('isAutoMemoryEnabled', () => {
  test('is on by default', () => {
    expect(isAutoMemoryEnabled()).toBe(true)
  })

  test('CLAUDIN_DISABLE_AUTO_MEMORY=1 turns it off', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(isAutoMemoryEnabled()).toBe(false)
  })

  test('CLAUDIN_DISABLE_AUTO_MEMORY=0 forces it on, ahead of --bare and the setting', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '0'
    process.env.CLAUDIN_SIMPLE = '1'
    setSettings({ autoMemoryEnabled: false })
    expect(isAutoMemoryEnabled()).toBe(true)
  })

  test('--bare turns it off', () => {
    process.env.CLAUDIN_SIMPLE = '1'
    expect(isAutoMemoryEnabled()).toBe(false)
  })

  test('a remote session turns it off without a persistent memory dir, not with one', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(isAutoMemoryEnabled()).toBe(false)
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = join(root, 'remote')
    expect(isAutoMemoryEnabled()).toBe(true)
  })

  test('autoMemoryEnabled in settings decides when no env var does', () => {
    setSettings({ autoMemoryEnabled: false })
    expect(isAutoMemoryEnabled()).toBe(false)
    setSettings({ autoMemoryEnabled: true })
    expect(isAutoMemoryEnabled()).toBe(true)
  })
})

describe('the extraction gates', () => {
  test('CLAUDIN_EXTRACT_MEMORIES=0 is the killswitch', () => {
    expect(isExtractMemoriesEnabled()).toBe(true)
    process.env.CLAUDIN_EXTRACT_MEMORIES = '0'
    expect(isExtractMemoriesEnabled()).toBe(false)
    expect(isExtractModeActive()).toBe(false)
  })

  test('an interactive session extracts, a -p one only under CLAUDIN_EXTRACT_MEMORIES_HEADLESS', () => {
    setIsInteractive(true)
    expect(isExtractModeActive()).toBe(true)
    setIsInteractive(false)
    expect(isExtractModeActive()).toBe(false)
    process.env.CLAUDIN_EXTRACT_MEMORIES_HEADLESS = '1'
    expect(isExtractModeActive()).toBe(true)
  })

  test('the turn interval defaults to 5 and takes a positive override', () => {
    expect(getExtractionTurnInterval()).toBe(5)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '4'
    expect(getExtractionTurnInterval()).toBe(4)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = 'often'
    expect(getExtractionTurnInterval()).toBe(5)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '0'
    expect(getExtractionTurnInterval()).toBe(5)
  })

  test('the idle wait defaults to 10 minutes and takes an override up to a day', () => {
    const saved = process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS
    try {
      delete process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS
      expect(getExtractionIdleMs()).toBe(600_000)
      process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = '60000'
      expect(getExtractionIdleMs()).toBe(60_000)
      process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = String(10 * 86_400_000)
      expect(getExtractionIdleMs()).toBe(86_400_000)
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS
      else process.env.CLAUDIN_EXTRACT_MEMORIES_IDLE_MS = saved
    }
  })
})

describe('getMemoryBaseDir', () => {
  test('is the config home, or the remote memory dir when one is set', () => {
    expect(getMemoryBaseDir()).toBe(join(root, 'config'))
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = join(root, 'remote')
    expect(getMemoryBaseDir()).toBe(join(root, 'remote'))
  })
})

describe('the Cowork path override', () => {
  // The UNC and NUL arms cannot be reached from here: POSIX normalize()
  // collapses a leading `//`, and an env var cannot carry a NUL.
  test('SECURITY: a relative or near-root override is refused', () => {
    for (const bad of ['relative/dir', '/a']) {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = bad
      expect(hasMemoryPathOverride()).toBe(false)
    }
  })

  test('an absolute override is the private dir, and turns the global dir off', () => {
    const cowork = join(root, 'cowork')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = cowork
    setProjectRoot(gitProject('cowork-project'))
    expect(hasMemoryPathOverride()).toBe(true)
    expect(getPrivateMemPath()).toBe(cowork + sep)
    expect(globalMemoryOffReason()).toEqual({ reason: 'cowork-override' })
  })
})

describe('getGlobalMemPath', () => {
  test('a ~/ setting expands to the home dir; a bare ~/ is refused', () => {
    setSettings({ autoMemoryGlobalDirectory: '~/claudin-global-memory-test' })
    expect(getGlobalMemPath()).toBe(join(homedir(), 'claudin-global-memory-test') + sep)
    clearMemoized()
    setSettings({ autoMemoryGlobalDirectory: '~/' })
    expect(getGlobalMemPath()).toBe(join(root, 'config', 'memory') + sep)
  })
})

describe('globalMemoryOffReason', () => {
  test('names auto memory being off, then the env killswitch', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(globalMemoryOffReason()).toEqual({ reason: 'auto-memory-off' })
    delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    expect(globalMemoryOffReason()).toEqual({ reason: 'env' })
  })

  test('names the two dirs when they nest', () => {
    const custom = join(root, 'nest-private')
    setSettings({ autoMemoryDirectory: custom, autoMemoryGlobalDirectory: join(custom, 'global') })
    setProjectRoot(gitProject('nest-project'))
    expect(globalMemoryOffReason()).toEqual({
      reason: 'nested',
      globalDir: join(custom, 'global') + sep,
      privateDir: custom + sep,
    })
  })
})

describe('getPrivateMemPath', () => {
  const legacyRoot = () => join(root, 'config', 'projects')

  test('a git project gets <gitRoot>/.claudin/memory/', () => {
    const project = gitProject('local-project')
    setProjectRoot(project)
    expect(getPrivateMemPath()).toBe(join(project, '.claudin', 'memory') + sep)
  })

  test('autoMemoryProjectLocal: false keeps the legacy per-project dir', () => {
    setProjectRoot(gitProject('legacy-setting-project'))
    setSettings({ autoMemoryProjectLocal: false })
    expect(getPrivateMemPath().startsWith(legacyRoot())).toBe(true)
  })

  test('a project outside git keeps the legacy per-project dir', () => {
    const dir = join(root, 'not-git')
    mkdirSync(dir, { recursive: true })
    setProjectRoot(dir)
    expect(getPrivateMemPath().startsWith(legacyRoot())).toBe(true)
  })

  test('a project-local dir that would nest the global one moves to the legacy dir', () => {
    const project = gitProject('nesting-project')
    setProjectRoot(project)
    setSettings({ autoMemoryGlobalDirectory: join(project, '.claudin', 'memory') })
    expect(getPrivateMemPath().startsWith(legacyRoot())).toBe(true)
  })

  test('a .claudin that cannot hold a directory falls back to the legacy dir', () => {
    const project = gitProject('blocked-project')
    writeFileSync(join(project, '.claudin'), 'a file, not a dir')
    setProjectRoot(project)
    expect(getPrivateMemPath().startsWith(legacyRoot())).toBe(true)
  })

  test('SECURITY: a .claudin symlink out of the repo falls back to the legacy dir', () => {
    const project = gitProject('symlink-project')
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(project, '.claudin'), 'dir')
    setProjectRoot(project)
    const result = getPrivateMemPath()
    expect(result.startsWith(legacyRoot())).toBe(true)
    expect(result.startsWith(outside)).toBe(false)
  })
})
