import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { layoutFallback } from 'src/vcs/diff/structured/fallback/rows.js'
import { LINE_MARKERS } from 'src/vcs/diff/structured/hunk/lines.js'
import { sanitizeHunk } from 'src/vcs/diff/structured/hunk/sanitize.js'

/** A hunk that starts at `oldStart` and `newStart`, its sizes counted from its lines. */
function hunkOf(lines: string[], oldStart = 1, newStart = oldStart): StructuredPatchHunk {
  const counted = lines.filter(line => !line.startsWith('\\'))
  return {
    oldStart,
    oldLines: counted.filter(line => !line.startsWith('+')).length,
    newStart,
    newLines: counted.filter(line => !line.startsWith('-')).length,
    lines,
  }
}

type Layout = ReturnType<typeof layoutFallback>

/** Each row as the view draws it, without the fill. */
function texts({ numberWidth, rows }: Layout): string[] {
  return rows.map(
    row =>
      `${String(row.number ?? '').padStart(numberWidth)} ${LINE_MARKERS[row.kind]}${row.spans.map(span => span.text).join('')}`,
  )
}

function rowWidths({ numberWidth, rows }: Layout): number[] {
  return rows.map(row => numberWidth + 2 + stringWidth(row.spans.map(span => span.text).join('')) + row.fill)
}

describe('layoutFallback: numbers', () => {
  test('a hunk whose sides start apart is numbered like the highlighted path: removed lines by the old file', () => {
    const hunk = hunkOf(
      [' ctx one', '-old line here', '-second old', '+new line here', '+second new', '+third new', ' ctx two'],
      10,
      12,
    )
    expect(texts(layoutFallback(hunk, 40, false))).toEqual([
      ' 12  ctx one',
      ' 11 -old line here',
      ' 12 -second old',
      ' 13 +new line here',
      ' 14 +second new',
      ' 15 +third new',
      ' 16  ctx two',
    ])
  })

  test('the number column is one wider than the digits of the largest number drawn', () => {
    const layout = layoutFallback(hunkOf([' ninety-eight', '-ninety-nine', '+ninety-nine again', ' one hundred', ' 101'], 98), 60, false)
    expect(layout.numberWidth).toBe(4)
    expect(texts(layout)[4]).toBe(' 101  101')
  })

  test('the no-newline note has no number, moves no count, and sits under the line it qualifies', () => {
    const layout = layoutFallback(hunkOf([' one', '-two', '\\ No newline at end of file', '+two', '+three']), 40, false)
    expect(texts(layout)).toEqual([' 1  one', ' 2 -two', '   \\ No newline at end of file', ' 2 +two', ' 3 +three'])
    expect(layout.rows[2]!.kind).toBe('note')
  })
})

describe('layoutFallback: width', () => {
  test('every row reaches the full width: gutter, code and fill', () => {
    const layout = layoutFallback(hunkOf([' same', '-the first wording', '+nothing alike here', ' ']), 36, false)
    expect(rowWidths(layout)).toEqual([36, 36, 36, 36])
  })

  test('whole rows and word-by-word rows both give the code the width minus the gutter', () => {
    // Line numbers of one digit make a four-column gutter, so the code gets sixteen columns at twenty.
    const sixteen = 'aaaa bbbb cccc d'
    const whole = layoutFallback(hunkOf([` ${sixteen}`]), 20, false)
    expect(texts(whole)).toEqual([` 1  ${sixteen}`])
    expect(whole.rows[0]!.fill).toBe(0)
    const wordByWord = layoutFallback(hunkOf([`-${sixteen}`, '+aaaa bbbb cccc e']), 20, false)
    expect(wordByWord.rows.map(row => row.spans.some(span => span.tag === 'changed'))).toEqual([true, true])
    expect(texts(wordByWord)).toEqual([` 1 -${sixteen}`, ' 1 +aaaa bbbb cccc e'])
    expect(texts(layoutFallback(hunkOf([` ${sixteen}x`]), 20, false))).toEqual([' 1  aaaa bbbb cccc ', '    dx'])
  })

  test('word-by-word rows wrap like whole rows, at spaces and as full as they go, each word keeping its mark', () => {
    const layout = layoutFallback(hunkOf(['-let value = compute(alpha) + 1', '+let value = compute(beta) + 1']), 24, false)
    expect(texts(layout)).toEqual([' 1 -let value = ', '   -compute(alpha) + 1', ' 1 +let value = ', '   +compute(beta) + 1'])
    expect(layout.rows[1]!.spans).toEqual([
      { text: 'compute(', tag: 'plain' },
      { text: 'alpha', tag: 'changed' },
      { text: ') + 1', tag: 'plain' },
    ])
  })

  test('at a width narrower than the gutter the code still gets a column: one character a row', () => {
    const layout = layoutFallback(hunkOf(['-abc', '+abd']), 1, false)
    expect(texts(layout)).toEqual([' 1 -a', '   -b', '   -c', ' 1 +a', '   +b', '   +d'])
    expect(layout.rows.every(row => row.fill === 0)).toBe(true)
    expect(texts(layoutFallback(hunkOf(['-abc', '+abd']), 30.8, false))).toEqual(texts(layoutFallback(hunkOf(['-abc', '+abd']), 30, false)))
  })
})

describe('layoutFallback: what the sanitizer hands it', () => {
  test('a line of a CRLF file adds no empty row', () => {
    const layout = layoutFallback(sanitizeHunk(hunkOf(['-a = 1\r', '+a = 2\r', ' b\r'])), 30, false)
    expect(texts(layout)).toEqual([' 1 -a = 1', ' 1 +a = 2', ' 2  b'])
  })

  test('tabs are expanded before measuring, so no row runs past the width', () => {
    const layout = layoutFallback(sanitizeHunk(hunkOf(['+\tif (ready) {\t// start\tthe engine now'])), 24, false)
    expect(texts(layout)).toEqual([' 1 +    if (ready) {    ', '   +// start    the ', '   +engine now'])
    expect(rowWidths(layout)).toEqual([24, 24, 24])
  })
})

describe('layoutFallback: dim', () => {
  test('a dimmed hunk marks no word', () => {
    const layout = layoutFallback(hunkOf(['-const value = computeThing(alpha);', '+const value = computeThing(beta);']), 50, true)
    expect(layout.rows.flatMap(row => row.spans.map(span => span.tag))).toEqual(['plain', 'plain'])
  })
})
