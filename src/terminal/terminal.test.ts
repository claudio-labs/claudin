import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import {
  isOutputLineTruncated,
  renderTruncatedContent,
} from 'src/terminal/terminal.js'

// renderTruncatedContent wraps at terminalWidth - 8 (never below 10), so a
// width of 18 wraps at 10 cells.
const WIDTH_FOR_WRAP_10 = 18

describe('renderTruncatedContent', () => {
  test('renders nothing for blank content', () => {
    expect(renderTruncatedContent('   \n', 80)).toBe('')
  })

  test('returns short content unchanged', () => {
    expect(renderTruncatedContent('one\ntwo\n', 80)).toBe('one\ntwo')
  })

  test('shows a fourth line instead of a "+1 line" hint', () => {
    expect(renderTruncatedContent('1\n2\n3\n4', 80)).toBe('1\n2\n3\n4')
  })

  test('cuts at three lines and counts the rest', () => {
    const rendered = stripAnsi(renderTruncatedContent('1\n2\n3\n4\n5\n6', 80))
    expect(rendered.split('\n').slice(0, 3)).toEqual(['1', '2', '3'])
    expect(rendered).toContain('… +3 lines')
    expect(rendered).toContain('to expand')
  })

  test('drops the expand hint when asked', () => {
    const rendered = stripAnsi(
      renderTruncatedContent('1\n2\n3\n4\n5\n6', 80, true),
    )
    expect(rendered).toBe('1\n2\n3\n… +3 lines')
  })

  test('wraps a long line at the terminal width', () => {
    expect(
      renderTruncatedContent('abcdefghijklmnopqrstuvwxyz', WIDTH_FOR_WRAP_10),
    ).toBe('abcdefghij\nklmnopqrst\nuvwxyz')
  })

  test('re-opens the style on every wrapped chunk', () => {
    const red = `\x1b[31m${'a'.repeat(15)}\x1b[39m`
    expect(renderTruncatedContent(red, WIDTH_FOR_WRAP_10)).toBe(
      `\x1b[31m${'a'.repeat(10)}\x1b[39m\n\x1b[31m${'a'.repeat(5)}\x1b[39m`,
    )
  })

  test('estimates the hidden lines of content too large to wrap', () => {
    const rendered = stripAnsi(
      renderTruncatedContent('x'.repeat(5000), WIDTH_FOR_WRAP_10),
    )
    expect(rendered.split('\n').slice(0, 3)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(10),
    ])
    expect(rendered).toContain('… +497 lines')
  })

  // Ported from openclaude #2553.
  test('keeps every wrapped line inside the width when a wide glyph straddles it', () => {
    const lines = renderTruncatedContent('a' + '你'.repeat(20), 38).split('\n')
    expect(lines.map(line => stringWidth(line))).toEqual([29, 12])
    expect(lines.join('')).toBe('a' + '你'.repeat(20))
  })

  test('loses no character when the slicer and stringWidth disagree on a glyph', () => {
    // The tokenizer counts a keycap with VS16 as two cells, stringWidth as one.
    const text = '1\uFE0Fabcdefghijklmnopqrs'
    const rendered = renderTruncatedContent(text, WIDTH_FOR_WRAP_10)
    expect(rendered.split('\n').join('')).toBe(text)
  })
})

describe('isOutputLineTruncated', () => {
  test('is true only past four lines, ignoring a trailing newline', () => {
    expect(isOutputLineTruncated('a')).toBe(false)
    expect(isOutputLineTruncated('1\n2\n3\n4')).toBe(false)
    expect(isOutputLineTruncated('1\n2\n3\n4\n')).toBe(false)
    expect(isOutputLineTruncated('1\n2\n3\n4\n5')).toBe(true)
  })
})
