import { describe, expect, test } from 'bun:test'
import { type GitDiffStats, resolveDiffStatSummary } from './gitDiff.js'

const stats = (linesAdded: number, linesRemoved: number, filesCount = 1): GitDiffStats => ({
  filesCount,
  linesAdded,
  linesRemoved,
})

describe('resolveDiffStatSummary', () => {
  test('keeps the branch group when the branch carries commits of its own', () => {
    const summary = resolveDiffStatSummary(stats(12, 3), stats(1240, 300), 'main')
    expect(summary.branch).toEqual(stats(1240, 300))
    expect(summary.branchBase).toBe('main')
  })

  test('drops the branch group on the base branch, where it repeats uncommitted', () => {
    // merge-base(HEAD, main) === HEAD there, so the second probe measures the
    // same working tree and would render the identical numbers twice.
    const summary = resolveDiffStatSummary(stats(97, 5, 2), stats(97, 5, 2), 'main')
    expect(summary.uncommitted).toEqual(stats(97, 5, 2))
    expect(summary.branch).toBeNull()
    expect(summary.branchBase).toBeNull()
  })

  test('drops the branch group on a clean base branch', () => {
    // Both probes come back empty, which parseShortstat reports as null.
    const summary = resolveDiffStatSummary(null, null, 'main')
    expect(summary).toEqual({ uncommitted: null, branch: null, branchBase: null })
  })

  test('keeps the branch group when the tree is clean but the branch is ahead', () => {
    const summary = resolveDiffStatSummary(null, stats(40, 2), 'main')
    expect(summary.branch).toEqual(stats(40, 2))
    expect(summary.branchBase).toBe('main')
  })

  test('drops the branch group when merge-base could not be resolved', () => {
    // Detached HEAD / shallow clone: the caller passes a null base and the
    // uncommitted half must still survive.
    const summary = resolveDiffStatSummary(stats(12, 3), null, null)
    expect(summary.uncommitted).toEqual(stats(12, 3))
    expect(summary.branch).toBeNull()
  })

  test('compares lines, not file counts', () => {
    // Same lines reached through a different file count is still the same work
    // seen twice — git reports `filesCount` differently for a rename.
    const summary = resolveDiffStatSummary(stats(10, 4, 1), stats(10, 4, 2), 'main')
    expect(summary.branch).toBeNull()
  })
})
