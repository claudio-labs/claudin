/**
 * The footer readout for a scope it measured. The characterization suite
 * reaches it only through fresh processes and only on the base branch for the
 * "nothing changed" case; this pins the mapping itself.
 */
import { describe, expect, test } from 'bun:test'
import type { DiffStatScope, GitDiffStats } from 'src/vcs/git/gitDiff.js'
import { readoutFor } from 'src/vcs/git/gitDiff/diffStatScope.js'

const uncommitted: DiffStatScope = { kind: 'uncommitted' }
const onBranch: DiffStatScope = { kind: 'branch', against: 'a'.repeat(40), base: 'origin/release' }
const measured: GitDiffStats = { filesCount: 2, linesAdded: 5, linesRemoved: 1 }

describe('readoutFor', () => {
  test('a branch measure goes in the branch slot, labelled with its base', () => {
    expect(readoutFor(onBranch, measured)).toStrictEqual({ uncommitted: null, branch: measured, branchBase: 'origin/release' })
  })

  test('the uncommitted measure goes in its own slot, with no label', () => {
    expect(readoutFor(uncommitted, measured)).toStrictEqual({ uncommitted: measured, branch: null, branchBase: null })
  })

  test.each([
    ['on a branch', onBranch],
    ['on the base', uncommitted],
  ] as const)('nothing changed %s: all null, the label included', (_label, scope) => {
    expect(readoutFor(scope, null)).toStrictEqual({ uncommitted: null, branch: null, branchBase: null })
  })
})
