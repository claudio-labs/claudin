import { describe, expect, test } from 'bun:test'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  ERROR_THRESHOLD_BUFFER_TOKENS,
} from './autoCompact.ts'
import { getContextWindowForModel } from 'src/utils/context.ts'

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
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const effective = getEffectiveContextWindowSize('some-unknown-3p-model')
      expect(effective).toBeGreaterThan(0)
      // 21k = CAPPED_DEFAULT_MAX_TOKENS (8k) + AUTOCOMPACT_BUFFER_TOKENS (13k).
      // Covers the anti-regression intent of issue #635 without assuming
      // the GrowthBook flag state.
      expect(effective).toBeGreaterThanOrEqual(21_000)
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })
})

describe('getAutoCompactThreshold', () => {
  test('returns positive threshold for known models', () => {
    const threshold = getAutoCompactThreshold('claude-sonnet-4')
    expect(threshold).toBeGreaterThan(0)
  })

  test('never returns negative threshold even for unknown 3P models (issue #635)', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const threshold = getAutoCompactThreshold('some-unknown-3p-model')
      expect(threshold).toBeGreaterThan(0)
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
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