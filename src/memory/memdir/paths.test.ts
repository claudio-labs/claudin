import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { findMemoryDir, getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

// getAutoMemPath() reads settings via ../utils/settings/settings.js and the
// current project root via ../bootstrap/state.js. Both are mocked at the
// module boundary so each test can control them without touching real global
// state. Everything else (mkdirSync/realpathSync/chmodSync, symlinks, and
// git-root detection via a real `.git` marker dir) is real.
const realSettings = { ...(await import('src/platform/settings/settings.js')) }
const realState = { ...(await import('src/platform/bootstrap/state.js')) }
const originalConfigDirEnv = process.env.CLAUDIN_CONFIG_DIR
const originalCoworkOverrideEnv =
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
const originalGlobalMemoryEnv = process.env.CLAUDIN_GLOBAL_MEMORY

afterAll(() => {
  mock.module('src/platform/settings/settings.js', () => realSettings)
  mock.module('src/platform/bootstrap/state.js', () => realState)
  if (originalConfigDirEnv === undefined) {
    delete process.env.CLAUDIN_CONFIG_DIR
  } else {
    process.env.CLAUDIN_CONFIG_DIR = originalConfigDirEnv
  }
  if (originalCoworkOverrideEnv === undefined) {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalCoworkOverrideEnv
  }
  if (originalGlobalMemoryEnv === undefined) {
    delete process.env.CLAUDIN_GLOBAL_MEMORY
  } else {
    process.env.CLAUDIN_GLOBAL_MEMORY = originalGlobalMemoryEnv
  }
})

/**
 * Re-imports paths.js with a cache-busting query so its top-level bindings
 * pick up whatever we've just mocked, and so getAutoMemPath's memoize cache
 * starts fresh per test (mirrors utils/plans.test.ts).
 */
async function importFreshPathsModule(options: {
  projectRoot: string
  autoMemoryDirectory?: string
  autoMemoryProjectLocal?: boolean
  autoMemoryGlobalDirectory?: string
  /** Set in the checked-in project settings, which must be ignored. */
  projectGlobalDirectory?: string
  /** Set in settings.local.json — in the repo, so ignored too. */
  localSettings?: {
    autoMemoryDirectory?: string
    autoMemoryGlobalDirectory?: string
    autoMemoryProjectLocal?: boolean
  }
}) {
  mock.module('src/platform/settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => ({}),
    getSettingsForSource: (source: string) =>
      source === 'userSettings'
        ? {
            autoMemoryDirectory: options.autoMemoryDirectory,
            autoMemoryProjectLocal: options.autoMemoryProjectLocal,
            autoMemoryGlobalDirectory: options.autoMemoryGlobalDirectory,
          }
        : source === 'projectSettings'
          ? { autoMemoryGlobalDirectory: options.projectGlobalDirectory }
          : source === 'localSettings'
            ? options.localSettings
            : undefined,
  }))
  mock.module('src/platform/bootstrap/state.js', () => ({
    ...realState,
    getProjectRoot: () => options.projectRoot,
  }))
  return import(`./paths.js?t=${Date.now()}-${Math.random()}`)
}

