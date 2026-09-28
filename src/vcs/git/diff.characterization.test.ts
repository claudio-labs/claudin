/**
 * Characterization of src/vcs/git/diff.ts (patches for the edit and write
 * tools, their permission dialogs and the IDE diff) and src/vcs/git/diffStat.ts
 * (the added/removed count), pinned before the clean-base rewrite.
 * docs/tech/rewrite/vcs/gitDiff.md is the spec.
 *
 * Hunks are the `StructuredPatchHunk` shape of the `diff` package. Where the
 * exact alignment of a hunk is the library's own choice (which of three equal
 * lines it calls removed), the tests read the two sides the hunks describe
 * instead of the line order.
 */
import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { getTotalLinesAdded, getTotalLinesRemoved } from 'src/platform/bootstrap/state.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import { adjustHunkLineNumbers, CONTEXT_LINES, countLinesChanged, DIFF_TIMEOUT_MS, getPatchForDisplay, getPatchFromContents } from 'src/vcs/git/diff.js'
import { countAddDel } from 'src/vcs/git/diffStat.js'

type Hunk = StructuredPatchHunk
const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]): Hunk => ({ oldStart, oldLines, newStart, newLines, lines })

/** The old and new text a list of hunks describes, markers left out. */
function sides(hunks: readonly Hunk[]): { before: string[]; after: string[] } {
  const before: string[] = []
  const after: string[] = []
  for (const line of hunks.flatMap(h => h.lines)) {
    const text = line.slice(1)
    if (line.startsWith(' ') || line.startsWith('-')) before.push(text)
    if (line.startsWith(' ') || line.startsWith('+')) after.push(text)
  }
  return { before, after }
}

const twenty = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
const edit = (old_string: string, new_string: string, replace_all = false): FileEdit => ({ old_string, new_string, replace_all })
const fromContents = (oldContent: string, newContent: string, extra: { ignoreWhitespace?: boolean; singleHunk?: boolean } = {}) =>
  getPatchFromContents({ filePath: 'notes/file.txt', oldContent, newContent, ...extra })
const forDisplay = (fileContents: string, edits: FileEdit[], ignoreWhitespace?: boolean) =>
  getPatchForDisplay({ filePath: 'notes/file.txt', fileContents, edits, ...(ignoreWhitespace === undefined ? {} : { ignoreWhitespace }) })

test('the exported settings: 3 lines of context, a 5 second limit per diff', () => {
  expect([CONTEXT_LINES, DIFF_TIMEOUT_MS]).toEqual([3, 5_000])
})

