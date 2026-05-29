import { describe, expect, test } from 'bun:test'
import {
  ADAPTIVE_EFFORT,
  getEffortSuffix,
  getEffortValueDescription,
  isAdaptiveEffort,
  resolveAppliedEffort,
  toPersistableEffort,
} from './effort.js'

const OPUS = 'claude-opus-4-8'

describe('adaptive effort', () => {
  test('isAdaptiveEffort recognizes the sentinel only', () => {
    expect(isAdaptiveEffort(ADAPTIVE_EFFORT)).toBe(true)
    expect(isAdaptiveEffort('adaptive')).toBe(true)
    expect(isAdaptiveEffort('high')).toBe(false)
    expect(isAdaptiveEffort(undefined)).toBe(false)
    expect(isAdaptiveEffort(50)).toBe(false)
  })

  test('resolveAppliedEffort returns undefined for adaptive (no effort field sent)', () => {
    expect(resolveAppliedEffort(OPUS, ADAPTIVE_EFFORT)).toBeUndefined()
  })

  test('getEffortSuffix surfaces adaptive in the status bar', () => {
    expect(getEffortSuffix(OPUS, ADAPTIVE_EFFORT)).toBe(' with adaptive effort')
  })

  test('adaptive is persistable as-is', () => {
    expect(toPersistableEffort(ADAPTIVE_EFFORT)).toBe(ADAPTIVE_EFFORT)
  })

  test('adaptive has its own description', () => {
    expect(getEffortValueDescription(ADAPTIVE_EFFORT)).toMatch(/per request/i)
  })
})
