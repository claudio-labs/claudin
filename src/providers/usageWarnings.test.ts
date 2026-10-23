import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  crossedThreshold,
  formatLimitReached,
  formatResetSuffix,
  formatUsageBar,
  formatUsageIndicator,
  formatUsageWarning,
  formatWindowDuration,
  standingWindow,
  type LimitWindow,
} from 'src/providers/usageWarnings.js'

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const HOUR = 3_600_000

function window(partial: Partial<LimitWindow>): LimitWindow {
  return { key: 'codex:primary', label: '5h', usedPercent: 0, ...partial }
}

describe('formatUsageBar', () => {
  test.each([
    [0, '▱▱▱▱▱▱▱▱▱▱'],
    [76, '▰▰▰▰▰▰▰▰▱▱'],
    [92, '▰▰▰▰▰▰▰▰▰▱'],
    [100, '▰▰▰▰▰▰▰▰▰▰'],
    [140, '▰▰▰▰▰▰▰▰▰▰'],
    [-5, '▱▱▱▱▱▱▱▱▱▱'],
  ])('%d%% → %s', (pct, bar) => {
    expect(formatUsageBar(pct)).toBe(bar)
  })

  test('the cell count is a parameter', () => {
    expect(formatUsageBar(50, 4)).toBe('▰▰▱▱')
  })
})

describe('formatResetSuffix', () => {
  let nowSpy: ReturnType<typeof spyOn<typeof Date, 'now'>>
  beforeEach(() => {
    nowSpy = spyOn(Date, 'now').mockReturnValue(NOW)
  })
  afterEach(() => nowSpy.mockRestore())

  test('nothing without a timestamp', () => {
    expect(formatResetSuffix(undefined, NOW)).toBe('')
  })

  test('a future reset carries the countdown', () => {
    expect(formatResetSuffix(NOW + 2 * HOUR + 14 * 60_000, NOW)).toMatch(
      /^ · resets .+ \(in 2h 14m\)$/,
    )
  })

  test('a passed reset keeps only the wall-clock time', () => {
    const text = formatResetSuffix(NOW - HOUR, NOW)
    expect(text).toMatch(/^ · resets /)
    expect(text).not.toContain('(in')
  })
})

describe('formatUsageWarning', () => {
  test('provider first, then window, bar, percent and reset', () => {
    const text = formatUsageWarning(
      'Codex OAuth',
      window({ usedPercent: 76.6, resetsAtMs: NOW + 72 * 60_000 }),
      NOW,
    )
    expect(text).toMatch(/^Codex OAuth · 5h ▰▰▰▰▰▰▰▰▱▱ 76% · resets .+ \(in 1h 12m\)$/)
  })

  test('no reset part when the provider sent none', () => {
    expect(formatUsageWarning('Anthropic', window({ label: 'weekly', usedPercent: 92 }), NOW)).toBe(
      'Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 92%',
    )
  })
})

test('formatUsageIndicator is the short standing form', () => {
  expect(formatUsageIndicator('Anthropic', window({ label: 'weekly', usedPercent: 92.9 }))).toBe(
    'Anthropic weekly 92%',
  )
})

test.each([
  [300, '5h'],
  [10080, 'weekly'],
  [43200, '30d'],
  [90, '90m'],
  [undefined, 'usage'],
  [0, 'usage'],
])('a %s-minute window reads %s', (minutes, label) => {
  expect(formatWindowDuration(minutes, 'usage')).toBe(label)
})

test('formatLimitReached puts the provider first', () => {
  expect(formatLimitReached('OpenRouter', 'rate limit', ' · resets in 42s')).toBe(
    'OpenRouter · rate limit reached · resets in 42s',
  )
})

describe('crossedThreshold', () => {
  const reset = NOW + HOUR

  test('below the lowest threshold nothing is announced', () => {
    const { window: w, state } = crossedThreshold([window({ usedPercent: 74.9 })], {})
    expect(w).toBeUndefined()
    expect(state).toEqual({})
  })

  test('each threshold is announced once per window', () => {
    let state = {}
    const seen: Array<number | undefined> = []
    for (const pct of [76, 80, 91, 93, 96, 97]) {
      const r = crossedThreshold([window({ usedPercent: pct, resetsAtMs: reset })], state)
      seen.push(r.window?.usedPercent)
      state = r.state
    }
    expect(seen).toEqual([76, undefined, 91, undefined, 96, undefined])
  })

  test('a jump past several thresholds is one announcement', () => {
    const first = crossedThreshold([window({ usedPercent: 96, resetsAtMs: reset })], {})
    expect(first.window?.usedPercent).toBe(96)
    const again = crossedThreshold([window({ usedPercent: 98, resetsAtMs: reset })], first.state)
    expect(again.window).toBeUndefined()
  })

  test('a reset that drifts by seconds between responses is the same window', () => {
    let state = crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset })], {}).state
    // Many small drifts in a row never add up to a re-arm.
    for (let i = 1; i <= 20; i++) {
      const r = crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset + i * 3_000 })], state)
      expect(r.window).toBeUndefined()
      state = r.state
    }
    // A drift past the tolerance in one step is a new window.
    expect(
      crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset + 60_000 + 6 * 60_000 })], state).window,
    ).toBeDefined()
  })

  test('a new reset instant re-arms the window', () => {
    const first = crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset })], {})
    const next = crossedThreshold(
      [window({ usedPercent: 80, resetsAtMs: reset + 5 * HOUR })],
      first.state,
    )
    expect(next.window?.usedPercent).toBe(80)
  })

  test('falling under the lowest threshold forgets the window', () => {
    const first = crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset })], {})
    const low = crossedThreshold([window({ usedPercent: 5, resetsAtMs: reset })], first.state)
    expect(low.state).toEqual({})
    const back = crossedThreshold([window({ usedPercent: 80, resetsAtMs: reset })], low.state)
    expect(back.window?.usedPercent).toBe(80)
  })

  test('100% is left to the limit-reached message', () => {
    const r = crossedThreshold([window({ usedPercent: 100, resetsAtMs: reset })], {})
    expect(r.window).toBeUndefined()
  })

  test('the fullest of several crossing windows is the one returned', () => {
    const r = crossedThreshold(
      [
        window({ key: 'codex:primary', usedPercent: 77 }),
        window({ key: 'codex:secondary', label: 'weekly', usedPercent: 91 }),
      ],
      {},
    )
    expect(r.window?.key).toBe('codex:secondary')
    expect(Object.keys(r.state).sort()).toEqual(['codex:primary', 'codex:secondary'])
  })
})

describe('standingWindow', () => {
  test('the fullest window over the floor whose reset has not passed', () => {
    const windows = [
      window({ key: 'a', usedPercent: 80, resetsAtMs: NOW + HOUR }),
      window({ key: 'b', usedPercent: 95, resetsAtMs: NOW - 1 }),
      window({ key: 'c', usedPercent: 90 }),
      window({ key: 'd', usedPercent: 60 }),
    ]
    expect(standingWindow(windows, 75, NOW)?.key).toBe('c')
  })

  test('nothing over the floor → nothing on screen', () => {
    expect(standingWindow([window({ usedPercent: 10 })], 75, NOW)).toBeUndefined()
  })
})
