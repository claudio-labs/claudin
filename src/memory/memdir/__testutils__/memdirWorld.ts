/**
 * A disposable world per test, for the memory-directory characterization
 * suites (`src/memory/memdir/*.characterization.test.ts`).
 *
 * Everything the unit reads from outside itself is pointed into one fresh temp
 * tree: the config home, the managed-settings directory, the session's three
 * directory slots, the flag-settings file, and a HOME for git. Nothing is
 * mocked. Call `useMemdirWorld()` at the top level of each suite so its hooks
 * belong to that file, and every process-global is handed back after each test.
 */
import { afterEach, beforeEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getCwdState,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getIsInteractive,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { findCanonicalGitRoot, findGitRoot } from 'src/vcs/git/git.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { resetPathScopedMemoryCache } from 'src/memory/memdir/pathScopedMemories.js'

/** Every variable a file of the unit reads. Each test starts with none set. */
export const MEMDIR_ENV_VARS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_MEMORY_PAST_CONTEXT',
  'CLAUDIN_LEAN_MEMORY_PROMPT',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'CLAUDE_CODE_ENTRYPOINT',
  'EMBEDDED_SEARCH_TOOLS',
] as const

/** Where a settings file lives, by the name the settings loader gives it. */
export type SettingsLayer = 'user' | 'project' | 'local' | 'flag' | 'policy'

export type MemdirWorld = {
  /** The temp tree, realpath-resolved. */
  readonly root: string
  /** `CLAUDIN_CONFIG_DIR` for this test. */
  readonly configDir: string
  /** A plain directory the session starts in; not a repository. */
  readonly project: string
  /** Makes `dir` the session's project root, original cwd and cwd. */
  enter(dir: string): void
  /** A directory under the root, created with its parents. */
  mkdir(...segments: string[]): string
  /** Writes `text` at the absolute `path`, creating its parents. */
  put(path: string, text: string): string
  /** Writes one settings layer as the settings loader reads it. */
  settings(layer: SettingsLayer, values: Record<string, unknown>): void
  /** Turns `dir` into a repository with one empty commit. */
  repo(dir: string): string
  git(cwd: string, ...args: string[]): string
  /** Forgets every memo the unit and the settings keep between calls. */
  refresh(): void
}

type Snapshot = {
  env: Array<[string, string | undefined]>
  projectRoot: string
  originalCwd: string
  cwd: string
  interactive: boolean
  flagPath: string | undefined
  flagInline: Record<string, unknown> | null
}

function takeSnapshot(): Snapshot {
  return {
    env: MEMDIR_ENV_VARS.map(name => [name, process.env[name]]),
    projectRoot: getProjectRoot(),
    originalCwd: getOriginalCwd(),
    cwd: getCwdState(),
    interactive: getIsInteractive(),
    flagPath: getFlagSettingsPath(),
    flagInline: getFlagSettingsInline(),
  }
}

function putBack(snapshot: Snapshot): void {
  for (const [name, value] of snapshot.env) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setProjectRoot(snapshot.projectRoot)
  setOriginalCwd(snapshot.originalCwd)
  setCwdState(snapshot.cwd)
  setIsInteractive(snapshot.interactive)
  setFlagSettingsPath(snapshot.flagPath)
  setFlagSettingsInline(snapshot.flagInline)
}

function forgetMemos(): void {
  resetSettingsCache()
  getAutoMemPath.cache.clear?.()
  resetPathScopedMemoryCache()
  findGitRoot.cache.clear()
  findCanonicalGitRoot.cache.clear()
}

function runGit(home: string, cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'memdir suite',
      GIT_AUTHOR_EMAIL: 'memdir-suite@example.invalid',
      GIT_COMMITTER_NAME: 'memdir suite',
      GIT_COMMITTER_EMAIL: 'memdir-suite@example.invalid',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return result.stdout
}

function openWorld(): { world: MemdirWorld; close: () => void } {
  const snapshot = takeSnapshot()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memdir-char-')))
  const configDir = join(root, 'config')
  const managedDir = join(root, 'managed')
  const gitHome = join(root, 'git-home')
  const project = join(root, 'project')
  for (const dir of [configDir, managedDir, gitHome, project]) {
    mkdirSync(dir, { recursive: true })
  }

  for (const name of MEMDIR_ENV_VARS) delete process.env[name]
  process.env.CLAUDIN_CONFIG_DIR = configDir
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  getManagedFilePath.cache.set(undefined, managedDir)
  getManagedSettingsDropInDir.cache.set(
    undefined,
    join(managedDir, 'managed-settings.d'),
  )

  const put = (path: string, text: string): string => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return path
  }

  const world: MemdirWorld = {
    root,
    configDir,
    project,
    enter(dir) {
      setProjectRoot(dir)
      setOriginalCwd(dir)
      setCwdState(dir)
      forgetMemos()
    },
    mkdir(...segments) {
      const dir = join(root, ...segments)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    put,
    settings(layer, values) {
      const file = {
        user: join(configDir, 'settings.json'),
        project: join(getOriginalCwd(), '.claudin', 'settings.json'),
        local: join(getOriginalCwd(), '.claudin', 'settings.local.json'),
        policy: join(managedDir, 'managed-settings.json'),
        flag: join(root, 'flag-settings.json'),
      }[layer]
      put(file, JSON.stringify(values, null, 2))
      if (layer === 'flag') setFlagSettingsPath(file)
      forgetMemos()
    },
    repo(dir) {
      mkdirSync(dir, { recursive: true })
      runGit(gitHome, dir, ['init', '-q', '-b', 'main'])
      runGit(gitHome, dir, ['commit', '-q', '--allow-empty', '-m', 'seed'])
      forgetMemos()
      return dir
    },
    git: (cwd, ...args) => runGit(gitHome, cwd, args),
    refresh: forgetMemos,
  }
  world.enter(project)

  const close = (): void => {
    putBack(snapshot)
    getManagedFilePath.cache.delete(undefined)
    getManagedSettingsDropInDir.cache.delete(undefined)
    forgetMemos()
    rmSync(root, { recursive: true, force: true })
  }
  return { world, close }
}

/**
 * Registers the world's hooks in the calling file and returns an accessor for
 * the current test's world.
 */
export function useMemdirWorld(): () => MemdirWorld {
  let current: { world: MemdirWorld; close: () => void } | undefined
  beforeEach(() => {
    current = openWorld()
  })
  afterEach(() => {
    current?.close()
    current = undefined
  })
  return () => {
    if (!current) throw new Error('useMemdirWorld: no world outside a test')
    return current.world
  }
}
