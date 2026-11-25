import { describe, expect, test } from 'bun:test'
import sliceAnsi from 'src/shared/text/sliceAnsi.js'

const BOLD = '\x1b[1m'
const BOLD_OFF = '\x1b[22m'
const RED = '\x1b[31m'
const FG_OFF = '\x1b[39m'
const LINK_OPEN = '\x1b]8;;https://example.com\x07'
const LINK_CLOSE = '\x1b]8;;\x07'

describe('sliceAnsi', () => {
  test('slices plain text by display cells', () => {
    expect(sliceAnsi('hello world', 0, 5)).toBe('hello')
    expect(sliceAnsi('hello world', 6)).toBe('world')
  })

  test('re-opens the style active at start and closes it at the end', () => {
    expect(sliceAnsi(`${BOLD}abc${BOLD_OFF}`, 1, 2)).toBe(`${BOLD}b${BOLD_OFF}`)
    expect(sliceAnsi(`${RED}abc`, 0, 2)).toBe(`${RED}ab${FG_OFF}`)
  })

  test('keeps a hyperlink open around the sliced text and closes it', () => {
    expect(sliceAnsi(`${LINK_OPEN}link${LINK_CLOSE} tail`, 0, 2)).toBe(
      `${LINK_OPEN}li${LINK_CLOSE}`,
    )
  })

  // The partition contract StructuredDiff relies on to split gutters from
  // content: a wide glyph straddling `end` goes whole to the left half, so
  // the two halves concatenate back to the original.
  test('includes a wide glyph that straddles end, so the halves partition', () => {
    expect(sliceAnsi('你好世界', 0, 3)).toBe('你好')
    expect(sliceAnsi('你好世界', 3)).toBe('世界')
  })

  test('drops a wide glyph that straddles start', () => {
    expect(sliceAnsi('你好世界', 1, 3)).toBe('好')
  })

  test('keeps a trailing combining mark with its base at the end boundary', () => {
    expect(sliceAnsi('भा', 0, 1)).toBe('भा')
  })

  test('skips a leading combining mark at start, which the left half owns', () => {
    expect(sliceAnsi('भाx', 1)).toBe('x')
  })

  test('an empty slice of text that starts with a zero-width char stays empty', () => {
    expect(sliceAnsi('\u200Babc', 0, 0)).toBe('')
  })

  // Ported from openclaude #2553: nothing was opened, so nothing may be closed.
  test('an empty or out-of-range slice of styled text emits no reset code', () => {
    expect(sliceAnsi(`${BOLD}abc`, 1, 1)).toBe('')
    expect(sliceAnsi(`${BOLD}abc`, 5, 9)).toBe('')
  })

  test('fitEnd drops a wide glyph that would straddle end', () => {
    expect(sliceAnsi('你好世界', 0, 3, { fitEnd: true })).toBe('你')
    expect(sliceAnsi('a你', 0, 2, { fitEnd: true })).toBe('a')
    expect(sliceAnsi('你好世界', 0, 4, { fitEnd: true })).toBe('你好')
  })
})
