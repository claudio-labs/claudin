import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
} from 'src/permissions/filePermissions/internalPaths.js'

// The auto-memory carve-outs: the memory directory is read and written with
// no prompt, though `.claudin` sits in DANGEROUS_DIRECTORIES. Pinned against a
// fresh git project and config home, so the real ~/.claudin and this repo's
// own memory are never resolved.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

describe('auto-memory carve-outs', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let priorMacro: unknown
  let root: string
  let memDir: string

  beforeAll(() => {
    // A read that falls through every carve-out reaches the bundled-skills
    // root, which reads the build-time MACRO.VERSION.
    priorMacro = (globalThis as Record<string, unknown>).MACRO
    ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'internal-paths-'))
    const project = join(root, 'project')
    mkdirSync(join(project, '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(project)
    getAutoMemPath.cache.clear?.()
    memDir = getAutoMemPath()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getAutoMemPath.cache.clear?.()
    if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
    else (globalThis as Record<string, unknown>).MACRO = priorMacro
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test('the memory dir resolves inside the fresh project', () => {
    expect(memDir).toBe(join(root, 'project', '.claudin', 'memory') + '/')
  })

  test('a memory file is writable and readable with no prompt', () => {
    const file = join(memDir, 'feedback-x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a team memory file rides the same carve-out', () => {
    const file = join(memDir, 'team', 'bugs', 'x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a sibling directory sharing the prefix is not memory', () => {
    const file = join(root, 'project', '.claudin', 'memoryx', 'x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('a traversal out of the memory dir is not memory', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    const file = `${memDir}../settings.json`
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('the Cowork override is readable but gets no write carve-out', () => {
    const override = join(root, 'cowork-memory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = override
    getAutoMemPath.cache.clear?.()
    try {
      const file = join(override, 'x.md')
      expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
      expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    } finally {
      delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      getAutoMemPath.cache.clear?.()
    }
  })

  test('a global memory file is writable and readable with no prompt', () => {
    const file = join(getGlobalMemPath(), 'user-language.md')
    expect(file.startsWith(join(root, 'config'))).toBe(true)
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a traversal out of the global dir is not memory', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    const file = `${getGlobalMemPath()}../settings.json`
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('the reason names the directory, team beating the private dir it sits in', () => {
    const reason = (result: { decisionReason?: unknown }) =>
      (result.decisionReason as { reason?: string } | undefined)?.reason
    const cases = [
      ['global', join(getGlobalMemPath(), 'user-language.md')],
      ['private', join(memDir, 'feedback-x.md')],
      ['team', join(memDir, 'team', 'bugs', 'x.md')],
    ] as const
    for (const [scope, file] of cases) {
      expect(reason(checkEditableInternalPath(file, { file_path: file }))).toBe(
        `${scope} memory files are allowed for writing`,
      )
      expect(reason(checkReadableInternalPath(file, { file_path: file }))).toBe(
        `${scope} memory files are allowed for reading`,
      )
    }
  })

  test('with auto memory off, no memory dir is carved out', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    try {
      for (const file of [
        join(memDir, 'feedback-x.md'),
        join(memDir, 'team', 'bugs', 'x.md'),
        join(getGlobalMemPath(), 'user-language.md'),
      ]) {
        expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
        expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
      }
    } finally {
      delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
    }
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 takes the global carve-out with it', () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    try {
      const file = join(getGlobalMemPath(), 'user-language.md')
      expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
      expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    } finally {
      delete process.env.CLAUDIN_GLOBAL_MEMORY
    }
  })
})