describe('getAutoMemPath', () => {
  const tmpDirs: string[] = []
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'claudin-mem-home-'))
    tmpDirs.push(fakeHome)
    process.env.CLAUDIN_CONFIG_DIR = join(fakeHome, '.claudin')
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  })

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshGitProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-mem-proj-'))
    tmpDirs.push(dir)
    mkdirSync(join(dir, '.git'))
    return dir
  }

  function freshNonGitProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-mem-nogit-'))
    tmpDirs.push(dir)
    return dir
  }

  test('defaults to <gitRoot>/.claudin/memory/, created 0700, for a git project', async () => {
    const projectDir = freshGitProjectDir()
    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
    })

    const result = getAutoMemPath()

    expect(result).toBe(join(projectDir, '.claudin', 'memory') + sep)
    expect(existsSync(result)).toBe(true)
    expect(statSync(result).mode & 0o777).toBe(0o700)
  })

  test('falls back to the legacy global path for a non-git project', async () => {
    const projectDir = freshNonGitProjectDir()
    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
    })

    const result = getAutoMemPath()

    expect(
      result.startsWith(join(process.env.CLAUDIN_CONFIG_DIR!, 'projects')),
    ).toBe(true)
  })

  test('autoMemoryProjectLocal: false forces the legacy global path even in a git project', async () => {
    const projectDir = freshGitProjectDir()
    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryProjectLocal: false,
    })

    const result = getAutoMemPath()

    expect(
      result.startsWith(join(process.env.CLAUDIN_CONFIG_DIR!, 'projects')),
    ).toBe(true)
  })

  test('autoMemoryDirectory setting still wins over the project-local default', async () => {
    const projectDir = freshGitProjectDir()
    const customDir = mkdtempSync(join(tmpdir(), 'claudin-mem-custom-'))
    tmpDirs.push(customDir)
    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryDirectory: customDir,
    })

    const result = getAutoMemPath()

    expect(result).toBe(customDir + sep)
  })

  // A memory dir is read and written with no prompt (internalPaths.ts), so
  // one that held the config home would put settings.json under that
  // carve-out. The refused setting falls back to the default dir.
  test('SECURITY: autoMemoryDirectory at the config home, or an ancestor of it, is refused', async () => {
    const configHome = process.env.CLAUDIN_CONFIG_DIR!
    for (const dir of [configHome, `${configHome}/`, fakeHome]) {
      const projectDir = freshGitProjectDir()
      const { getAutoMemPath } = await importFreshPathsModule({
        projectRoot: projectDir,
        autoMemoryDirectory: dir,
      })
      expect(getAutoMemPath()).toBe(join(projectDir, '.claudin', 'memory') + sep)
    }
  })

  test('autoMemoryDirectory beside the config home, or inside it, is taken', async () => {
    const configHome = process.env.CLAUDIN_CONFIG_DIR!
    for (const dir of [join(fakeHome, '.claudin-notes'), join(configHome, 'my-memory')]) {
      const { getAutoMemPath } = await importFreshPathsModule({
        projectRoot: freshGitProjectDir(),
        autoMemoryDirectory: dir,
      })
      expect(getAutoMemPath()).toBe(dir + sep)
    }
  })

  test('SECURITY: a .claudin symlink escaping the project root falls back to the legacy global path', async () => {
    const projectDir = freshGitProjectDir()
    const outsideDir = freshNonGitProjectDir()
    symlinkSync(outsideDir, join(projectDir, '.claudin'), 'dir')
    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
    })

    const result = getAutoMemPath()

    expect(
      result.startsWith(join(process.env.CLAUDIN_CONFIG_DIR!, 'projects')),
    ).toBe(true)
    expect(result.startsWith(projectDir)).toBe(false)
    expect(result.startsWith(outsideDir)).toBe(false)
  })

  test('migrates existing global memory into the new project-local dir once, without touching the original', async () => {
    const projectDir = freshGitProjectDir()
    const legacyModule = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryProjectLocal: false,
    })
    const legacyPath = legacyModule.getAutoMemPath()
    mkdirSync(legacyPath, { recursive: true })
    writeFileSync(join(legacyPath, 'MEMORY.md'), '- old memory\n')

    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
    })
    const result = getAutoMemPath()

    expect(result).toBe(join(projectDir, '.claudin', 'memory') + sep)
    expect(readFileSync(join(result, 'MEMORY.md'), 'utf-8')).toBe(
      '- old memory\n',
    )
    expect(readFileSync(join(legacyPath, 'MEMORY.md'), 'utf-8')).toBe(
      '- old memory\n',
    )
  })

  test('does not migrate when the project-local dir already has memory content', async () => {
    const projectDir = freshGitProjectDir()
    const legacyModule = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryProjectLocal: false,
    })
    const legacyPath = legacyModule.getAutoMemPath()
    mkdirSync(legacyPath, { recursive: true })
    writeFileSync(join(legacyPath, 'MEMORY.md'), '- old memory\n')

    const projectLocalPath = join(projectDir, '.claudin', 'memory') + sep
    mkdirSync(projectLocalPath, { recursive: true })
    writeFileSync(join(projectLocalPath, 'MEMORY.md'), '- already here\n')

    const { getAutoMemPath } = await importFreshPathsModule({
      projectRoot: projectDir,
    })
    const result = getAutoMemPath()

    expect(readFileSync(join(result, 'MEMORY.md'), 'utf-8')).toBe(
      '- already here\n',
    )
  })
})

