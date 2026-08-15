import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// cleanupOldPlanFiles() reads the current plans dir via ./plans.js and the
// cutoff period via ./settings/settings.js. Both are mocked at the module
// boundary (they're config sources, covered by their own dedicated tests —
// see plans.test.ts) so this file can pin exact directories/dates without
// touching the developer's real ~/.claudin settings or plans. All the actual
// sweep behavior under test (readdir/stat/unlink) runs against real fs.
const realPlans = { ...(await import('src/agent/plans/plans.js')) }
const realSettings = { ...(await import('src/platform/settings/settings.js')) }

afterAll(() => {
  mock.module('src/agent/plans/plans.js', () => realPlans)
  mock.module('src/platform/settings/settings.js', () => realSettings)
})

async function importFreshCleanupModule(options: {
  plansDir: string
  legacyHomeConfigDir: string
}) {
  mock.module('src/agent/plans/plans.js', () => ({
    ...realPlans,
    getPlansDirectory: () => options.plansDir,
  }))
  mock.module('src/platform/settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => ({}),
  }))
  process.env.CLAUDIN_CONFIG_DIR = options.legacyHomeConfigDir
  return import(`./cleanup.js?t=${Date.now()}-${Math.random()}`)
}

/** Creates a task-list dir with one task file and backdates its mtime. */
function writeAgedTaskListDir(
  tasksBaseDir: string,
  name: string,
  ageDays: number,
): string {
  const dir = join(tasksBaseDir, name)
  mkdirSync(dir, { recursive: true })
  const taskFile = join(dir, '1.json')
  writeFileSync(taskFile, '{}')
  const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  utimesSync(taskFile, past, past)
  utimesSync(dir, past, past)
  return dir
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

describe('cleanupOldTaskListDirs', () => {
  const tmpDirs: string[] = []
  const originalConfigDirEnv = process.env.CLAUDIN_CONFIG_DIR
  const originalTaskListIdEnv = process.env.CLAUDE_CODE_TASK_LIST_ID

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalConfigDirEnv === undefined) {
      delete process.env.CLAUDIN_CONFIG_DIR
    } else {
      process.env.CLAUDIN_CONFIG_DIR = originalConfigDirEnv
    }
    if (originalTaskListIdEnv === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskListIdEnv
    }
  })

  async function setup(): Promise<{
    tasksBaseDir: string
    cleanupOldTaskListDirs: () => Promise<{ messages: number; errors: number }>
  }> {
    const home = mkdtempSync(join(tmpdir(), 'claudin-cleanup-tasks-'))
    tmpDirs.push(home)
    const configDir = join(home, '.claudin')
    const tasksBaseDir = join(configDir, 'tasks')
    mkdirSync(tasksBaseDir, { recursive: true })
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'live-session'
    const mod = await importFreshCleanupModule({
      plansDir: join(configDir, 'plans'),
      legacyHomeConfigDir: configDir,
    })
    return { tasksBaseDir, cleanupOldTaskListDirs: mod.cleanupOldTaskListDirs }
  }

  test('removes task lists older than the cutoff and keeps recent ones', async () => {
    const { tasksBaseDir, cleanupOldTaskListDirs } = await setup()
    const stale = writeAgedTaskListDir(tasksBaseDir, 'old-session', 40)
    const recent = writeAgedTaskListDir(tasksBaseDir, 'new-session', 1)

    const result = await cleanupOldTaskListDirs()

    expect(result).toEqual({ messages: 1, errors: 0 })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('never removes the live task list, however old its mtime', async () => {
    const { tasksBaseDir, cleanupOldTaskListDirs } = await setup()
    const live = writeAgedTaskListDir(tasksBaseDir, 'live-session', 400)

    const result = await cleanupOldTaskListDirs()

    expect(result).toEqual({ messages: 0, errors: 0 })
    expect(existsSync(live)).toBe(true)
  })

  test('protects another session whose task files were touched recently', async () => {
    const { tasksBaseDir, cleanupOldTaskListDirs } = await setup()
    const other = writeAgedTaskListDir(tasksBaseDir, 'other-session', 400)
    // updateTask rewrites the JSON in place, which never moves the directory's
    // own mtime — so a live session that only ticks statuses looks ancient.
    const now = new Date()
    utimesSync(join(other, '1.json'), now, now)

    const result = await cleanupOldTaskListDirs()

    expect(result).toEqual({ messages: 0, errors: 0 })
    expect(existsSync(other)).toBe(true)
  })

  test('is a no-op when the tasks dir does not exist', async () => {
    const { tasksBaseDir, cleanupOldTaskListDirs } = await setup()
    rmSync(tasksBaseDir, { recursive: true, force: true })

    expect(await cleanupOldTaskListDirs()).toEqual({ messages: 0, errors: 0 })
  })
})
