/**
 * src/vcs/git/diff.ts, for the two fixes the characterization suite does not
 * reach (docs/tech/rewrite/vcs/gitDiff.md, findings 9 and 10).
 */
import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { getTotalLinesAdded, getTotalLinesRemoved } from 'src/platform/bootstrap/state.js'
import { countLinesChanged, getPatchForDisplay, getPatchFromContents } from 'src/vcs/git/diff.js'

/** What `run` adds to the session's lines-added and lines-removed totals. */
function totalsAddedBy(run: () => void): [number, number] {
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()
  run()
  return [getTotalLinesAdded() - added, getTotalLinesRemoved() - removed]
}

/** The new side a list of hunks describes, markers left out. */
function newSide(hunks: readonly StructuredPatchHunk[]): string[] {
  return hunks.flatMap(h => h.lines).filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1))
}

describe('countLinesChanged: a written file with no hunks counts its lines', () => {
  test.each([
    ['two lines, each ended', 'a\nb\n', 2],
    ['two lines, the last one open', 'a\nb', 2],
    ['one empty line', '\n', 1],
    ['a line and a blank one', 'a\n\n', 2],
    ['CRLF line ends', 'a\r\nb\r\n', 2],
  ])('%s: a final newline ends the last line, it does not add one', (_label, content, lines) => {
    expect(totalsAddedBy(() => countLinesChanged([], content))).toEqual([lines, 0])
  })
})

describe('hunk lines carry the texts exactly, whatever they contain', () => {
  // Sequences an escaping scheme might use to protect `&` and `$`, and the
  // replacement patterns themselves. None of them may come out altered.
  const tricky = [
    '<<:AMPERSAND_TOKEN:>>',
    '<<:DOLLAR_TOKEN:>>',
    '__AMPERSAND__ __DOLLAR__',
    '{{AMP}} {{DOLLAR}}',
    '&amp; &#36; &#x26;',
    '\u0000&\u0000$\u0000',
    "$& $1 $$ $` $' $<name>",
  ]
  const before = tricky.map((text, i) => `${i} ${text}`).join('\n') + '\n'
  const after = tricky.map((text, i) => `${i} ${text} (edited)`).join('\n') + '\n'

  test('getPatchFromContents', () => {
    expect(newSide(getPatchFromContents({ filePath: 'odd.txt', oldContent: before, newContent: after }))).toEqual(after.split('\n').slice(0, -1))
  })

  test('getPatchForDisplay, the text of the file and of the edit alike', () => {
    const hunks = getPatchForDisplay({
      filePath: 'odd.txt',
      fileContents: before,
      edits: [{ old_string: before, new_string: after, replace_all: false }],
    })
    expect(newSide(hunks)).toEqual(after.split('\n').slice(0, -1))
  })
})
