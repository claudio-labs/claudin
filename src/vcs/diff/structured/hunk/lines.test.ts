import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { readHunkLines, separateNotes } from 'src/vcs/diff/structured/hunk/lines.js'

const NOTE = '\\ No newline at end of file'

describe('readHunkLines', () => {
  test('numbers a removed line by the old file and every other line by the new one, on sides that start apart', () => {
    const hunk: StructuredPatchHunk = {
      oldStart: 10,
      oldLines: 4,
      newStart: 12,
      newLines: 5,
      lines: [' ctx one', '-old line here', '-second old', '+new line here', '+second new', '+third new', ' ctx two'],
    }
    expect(readHunkLines(hunk).map(line => [line.kind, line.number])).toEqual([
      ['context', 12],
      ['removed', 11],
      ['removed', 12],
      ['added', 13],
      ['added', 14],
      ['added', 15],
      ['context', 16],
    ])
  })

  test('the no-newline note takes no number and does not move the count', () => {
    const hunk: StructuredPatchHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [' one', '-two', NOTE, '+two', '+three'],
    }
    expect(readHunkLines(hunk)).toEqual([
      { kind: 'context', code: 'one', number: 1 },
      { kind: 'removed', code: 'two', number: 2 },
      { kind: 'note', code: ' No newline at end of file', number: null },
      { kind: 'added', code: 'two', number: 2 },
      { kind: 'added', code: 'three', number: 3 },
    ])
  })

  test('a line that starts with anything else is context, an empty one included', () => {
    const hunk: StructuredPatchHunk = { oldStart: 5, oldLines: 2, newStart: 5, newLines: 2, lines: ['xodd', ''] }
    expect(readHunkLines(hunk)).toEqual([
      { kind: 'context', code: 'odd', number: 5 },
      { kind: 'context', code: '', number: 6 },
    ])
  })
})

describe('separateNotes', () => {
  test('takes the notes out and remembers the line of code each one follows', () => {
    const hunk: StructuredPatchHunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [NOTE, '-a', NOTE, '+b', NOTE],
    }
    expect(separateNotes(hunk)).toEqual({
      hunk: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
      notes: [
        { code: ' No newline at end of file', after: -1 },
        { code: ' No newline at end of file', after: 0 },
        { code: ' No newline at end of file', after: 1 },
      ],
    })
    expect(hunk.lines).toEqual([NOTE, '-a', NOTE, '+b', NOTE])
  })

  test('a hunk without notes comes back as it is', () => {
    const hunk: StructuredPatchHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    expect(separateNotes(hunk)).toEqual({ hunk, notes: [] })
    expect(separateNotes(hunk).hunk).toBe(hunk)
  })
})