describe('getPatchFromContents', () => {
  test('a change carries three lines of context on each side', () => {
    expect(fromContents(twenty, twenty.replace('line10\n', 'LINE10\n'))).toStrictEqual([
      hunk(7, 7, 7, 7, [' line7', ' line8', ' line9', '-line10', '+LINE10', ' line11', ' line12', ' line13']),
    ])
  })

  test('changes far apart are separate hunks; singleHunk puts the whole file in one', () => {
    const edited = twenty.replace('line2\n', 'L2\n').replace('line19\n', 'L19\n')
    const shape = (hunks: Hunk[]) => hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.lines.length])
    expect(shape(fromContents(twenty, edited))).toEqual([[1, 5, 1, 5, 6], [16, 5, 16, 5, 6]])
    const [whole, ...none] = fromContents(twenty, edited, { singleHunk: true })
    expect(none).toEqual([])
    expect(shape([whole!])).toEqual([[1, 20, 1, 20, 22]])
    expect(sides([whole!]).after.join('\n') + '\n').toBe(edited)
  })

  test('the same text on both sides has no hunk', () => {
    expect(fromContents(twenty, twenty)).toEqual([])
  })

  test('a file created from nothing starts at line 1 with 0 old lines; an emptied file ends with 0 new lines', () => {
    expect(fromContents('', 'a\nb\n')).toStrictEqual([hunk(1, 0, 1, 2, ['+a', '+b'])])
    expect(fromContents('a\nb\n', '')).toStrictEqual([hunk(1, 2, 1, 0, ['-a', '-b'])])
  })

  test('a missing final newline is marked on the side that lacks it', () => {
    expect(fromContents('a\nb', 'a\nc')).toStrictEqual([
      hunk(1, 2, 1, 2, [' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file']),
    ])
    expect(fromContents('a', 'a\n')).toStrictEqual([hunk(1, 1, 1, 1, ['-a', '\\ No newline at end of file', '+a'])])
  })

  test('& and $ in the text come through as they are, and tabs stay tabs', () => {
    const [only] = fromContents('x & y\n$1 $& $$\n\tindented\n', "x && y\n$1 $& $$ $` $'\n\tindented\n")
    expect(only!.lines).toEqual(['-x & y', '-$1 $& $$', '+x && y', "+$1 $& $$ $` $'", ' \tindented'])
  })

  test('whitespace: a change by default; ignored at the ends of a line with ignoreWhitespace, but not inside it', () => {
    expect(fromContents('a b  \nz\n', 'a b\nz\n')).toStrictEqual([hunk(1, 2, 1, 2, ['-a b  ', '+a b', ' z'])])
    expect(fromContents('a b  \nz\n', 'a b\nz\n', { ignoreWhitespace: true })).toEqual([])
    expect(fromContents('  a\nz\n', 'a\nz\n', { ignoreWhitespace: true })).toEqual([])
    expect(fromContents('a  b\n', 'a b\n', { ignoreWhitespace: true })).toStrictEqual([hunk(1, 1, 1, 1, ['-a  b', '+a b'])])
  })
})

describe('getPatchForDisplay: the file with the edits applied', () => {
  test('an edit replaces the first occurrence; replace_all replaces every one', () => {
    expect(sides(forDisplay('a\na\na\n', [edit('a', 'b')]))).toEqual({ before: ['a', 'a', 'a'], after: ['b', 'a', 'a'] })
    expect(sides(forDisplay('a\na\na\n', [edit('a', 'b', true)]))).toEqual({ before: ['a', 'a', 'a'], after: ['b', 'b', 'b'] })
  })

  test('an edit object without replace_all replaces the first occurrence only', () => {
    const bare = { old_string: 'a', new_string: 'b' } as unknown as FileEdit
    expect(sides(forDisplay('a\na\n', [bare])).after).toEqual(['b', 'a'])
  })

  test('edits apply in order, each to the text the one before produced', () => {
    expect(forDisplay('one\n', [edit('one', 'two'), edit('two', 'three')])).toStrictEqual([hunk(1, 1, 1, 1, ['-one', '+three'])])
  })

  test('no edits, or an edit that matches nothing: no hunk', () => {
    expect(forDisplay('a\n', [])).toEqual([])
    expect(forDisplay('a\n', [edit('zzz', 'y')])).toEqual([])
  })

  test('a new file: an empty old string against empty contents', () => {
    expect(forDisplay('', [edit('', 'hello\n')])).toStrictEqual([hunk(1, 0, 1, 1, ['+hello'])])
  })

  test('the replacement is literal text: $& $1 $$ are not replacement patterns, & is kept', () => {
    expect(forDisplay('price\n', [edit('price', '$& $1 $$')])).toStrictEqual([hunk(1, 1, 1, 1, ['-price', '+$& $1 $$'])])
    expect(forDisplay('a & b\n', [edit('a & b', 'a && b')])).toStrictEqual([hunk(1, 1, 1, 1, ['-a & b', '+a && b'])])
  })

  test('each leading tab is shown as two spaces, in the file and in the edit; a tab after text stays', () => {
    const shown = forDisplay('\tfoo\n\t\tbar\nx\tbaz\n', [edit('\t\tbar', '\t\tqux')])
    expect(shown).toStrictEqual([hunk(1, 3, 1, 3, ['   foo', '-    bar', '+    qux', ' x\tbaz'])])
  })

  test('an edit written with two spaces matches a line indented with one tab', () => {
    expect(forDisplay('\tfoo\n', [edit('  foo', '  bar')])).toStrictEqual([hunk(1, 1, 1, 1, ['-  foo', '+  bar'])])
  })

  test('an edit that starts with a tab found after text on its line shows no hunk', () => {
    expect(forDisplay('x\tbaz\n', [edit('\tbaz', '\tBAZ')])).toEqual([])
  })

  test('ignoreWhitespace hides an edit that only re-indents', () => {
    expect(forDisplay('  a\nb\n', [edit('  a', 'a')], true)).toEqual([])
    expect(forDisplay('  a\nb\n', [edit('  a', 'a')])).toStrictEqual([hunk(1, 2, 1, 2, ['-  a', '+a', ' b'])])
  })
})

