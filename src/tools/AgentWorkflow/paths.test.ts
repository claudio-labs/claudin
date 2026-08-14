import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { runWithCwdOverride } from 'src/utils/fs/cwd.js'

// paths.ts reports gitignore additions via src/services/git/gitignore.js; mock it
// at the module boundary so the real implementation never appends to the
// developer's actual ~/.config/git/ignore. Everything else (mkdirSync/
// realpathSync/chmodSync, symlinks, cwd, config-home resolution) is real.
const realGitignore = { ...(await import('src/services/git/gitignore.js')) }
const originalConfigDirEnv = process.env.CLAUDIN_CONFIG_DIR

let gitignoreCalls: Array<{ filename: string; cwd: string }> = []

afterAll(() => {
  mock.module('src/services/git/gitignore.js', () => realGitignore)
  if (originalConfigDirEnv === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = originalConfigDirEnv
})

/**
 * Re-import paths.js with a cache-busting query so its memoized resolvers start
 * empty and its `addFileGlobRuleToGitignore` binding picks up the mock (mirrors
 * utils/plans.test.ts).
 */
async function importFreshPaths() {
  gitignoreCalls = []
  mock.module('src/services/git/gitignore.js', () => ({
    ...realGitignore,
    addFileGlobRuleToGitignore: async (filename: string, cwd: string) => {
      gitignoreCalls.push({ filename, cwd })
    },
  }))
  return import(`./paths.js?t=${Date.now()}-${Math.random()}`)
}

describe('getWorkflowsDir / getWorkflowRunsDir', () => {
  const tmpDirs: string[] = []

  beforeEach(() => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'wf-paths-home-'))
    tmpDirs.push(fakeHome)
    process.env.CLAUDIN_CONFIG_DIR = join(fakeHome, '.claudin')
  })

  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  })

  function freshProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wf-paths-proj-'))
    tmpDirs.push(dir)
    return dir
  }

  test('defaults to <cwd>/.claudin/workflows, created 0700', async () => {
    const projectDir = freshProjectDir()
    const { getWorkflowsDir } = await importFreshPaths()

    const result = runWithCwdOverride(projectDir, () => getWorkflowsDir())

    expect(result).toBe(join(projectDir, '.claudin', 'workflows'))
    expect(existsSync(result)).toBe(true)
    expect(statSync(result).mode & 0o777).toBe(0o700)
  })

  test('SECURITY: a .claudin symlink escaping the project root falls back to the global config dir', async () => {
    const projectDir = freshProjectDir()
    const outsideDir = freshProjectDir() // an unrelated tmp dir = "outside the project"
    symlinkSync(outsideDir, join(projectDir, '.claudin'), 'dir')
    const { getWorkflowsDir } = await importFreshPaths()

    const result = runWithCwdOverride(projectDir, () => getWorkflowsDir())

    expect(result).toBe(join(process.env.CLAUDIN_CONFIG_DIR!, 'workflows'))
    expect(result.startsWith(projectDir)).toBe(false)
    expect(result.startsWith(outsideDir)).toBe(false)
    expect(existsSync(result)).toBe(true)
  })

  test('is memoized per-cwd: different cwds resolve independently', async () => {
    const projectA = freshProjectDir()
    const projectB = freshProjectDir()
    const { getWorkflowsDir } = await importFreshPaths()

    const a = runWithCwdOverride(projectA, () => getWorkflowsDir())
    const b = runWithCwdOverride(projectB, () => getWorkflowsDir())
    const aAgain = runWithCwdOverride(projectA, () => getWorkflowsDir())

    expect(a).toBe(join(projectA, '.claudin', 'workflows'))
    expect(b).toBe(join(projectB, '.claudin', 'workflows'))
    expect(aAgain).toBe(a)
  })

  test('getWorkflowRunsDir nests .runs and gitignores it when inside the project', async () => {
    const projectDir = freshProjectDir()
    const { getWorkflowRunsDir } = await importFreshPaths()

    const runs = runWithCwdOverride(projectDir, () => getWorkflowRunsDir())

    expect(runs).toBe(join(projectDir, '.claudin', 'workflows', '.runs'))
    expect(existsSync(runs)).toBe(true)
    expect(statSync(runs).mode & 0o777).toBe(0o700)
    expect(gitignoreCalls).toEqual([
      { filename: `.claudin${sep}workflows${sep}.runs/`, cwd: projectDir },
    ])
  })

  test('getWorkflowRunsDir does not gitignore when the workflows dir fell back outside the project', async () => {
    const projectDir = freshProjectDir()
    const outsideDir = freshProjectDir()
    symlinkSync(outsideDir, join(projectDir, '.claudin'), 'dir')
    const { getWorkflowRunsDir } = await importFreshPaths()

    const runs = runWithCwdOverride(projectDir, () => getWorkflowRunsDir())

    expect(runs.startsWith(process.env.CLAUDIN_CONFIG_DIR!)).toBe(true)
    expect(gitignoreCalls).toEqual([])
  })
})
