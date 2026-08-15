import type { StructuredPatchHunk } from 'diff'
import { describe, expect, test } from 'bun:test'
import type { GitDiffResult, PerFileStats } from 'src/vcs/git/gitDiff.js'
import { gitDiffResultToFiles } from 'src/vcs/diff/hooks/useDiffData.js'

// Minimal hunk just to mark "this file has parsed diff content".
function hunk(): StructuredPatchHunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' x'] }
}

function result(
  perFileStats: Record<string, PerFileStats>,
): GitDiffResult {
  return {
    stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
    perFileStats: new Map(Object.entries(perFileStats)),
    hunks: new Map(),
  }
}

describe('gitDiffResultToFiles', () => {
  test('a pure rename (numstat entry, no hunks) is NOT a large file', () => {
    const files = gitDiffResultToFiles(
      result({
        'b.ts': { added: 0, removed: 0, isBinary: false, renamedFrom: 'a.ts' },
      }),
      new Map(), // no hunks — git emits no @@ for an identical rename
    )
    expect(files).toHaveLength(1)
    expect(files[0]!.isLargeFile).toBe(false)
    expect(files[0]!.renamedFrom).toBe('a.ts')
  })

  test('a non-binary, non-untracked file with no hunks IS a large file', () => {
    const files = gitDiffResultToFiles(
      result({ 'big.bin': { added: 0, removed: 0, isBinary: false } }),
      new Map(),
    )
    expect(files[0]!.isLargeFile).toBe(true)
    expect(files[0]!.renamedFrom).toBeUndefined()
  })

  test('a rename WITH content changes keeps its hunks and is not large', () => {
    const files = gitDiffResultToFiles(
      result({
        'b.ts': { added: 3, removed: 1, isBinary: false, renamedFrom: 'a.ts' },
      }),
      new Map([['b.ts', [hunk()]]]),
    )
    expect(files[0]!.isLargeFile).toBe(false)
    expect(files[0]!.renamedFrom).toBe('a.ts')
  })

  test('binary files are flagged binary, never large', () => {
    const files = gitDiffResultToFiles(
      result({ 'img.png': { added: 0, removed: 0, isBinary: true } }),
      new Map(),
    )
    expect(files[0]!.isBinary).toBe(true)
    expect(files[0]!.isLargeFile).toBe(false)
  })

  test('untracked files are flagged untracked, never large', () => {
    const files = gitDiffResultToFiles(
      result({
        'new.ts': { added: 5, removed: 0, isBinary: false, isUntracked: true },
      }),
      new Map(),
    )
    expect(files[0]!.isUntracked).toBe(true)
    expect(files[0]!.isLargeFile).toBe(false)
  })

  test('a file whose churn exceeds the per-file line cap is truncated', () => {
    const files = gitDiffResultToFiles(
      result({ 'huge.ts': { added: 300, removed: 200, isBinary: false } }),
      new Map([['huge.ts', [hunk()]]]),
    )
    expect(files[0]!.isTruncated).toBe(true)
    expect(files[0]!.isLargeFile).toBe(false)
  })

  test('a normal small file with hunks carries no special flags', () => {
    const files = gitDiffResultToFiles(
      result({ 'a.ts': { added: 2, removed: 1, isBinary: false } }),
      new Map([['a.ts', [hunk()]]]),
    )
    expect(files[0]).toMatchObject({
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isUntracked: false,
    })
  })
})
