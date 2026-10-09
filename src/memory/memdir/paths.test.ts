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
    expect(paths.getGlobalMemEntrypoint()).toBe(
      join(process.env.CLAUDIN_CONFIG_DIR!, 'memory', 'MEMORY.md'),
    )
    expect(paths.isGlobalMemoryEnabled()).toBe(true)
  })

  test('a file in it is a global memory path, a private memory is not', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({ projectRoot: projectDir })
    const globalDir = paths.getGlobalMemPath()

    expect(paths.isGlobalMemPath(join(globalDir, 'user-role.md'))).toBe(true)
    expect(paths.isGlobalMemPath(join(paths.getAutoMemPath(), 'x.md'))).toBe(false)
    expect(paths.isAutoMemPath(join(globalDir, 'user-role.md'))).toBe(false)
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    expect(paths.isGlobalMemPath(`${globalDir}../settings.json`)).toBe(false)
    expect(paths.isGlobalMemPath(`${globalDir.slice(0, -1)}x/a.md`)).toBe(false)
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 turns it off, and takes the path test with it', async () => {
    const projectDir = freshGitProjectDir()
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const paths = await importFreshPathsModule({ projectRoot: projectDir })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
    expect(
      paths.isGlobalMemPath(join(paths.getGlobalMemPath(), 'user-role.md')),
    ).toBe(false)
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

  test('a global dir nested in the private one is off', async () => {
    const projectDir = freshGitProjectDir()
    const paths = await importFreshPathsModule({
      projectRoot: projectDir,
      autoMemoryGlobalDirectory: join(projectDir, '.claudin', 'memory', 'global'),
    })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
  })

  test('a Cowork memory override turns it off', async () => {
    const projectDir = freshGitProjectDir()
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(projectDir, 'cowork')
    const paths = await importFreshPathsModule({ projectRoot: projectDir })

    expect(paths.isGlobalMemoryEnabled()).toBe(false)
  })
})