describe('global memory directory', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'claudin-gmem-home-'))
    tmpDirs.push(fakeHome)
    process.env.CLAUDIN_CONFIG_DIR = join(fakeHome, '.claudin')
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    delete process.env.CLAUDIN_GLOBAL_MEMORY
  })

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshGitProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-gmem-proj-'))
    tmpDirs.push(dir)
    mkdirSync(join(dir, '.git'))
    return dir
  }

  test('defaults to <configHome>/memory/, outside every project', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({ projectRoot: projectDir })

    expect(paths.getGlobalMemPath()).toBe(
      join(process.env.CLAUDIN_CONFIG_DIR!, 'memory') + sep,
    )
    expect(paths.isGlobalMemoryEnabled()).toBe(true)
  })

  // isGlobalMemPath/isAutoMemPath are gone: which directory a path is in is
  // findMemoryDir over the resolved roots (memoryDirs.ts).
  test('a file in it is a global memory, a private memory is not', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({ projectRoot: projectDir })
    const globalDir = paths.getGlobalMemPath()
    const autoDir = paths.getAutoMemPath()
    const dirs = testMemoryDirs({ global: globalDir, private: autoDir, team: join(autoDir, 'team') })
    const scopeOf = (path: string) => findMemoryDir(dirs, path)?.scope ?? null

    expect(scopeOf(join(globalDir, 'user-role.md'))).toBe('global')
    expect(scopeOf(join(autoDir, 'x.md'))).toBe('private')
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    expect(scopeOf(`${globalDir}../settings.json`)).toBeNull()
    expect(scopeOf(`${globalDir.slice(0, -1)}x/a.md`)).toBeNull()
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 turns it off, and takes it out of the session dirs', async () => {
    const projectDir = freshGitProjectDir()
    // On first: the session dirs list it, so the off case below is not vacuous.
    const on = await importFreshPathsModule({ projectRoot: projectDir })
    expect(on.isGlobalMemoryEnabled()).toBe(true)
    expect(getMemoryDirs().map(dir => dir.scope)).toEqual(['global', 'private', 'team'])

    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const paths = await importFreshPathsModule({ projectRoot: projectDir })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
    expect(getMemoryDirs().map(dir => dir.scope)).toEqual(['private', 'team'])
  })

  test('autoMemoryGlobalDirectory from user settings wins', async () => {
    const projectDir = freshGitProjectDir()
    const customDir = mkdtempSync(join(tmpdir(), 'claudin-gmem-custom-'))
    tmpDirs.push(customDir)
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryGlobalDirectory: customDir,
    })

    expect(paths.getGlobalMemPath()).toBe(customDir + sep)
  })

  test('SECURITY: autoMemoryGlobalDirectory at the config home, or an ancestor of it, is refused', async () => {
    const configHome = process.env.CLAUDIN_CONFIG_DIR!
    const defaultDir = join(configHome, 'memory') + sep
    for (const dir of [configHome, `${configHome}/`, join(configHome, '..')]) {
      const paths = await importFreshPathsModule({
        projectRoot: freshGitProjectDir(),
        autoMemoryGlobalDirectory: dir,
      })
      expect(paths.getGlobalMemPath()).toBe(defaultDir)
    }
  })

  test('autoMemoryGlobalDirectory beside the config home is taken', async () => {
    const configHome = process.env.CLAUDIN_CONFIG_DIR!
    const beside = join(configHome, '..', 'dotfiles', 'claudin-memory')
    const paths = await importFreshPathsModule({
      projectRoot: freshGitProjectDir(),
      autoMemoryGlobalDirectory: beside,
    })
    expect(paths.getGlobalMemPath()).toBe(beside + sep)
  })

  test('SECURITY: autoMemoryGlobalDirectory in project settings is ignored', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      projectGlobalDirectory: join(process.env.CLAUDIN_CONFIG_DIR!, '..', '.ssh'),
    })

    expect(paths.getGlobalMemPath()).toBe(
      join(process.env.CLAUDIN_CONFIG_DIR!, 'memory') + sep,
    )
  })

  test('a global dir set inside the project-local private dir moves the private dir aside', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryGlobalDirectory: join(projectDir, '.claudin', 'memory', 'global'),
    })

    expect(paths.getAutoMemPath()).not.toBe(join(projectDir, '.claudin', 'memory') + sep)
    expect(paths.isGlobalMemoryEnabled()).toBe(true)
  })

  test('a private dir set by autoMemoryDirectory that nests with the global one turns the global off', async () => {
    const projectDir = freshGitProjectDir()
    const custom = mkdtempSync(join(tmpdir(), 'claudin-gmem-nest-'))
    tmpDirs.push(custom)
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryDirectory: custom,
      autoMemoryGlobalDirectory: join(custom, 'global'),
    })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
  })

  test('a Cowork memory override turns it off', async () => {
    const projectDir = freshGitProjectDir()
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(projectDir, 'cowork')
    const paths = await importFreshPathsModule({ projectRoot: projectDir })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
  })

  test('SECURITY: settings.local.json, which lives in the repo, cannot move a memory dir', async () => {
    const projectDir = freshGitProjectDir()
    const elsewhere = join(projectDir, '..', 'not-memory')
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      localSettings: {
        autoMemoryDirectory: elsewhere,
        autoMemoryGlobalDirectory: elsewhere,
        autoMemoryProjectLocal: false,
      },
    })

    expect(paths.getAutoMemPath()).toBe(join(projectDir, '.claudin', 'memory') + sep)
    expect(paths.getGlobalMemPath()).toBe(join(process.env.CLAUDIN_CONFIG_DIR!, 'memory') + sep)
  })

  test('a repo rooted where the global dir would be its private one moves its private dir, not the global', async () => {
    // A dotfiles repo at $HOME: <gitRoot>/.claudin/memory/ IS ~/.claudin/memory/.
    const home = process.env.CLAUDIN_CONFIG_DIR!.replace(/[/\\]\.claudin$/, '')
    mkdirSync(join(home, '.git'), { recursive: true })
    const paths = await importFreshPathsModule({ projectRoot: home })

    const privateDir = paths.getAutoMemPath()
    expect(privateDir).not.toBe(paths.getGlobalMemPath())
    expect(privateDir.startsWith(join(process.env.CLAUDIN_CONFIG_DIR!, 'projects') + sep)).toBe(true)
    expect(paths.isGlobalMemoryEnabled()).toBe(true)
  })
})
