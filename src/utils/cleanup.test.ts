import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// cleanupOldPlanFiles() reads the current plans dir via ./plans.js and the
// cutoff period via ./settings/settings.js. Both are mocked at the module
// boundary (they're config sources, covered by their own dedicated tests —
// see plans.test.ts) so this file can pin exact directories/dates without
// touching the developer's real ~/.claudin settings or plans. All the actual
// sweep behavior under test (readdir/stat/unlink) runs against real fs.
const realPlans = { ...(await import('./plans.js')) }
const realSettings = { ...(await import('./settings/settings.js')) }

afterAll(() => {
  mock.module('./plans.js', () => realPlans)
  mock.module('./settings/settings.js', () => realSettings)
})

async function importFreshCleanupModule(options: {
  plansDir: string
  legacyHomeConfigDir: string
}) {
  mock.module('./plans.js', () => ({
    ...realPlans,
    getPlansDirectory: () => options.plansDir,
  }))
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getSettings_DEPRECATED: () => ({}),
  }))
  process.env.CLAUDIN_CONFIG_DIR = options.legacyHomeConfigDir
  return import(`./cleanup.js?t=${Date.now()}-${Math.random()}`)
}

/** Writes a .md plan file and backdates its mtime by `ageDays` days. */
function writeAgedPlanFile(dir: string, name: string, ageDays: number): string {
  const filePath = join(dir, name)
  writeFileSync(filePath, '# plan')
  const ageMs = ageDays * 24 * 60 * 60 * 1000
  const past = new Date(Date.now() - ageMs)
  utimesSync(filePath, past, past)
  return filePath
}

describe('cleanupOldPlanFiles', () => {
  const tmpDirs: string[] = []
  const originalConfigDirEnv = process.env.CLAUDIN_CONFIG_DIR

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalConfigDirEnv === undefined) {
      delete process.env.CLAUDIN_CONFIG_DIR
    } else {
      process.env.CLAUDIN_CONFIG_DIR = originalConfigDirEnv
    }
  })

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tmpDirs.push(dir)
    return dir
  }

  test('removes plan files older than the cutoff and keeps recent ones, in the current plans dir', async () => {
    const plansDir = freshDir('claudin-cleanup-plans-')
    const legacyHome = freshDir('claudin-cleanup-legacyhome-')
    const oldFile = writeAgedPlanFile(plansDir, 'old-plan.md', 40)
    const newFile = writeAgedPlanFile(plansDir, 'new-plan.md', 1)

    const { cleanupOldPlanFiles } = await importFreshCleanupModule({
      plansDir,
      legacyHomeConfigDir: join(legacyHome, '.claudin'),
    })
    const result = await cleanupOldPlanFiles()

    expect(result).toEqual({ messages: 1, errors: 0 })
    await expect(Bun.file(oldFile).exists()).resolves.toBe(false)
    await expect(Bun.file(newFile).exists()).resolves.toBe(true)
  })

  test('also sweeps the legacy ~/.claudin/plans dir and merges the counts', async () => {
    const plansDir = freshDir('claudin-cleanup-plans-')
    const legacyHome = freshDir('claudin-cleanup-legacyhome-')
    const legacyPlansDir = join(legacyHome, '.claudin', 'plans')
    mkdirSync(legacyPlansDir, { recursive: true })

    writeAgedPlanFile(plansDir, 'new-in-current.md', 40) // new dir: 1 old file
    writeAgedPlanFile(legacyPlansDir, 'old-in-legacy-1.md', 40) // legacy dir: 2 old files
    writeAgedPlanFile(legacyPlansDir, 'old-in-legacy-2.md', 40)
    writeAgedPlanFile(legacyPlansDir, 'recent-in-legacy.md', 1)

    const { cleanupOldPlanFiles } = await importFreshCleanupModule({
      plansDir,
      legacyHomeConfigDir: join(legacyHome, '.claudin'),
    })
    const result = await cleanupOldPlanFiles()

    // 1 removed from the current dir + 2 removed from the legacy dir
    expect(result).toEqual({ messages: 3, errors: 0 })
  })

  test('does not double-sweep when the current plans dir already equals the legacy dir', async () => {
    const legacyHome = freshDir('claudin-cleanup-legacyhome-')
    const plansDir = join(legacyHome, '.claudin', 'plans')
    mkdirSync(plansDir, { recursive: true })
    writeAgedPlanFile(plansDir, 'old-plan.md', 40)

    const { cleanupOldPlanFiles } = await importFreshCleanupModule({
      plansDir,
      legacyHomeConfigDir: join(legacyHome, '.claudin'),
    })
    const result = await cleanupOldPlanFiles()

    // Must count the single old file once, not twice via a redundant second pass.
    expect(result).toEqual({ messages: 1, errors: 0 })
  })
})
