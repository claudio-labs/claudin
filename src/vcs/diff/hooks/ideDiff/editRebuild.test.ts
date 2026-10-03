/**
 * The edits rebuilt from the IDE's answer (spec, finding 3): they keep the
 * final newline, so applying them to the old text gives the new text exactly.
 */
import { describe, expect, test } from 'bun:test'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import { computeEditsFromContents } from 'src/vcs/diff/hooks/useDiffInIDE.js'

const numbered = (count: number, ending = '\n'): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + ending

function applyInOrder(text: string, edits: FileEdit[]): string {
  return edits.reduce((current, edit) => current.replace(edit.old_string, () => edit.new_string), text)
}

const edit = (old_string: string, new_string: string): FileEdit => ({ old_string, new_string, replace_all: false })

describe('single mode: one edit holding both complete texts', () => {
  const cases = [
    { name: 'a change in a file with a final newline', before: 'a\nb\n', after: 'a\nB\n' },
    { name: 'the final newline removed', before: 'a\nb\n', after: 'a\nb' },
    { name: 'the final newline added', before: 'a\nb', after: 'a\nb\n' },
  ]
  for (const row of cases) {
    test(row.name, () => {
      expect(computeEditsFromContents('/f.ts', row.before, row.after, 'single')).toEqual([edit(row.before, row.after)])
    })
  }
})

describe('multiple mode: one edit per region, the last one carrying its final newline', () => {
  const cases: Array<{ name: string; before: string; after: string; edits: FileEdit[] }> = [
    {
      name: 'a change at the end of a file with a final newline',
      before: numbered(5),
      after: numbered(5).replace('line 5', 'LINE 5'),
      edits: [edit('line 2\nline 3\nline 4\nline 5\n', 'line 2\nline 3\nline 4\nLINE 5\n')],
    },
    {
      name: 'only the final newline removed',
      before: 'a\nb\n',
      after: 'a\nb',
      edits: [edit('a\nb\n', 'a\nb')],
    },
    {
      name: 'only the final newline added',
      before: 'a\nb',
      after: 'a\nb\n',
      edits: [edit('a\nb', 'a\nb\n')],
    },
    {
      name: 'a region in the middle carries no newline of its own',
      before: numbered(12),
      after: numbered(12).replace('line 2\n', 'LINE 2\n'),
      edits: [edit('line 1\nline 2\nline 3\nline 4\nline 5', 'line 1\nLINE 2\nline 3\nline 4\nline 5')],
    },
    {
      name: 'text added to an empty file',
      before: '',
      after: 'fresh\n',
      edits: [edit('', 'fresh\n')],
    },
    { name: 'identical texts give no edits', before: 'same\n', after: 'same\n', edits: [] },
  ]
  for (const row of cases) {
    test(row.name, () => {
      const edits = computeEditsFromContents('/f.ts', row.before, row.after, 'multiple')
      expect(edits).toEqual(row.edits)
      expect(applyInOrder(row.before, edits)).toBe(row.after)
    })
  }

  test('two distant regions round-trip, the final newline included', () => {
    const before = numbered(20)
    const after = before.replace('line 3\n', 'LINE 3\n').replace('line 20\n', 'line 20')
    const edits = computeEditsFromContents('/f.ts', before, after, 'multiple')
    expect(edits).toHaveLength(2)
    expect(edits.every(e => e.replace_all === false)).toBe(true)
    expect(applyInOrder(before, edits)).toBe(after)
  })
})
