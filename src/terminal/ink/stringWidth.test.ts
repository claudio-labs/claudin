import { describe, expect, test } from 'bun:test'
import {
  stringWidth,
  stringWidthJavaScript,
} from 'src/terminal/ink/stringWidth.js'

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

// Under `bun test`, `stringWidth` resolves to Bun.stringWidth, so these call the
// fallback DIRECTLY — it is the implementation every Node run uses, and the only
// one of the two that can be wrong here.
describe('stringWidthJavaScript — emoji presentation', () => {
  test('a text-presentation emoji is ONE cell', () => {
    // The regression: emoji-regex matches all four, and counting them as 2
    // drifted the model a column right of the terminal for the rest of the row.
    expect(stringWidthJavaScript('\u2714')).toBe(1) // heavy check
    expect(stringWidthJavaScript('\u25B6')).toBe(1) // play
    expect(stringWidthJavaScript('\u26A0')).toBe(1) // warning
    expect(stringWidthJavaScript('\u2716')).toBe(1) // heavy multiplication
  })

  test('VS16 asks for emoji presentation, and gets two cells', () => {
    expect(stringWidthJavaScript('\u2714\uFE0F')).toBe(2)
    expect(stringWidthJavaScript('\u26A0\uFE0F')).toBe(2)
  })

  test('an emoji-presentation default is still two cells', () => {
    expect(stringWidthJavaScript('\u2705')).toBe(2)
    expect(stringWidthJavaScript('\u274C')).toBe(2)
    expect(stringWidthJavaScript('\u{1F44D}')).toBe(2)
  })

  test('the sequences that carry a trailing mark keep their width', () => {
    expect(stringWidthJavaScript('\u{1F1E7}\u{1F1F7}')).toBe(2) // flag
    expect(stringWidthJavaScript('\u{1F1E7}')).toBe(1) // lone regional indicator
    expect(stringWidthJavaScript('1\uFE0F\u20E3')).toBe(2) // keycap
    expect(stringWidthJavaScript('1\u20E3')).toBe(2) // keycap, no VS16
    expect(stringWidthJavaScript('1\uFE0F')).toBe(1) // incomplete keycap
    expect(stringWidthJavaScript('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(2)
    expect(stringWidthJavaScript('\u{1F44D}\u{1F3FD}')).toBe(2) // skin tone
  })

  test('a footer row measures as many cells as the terminal paints', () => {
    // The shape that broke: the row measured one column wider than it was drawn,
    // so repainting it on selection duplicated the label's first letter.
    expect(stringWidthJavaScript('\u2714 tiny \u00B7 connected')).toBe(
      'X tiny \u00B7 connected'.length,
    )
  })

  test('the fallback agrees with the Bun implementation beside it', () => {
    for (const s of ['\u2714', '\u2714\uFE0F', '\u26A0', '\u2705', 'plain', '']) {
      expect(stringWidthJavaScript(s)).toBe(stringWidth(s))
    }
  })
})
