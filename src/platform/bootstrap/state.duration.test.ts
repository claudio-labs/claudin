import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  getTotalDuration,
  markTurnEnd,
  markTurnStart,
  resetCostState,
  setCostStateForRestore,
} from 'src/platform/bootstrap/state.js'

describe('active wall-duration tracking', () => {
  let nowSpy: ReturnType<typeof spyOn>
  let now = 1_700_000_000_000

  const setNow = (t: number) => {
    now = t
  }

  beforeEach(() => {
    now = 1_700_000_000_000
    nowSpy = spyOn(Date, 'now').mockImplementation(() => now)
    resetCostState()
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  test('is zero and stays frozen while idle', () => {
    expect(getTotalDuration()).toBe(0)
    setNow(now + 60_000) // 60s pass with no active turn
    expect(getTotalDuration()).toBe(0)
  })

  test('accumulates a single completed turn, then freezes', () => {
    markTurnStart()
    setNow(now + 5_000)
    markTurnEnd()
    expect(getTotalDuration()).toBe(5_000)
    // Idle time after the turn must NOT count.
    setNow(now + 120_000)
    expect(getTotalDuration()).toBe(5_000)
  })

  test('live-ticks while a turn is in progress', () => {
    markTurnStart()
    setNow(now + 2_000)
    expect(getTotalDuration()).toBe(2_000)
    setNow(now + 3_000)
    expect(getTotalDuration()).toBe(5_000)
  })

  test('sums multiple turns, excluding the idle gap between them', () => {
    markTurnStart()
    setNow(now + 4_000)
    markTurnEnd()
    setNow(now + 100_000) // long idle — not counted
    markTurnStart()
    setNow(now + 6_000)
    markTurnEnd()
    expect(getTotalDuration()).toBe(10_000)
  })

  test('markTurnStart is idempotent — keeps the earliest start', () => {
    markTurnStart()
    setNow(now + 1_000)
    markTurnStart() // must not reset the clock
    setNow(now + 2_000)
    markTurnEnd()
    expect(getTotalDuration()).toBe(3_000)
  })

  test('markTurnEnd is idempotent — a second call is a no-op', () => {
    markTurnStart()
    setNow(now + 5_000)
    markTurnEnd()
    setNow(now + 10_000)
    markTurnEnd() // no active turn — must not add anything
    expect(getTotalDuration()).toBe(5_000)
  })

  test('restore seeds the accumulator from persisted lastDuration', () => {
    setCostStateForRestore({
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      lastDuration: 42_000,
      modelUsage: undefined,
    })
    expect(getTotalDuration()).toBe(42_000)
    // A fresh turn resumes ticking on top of the restored total.
    markTurnStart()
    setNow(now + 3_000)
    markTurnEnd()
    expect(getTotalDuration()).toBe(45_000)
  })
})
