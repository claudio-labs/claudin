import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CronScheduler, createCronScheduler } from 'src/agent/tasks/cronScheduler.js'
import {
  type CronTask,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
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

  test('a one-shot is anchored at createdAt with its early jitter', async () => {
    const createdAt = Date.now()
    const task = { id: 'ffffffff', cron: '30 * * * *', prompt: 'p', createdAt }
    expect((await firstSight(task)).next).toBe(oneShotJitteredNextCronRunMs('30 * * * *', createdAt, 'ffffffff'))
  }, 15_000)
})
