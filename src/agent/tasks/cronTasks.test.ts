import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addCronTask,
  type CronTask,
  DEFAULT_CRON_JITTER_CONFIG,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  jitteredNextCronRunMs,
  listAllCronTasks,
  markCronTasksFired,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  removeCronTasks,
  writeCronTasks,
} from 'src/agent/tasks/cronTasks.js'
import {
  getProjectRoot,
  getSessionCronTasks,
  removeSessionCronTasks,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'

const MIN = 60_000
const HOUR = 60 * MIN
const NOV_1_0905 = new Date(2026, 10, 1, 9, 5).getTime()

let root: string
let savedRoot: string

beforeAll(() => {
  savedRoot = getProjectRoot()
  root = mkdtempSync(join(tmpdir(), 'cron-tasks-'))
  // addCronTask/listAllCronTasks without a dir resolve the project root.
  setProjectRoot(root)
})

afterAll(() => {
  setProjectRoot(savedRoot)
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map(t => t.id))
  rmSync(join(root, '.claudin'), { recursive: true, force: true })
})

function writeRaw(body: string): void {
  mkdirSync(join(root, '.claudin'), { recursive: true })
  writeFileSync(getCronFilePath(root), body)
}

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 'aaaaaaaa',
  cron: '*/5 * * * *',
  prompt: 'p',
  createdAt: NOV_1_0905,
  ...over,
})

describe('the cron file', () => {
  test('lives at .claudin/scheduled_tasks.json under the directory', () => {
    expect(getCronFilePath('/x')).toBe(join('/x', '.claudin', 'scheduled_tasks.json'))
    expect(getCronFilePath()).toBe(join(root, '.claudin', 'scheduled_tasks.json'))
  })

  test('a missing, malformed or task-less file reads as no tasks', async () => {
    expect(await readCronTasks(root)).toEqual([])
    writeRaw('{ not json')
    expect(await readCronTasks(root)).toEqual([])
    writeRaw('"a string"')
    expect(await readCronTasks(root)).toEqual([])
    writeRaw('{"tasks": "nope"}')
    expect(await readCronTasks(root)).toEqual([])
  })

  test('an unreadable path (a directory) reads as no tasks', async () => {
    mkdirSync(getCronFilePath(root), { recursive: true })
    expect(await readCronTasks(root)).toEqual([])
  })

  test('drops malformed entries and invalid crons, keeps the optional fields it knows', async () => {
    writeRaw(
      JSON.stringify({
        tasks: [
          null,
          { id: 'x', cron: '* * * * *', prompt: 'p' },
          { id: 'bad', cron: 'not a cron', prompt: 'p', createdAt: 1 },
          { id: 'ok', cron: '0 9 * * *', prompt: 'p', createdAt: 1, lastFiredAt: 2, recurring: true, permanent: true, extra: 1 },
          { id: 'plain', cron: '0 9 * * *', prompt: 'p', createdAt: 1, lastFiredAt: 'x', recurring: false },
        ],
      }),
    )
    expect(await readCronTasks(root)).toEqual([
      { id: 'ok', cron: '0 9 * * *', prompt: 'p', createdAt: 1, lastFiredAt: 2, recurring: true, permanent: true },
      { id: 'plain', cron: '0 9 * * *', prompt: 'p', createdAt: 1 },
    ])
  })

  test('hasCronTasksSync is true only for a file with at least one task', () => {
    expect(hasCronTasksSync(root)).toBe(false)
    writeRaw('{ not json')
    expect(hasCronTasksSync(root)).toBe(false)
    writeRaw('{"tasks": []}')
    expect(hasCronTasksSync(root)).toBe(false)
    writeRaw('{"tasks": [{}]}')
    expect(hasCronTasksSync(root)).toBe(true)
  })

  test('writeCronTasks creates .claudin and strips the runtime-only durable flag', async () => {
    await writeCronTasks([task({ durable: true })], root)
    const raw = readFileSync(getCronFilePath(root), 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ tasks: [task()] })
  })
})

