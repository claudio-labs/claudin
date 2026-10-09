import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { loadMemoryPrompt } from 'src/memory/memdir/memdir.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'

// What loadMemoryPrompt does with the global dir: it names it in the combined
// prompt and creates it 0700, and with CLAUDIN_GLOBAL_MEMORY=0 does neither.
// Pinned against a fresh git project and config home, so the real ~/.claudin
// is never created.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

describe('the global memory in the loaded prompt', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let root: string

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'load-mem-prompt-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    previousProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
  })

  beforeEach(() => {
    // A fresh config home per test, so "was the dir created" is answerable.
    process.env.CLAUDIN_CONFIG_DIR = mkdtempSync(join(root, 'config-'))
    delete process.env.CLAUDIN_GLOBAL_MEMORY
    getAutoMemPath.cache.clear?.()
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

  test('names the global dir beside the private and team ones, and creates it 0700', async () => {
    const globalDir = getGlobalMemPath()
    const prompt = (await loadMemoryPrompt())!

    expect(prompt).toContain(getAutoMemPath())
    expect(prompt).toContain(getTeamMemPath())
    expect(prompt).toContain(globalDir)
    expect(existsSync(globalDir)).toBe(true)
    expect(statSync(globalDir).mode & 0o777).toBe(0o700)
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 leaves it out, and does not create it', async () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    const globalDir = getGlobalMemPath()
    const prompt = (await loadMemoryPrompt())!

    expect(prompt).toContain(getTeamMemPath())
    expect(prompt).not.toContain(globalDir)
    expect(existsSync(globalDir)).toBe(false)
  })
})
