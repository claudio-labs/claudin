import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { runWithCwdOverride } from './cwd.js'

// getPlansDirectory() reads settings via ./settings/settings.js and reports
// gitignore additions via ./git/gitignore.js. Both are mocked at the module
// boundary: settings so each test can control `plansDirectory` without
// touching the real ~/.claudin/settings.json, and gitignore because the real
// implementation appends to the developer's actual ~/.config/git/ignore.
// Everything else (mkdirSync/realpathSync/chmodSync, symlinks, cwd) is real.
const realSettings = { ...(await import('./settings/settings.js')) }
const realGitignore = { ...(await import('./git/gitignore.js')) }
const originalConfigDirEnv = process.env.CLAUDIN_CONFIG_DIR

afterAll(() => {
  mock.module('./settings/settings.js', () => realSettings)
  mock.module('./git/gitignore.js', () => realGitignore)
  if (originalConfigDirEnv === undefined) {
    delete process.env.CLAUDIN_CONFIG_DIR
  } else {
    process.env.CLAUDIN_CONFIG_DIR = originalConfigDirEnv
  }
})

let gitignoreCalls: Array<{ filename: string; cwd: string }> = []

/**
 * Re-imports plans.js with a cache-busting query so its top-level
 * `import { getInitialSettings } from './settings/settings.js'` binding
 * picks up whatever we've just mocked (mirrors utils/effort.xhighDefault.test.ts).
 */
async function importFreshPlansModule(options: { plansDirectory?: string } = {}) {
  gitignoreCalls = []
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => ({ plansDirectory: options.plansDirectory }),
  }))
  mock.module('./git/gitignore.js', () => ({
    ...realGitignore,
    addFileGlobRuleToGitignore: async (filename: string, cwd: string) => {
      gitignoreCalls.push({ filename, cwd })
    },
  }))
  return import(`./plans.js?t=${Date.now()}-${Math.random()}`)
}

