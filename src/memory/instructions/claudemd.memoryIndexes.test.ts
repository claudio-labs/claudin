import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getAutoMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { areMemoryIndexesEmpty } from 'src/memory/memdir/memdir.js'
import {
  clearMemoryFileCaches,
  getClaudeMds,
  getMemoryFiles,
} from 'src/memory/instructions/claudemd.js'

// Which MEMORY.md indexes reach context, in which order. Pinned against a
// fresh git project and config home, so the real ~/.claudin and this repo's
// own memory are never resolved.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

describe('memory indexes in getMemoryFiles', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let previousOriginalCwd: string
  let root: string
  let globalDir: string
  let privateDir: string

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'claudemd-indexes-'))
    const project = join(root, 'project')
    mkdirSync(join(project, '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    previousOriginalCwd = getOriginalCwd()
    setProjectRoot(project)
    setOriginalCwd(project)
    getAutoMemPath.cache.clear?.()
    privateDir = getAutoMemPath()
    globalDir = getGlobalMemPath()
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'MEMORY.md'), '- [pt-BR](user-language.md) — answers in pt-BR\n')
    writeFileSync(join(privateDir, 'MEMORY.md'), '- [pnpm](project-pnpm.md) — this repo uses pnpm\n')
  })

  beforeEach(() => {
    delete process.env.CLAUDIN_GLOBAL_MEMORY
    clearMemoryFileCaches()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    setOriginalCwd(previousOriginalCwd)
    getAutoMemPath.cache.clear?.()
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearMemoryFileCaches()
    rmSync(root, { recursive: true, force: true })
  })

  test('the global index loads before the private one', async () => {
    const indexes = (await getMemoryFiles()).filter(
      f => f.type === 'GlobalMem' || f.type === 'AutoMem',
    )
    expect(indexes.map(f => f.type)).toEqual(['GlobalMem', 'AutoMem'])
    expect(indexes[0]!.path).toBe(join(globalDir, 'MEMORY.md'))
  })

  test('the model is told which index is the global one', async () => {
    const text = getClaudeMds(await getMemoryFiles())
    expect(text).toContain(
      `Contents of ${join(globalDir, 'MEMORY.md')} (user's global auto-memory, shared by every project):`,
    )
    expect(text).toContain('answers in pt-BR')
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 leaves the global index out', async () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const types = (await getMemoryFiles()).map(f => f.type)
    expect(types).not.toContain('GlobalMem')
    expect(types).toContain('AutoMem')
  })

  test('a non-empty global index alone means the indexes are not empty', () => {
    expect(
      areMemoryIndexesEmpty([
        { type: 'GlobalMem', content: '- [pt-BR](user-language.md) — hook' },
        { type: 'AutoMem', content: '' },
      ]),
    ).toBe(false)
  })
})
