import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  isAutoManagedMemoryFile,
  isAutoMemFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from 'src/memory/memdir/memoryFileDetection.js'

// What the transcript counts as a memory operation: the collapsed read/search
// badge and the extraction fork's "the main agent already wrote" check both
// go through these predicates. Pinned against a fresh git project and config
// home, so the real ~/.claudin and this repo's own memory are never resolved.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
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
    getAutoMemPath.cache.clear?.()
    memDir = getAutoMemPath()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getAutoMemPath.cache.clear?.()
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test('a private memory file is an auto-managed memory file', () => {
    const file = join(memDir, 'feedback-x.md')
    expect(isAutoMemFile(file)).toBe(true)
    expect(isAutoManagedMemoryFile(file)).toBe(true)
  })

  test('a source file of the project is not', () => {
    const file = join(root, 'project', 'src', 'index.ts')
    expect(isAutoMemFile(file)).toBe(false)
    expect(isAutoManagedMemoryFile(file)).toBe(false)
  })

  test('a traversal out of the memory dir is not a memory file', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    expect(isAutoMemFile(`${memDir}../../src/index.ts`)).toBe(false)
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
      expect(isAutoMemFile(join(memDir, 'feedback-x.md'))).toBe(false)
    } finally {
      delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
    }
  })
})
