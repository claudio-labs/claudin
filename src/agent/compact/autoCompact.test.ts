import { describe, expect, test } from 'bun:test'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  isAboveHeapPressureThreshold,
  shouldAutoCompact,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  ERROR_THRESHOLD_BUFFER_TOKENS,
} from 'src/agent/compact/autoCompact.ts'
import { getContextWindowForModel } from 'src/agent/context/context.ts'
import { createUserMessage } from 'src/agent/messages/messages.ts'

// Compaction starts on the model's context window and on nothing else. The
// heap-pressure backstop used to fire at 0.7 of the V8 limit by default, which
// made a long conversation compact for occupying memory rather than for
// filling the window — the clipping policy (pruneOldToolResults +
// applyStableStubs) is what answers memory now, and it drops no messages, so
// the timeline survives where compaction would have cut it.
describe('heap pressure is opt-in', () => {
  const ENV = 'CLAUDIN_HEAP_PRESSURE_RATIO'
  const saved = process.env[ENV]
  const restore = () => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  }

  // 25 clears MIN_MESSAGES_FOR_HEAP_TRIGGER (20), so only the ratio decides.
  const LONG_ENOUGH = 25
  // 90% of the limit — comfortably past the 0.7 this used to default to, so
  // "off by default" is a claim about the code and not about how much memory
  // the test runner happens to be using.
  const HEAP_AT_90 = () => ({ used_heap_size: 900, heap_size_limit: 1000 })

  test('never fires with the env unset, even at 90% heap', () => {
    delete process.env[ENV]
    try {
      expect(isAboveHeapPressureThreshold(LONG_ENOUGH, HEAP_AT_90)).toBe(false)
      expect(isAboveHeapPressureThreshold(100_000, HEAP_AT_90)).toBe(false)
    } finally {
      restore()
    }
  })

  test('setting the ratio opts the backstop back in, and it still compares', () => {
    process.env[ENV] = '0.8'
    try {
      expect(isAboveHeapPressureThreshold(LONG_ENOUGH, HEAP_AT_90)).toBe(true)
      // The fresh-session guard still holds above it.
      expect(isAboveHeapPressureThreshold(1, HEAP_AT_90)).toBe(false)
      // …and a ratio above the reading does not fire.
      process.env[ENV] = '0.95'
      expect(isAboveHeapPressureThreshold(LONG_ENOUGH, HEAP_AT_90)).toBe(false)
    } finally {
      restore()
    }
  })

  test('an out-of-range ratio leaves it off rather than falling back to 0.7', () => {
    for (const bad of ['0', '1', '1.5', '-0.2', 'nonsense']) {
      process.env[ENV] = bad
      expect(isAboveHeapPressureThreshold(LONG_ENOUGH, HEAP_AT_90)).toBe(false)
    }
    restore()
  })

  test('a short conversation under the window does not compact', async () => {
    delete process.env[ENV]
    try {
      const messages = Array.from({ length: LONG_ENOUGH }, (_, i) =>
        createUserMessage({ content: `message ${i}` }),
      )
      expect(await shouldAutoCompact(messages, 'claude-sonnet-4')).toBe(false)
    } finally {
      restore()
    }
  })
})

describe('getEffectiveContextWindowSize', () => {
  test('returns positive value for known models with large context windows', () => {
    // claude-sonnet-4 has 200k context
    const effective = getEffectiveContextWindowSize('claude-sonnet-4')
    expect(effective).toBeGreaterThan(0)
  })

  test('never returns negative even for unknown 3P models (issue #635)', () => {
    // Previously, unknown 3P models got 8k context → effective context was
    // 8k minus 20k summary reservation = -12k, causing infinite auto-compact.
    // Now the fallback is 128k and there's a floor, so effective is always
    // at least reservedTokensForSummary + buffer.
    //
    // The exact floor depends on the max-output-tokens slot-reservation cap
    // (tengu_otk_slot_v1 GrowthBook flag). With cap enabled, the model's
    // default output cap drops to CAPPED_DEFAULT_MAX_TOKENS (8k), so the
    // summary reservation is 8k and the floor is 8k + 13k = 21k. With cap
    // disabled it's 20k + 13k = 33k. Assert the worst case so the test is
    // stable regardless of flag state in CI vs local.
    process.env.CLAUDIN_USE_OPENAI = '1'
    try {
      const effective = getEffectiveContextWindowSize('some-unknown-3p-model')
      expect(effective).toBeGreaterThan(0)
      // 21k = CAPPED_DEFAULT_MAX_TOKENS (8k) + AUTOCOMPACT_BUFFER_TOKENS (13k).
      // Covers the anti-regression intent of issue #635 without assuming
      // the GrowthBook flag state.
      expect(effective).toBeGreaterThanOrEqual(21_000)
    } finally {
      delete process.env.CLAUDIN_USE_OPENAI
    }
  })
})

