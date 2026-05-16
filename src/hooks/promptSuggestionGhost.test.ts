import { describe, expect, test } from 'bun:test'
import { computeGhostRemainder } from './promptSuggestionGhost.js'

describe('computeGhostRemainder', () => {
  test('returns the full suggestion when input is empty', () => {
    expect(computeGhostRemainder('Rode os tests', '', false)).toBe('Rode os tests')
  })

  test('returns the tail when input is a case-insensitive prefix', () => {
    expect(computeGhostRemainder('Rode os tests', 'Rode', false)).toBe(' os tests')
    expect(computeGhostRemainder('Rode os tests', 'rode os', false)).toBe(' tests')
    // case-insensitive: user typed lowercase, suggestion has capital R
    expect(computeGhostRemainder('Rode os tests', 'rode', false)).toBe(' os tests')
  })

  test('returns null when input diverges from suggestion', () => {
    expect(computeGhostRemainder('Rode os tests', 'Cancel', false)).toBeNull()
    expect(computeGhostRemainder('Rode os tests', 'Rodax', false)).toBeNull()
  })

  test('returns null while the assistant is responding', () => {
    expect(computeGhostRemainder('Rode os tests', '', true)).toBeNull()
    expect(computeGhostRemainder('Rode os tests', 'Rode', true)).toBeNull()
  })

  test('returns null when there is no suggestion', () => {
    expect(computeGhostRemainder(null, '', false)).toBeNull()
    expect(computeGhostRemainder(null, 'anything', false)).toBeNull()
  })

  test('returns empty string when input equals suggestion (fully accepted)', () => {
    expect(computeGhostRemainder('Rode os tests', 'Rode os tests', false)).toBe('')
  })
})
