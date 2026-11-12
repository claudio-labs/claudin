/**
 * Characterization of windowsPaths.ts on Linux, pinned before `checkPathExists`
 * trades its `dir "<path>"` shell probe for a stat.
 *
 * `checkPathExists` runs through /bin/sh, so on Linux it asks GNU coreutils
 * `dir` (exit 0 when the path exists, 2 when not) — deterministic enough to
 * pin. The Windows lookups behind `findGitBashPath` are reached without
 * `mock.module`:
 * - the hardcoded `C:\Program Files\…` locations are RELATIVE paths to a Linux
 *   shell (a backslash before a letter stays literal inside double quotes), so
 *   a file literally named `C:\Program Files\Git\cmd\git.exe` in the process
 *   cwd satisfies them — each such test `chdir`s into a temp dir and back;
 * - `where.exe` is NOT reachable: under Bun, `execSync` without an `env`
 *   option spawns with the environment the process STARTED with, so neither a
 *   prepended PATH (a fake where.exe) nor a variable set at runtime reaches
 *   the shell. The where.exe success branch stays uncovered on Linux; the
 *   tests below only see "where.exe not found" (it is absent on Linux);
 * - `process.exit` is spied to throw, so the failure path never exits;
 * - `findGitBashPath` and `getPlatform` are lodash memoizes, so their `.cache`
 *   is cleared/set directly and put back.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  checkPathExists,
  findGitBashPath,
  posixPathToWindowsPath,
  setShellIfWindows,
  windowsPathToPosixPath,
} from 'src/shared/fs/windowsPaths.js'
import { getPlatform } from 'src/shared/proc/platform.js'

class ExitCalled extends Error {
  constructor(readonly code: unknown) {
    super(`process.exit(${String(code)})`)
  }
}

const GIT_BASH_ERROR =
  'Claudin on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDIN_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe'

const saved = {
  gitBashPath: process.env.CLAUDIN_GIT_BASH_PATH,
  shell: process.env.SHELL,
  cwd: process.cwd(),
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

let root: string
let existingFile: string
let missingPath: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'windows-paths-test-'))
  existingFile = join(root, 'bash.exe')
  writeFileSync(existingFile, '')
  missingPath = join(root, 'does-not-exist.exe')
})

afterAll(() => {
  process.chdir(saved.cwd)
  restoreEnv('CLAUDIN_GIT_BASH_PATH', saved.gitBashPath)
  restoreEnv('SHELL', saved.shell)
  findGitBashPath.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
})

describe('windowsPathToPosixPath', () => {
  test.each([
    ['\\\\server\\share\\dir', '//server/share/dir'],
    ['C:\\Users\\foo', '/c/Users/foo'],
    ['d:/mixed\\path', '/d/mixed/path'],
    ['C:\\', '/c/'],
    // No separator after the colon: not a drive path, only slashes flip.
    ['C:', 'C:'],
    ['C:foo\\bar', 'C:foo/bar'],
    ['relative\\dir\\file.txt', 'relative/dir/file.txt'],
    ['/already/posix', '/already/posix'],
    ['', ''],
  ])('%p → %p', (input, expected) => {
    expect(windowsPathToPosixPath(input)).toBe(expected)
  })
})

describe('posixPathToWindowsPath', () => {
  test.each([
    ['//server/share/x', '\\\\server\\share\\x'],
    ['/cygdrive/c/Users/foo', 'C:\\Users\\foo'],
    ['/cygdrive/d', 'D:\\'],
    ['/cygdrive/d/', 'D:\\'],
    // Not /cygdrive/<letter>(/|end), and "/c" is followed by "y": slashes only.
    ['/cygdrive/cx', '\\cygdrive\\cx'],
    ['/c/Users/foo', 'C:\\Users\\foo'],
    ['/c', 'C:\\'],
    ['/c/', 'C:\\'],
    // Any single-letter top directory reads as a drive, even a real Linux one.
    ['/a/b', 'A:\\b'],
    ['/usr/bin', '\\usr\\bin'],
    ['relative/dir', 'relative\\dir'],
    ['C:\\already', 'C:\\already'],
    ['', ''],
  ])('%p → %p', (input, expected) => {
    expect(posixPathToWindowsPath(input)).toBe(expected)
  })

  test('a drive path round-trips through both conversions', () => {
    expect(posixPathToWindowsPath(windowsPathToPosixPath('C:\\a\\b c\\d'))).toBe('C:\\a\\b c\\d')
    expect(windowsPathToPosixPath(posixPathToWindowsPath('/e/x/y'))).toBe('/e/x/y')
  })
})

describe('checkPathExists (today: `dir "<path>"` through the shell)', () => {
  test('an existing file is true', () => {
    expect(checkPathExists(existingFile)).toBe(true)
  })

  test('an existing directory is true', () => {
    expect(checkPathExists(root)).toBe(true)
  })

  test('a missing path is false', () => {
    expect(checkPathExists(missingPath)).toBe(false)
  })

  test('the path is shell-interpreted: a $VAR inside it is expanded', () => {
    // $PWD is set by the shell itself, so this does not depend on the env.
    expect(checkPathExists('$PWD')).toBe(true)
    expect(checkPathExists('$PWD/definitely-not-here-1f3a')).toBe(false)
  })

  test('the path is shell-interpreted: a quote can break out and make a missing path "exist"', () => {
    expect(checkPathExists(`${missingPath}" || true "`)).toBe(true)
  })
})

describe('findGitBashPath', () => {
  let exitSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>
  let work: string

  /** Writes an empty file whose NAME is the given Windows path, in the cwd. */
  function touchLiteral(name: string): void {
    writeFileSync(join(work, name), '')
  }

  beforeEach(() => {
    findGitBashPath.cache.clear?.()
    delete process.env.CLAUDIN_GIT_BASH_PATH
    work = mkdtempSync(join(root, 'cwd-'))
    process.chdir(work)
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code)
    }) as typeof process.exit)
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.chdir(saved.cwd)
      restoreEnv('CLAUDIN_GIT_BASH_PATH', saved.gitBashPath)
    exitSpy.mockRestore()
    errorSpy.mockRestore()
    findGitBashPath.cache.clear?.()
  })

  test('CLAUDIN_GIT_BASH_PATH that exists is returned as-is, and the answer is memoized', () => {
    process.env.CLAUDIN_GIT_BASH_PATH = existingFile
    expect(findGitBashPath()).toBe(existingFile)
    process.env.CLAUDIN_GIT_BASH_PATH = missingPath
    expect(findGitBashPath()).toBe(existingFile)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('CLAUDIN_GIT_BASH_PATH that does not exist prints the path and exits 1 (no fallback search)', () => {
    process.env.CLAUDIN_GIT_BASH_PATH = missingPath
    touchLiteral('C:\\Program Files\\Git\\cmd\\git.exe')
    touchLiteral('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(() => findGitBashPath()).toThrow(ExitCalled)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(
      `Claudin was unable to find CLAUDIN_GIT_BASH_PATH path "${missingPath}"`,
    )
  })

  test('git in the 64-bit default location → its sibling bin\\bash.exe', () => {
    touchLiteral('C:\\Program Files\\Git\\cmd\\git.exe')
    touchLiteral('C:\\Program Files\\Git\\bin\\bash.exe')
    // Both locations present: 64-bit is checked first.
    touchLiteral('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
    touchLiteral('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
    expect(findGitBashPath()).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  test('git only in the 32-bit default location → its bin\\bash.exe', () => {
    touchLiteral('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
    touchLiteral('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
    expect(findGitBashPath()).toBe('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  })

  test('git found but no bash.exe beside it prints the install hint and exits 1', () => {
    touchLiteral('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(() => findGitBashPath()).toThrow(ExitCalled)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(GIT_BASH_ERROR)
  })

  test('no default location and no where.exe prints the install hint and exits 1', () => {
    expect(() => findGitBashPath()).toThrow(ExitCalled)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(GIT_BASH_ERROR)
  })
})

describe('setShellIfWindows', () => {
  const platformCache = getPlatform.cache as unknown as Map<unknown, unknown>
  let hadPlatform: boolean
  let savedPlatform: unknown

  beforeEach(() => {
    hadPlatform = platformCache.has(undefined)
    savedPlatform = platformCache.get(undefined)
    findGitBashPath.cache.clear?.()
  })

  afterEach(() => {
    if (hadPlatform) platformCache.set(undefined, savedPlatform)
    else platformCache.delete(undefined)
    restoreEnv('SHELL', saved.shell)
    restoreEnv('CLAUDIN_GIT_BASH_PATH', saved.gitBashPath)
    findGitBashPath.cache.clear?.()
  })

  test('off Windows it leaves SHELL alone and never looks for git-bash', () => {
    platformCache.set(undefined, 'linux')
    process.env.SHELL = '/bin/zsh'
    // Would print and exit if findGitBashPath ran.
    process.env.CLAUDIN_GIT_BASH_PATH = missingPath
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new ExitCalled(1)
    }) as typeof process.exit)
    try {
      setShellIfWindows()
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
    expect(process.env.SHELL).toBe('/bin/zsh')
  })

  test('on Windows it sets SHELL to the git-bash path', () => {
    platformCache.set(undefined, 'windows')
    process.env.SHELL = '/bin/zsh'
    process.env.CLAUDIN_GIT_BASH_PATH = existingFile
    setShellIfWindows()
    expect(process.env.SHELL).toBe(existingFile)
  })
})
