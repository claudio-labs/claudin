import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetFallbackHoldsForTesting,
  FALLBACK_HOLD_MS,
  holdFallback,
  isFallbackHeld,
} from 'src/providers/model/fallbackHold.js'

afterEach(() => _resetFallbackHoldsForTesting())

describe('the fallback hold', () => {
  test('nothing is held until a primary gives way', () => {
    expect(isFallbackHeld('opus', 'sonnet', 0)).toBe(false)
  })

  test('held for ten minutes from the switch, then released', () => {
    holdFallback('opus', 'sonnet', 1_000)
    expect(FALLBACK_HOLD_MS).toBe(600_000)
    expect(isFallbackHeld('opus', 'sonnet', 1_000)).toBe(true)
    expect(isFallbackHeld('opus', 'sonnet', 1_000 + FALLBACK_HOLD_MS - 1)).toBe(true)
    expect(isFallbackHeld('opus', 'sonnet', 1_000 + FALLBACK_HOLD_MS)).toBe(false)
    // Released for good: an earlier clock does not bring it back.
    expect(isFallbackHeld('opus', 'sonnet', 1_000)).toBe(false)
  })

  test('keyed by the pair: another primary or fallback is not held', () => {
    holdFallback('opus', 'sonnet', 0)
    expect(isFallbackHeld('opus', 'haiku', 1)).toBe(false)
    expect(isFallbackHeld('gpt-5', 'sonnet', 1)).toBe(false)
  })

  test('a second switch restarts the clock', () => {
    holdFallback('opus', 'sonnet', 0)
    holdFallback('opus', 'sonnet', FALLBACK_HOLD_MS - 1)
    expect(isFallbackHeld('opus', 'sonnet', FALLBACK_HOLD_MS + 10)).toBe(true)
  })

  test('the default clock is now', () => {
    holdFallback('opus', 'sonnet')
    expect(isFallbackHeld('opus', 'sonnet')).toBe(true)
  })
})