describe('getAutoCompactThreshold', () => {
  test('returns positive threshold for known models', () => {
    const threshold = getAutoCompactThreshold('claude-sonnet-4')
    expect(threshold).toBeGreaterThan(0)
  })

  test('never returns negative threshold even for unknown 3P models (issue #635)', () => {
    process.env.CLAUDIN_USE_OPENAI = '1'
    try {
      const threshold = getAutoCompactThreshold('some-unknown-3p-model')
      expect(threshold).toBeGreaterThan(0)
    } finally {
      delete process.env.CLAUDIN_USE_OPENAI
    }
  })
})

describe('calculateTokenWarningState — two-tier warning', () => {
  const model = 'claude-sonnet-4'

  // Mirror the internal threshold selection so the test points are derived,
  // not hardcoded (the effective window depends on the max-output cap flag).
  const baseThreshold = isAutoCompactEnabled()
    ? getAutoCompactThreshold(model)
    : getEffectiveContextWindowSize(model)
  const warnAt = baseThreshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errAt = baseThreshold - ERROR_THRESHOLD_BUFFER_TOKENS

  test('error buffer is strictly tighter than warning, so the tiers are distinct', () => {
    // Equal buffers (the old bug) collapse the two tiers: isAboveError would
    // always equal isAboveWarning and the yellow "warning" color is unreachable.
    expect(ERROR_THRESHOLD_BUFFER_TOKENS).toBeLessThan(
      WARNING_THRESHOLD_BUFFER_TOKENS,
    )
    expect(errAt).toBeGreaterThan(warnAt)
  })

  test('warning fires before error with a gap of the buffer difference', () => {
    const belowBoth = calculateTokenWarningState(warnAt - 1, model)
    expect(belowBoth.isAboveWarningThreshold).toBe(false)
    expect(belowBoth.isAboveErrorThreshold).toBe(false)

    // In the warning band: yellow tier on, red tier still off.
    const warnBand = calculateTokenWarningState(warnAt, model)
    expect(warnBand.isAboveWarningThreshold).toBe(true)
    expect(warnBand.isAboveErrorThreshold).toBe(false)

    // In the error band: both on.
    const errBand = calculateTokenWarningState(errAt, model)
    expect(errBand.isAboveWarningThreshold).toBe(true)
    expect(errBand.isAboveErrorThreshold).toBe(true)
  })
})

describe('calculateTokenWarningState — percentUntilAutoCompact', () => {
  const model = 'claude-sonnet-4'
  const autoCompactThreshold = getAutoCompactThreshold(model)

  test('is 100 at zero usage', () => {
    expect(calculateTokenWarningState(0, model).percentUntilAutoCompact).toBe(100)
  })

  test('reaches 0 exactly at the auto-compact trigger, while percentLeft is still positive', () => {
    // This is the whole point of the field: a "X% until auto-compact" label
    // must hit 0 when auto-compact fires, unlike percentLeft (measured against
    // the full raw window, which is still positive at the trigger).
    const atTrigger = calculateTokenWarningState(autoCompactThreshold, model)
    expect(atTrigger.percentUntilAutoCompact).toBe(0)

    const rawWindow = getContextWindowForModel(model)
    expect(autoCompactThreshold).toBeLessThan(rawWindow)
    expect(atTrigger.percentLeft).toBeGreaterThan(0)
  })

  test('never goes negative past the trigger', () => {
    expect(
      calculateTokenWarningState(autoCompactThreshold + 50_000, model)
        .percentUntilAutoCompact,
    ).toBe(0)
  })
})
