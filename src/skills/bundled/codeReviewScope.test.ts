import { describe, expect, test } from 'bun:test'

import {
  formatReviewScope,
  mergeScopeFiles,
  parseNumstat,
  parseUntracked,
  type ScopeFile,
  type ReviewScope,
} from 'src/skills/bundled/codeReviewScope.js'

const tracked = (
  path: string,
  additions: number,
  deletions: number,
  binary = false,
): ScopeFile => ({ path, additions, deletions, binary, untracked: false })

describe('parseNumstat', () => {
  test('reads added/deleted/path rows', () => {
    const files = parseNumstat('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n')
    expect(files).toEqual([
      tracked('src/a.ts', 12, 3),
      tracked('src/b.ts', 0, 7),
    ])
  })

  test('marks a binary row instead of parsing its dashes as churn', () => {
    const [file] = parseNumstat('-\t-\tassets/logo.png\n')
    expect(file).toEqual(tracked('assets/logo.png', 0, 0, true))
  })

  test('keeps a path containing a tab intact', () => {
    const [file] = parseNumstat('1\t0\tsrc/od\td.ts\n')
    expect(file?.path).toBe('src/od\td.ts')
  })

  test('ignores blank and malformed rows', () => {
    expect(parseNumstat('\n\nnot-a-row\n1\t2\n')).toEqual([])
  })
})

describe('parseUntracked', () => {
  test('turns each path into a churn-less untracked entry', () => {
    expect(parseUntracked('src/new.ts\ndocs/new.md\n')).toEqual([
      { path: 'src/new.ts', additions: 0, deletions: 0, binary: false, untracked: true },
      { path: 'docs/new.md', additions: 0, deletions: 0, binary: false, untracked: true },
    ])
  })

  test('ignores blank lines', () => {
    expect(parseUntracked('\n\n')).toEqual([])
  })
})

describe('mergeScopeFiles', () => {
  test('a file in both passes is one entry, keeping the larger churn', () => {
    const merged = mergeScopeFiles([
      [tracked('src/a.ts', 10, 1)],
      [tracked('src/a.ts', 4, 6)],
    ])
    expect(merged).toEqual([tracked('src/a.ts', 10, 6)])
  })

  test('orders by churn, with the path as a deterministic tie-break', () => {
    const merged = mergeScopeFiles([
      [
        tracked('src/b.ts', 1, 1),
        tracked('src/big.ts', 50, 0),
        tracked('src/a.ts', 1, 1),
      ],
    ])
    expect(merged.map(f => f.path)).toEqual([
      'src/big.ts',
      'src/a.ts',
      'src/b.ts',
    ])
  })

  test('binary in either pass stays binary', () => {
    const [file] = mergeScopeFiles([
      [tracked('x.png', 0, 0, true)],
      [tracked('x.png', 0, 0)],
    ])
    expect(file?.binary).toBe(true)
  })

  // A new file carries no churn, so churn ordering would bury it last — right
  // where the listing cap drops it.
  test('untracked files sort ahead of the highest-churn tracked file', () => {
    const merged = mergeScopeFiles([
      [tracked('src/huge.ts', 900, 0)],
      parseUntracked('src/z-new.ts\nsrc/a-new.ts\n'),
    ])
    expect(merged.map(f => f.path)).toEqual([
      'src/a-new.ts',
      'src/z-new.ts',
      'src/huge.ts',
    ])
  })

  test('a path in both a diff pass and the untracked list is tracked', () => {
    const [file] = mergeScopeFiles([
      parseUntracked('src/a.ts\n'),
      [tracked('src/a.ts', 3, 1)],
    ])
    expect(file?.untracked).toBe(false)
  })
})

describe('formatReviewScope', () => {
  const base: ReviewScope = {
    range: 'origin/main...HEAD',
    includesWorkingTree: true,
    files: [tracked('src/a.ts', 40, 2)],
    totalAdditions: 40,
    totalDeletions: 2,
  }

  test('names both commands when the working tree contributed', () => {
    const text = formatReviewScope(base)
    expect(text).toContain('    git diff origin/main...HEAD')
    expect(text).toContain('    git diff HEAD')
    expect(text).toContain('1 file, +40 −2')
    expect(text).toContain('- src/a.ts (+40 −2)')
  })

  test('omits the working-tree command when nothing is uncommitted', () => {
    const text = formatReviewScope({ ...base, includesWorkingTree: false })
    expect(text).toContain('git diff origin/main...HEAD')
    expect(text).not.toContain('    git diff HEAD\n')
  })

  test('omits the range when only the working tree differs', () => {
    const text = formatReviewScope({ ...base, range: '' })
    expect(text).toContain('    git diff HEAD')
    expect(text).not.toContain('...HEAD')
  })

  test('labels a binary file instead of printing +0 −0', () => {
    const text = formatReviewScope({
      ...base,
      files: [tracked('logo.png', 0, 0, true)],
    })
    expect(text).toContain('- logo.png (binary)')
  })

  test('sends the reviewer to Read an untracked file the diff cannot show', () => {
    const text = formatReviewScope({
      ...base,
      files: [...parseUntracked('src/new.ts\n'), ...base.files],
    })
    expect(text).toContain('- src/new.ts (new file, untracked)')
    expect(text).toContain('are NOT in the output of those')
    expect(text).toContain('Read each one in full')
  })

  test('no note when nothing is untracked', () => {
    expect(formatReviewScope(base)).not.toContain('untracked')
  })

  test('a change made only of new files has no diff to fetch', () => {
    const text = formatReviewScope({
      range: '',
      includesWorkingTree: false,
      files: parseUntracked('src/new.ts\n'),
      totalAdditions: 0,
      totalDeletions: 0,
    })
    expect(text).toContain('entirely new files — there is no diff to fetch')
    expect(text).not.toContain('git diff')
  })

  test('truncates a wide diff to a listed cap plus a remainder count', () => {
    const files = Array.from({ length: 64 }, (_, i) =>
      tracked(`src/f${String(i).padStart(3, '0')}.ts`, 100 - i, 0),
    )
    const text = formatReviewScope({ ...base, files })
    expect(text).toContain('64 files')
    expect(text).toContain('- src/f000.ts (+100 −0)')
    expect(text).toContain('- …and 4 more files')
    expect(text).not.toContain('src/f060.ts')
  })
})
