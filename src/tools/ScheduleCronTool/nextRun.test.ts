import { describe, expect, test } from 'bun:test'

import { describeNextRun, formatRunTime } from 'src/tools/ScheduleCronTool/nextRun.js'

const NOV_1_0905 = new Date(2026, 10, 1, 9, 5).getTime()

// When it fires is cronTasks' nextFireMs (tested there); this is the format.
describe('describeNextRun', () => {
  test("formats the scheduler's next fire, or nothing when the cron never matches again", () => {
    const hourly = { id: '00000000', cron: '7 * * * *', createdAt: NOV_1_0905, recurring: true }
    expect(describeNextRun(hourly, NOV_1_0905)).toBe('2026-11-01 09:07')
    // A fired session job with 3 minutes of jitter, listed at 11:02, runs at 11:03, not 12:03.
    const jittered = { id: '80000000', cron: '0 * * * *', createdAt: NOV_1_0905, recurring: true }
    expect(describeNextRun(jittered, new Date(2026, 10, 1, 11, 2).getTime())).toBe('2026-11-01 11:03')
    const never = { id: '00000000', cron: '0 0 31 2 *', createdAt: NOV_1_0905, recurring: false }
    expect(describeNextRun(never, NOV_1_0905)).toBeUndefined()
  })
})

describe('formatRunTime', () => {
  test('is local date and minute, zero-padded', () => {
    expect(formatRunTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04')
  })
})