describe('adding, removing and stamping tasks', () => {
  test('a non-durable task goes to the session store only, with its agent', async () => {
    const id = await addCronTask('*/5 * * * *', 'remind', true, false, 'agent-1')
    expect(id).toMatch(/^[0-9a-f]{8}$/)
    expect(getSessionCronTasks()).toMatchObject([{ id, cron: '*/5 * * * *', recurring: true, agentId: 'agent-1' }])
    expect(await readCronTasks(root)).toEqual([])
  })

  test('a durable task is appended to the project file', async () => {
    await writeCronTasks([task()], root)
    const id = await addCronTask('0 9 * * *', 'daily', false, true)
    const onDisk = await readCronTasks(root)
    expect(onDisk.map(t => t.id)).toEqual(['aaaaaaaa', id])
    expect(onDisk[1]).not.toHaveProperty('recurring')
  })

  test('removeCronTasks sweeps the session store first, then the file', async () => {
    await removeCronTasks([])
    const sessionId = await addCronTask('*/5 * * * *', 's', false, false)
    await writeCronTasks([task(), task({ id: 'bbbbbbbb' })], root)
    await removeCronTasks([sessionId])
    expect(getSessionCronTasks()).toEqual([])
    expect((await readCronTasks(root)).length).toBe(2)
    await removeCronTasks(['bbbbbbbb', 'missing'])
    expect((await readCronTasks(root)).map(t => t.id)).toEqual(['aaaaaaaa'])
  })

  test('removeCronTasks with a dir never touches the session store, and a miss writes nothing', async () => {
    const sessionId = await addCronTask('*/5 * * * *', 's', false, false)
    await writeCronTasks([task()], root)
    const before = readFileSync(getCronFilePath(root), 'utf-8')
    await removeCronTasks([sessionId], root)
    expect(getSessionCronTasks().map(t => t.id)).toEqual([sessionId])
    expect(readFileSync(getCronFilePath(root), 'utf-8')).toBe(before)
  })

  test('markCronTasksFired stamps lastFiredAt on matching file tasks only', async () => {
    await markCronTasksFired([], 5)
    await writeCronTasks([task({ recurring: true }), task({ id: 'bbbbbbbb' })], root)
    await markCronTasksFired(['missing'], 5, root)
    expect((await readCronTasks(root)).every(t => t.lastFiredAt === undefined)).toBe(true)
    await markCronTasksFired(['aaaaaaaa'], 5, root)
    expect((await readCronTasks(root)).map(t => t.lastFiredAt)).toEqual([5, undefined])
  })

  test('listAllCronTasks merges session tasks only without a dir', async () => {
    await writeCronTasks([task()], root)
    const sessionId = await addCronTask('*/5 * * * *', 's', false, false)
    expect((await listAllCronTasks(root)).map(t => t.id)).toEqual(['aaaaaaaa'])
    const all = await listAllCronTasks()
    expect(all.map(t => [t.id, t.durable])).toEqual([
      ['aaaaaaaa', undefined],
      [sessionId, false],
    ])
  })
})

describe('fire times', () => {
  test('nextCronRunMs is strictly after fromMs, null for an invalid or impossible cron', () => {
    expect(nextCronRunMs('7 * * * *', NOV_1_0905)).toBe(new Date(2026, 10, 1, 9, 7).getTime())
    expect(nextCronRunMs('nope', NOV_1_0905)).toBeNull()
    expect(nextCronRunMs('0 0 31 2 *', NOV_1_0905)).toBeNull()
  })

  test('recurring jitter is a fraction of the gap, capped, and zero for a non-hex id', () => {
    const t1 = new Date(2026, 10, 1, 10, 0).getTime()
    expect(jitteredNextCronRunMs('0 * * * *', NOV_1_0905, '00000000')).toBe(t1)
    const late = jitteredNextCronRunMs('0 * * * *', NOV_1_0905, '80000000')! - t1
    expect(late).toBe(0.5 * DEFAULT_CRON_JITTER_CONFIG.recurringFrac * HOUR)
    // Daily: 10% of a day is over the 15-minute cap.
    const daily = jitteredNextCronRunMs('0 10 * * *', NOV_1_0905, 'ffffffff')! - t1
    expect(daily).toBe(DEFAULT_CRON_JITTER_CONFIG.recurringCapMs)
    expect(jitteredNextCronRunMs('0 * * * *', NOV_1_0905, 'zzzz')).toBe(t1)
  })

  test('recurring jitter: null for an invalid cron, capped for a yearly one', () => {
    expect(jitteredNextCronRunMs('nope', NOV_1_0905, 'ffffffff')).toBeNull()
    const at1430 = new Date(2026, 10, 1, 14, 30).getTime()
    expect(jitteredNextCronRunMs('30 14 1 11 *', NOV_1_0905, '00000000')).toBe(at1430)
    expect(jitteredNextCronRunMs('30 14 1 11 *', NOV_1_0905, 'ffffffff')).toBe(
      at1430 + DEFAULT_CRON_JITTER_CONFIG.recurringCapMs,
    )
  })

  test('one-shot jitter fires early only on :00/:30, never before it was created', () => {
    const at1430 = new Date(2026, 10, 1, 14, 30).getTime()
    expect(oneShotJitteredNextCronRunMs('nope', NOV_1_0905, 'ffffffff')).toBeNull()
    expect(oneShotJitteredNextCronRunMs('31 14 1 11 *', NOV_1_0905, 'ffffffff')).toBe(at1430 + MIN)
    expect(oneShotJitteredNextCronRunMs('30 14 1 11 *', NOV_1_0905, '80000000')).toBe(
      at1430 - 0.5 * DEFAULT_CRON_JITTER_CONFIG.oneShotMaxMs,
    )
    const createdJustBefore = at1430 - 10_000
    expect(oneShotJitteredNextCronRunMs('30 14 1 11 *', createdJustBefore, 'ffffffff')).toBe(createdJustBefore)
  })

  test('findMissedTasks returns the tasks whose next run from createdAt is past', () => {
    const due = task({ id: 'due', cron: '7 * * * *' })
    const later = task({ id: 'later', cron: '0 0 1 1 *' })
    const never = task({ id: 'never', cron: '0 0 31 2 *' })
    const now = NOV_1_0905 + HOUR
    expect(findMissedTasks([due, later, never], now).map(t => t.id)).toEqual(['due'])
  })
})
