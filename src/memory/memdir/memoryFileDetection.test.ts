import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getPrivateMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { memoryScopeOf } from 'src/memory/memdir/memoryDirs.js'
import {
  isAutoManagedMemoryFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from 'src/memory/memdir/memoryFileDetection.js'

// The private-dir predicate and the freshness-note predicate were folded into
// the scope registry (memoryDirs.ts): "a private memory file" is
// memoryScopeOf(path) === 'private', "a memory file of any directory" is
// memoryScopeOf(path) !== null.
const isPrivateMemFile = (path: string): boolean => memoryScopeOf(path) === 'private'
const isAnyMemFile = (path: string): boolean => memoryScopeOf(path) !== null

// What the transcript counts as a memory operation: the collapsed read/search
// badge and the extraction fork's "the main agent already wrote" check both
// go through these predicates. Pinned against a fresh git project and config
// home, so the real ~/.claudin and this repo's own memory are never resolved.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

describe('memory file detection', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let root: string
  let memDir: string

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'mem-detect-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    memDir = getPrivateMemPath()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test('a private memory file is an auto-managed memory file', () => {
    const file = join(memDir, 'feedback-x.md')
    expect(isPrivateMemFile(file)).toBe(true)
    expect(isAutoManagedMemoryFile(file)).toBe(true)
  })

  test('a source file of the project is not', () => {
    const file = join(root, 'project', 'src', 'index.ts')
    expect(isPrivateMemFile(file)).toBe(false)
    expect(isAutoManagedMemoryFile(file)).toBe(false)
  })

  test('a traversal out of the memory dir is not a memory file', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    expect(isPrivateMemFile(`${memDir}../../src/index.ts`)).toBe(false)
  })

  test('the private memory dir is a memory directory, the project root is not', () => {
    expect(isMemoryDirectory(memDir)).toBe(true)
    expect(isMemoryDirectory(memDir.replace(/\/$/, ''))).toBe(true)
    expect(isMemoryDirectory(join(root, 'project'))).toBe(false)
  })

  test('a shell command over the private dir targets memory', () => {
    expect(isShellCommandTargetingMemory(`grep -rn pnpm ${memDir}`)).toBe(true)
    expect(isShellCommandTargetingMemory(`cat ${join(memDir, 'MEMORY.md')}`)).toBe(true)
  })

  test('a shell command over project files does not', () => {
    expect(isShellCommandTargetingMemory(`grep -rn pnpm ${join(root, 'project', 'src')}`)).toBe(false)
  })

  test('nothing is memory when auto memory is off', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    try {
      expect(isPrivateMemFile(join(memDir, 'feedback-x.md'))).toBe(false)
    } finally {
      delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
    }
  })

  test('a global memory file is an auto-managed memory file, though not a private one', () => {
    const file = join(getGlobalMemPath(), 'user-language.md')
    expect(isPrivateMemFile(file)).toBe(false)
    expect(memoryScopeOf(file)).toBe('global')
    expect(isAutoManagedMemoryFile(file)).toBe(true)
  })

  test('a global memory file is nothing special with the global dir off', () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    try {
      expect(isAutoManagedMemoryFile(join(getGlobalMemPath(), 'user-language.md'))).toBe(false)
      expect(isAnyMemFile(join(getGlobalMemPath(), 'user-language.md'))).toBe(false)
    } finally {
      delete process.env.CLAUDIN_GLOBAL_MEMORY
    }
  })

  test('a Read of a private, team or global memory carries the freshness note; a source file does not', () => {
    expect(isAnyMemFile(join(memDir, 'feedback-x.md'))).toBe(true)
    expect(isAnyMemFile(join(memDir, 'team', 'bugs', 'x.md'))).toBe(true)
    expect(memoryScopeOf(join(memDir, 'team', 'bugs', 'x.md'))).toBe('team')
    expect(isAnyMemFile(join(getGlobalMemPath(), 'user-language.md'))).toBe(true)
    expect(isAnyMemFile(join(root, 'project', 'src', 'index.ts'))).toBe(false)
    // FileReadTool records the mtime the note is computed from through it.
    const dispatch = readFileSync(new URL('../../tools/FileReadTool/readDispatch.ts', import.meta.url), 'utf8')
    expect(dispatch).toContain('if (memoryScopeOf(fullFilePath) !== null) {\n    markMemoryFileMtime(data, mtimeMs)')
  })

  describe('with the global dir moved outside the config home', () => {
    let customDir: string

    beforeAll(() => {
      customDir = join(root, 'dotfiles', 'claudin-memory')
      setFlagSettingsInline({ autoMemoryGlobalDirectory: customDir })
      resetSettingsCache()
      getGlobalMemPath.cache.clear?.()
    })

    afterAll(() => {
      setFlagSettingsInline(null)
      resetSettingsCache()
      getGlobalMemPath.cache.clear?.()
    })

    test('it is a memory directory', () => {
      expect(getGlobalMemPath()).toBe(`${customDir}/`)
      expect(isMemoryDirectory(customDir)).toBe(true)
      expect(isMemoryDirectory(join(customDir, 'sub'))).toBe(true)
    })

    test('a shell command over it targets memory', () => {
      expect(isShellCommandTargetingMemory(`grep -rn pt-BR ${customDir}`)).toBe(true)
    })
  })
})
