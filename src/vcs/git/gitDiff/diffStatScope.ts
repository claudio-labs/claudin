import type { DiffStatSummary, GitDiffStats } from 'src/vcs/git/gitDiff/types.js'

export type DiffStatScope = { kind: 'uncommitted' } | { kind: 'branch'; against: string; base: string }

/**
 * Which change the footer measures. A branch that has left its base is
 * measured from the merge-base, so its commits count along with the work not
 * yet committed. Sitting on the base, or with no merge-base or no HEAD to
 * compare, that measure would only repeat the uncommitted one under a branch
 * label.
 */
export function chooseDiffStatScope(head: string, mergeBase: string | null, base: string): DiffStatScope {
  if (!head || !mergeBase || mergeBase === head) return { kind: 'uncommitted' }
  return { kind: 'branch', against: mergeBase, base }
}

/** The readout for what was measured: git's totals in the scope's slot, or nothing when nothing changed. */
export function readoutFor(scope: DiffStatScope, measured: GitDiffStats | null): DiffStatSummary {
  if (measured === null) return noReadout()
  if (scope.kind === 'branch') return { uncommitted: null, branch: measured, branchBase: scope.base }
  return { uncommitted: measured, branch: null, branchBase: null }
}

export function noReadout(): DiffStatSummary {
  return { uncommitted: null, branch: null, branchBase: null }
}
