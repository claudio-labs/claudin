import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  _resetFallbackHoldsForTesting,
  clearFallbackHolds,
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

describe('/model ends the hold', () => {
  test('clearFallbackHolds releases every pair', () => {
    holdFallback('opus', 'sonnet', 0)
    holdFallback('gpt-5', 'gpt-5-mini', 0)
    clearFallbackHolds()
    expect(isFallbackHeld('opus', 'sonnet', 1)).toBe(false)
    expect(isFallbackHeld('gpt-5', 'gpt-5-mini', 1)).toBe(false)
  })

  test('both /model paths clear it right after setting the model', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'commands', 'model', 'model.tsx'), 'utf8')
    const after = (field: string) =>
      `        ${field},\n        mainLoopModelForSession: null\n      }));\n      // A model the user picks is the one the loop runs on (fallbackHold.ts).\n      clearFallbackHolds();\n`
    expect(source).toContain(after('mainLoopModel: model'))
    expect(source).toContain(after('mainLoopModel: modelValue'))
  })
})
