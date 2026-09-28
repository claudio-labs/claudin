/**
 * parseGitDiff, for what the characterization suite leaves open: the content
 * lines that look like file headers, and the newline that closes a file's
 * section. Both are fixes in docs/tech/rewrite/vcs/gitDiff.md (findings 1, 2).
 */
import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { parseGitDiff } from 'src/vcs/git/gitDiff.js'

/** One file's section as git prints it, headers first, then `body`. */
function fileSection(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`
}

const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]): StructuredPatchHunk => ({
  oldStart,
  oldLines,
  newStart,
  newLines,
  lines,
})

describe('content lines that look like file headers stay in their hunk', () => {
  test('Markdown front matter and a rule: removed lines that start with ---', () => {
    const text = fileSection('post.md', '@@ -1,5 +1,3 @@\n----\n-title: Notes\n----\n+# Notes\n body\n----\n+***\n')
    expect(parseGitDiff(text).get('post.md')).toStrictEqual([
      hunk(1, 5, 1, 3, ['----', '-title: Notes', '----', '+# Notes', ' body', '----', '+***']),
    ])
  })

  test('an SQL comment removed and a C increment added: -- and ++ at the start of the text', () => {
    const text = fileSection('query.c', '@@ -1,2 +1,2 @@\n--- pick the newest row\n+++i;\n return i;\n')
    expect(parseGitDiff(text).get('query.c')).toStrictEqual([
      hunk(1, 2, 1, 2, ['--- pick the newest row', '+++i;', ' return i;']),
    ])
  })

  test('in a later hunk too, while the header pair before the first hunk is never content', () => {
    const text = fileSection('schema.sql', '@@ -1 +1 @@\n-a\n+b\n@@ -9,2 +9,2 @@\n--- old note\n+++ new note\n z\n')
    const hunks = parseGitDiff(text).get('schema.sql')!
    expect(hunks.map(h => h.lines)).toEqual([['-a', '+b'], ['--- old note', '+++ new note', ' z']])
    expect(hunks.flatMap(h => h.lines)).not.toContain('--- a/schema.sql')
  })
})

describe("the newline that closes a file's section is not a line of its last hunk", () => {
  test('every file ends on its own last line, not on an extra empty one', () => {
    const text = fileSection('one.txt', '@@ -1 +1 @@\n-one\n+uno\n') + fileSection('two.txt', '@@ -1,2 +1,2 @@\n two\n-2\n+dos\n')
    expect([...parseGitDiff(text)]).toStrictEqual([
      ['one.txt', [hunk(1, 1, 1, 1, ['-one', '+uno'])]],
      ['two.txt', [hunk(1, 2, 1, 2, [' two', '-2', '+dos'])]],
    ])
  })

  test('a blank context line at the very end (diff.suppressBlankEmpty) is kept', () => {
    const text = fileSection('blank.txt', '@@ -1,3 +1,3 @@\n-a\n+b\n x\n\n')
    expect(parseGitDiff(text).get('blank.txt')).toStrictEqual([hunk(1, 3, 1, 3, ['-a', '+b', ' x', ''])])
  })

  test('text that stops without a final newline keeps its last line', () => {
    const text = fileSection('cut.txt', '@@ -1 +1 @@\n-a\n+b')
    expect(parseGitDiff(text).get('cut.txt')).toStrictEqual([hunk(1, 1, 1, 1, ['-a', '+b'])])
  })
})
