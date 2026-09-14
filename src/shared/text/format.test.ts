import { describe, expect, test } from 'bun:test'

import {
  formatCountdownDuration,
  formatResetCountdown,
} from 'src/shared/text/format.js'

const NOW = 1_700_000_000_000

describe('formatCountdownDuration', () => {
  test('renders hours and minutes', () => {
    expect(formatCountdownDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m')
  })

  test('drops the minutes when they round to zero', () => {
    expect(formatCountdownDuration(3 * 3_600_000)).toBe('3h')
  })

  test('renders minutes alone under an hour', () => {
    expect(formatCountdownDuration(45 * 60_000)).toBe('45m')
  })

  test('renders seconds under a minute', () => {
    // Rounded up to "1m" this contradicted the retry notice ticking beside it.
    expect(formatCountdownDuration(7_000)).toBe('7s')
    expect(formatCountdownDuration(59_999)).toBe('60s')
  })

  test('renders days, with hours when there are any', () => {
    expect(formatCountdownDuration(3 * 86_400_000)).toBe('3d')
    expect(formatCountdownDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h')
  })

  test('never reads as zero', () => {
    expect(formatCountdownDuration(1)).toBe('1s')
    expect(formatCountdownDuration(0)).toBe('1s')
  })

  test('rounds up rather than truncating', () => {
    expect(formatCountdownDuration(61_000)).toBe('2m')
  })
})

describe('formatResetCountdown', () => {
  test('counts down to a future timestamp', () => {
    const resetsAt = new Date(NOW + 2 * 3_600_000 + 15 * 60_000).toISOString()
    expect(formatResetCountdown(resetsAt, NOW)).toBe('Resets in 2h 15m')
  })

  test('reports a past timestamp as resetting now', () => {
    expect(formatResetCountdown(new Date(NOW - 1000).toISOString(), NOW)).toBe(
      'Resetting now',
    )
  })

  test('returns undefined without a timestamp or for an unparseable one', () => {
    expect(formatResetCountdown(undefined, NOW)).toBeUndefined()
    expect(formatResetCountdown('not a date', NOW)).toBeUndefined()
  })
})