describe('adjustHunkLineNumbers', () => {
  const hunks = [hunk(1, 2, 3, 4, ['-x', '+y']), hunk(10, 1, 12, 1, [' z'])]

  test('an offset of 0 hands back the very same array', () => {
    expect(adjustHunkLineNumbers(hunks, 0)).toBe(hunks)
  })

  test('any other offset moves both starts and leaves everything else, input included, as it was', () => {
    expect(adjustHunkLineNumbers(hunks, 40)).toStrictEqual([hunk(41, 2, 43, 4, ['-x', '+y']), hunk(50, 1, 52, 1, [' z'])])
    expect(adjustHunkLineNumbers(hunks, -1)).toStrictEqual([hunk(0, 2, 2, 4, ['-x', '+y']), hunk(9, 1, 11, 1, [' z'])])
    expect(hunks).toStrictEqual([hunk(1, 2, 3, 4, ['-x', '+y']), hunk(10, 1, 12, 1, [' z'])])
  })
})

describe("countLinesChanged: adds to the session's lines added and removed", () => {
  function delta(run: () => void): [number, number] {
    const added = getTotalLinesAdded()
    const removed = getTotalLinesRemoved()
    run()
    return [getTotalLinesAdded() - added, getTotalLinesRemoved() - removed]
  }

  test('+ and - lines across all hunks; context and markers do not count', () => {
    const patch = [...fromContents('a\nb', 'a\nc'), ...fromContents(twenty, twenty.replace('line3\n', 'x\ny\n'))]
    expect(delta(() => countLinesChanged(patch))).toEqual([3, 2])
  })

  test('with no hunks, the new file content counts every line as added, \\n or \\r\\n', () => {
    expect(delta(() => countLinesChanged([], 'one\ntwo'))).toEqual([2, 0])
    expect(delta(() => countLinesChanged([], 'one\r\ntwo\r\nthree'))).toEqual([3, 0])
  })

  test('no hunks and no content, or empty content: nothing', () => {
    expect(delta(() => countLinesChanged([]))).toEqual([0, 0])
    expect(delta(() => countLinesChanged([], ''))).toEqual([0, 0])
  })

  test('when there are hunks the content argument is not looked at', () => {
    expect(delta(() => countLinesChanged(fromContents('a\n', 'b\n'), 'x\ny\nz'))).toEqual([1, 1])
  })
})

describe('countAddDel', () => {
  test('sums + and - lines over the hunks; context, markers and empty lines are not counted', () => {
    const hunks = [hunk(1, 3, 1, 3, ['+a', '-b', ' c', '\\ No newline at end of file', '']), hunk(9, 0, 9, 2, ['+d', '+e'])]
    expect(countAddDel(hunks)).toStrictEqual({ additions: 3, deletions: 1 })
  })

  test('a line that starts with +++ or --- is content, since hunks carry no file headers', () => {
    expect(countAddDel([hunk(1, 1, 1, 1, ['----', '+++ plus'])])).toStrictEqual({ additions: 1, deletions: 1 })
  })

  test('no hunks: zero and zero', () => {
    expect(countAddDel([])).toStrictEqual({ additions: 0, deletions: 0 })
  })

  test('agrees with the patches getPatchFromContents builds', () => {
    expect(countAddDel(fromContents(twenty, twenty.replace('line5\n', '').replace('line15\n', 'fifteen\nsixteen-ish\n')))).toStrictEqual({ additions: 2, deletions: 2 })
  })
})
