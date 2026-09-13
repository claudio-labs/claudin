import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import {
  buildRowLineIndex,
  logicalLineNumbers,
  rangeFromScreenRows,
  selectionRange,
} from 'src/vcs/diff/ui/rowLines.js'
import type { DiffSegment } from 'src/vcs/diff/ui/types.js'

function hunk(newStart: number, lines: string[]): StructuredPatchHunk {
  return {
    oldStart: newStart,
    oldLines: lines.filter(l => !l.startsWith('+')).length,
    newStart,
    newLines: lines.filter(l => !l.startsWith('-')).length,
    lines,
  } as StructuredPatchHunk
}

// 6 context, 7 context, 8 removed, 8 added, 9 added
const SEGMENTS: DiffSegment[] = [
  {
    kind: 'hunk',
    hunk: hunk(6, [
      '   export function formatRelative(ts) {',
      '     const diff = Date.now() - ts',
      "-    if (diff < 60000) return 'just now'",
      "+    if (diff < MINUTE) return 'just now'",
      '+    if (diff < HOUR) return mins(diff)',
    ]),
  },
]

/** What ColorDiff emits: a numbered gutter, blank on a wrap continuation. */
const ROWS = [
  '    6   export function formatRelative(ts) {',
  '    7     const diff = Date.now() - ts',
  "    8 -   if (diff < 60000) return 'just now'",
  "    8 +   if (diff < MINUTE) return 'just now'",
  '    9 +   if (diff < HOUR) return mins(diff)',
]

describe('logicalLineNumbers', () => {
  test('context and additions advance the new-file cursor, removals do not', () => {
    expect(logicalLineNumbers(SEGMENTS)).toEqual([6, 7, null, 8, 9])
  })

  test('a collapsed gap is one entry with no line number', () => {
    const withGap: DiffSegment[] = [
      { kind: 'gap', id: 'g', startLine: 1, lineCount: 8 },
      ...SEGMENTS,
    ]
    expect(logicalLineNumbers(withGap)).toEqual([null, 6, 7, null, 8, 9])
  })
})

describe('buildRowLineIndex', () => {
  test('maps each rendered row to its new-file line', () => {
    expect(buildRowLineIndex(SEGMENTS, ROWS)).toEqual([6, 7, null, 8, 9])
  })

  test('a wrapped line contributes one numbered row and one continuation', () => {
    const wrapped = [
      ...ROWS.slice(0, 4),
      '    9 +   if (diff < HOUR) return',
      '        + mins(diff)',
    ]
    expect(buildRowLineIndex(SEGMENTS, wrapped)).toEqual([6, 7, null, 8, 9, null])
  })

  test('gap marker rows count as a logical line', () => {
    const withGap: DiffSegment[] = [
      { kind: 'gap', id: 'g', startLine: 1, lineCount: 8 },
      ...SEGMENTS,
    ]
    const rows = ['··· 8 lines ─────────', ...ROWS]
    expect(buildRowLineIndex(withGap, rows)).toEqual([null, 6, 7, null, 8, 9])
  })

  test('survives ANSI colouring around the gutter', () => {
    const colored = ROWS.map(r => `\u001B[32m${r}\u001B[39m`)
    expect(buildRowLineIndex(SEGMENTS, colored)).toEqual([6, 7, null, 8, 9])
  })

  test('returns null when the rows run past the segments', () => {
    expect(buildRowLineIndex(SEGMENTS, [...ROWS, '   10   one too many'])).toBeNull()
  })

  test('returns null when the rows stop short of the segments', () => {
    expect(buildRowLineIndex(SEGMENTS, ROWS.slice(0, 3))).toBeNull()
  })

  test('returns null when the first row is a continuation', () => {
    expect(buildRowLineIndex(SEGMENTS, ['      + orphan', ...ROWS])).toBeNull()
  })
})

describe('selectionRange', () => {
  const index = [6, 7, null, 8, 9]

  test('spans the new-file lines the selection covers', () => {
    expect(selectionRange(index, 0, 3)).toEqual({ start: 6, end: 8 })
  })

  test('ignores removed lines inside the range', () => {
    expect(selectionRange(index, 2, 4)).toEqual({ start: 8, end: 9 })
  })

  test('works with the endpoints reversed', () => {
    expect(selectionRange(index, 4, 1)).toEqual({ start: 7, end: 9 })
  })

  test('clamps out-of-range endpoints', () => {
    expect(selectionRange(index, -5, 99)).toEqual({ start: 6, end: 9 })
  })

  test('null for a selection of pure deletions', () => {
    expect(selectionRange(index, 2, 2)).toBeNull()
  })
})

describe('rangeFromScreenRows', () => {
  const index = [6, 7, null, 8, 9]
  // A pane whose 5 content rows start at screen row 17 and show diffRows[0..].
  const pane = { firstContentRow: 17, height: 5, scrollOffset: 0 }

  test('maps a drag over the pane to its new-file lines', () => {
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 17, toRow: 20 }),
    ).toEqual({ start: 6, end: 8 })
  })

  test('accounts for the scroll offset', () => {
    expect(
      rangeFromScreenRows(index, {
        ...pane,
        scrollOffset: 3,
        fromRow: 17,
        toRow: 18,
      }),
    ).toEqual({ start: 8, end: 9 })
  })

  test('a drag running off both ends attaches the part over the pane', () => {
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 2, toRow: 40 }),
    ).toEqual({ start: 6, end: 9 })
  })

  test('endpoints in either order', () => {
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 20, toRow: 18 }),
    ).toEqual({ start: 7, end: 8 })
  })

  test('null when the drag never touched the pane', () => {
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 2, toRow: 9 }),
    ).toBeNull()
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 30, toRow: 40 }),
    ).toBeNull()
  })

  test('null when the rows it covered are all deletions', () => {
    expect(
      rangeFromScreenRows(index, { ...pane, fromRow: 19, toRow: 19 }),
    ).toBeNull()
  })
})
