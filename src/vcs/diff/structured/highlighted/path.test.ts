import { describe, expect, test } from 'bun:test'
import { chooseDiffPath } from 'src/vcs/diff/structured/highlighted/path.js'

describe('chooseDiffPath', () => {
  test('the syntax renderer draws the hunk unless something turns highlighting off', () => {
    expect(chooseDiffPath({ skipHighlighting: false, highlightingDisabled: false, unavailableReason: null })).toBe(
      'highlighted',
    )
  })

  test('the prop, the setting and the switch each turn it off on their own', () => {
    expect(chooseDiffPath({ skipHighlighting: true, highlightingDisabled: false, unavailableReason: null })).toBe(
      'fallback',
    )
    expect(chooseDiffPath({ skipHighlighting: false, highlightingDisabled: true, unavailableReason: null })).toBe(
      'fallback',
    )
    expect(chooseDiffPath({ skipHighlighting: false, highlightingDisabled: false, unavailableReason: 'env' })).toBe(
      'fallback',
    )
  })
})
