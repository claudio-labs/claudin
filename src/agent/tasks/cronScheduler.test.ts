import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CronScheduler, createCronScheduler } from 'src/agent/tasks/cronScheduler.js'
import {
  type CronTask,
  DEFAULT_CRON_JITTER_CONFIG,
  finalRunNotice,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  readCronTasks,
  writeCronTasks,
} from 'src/agent/tasks/cronTasks.js'

const HOUR = 60 * 60 * 1000
const running: Array<{ scheduler: CronScheduler; dir: string }> = []

afterEach(() => {
  for (const { scheduler, dir } of running.splice(0)) {
    scheduler.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A daemon-style scheduler (explicit dir: no bootstrap state) over one task,
// read back through getNextFireTime() once the first check() has seen it, and
// whether that check fired it on the spot.
async function firstSight(task: CronTask): Promise<{ next: number | null; fired: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'cron-scheduler-'))
  await writeCronTasks([task], dir)
  const fired: string[] = []
  const scheduler = createCronScheduler({
    dir,
    lockIdentity: 'cron-scheduler-test',
    onFire: prompt => fired.push(prompt),
    isLoading: () => false,
  })
  running.push({ scheduler, dir })
  scheduler.start()
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const next = scheduler.getNextFireTime()
    if (next !== null) return { next, fired }
    await new Promise(r => setTimeout(r, 100))
  }
  return { next: null, fired }
}

// The scheduler's first-sight anchors, which a tool reporting "next run"
// has to agree with.
describe('cronScheduler first sight', () => {
  test('a never-fired recurring task is anchored at createdAt, jitter included', async () => {
    const createdAt = Date.now()
    const task = { id: 'ffffffff', cron: '0 * * * *', prompt: 'p', createdAt, recurring: true }
    expect((await firstSight(task)).next).toBe(jitteredNextCronRunMs('0 * * * *', createdAt, 'ffffffff'))
  }, 15_000)

  // Anchored at its old createdAt instead, it would be overdue and fire again
  // on the first tick.
  test('a fired-before recurring task is anchored at lastFiredAt, not fired again', async () => {
    const lastFiredAt = Date.now()
    const task = { id: '80000000', cron: '0 * * * *', prompt: 'p', createdAt: lastFiredAt - 5 * HOUR, lastFiredAt, recurring: true }
    const { next, fired } = await firstSight(task)
    expect(next).toBe(jitteredNextCronRunMs('0 * * * *', lastFiredAt, '80000000'))
    expect(fired).toEqual([])
  }, 15_000)

  // The lead (up to 90 s) is clamped to createdAt, so a mark closer than that
  // makes the task due on the first check, which fires and deletes it: take
  // whichever of :00 and :30 is further from now.
  test('a one-shot is anchored at createdAt with its early jitter', async () => {
    const createdAt = Date.now()
    const minute = new Date(createdAt).getMinutes()
    const cron = minute >= 15 && minute < 45 ? '0 * * * *' : '30 * * * *'
    const task = { id: 'ffffffff', cron, prompt: 'p', createdAt }
    expect((await firstSight(task)).next).toBe(oneShotJitteredNextCronRunMs(cron, createdAt, 'ffffffff'))
  }, 15_000)
})

describe('cronScheduler aged-out recurring task', () => {
  async function fireOnce(task: CronTask): Promise<{ fired: string[]; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'cron-scheduler-'))
    await writeCronTasks([task], dir)
    const fired: string[] = []
    const scheduler = createCronScheduler({
      dir,
      lockIdentity: 'cron-scheduler-test',
      onFire: prompt => fired.push(prompt),
      isLoading: () => false,
    })
    running.push({ scheduler, dir })
    scheduler.start()
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && fired.length === 0) await new Promise(r => setTimeout(r, 100))
    return { fired, dir }
  }

  test('its last fire carries the notice after the prompt, and the task is deleted', async () => {
    const DAY = 24 * HOUR
    const task = { id: 'a9ed0001', cron: '* * * * *', prompt: 'check the deploy', createdAt: Date.now() - 8 * DAY, recurring: true }
    const { fired, dir } = await fireOnce(task)
    expect(fired).toEqual([`check the deploy\n\n${finalRunNotice(task, DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs)}`])
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline && (await readCronTasks(dir)).length > 0) await new Promise(r => setTimeout(r, 100))
    expect(await readCronTasks(dir)).toEqual([])
  }, 15_000)

  test('a fire before the limit carries no notice', async () => {
    const task = { id: 'a9ed0002', cron: '* * * * *', prompt: 'check the deploy', createdAt: Date.now() - 2 * HOUR, recurring: true }
    expect((await fireOnce(task)).fired).toEqual(['check the deploy'])
  }, 15_000)
})
