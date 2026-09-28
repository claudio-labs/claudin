import { logError } from 'src/shared/log.js'
import { getDefaultBranch, getHead } from 'src/vcs/git/git.js'
import { chooseDiffStatScope, noReadout, readoutFor } from 'src/vcs/git/gitDiff/diffStatScope.js'
import { diffArgs, mergeBaseArgs, runGit } from 'src/vcs/git/gitDiff/gitRunner.js'
import { repositoryRoot } from 'src/vcs/git/gitDiff/repository.js'
import { parseShortstat } from 'src/vcs/git/gitDiff/shortstat.js'
import type { DiffStatSummary } from 'src/vcs/git/gitDiff/types.js'

/** The footer polls this, so a slow git has to give up sooner than elsewhere. */
const READOUT_LIMITS = { timeoutMs: 2_000 }

/** Names the base branch when the repository's default branch is not the one. */
const BASE_REF_VARIABLE = 'CLAUDIN_BASE_REF'

/**
 * The footer's line counts for the repository around the session's current
 * directory: the branch's changes since it left its base, or else the
 * uncommitted ones. Tracked files only. Any failure shows less, never throws.
 */
export async function fetchDiffStatSummary(): Promise<DiffStatSummary> {
  try {
    const root = repositoryRoot()
    return root === null ? noReadout() : await measure(root)
  } catch (error) {
    logError(error)
    return noReadout()
  }
}

async function measure(root: string): Promise<DiffStatSummary> {
  const base = process.env[BASE_REF_VARIABLE] || (await getDefaultBranch())
  const head = await getHead()
  const mergeBase = head === '' ? null : await runGit(root, mergeBaseArgs(base), READOUT_LIMITS)
  const scope = chooseDiffStatScope(head, mergeBase?.trim() || null, base)
  const against = scope.kind === 'branch' ? scope.against : 'HEAD'
  const output = await runGit(root, diffArgs(against, 'totals'), READOUT_LIMITS)
  return readoutFor(scope, output === null ? null : parseShortstat(output))
}
