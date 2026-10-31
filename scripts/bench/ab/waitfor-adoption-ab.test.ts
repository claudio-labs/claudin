import { describe, expect, test } from 'bun:test'
import { LONG_BASE_CAP_S, type LongRow, longWaitVerdict } from './waitfor-adoption-ab.ts'

const row = (arm: LongRow['arm'], over: Partial<LongRow> = {}): LongRow => ({
  arm,
  rep: 1,
  calls: arm === 'lever' ? 3 : 5,
  waitFor: arm === 'lever' ? 1 : 3,
  maxTimeoutAsked: arm === 'lever' ? 60 : LONG_BASE_CAP_S,
  cost: 0.2,
  correct: true,
  ...over,
})

const runOf = (lever: Partial<LongRow>[]) => [
  ...Array.from({ length: 5 }, () => row('base')),
  ...Array.from({ length: 5 }, () => row('placebo')),
  ...lever.map(over => row('lever', over)),
]

describe('longWaitVerdict', () => {
  test('one call above the base cap, fewer requests, every answer right: pass', () => {
    expect(longWaitVerdict(runOf([{}, {}, {}, {}, { waitFor: 2, calls: 4 }]))).toEqual({ pass: true, reasons: [] })
  })

  test('two reps that polled again fail it', () => {
    expect(longWaitVerdict(runOf([{}, {}, {}, { waitFor: 2 }, { waitFor: 2 }])).pass).toBe(false)
  })

  test('a lever that keeps asking for the base cap fails the mechanism', () => {
    const v = longWaitVerdict(runOf(Array.from({ length: 5 }, () => ({ maxTimeoutAsked: LONG_BASE_CAP_S }))))
    expect(v.reasons).toEqual([`timeout_s above ${LONG_BASE_CAP_S} in 0/5 lever reps`])
  })

  test('a lever no cheaper in requests than the cheapest base rep fails', () => {
    const rows = [...runOf([{}, {}, {}, {}, {}]), row('placebo', { calls: 3 })]
    expect(longWaitVerdict(rows).reasons).toEqual(['lever median calls 3 not below the base/placebo minimum 3'])
  })

  test('a wrong answer fails it, and a run with no lever cannot pass', () => {
    expect(longWaitVerdict(runOf([{ correct: false }, {}, {}, {}, {}])).pass).toBe(false)
    expect(longWaitVerdict([row('base')]).pass).toBe(false)
  })
})
