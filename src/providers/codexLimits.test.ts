import { afterEach, describe, expect, test } from 'bun:test'

import {
  codexLimitWindows,
  getCodexAnnouncement,
  getCodexLimits,
  recordCodexLimits,
  resetCodexLimitsForTesting,
  subscribeCodexLimits,
} from 'src/providers/codexLimits.js'
import type { CodexUsageData } from 'src/providers/usage/codexUsage.js'

const RESET = '2026-10-22T16:10:00.000Z'

function data(primary: number, secondary?: number, resetsAt = RESET): CodexUsageData {
  return {
    planType: 'plus',
    snapshots: [
      {
        limitName: 'codex',
        primary: { usedPercent: primary, windowMinutes: 300, resetsAt },
        secondary:
          secondary === undefined ? undefined : { usedPercent: secondary, windowMinutes: 10080 },
      },
    ],
  }
}

afterEach(resetCodexLimitsForTesting)

describe('codexLimitWindows', () => {
  test('one labeled window per slot, keyed by limit and slot', () => {
    expect(codexLimitWindows(data(76, 40))).toEqual([
      { key: 'codex:primary', label: '5h', usedPercent: 76, resetsAtMs: Date.parse(RESET) },
      { key: 'codex:secondary', label: 'weekly', usedPercent: 40, resetsAtMs: undefined },
    ])
  })

  test('an unparseable reset is no reset', () => {
    expect(codexLimitWindows(data(1, undefined, 'not a date'))[0]?.resetsAtMs).toBeUndefined()
  })
})

describe('recordCodexLimits', () => {
  test('keeps what the last response said and tells the listeners', () => {
    let calls = 0
    subscribeCodexLimits(() => calls++)
    recordCodexLimits(data(10))
    expect(getCodexLimits()).toEqual(data(10))
    expect(calls).toBe(1)
  })

  test('nothing, an empty answer or a repeat notifies nobody', () => {
    let calls = 0
    subscribeCodexLimits(() => calls++)
    recordCodexLimits(undefined)
    recordCodexLimits({ snapshots: [] })
    expect(getCodexLimits()).toBeUndefined()
    recordCodexLimits(data(10))
    recordCodexLimits(data(10))
    expect(calls).toBe(1)
  })

  test('unsubscribing stops the calls', () => {
    let calls = 0
    const unsubscribe = subscribeCodexLimits(() => calls++)
    unsubscribe()
    recordCodexLimits(data(10))
    expect(calls).toBe(0)
  })

  test('each threshold is announced once, with a new id each time', () => {
    recordCodexLimits(data(50))
    expect(getCodexAnnouncement()).toBeUndefined()
    recordCodexLimits(data(76))
    const first = getCodexAnnouncement()
    expect(first?.window).toMatchObject({ key: 'codex:primary', usedPercent: 76 })
    recordCodexLimits(data(80))
    expect(getCodexAnnouncement()).toBe(first)
    recordCodexLimits(data(91))
    const second = getCodexAnnouncement()
    expect(second?.id).not.toBe(first?.id)
    expect(second?.window.usedPercent).toBe(91)
  })

  test('the weekly window announces on its own', () => {
    recordCodexLimits(data(10, 92))
    expect(getCodexAnnouncement()?.window).toMatchObject({ key: 'codex:secondary', label: 'weekly' })
  })
})
