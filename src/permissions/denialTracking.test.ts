import { describe, expect, test } from 'bun:test'

import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from 'src/permissions/denialTracking.js'

describe('denial tracking', () => {
  test('starts at zero', () => {
    expect(createDenialTrackingState()).toEqual({ consecutiveDenials: 0, totalDenials: 0 })
  })

  test('a denial counts toward both limits', () => {
    const state = recordDenial(recordDenial(createDenialTrackingState()))
    expect(state).toEqual({ consecutiveDenials: 2, totalDenials: 2 })
  })

  test('a success breaks the streak and keeps the total', () => {
    const state = recordSuccess(recordDenial(createDenialTrackingState()))
    expect(state).toEqual({ consecutiveDenials: 0, totalDenials: 1 })
  })

  test('a success with no streak returns the same state', () => {
    const state = { consecutiveDenials: 0, totalDenials: 4 }
    expect(recordSuccess(state)).toBe(state)
  })

  test('falls back to prompting at either limit', () => {
    const below = { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: DENIAL_LIMITS.maxTotal - 1 }
    expect(shouldFallbackToPrompting(below)).toBe(false)
    expect(shouldFallbackToPrompting({ ...below, consecutiveDenials: DENIAL_LIMITS.maxConsecutive })).toBe(true)
    expect(shouldFallbackToPrompting({ ...below, totalDenials: DENIAL_LIMITS.maxTotal })).toBe(true)
  })
})
