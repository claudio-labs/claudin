import { describe, expect, test } from 'bun:test'

import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from 'src/agent/tasks/cronTasks.js'
import { describeNextRun, formatRunTime, nextRunMs } from 'src/tools/ScheduleCronTool/nextRun.js'

const NOV_1_0905 = new Date(2026, 10, 1, 9, 5).getTime()
const HOUR = 60 * 60 * 1000

describe('nextRunMs', () => {
  test('a new recurring job runs when the scheduler first anchors it: createdAt plus jitter', () => {
    const task = { id: 'ffffffff', cron: '0 * * * *', createdAt: NOV_1_0905, recurring: true }
    const next = nextRunMs(task, NOV_1_0905)
    expect(next).toBe(jitteredNextCronRunMs('0 * * * *', NOV_1_0905, 'ffffffff'))
    // An hourly job with the largest jitter runs about six minutes after :00.
    const late = next! - new Date(2026, 10, 1, 10, 0).getTime()
    expect(late).toBeGreaterThan(5.9 * 60_000)
    expect(late).toBeLessThanOrEqual(6 * 60_000)
  })

  test('a recurring job that fired since re-anchors at now', () => {
    const task = { id: '00000000', cron: '*/10 * * * *', createdAt: NOV_1_0905, recurring: true }
    const later = NOV_1_0905 + 2 * HOUR
    expect(nextRunMs(task, later)).toBe(jitteredNextCronRunMs('*/10 * * * *', later, '00000000'))
  })

  test('a fired-before durable job anchors at lastFiredAt', () => {
    const lastFiredAt = NOV_1_0905 + HOUR
    const task = { id: '80000000', cron: '0 * * * *', createdAt: NOV_1_0905, recurring: true, lastFiredAt }
    expect(nextRunMs(task, lastFiredAt)).toBe(jitteredNextCronRunMs('0 * * * *', lastFiredAt, '80000000'))
  })

  test('a one-shot job keeps its createdAt anchor', () => {
    const task = { id: 'ffffffff', cron: '30 14 1 11 *', createdAt: NOV_1_0905, recurring: false }
    expect(nextRunMs(task, NOV_1_0905 + HOUR)).toBe(
      oneShotJitteredNextCronRunMs('30 14 1 11 *', NOV_1_0905, 'ffffffff'),
    )
  })
})

describe('describeNextRun', () => {
  test('formats the next run, or nothing when the cron never matches again', () => {
    const hourly = { id: '00000000', cron: '7 * * * *', createdAt: NOV_1_0905, recurring: true }
    expect(describeNextRun(hourly, NOV_1_0905)).toBe('2026-11-01 09:07')
    const never = { id: '00000000', cron: '0 0 31 2 *', createdAt: NOV_1_0905, recurring: false }
    expect(describeNextRun(never, NOV_1_0905)).toBeUndefined()
  })
})

describe('formatRunTime', () => {
  test('is local date and minute, zero-padded', () => {
    expect(formatRunTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04')
  })
})
