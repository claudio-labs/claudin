// hunkAtRow does not fail closed when the rendered rows and the
// segments disagree, so `x` can target a hunk the cursor is not on.
import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { renderDiffRows } from 'src/vcs/diff/ui/DiffPane.js'
import { buildRowLineIndex, hunkAtRow } from 'src/vcs/diff/ui/rowLines.js'
import type { DiffSegment } from 'src/vcs/diff/ui/types.js'

const hunkA: StructuredPatchHunk = {
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 2,
  // A context line long enough to wrap, whose continuation starts with "42 ".
  lines: [` ${'x'.repeat(34)} 42 items are kept in the buffer`, '-old', '+new'],
}
const hunkB: StructuredPatchHunk = {
  oldStart: 40,
  oldLines: 1,
  newStart: 40,
  newLines: 1,
  lines: ['-b', '+c'],
}
const segments: DiffSegment[] = [
  { kind: 'hunk', hunk: hunkA },
  { kind: 'gap', id: 'g', startLine: 12, lineCount: 28 },
  { kind: 'hunk', hunk: hunkB },
]

describe('hunkAtRow on a wrapped context line', () => {
  test('rows whose continuation starts with a number: x never names the wrong hunk', () => {
    const rows = renderDiffRows(segments, {
      filePath: 'a.txt',
      firstLine: null,
      fileContent: undefined,
      width: 40,
      theme: 'dark',
    })
    // eslint-disable-next-line no-control-regex
    const plain = rows.map(r => r.replace(/\u001B\[[0-9;]*m/g, ''))
    // The selection index fails closed on these rows ...
    expect(buildRowLineIndex(segments, rows)).toBeNull() // fails closed, as designed
    // ... but hunkAtRow still answers, and on the gap marker row it names hunk B.
    const gapRow = plain.findIndex(r => r.trimStart().startsWith('···'))
    expect(gapRow).toBeGreaterThan(0)
    expect(hunkAtRow(segments, rows, gapRow)).toBeNull()
    // Fail closed for the whole file, the way selection does: even the '+new'
    // row of hunk A names nothing rather than a guess.
    const newRow = plain.findIndex(r => r.includes('+') && r.includes('new'))
    expect(newRow).toBeGreaterThan(0)
    expect(hunkAtRow(segments, rows, newRow)).toBeNull()
  })
})
