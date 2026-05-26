import { describe, expect, test } from 'bun:test'
import { stringWidth } from './stringWidth.js'

describe('stringWidth — Kitty placeholder support', () => {
  const PLACEHOLDER = '\u{10EEEE}'

  test('plain placeholder counts as width 1', () => {
    expect(stringWidth(PLACEHOLDER)).toBe(1)
  })

  test('placeholder with 3 zero-width combining diacritics is width 1', () => {
    expect(stringWidth(`${PLACEHOLDER}\u{0305}\u{0305}\u{0305}`)).toBe(1)
  })

  test('placeholder with non-zero-width diacritic stays width 1', () => {
    // U+0483 is in the Cyrillic combining range — Bun.stringWidth would
    // normally treat it as adding width. Our shortcut handles that.
    expect(stringWidth(`${PLACEHOLDER}\u{0483}`)).toBe(1)
  })

  test('row of N placeholders measures as N cells', () => {
    const cell = `${PLACEHOLDER}\u{0305}\u{0305}\u{0305}`
    expect(stringWidth(cell.repeat(40))).toBe(40)
  })

  test('does not affect normal text width', () => {
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('')).toBe(0)
    expect(stringWidth('foo bar baz')).toBe(11)
  })

  test('does not affect emoji width', () => {
    expect(stringWidth('👍')).toBe(2)
  })

  test('placeholders mixed with text count both correctly', () => {
    // Regression: previously any string containing U+10EEEE collapsed to
    // just the placeholder count, ignoring surrounding text.
    expect(stringWidth(`hello ${PLACEHOLDER}`)).toBe(7)
    expect(stringWidth(`${PLACEHOLDER}${PLACEHOLDER} world`)).toBe(8)
    expect(stringWidth(`a${PLACEHOLDER}b${PLACEHOLDER}c`)).toBe(5)
  })

  test('placeholder with full 3-diacritic cluster + surrounding text', () => {
    const cell = `${PLACEHOLDER}\u{0305}\u{0305}\u{0305}`
    expect(stringWidth(`prefix ${cell}${cell} suffix`)).toBe(16) // 7+2+7
  })

  test('placeholder followed by emoji', () => {
    expect(stringWidth(`${PLACEHOLDER}👍`)).toBe(3) // 1 + 2
  })
})