describe('getPlansDirectory', () => {
  const tmpDirs: string[] = []
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'claudin-plans-home-'))
    tmpDirs.push(fakeHome)
    process.env.CLAUDIN_CONFIG_DIR = join(fakeHome, '.claudin')
  })

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function freshProjectDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'claudin-plans-proj-'))
    tmpDirs.push(dir)
    return dir
  }

  test('defaults to <cwd>/.claudin/plans, created 0700, when no plansDirectory setting is present', async () => {
    const projectDir = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule()

    const result = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(result).toBe(join(projectDir, '.claudin', 'plans'))
    expect(existsSync(result)).toBe(true)
    expect(statSync(result).mode & 0o777).toBe(0o700)
  })

  test('honors a plansDirectory setting relative to the project root', async () => {
    const projectDir = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule({
      plansDirectory: 'my-plans',
    })

    const result = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(result).toBe(join(projectDir, 'my-plans'))
    expect(existsSync(result)).toBe(true)
  })

  test('falls back to <cwd>/.claudin/plans when plansDirectory escapes the project root lexically', async () => {
    const projectDir = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule({
      plansDirectory: '../outside',
    })

    const result = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(result).toBe(join(projectDir, '.claudin', 'plans'))
  })

  test('SECURITY: a .claudin symlink escaping the project root falls back to the global config dir', async () => {
    const projectDir = freshProjectDir()
    const outsideDir = freshProjectDir() // a second, unrelated tmp dir = "outside the project"
    symlinkSync(outsideDir, join(projectDir, '.claudin'), 'dir')
    const { getPlansDirectory } = await importFreshPlansModule()

    const result = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(result).toBe(join(process.env.CLAUDIN_CONFIG_DIR!, 'plans'))
    expect(result.startsWith(projectDir)).toBe(false)
    expect(result.startsWith(outsideDir)).toBe(false)
    expect(existsSync(result)).toBe(true)
  })

  test('SECURITY (TOCTOU): a symlink whose target does not exist yet falls back to the global config dir, not the unverified lexical path', async () => {
    // Regression test for a bug in the first version of the symlink-escape
    // check: if realpathSync() throws (e.g. the attacker's symlink target
    // hasn't been created yet at check time), the old code left plansPath as
    // the unverified lexical path — which then got memoized process-wide.
    const projectDir = freshProjectDir()
    const danglingTarget = join(projectDir, '..', 'never-created', 'target')
    symlinkSync(danglingTarget, join(projectDir, '.claudin'), 'dir')
    const { getPlansDirectory } = await importFreshPlansModule()

    const result = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(result).toBe(join(process.env.CLAUDIN_CONFIG_DIR!, 'plans'))
    expect(result).not.toBe(join(projectDir, '.claudin', 'plans'))
    expect(existsSync(result)).toBe(true)
  })

  test('is memoized per-cwd: different cwds resolve independently, not to a globally frozen value', async () => {
    const projectA = freshProjectDir()
    const projectB = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule()

    const resultA = runWithCwdOverride(projectA, () => getPlansDirectory())
    const resultB = runWithCwdOverride(projectB, () => getPlansDirectory())
    const resultAAgain = runWithCwdOverride(projectA, () => getPlansDirectory())

    expect(resultA).toBe(join(projectA, '.claudin', 'plans'))
    expect(resultB).toBe(join(projectB, '.claudin', 'plans'))
    expect(resultAAgain).toBe(resultA)
  })

  test('cache.clear() forces recomputation for a cwd whose directory was deleted underneath the cached value', async () => {
    // This is the exact mechanism AgentTool.tsx's cleanupWorktreeIfNeeded()
    // relies on: after removeAgentWorktree() deletes a subagent worktree,
    // getPlansDirectory.cache.clear() must be called or a later subagent
    // reusing the same deterministic worktree path gets served a plans-dir
    // path for a directory that no longer exists.
    const projectDir = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule()

    const first = runWithCwdOverride(projectDir, () => getPlansDirectory())
    expect(existsSync(first)).toBe(true)

    rmSync(projectDir, { recursive: true, force: true })

    // Without clearing the cache, the memoized string is returned as-is and
    // no fs work re-runs, so it now points at a directory that is gone.
    const stale = runWithCwdOverride(projectDir, () => getPlansDirectory())
    expect(stale).toBe(first)
    expect(existsSync(stale)).toBe(false)

    getPlansDirectory.cache.clear?.()
    const recomputed = runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(recomputed).toBe(first)
    expect(existsSync(recomputed)).toBe(true)
  })

  test('adds the resolved plans dir to the global gitignore when it lives inside the project', async () => {
    const projectDir = freshProjectDir()
    const { getPlansDirectory } = await importFreshPlansModule()

    runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(gitignoreCalls).toEqual([
      { filename: `.claudin${sep}plans/`, cwd: projectDir },
    ])
  })

  test('does not touch gitignore when the plans dir fell back outside the project (symlink escape)', async () => {
    const projectDir = freshProjectDir()
    const outsideDir = freshProjectDir()
    symlinkSync(outsideDir, join(projectDir, '.claudin'), 'dir')
    const { getPlansDirectory } = await importFreshPlansModule()

    runWithCwdOverride(projectDir, () => getPlansDirectory())

    expect(gitignoreCalls).toEqual([])
  })

  test('a `cd` inside a Bash command does not move the plans directory', async () => {
    // Regression: Shell.ts persists the cwd after every foreground command and
    // plan mode allows read-only Bash, so `cd sub && ls` moved getCwd() into the
    // subdirectory. Keyed on getCwd(), the plans dir moved with it: the plan file
    // the model had been told to write stopped being recognized as the plan file
    // and every write to it was denied with "Only the plan file may be edited".
    const projectDir = freshProjectDir()
    const subDir = join(projectDir, 'sub')
    mkdirSync(subDir)
    const { getPlansDirectory } = await importFreshPlansModule()
    const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } =
      await import('../bootstrap/state.js')
    const previousCwd = getCwdState()
    const previousOriginalCwd = getOriginalCwd()

    try {
      setOriginalCwd(projectDir)
      setCwdState(projectDir)
      const before = getPlansDirectory()

      setCwdState(subDir) // what BashTool's cwd tracking does after `cd sub`
      const after = getPlansDirectory()

      expect(before).toBe(join(projectDir, '.claudin', 'plans'))
      expect(after).toBe(before)
      expect(existsSync(join(subDir, '.claudin'))).toBe(false)
    } finally {
      setCwdState(previousCwd)
      setOriginalCwd(previousOriginalCwd)
    }
  })
})
