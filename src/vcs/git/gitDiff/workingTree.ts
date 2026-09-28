import type { StructuredPatchHunk } from 'diff'
import { logError } from 'src/shared/log.js'
import { diffArgs, runGit, UNTRACKED_FILES_ARGS } from 'src/vcs/git/gitDiff/gitRunner.js'
import { MAX_FILES_FOR_DETAIL, MAX_PATCH_BYTES } from 'src/vcs/git/gitDiff/limits.js'
import { parseGitNumstat } from 'src/vcs/git/gitDiff/numstat.js'
import { hasStoppedOperation, repositoryRoot } from 'src/vcs/git/gitDiff/repository.js'
import { parseShortstat } from 'src/vcs/git/gitDiff/shortstat.js'
import type { GitDiffResult } from 'src/vcs/git/gitDiff/types.js'
import { parseGitDiff } from 'src/vcs/git/gitDiff/unifiedDiff.js'
import { parseUntrackedList, withUntrackedFiles } from 'src/vcs/git/gitDiff/untrackedFiles.js'

const GIT_LIMITS = { timeoutMs: 5_000 }
const PATCH_LIMITS = { timeoutMs: 5_000, maxBytes: MAX_PATCH_BYTES }
/** Room for every untracked name, since each one is counted, not only the ones shown. */
const UNTRACKED_LIMITS = { timeoutMs: 5_000, maxBytes: 10_000_000 }

/**
 * Per-file numbers for the working tree and index against HEAD, then the
 * untracked files. Null outside a repository, before the first commit, while
 * an operation is stopped half-way, or when git fails.
 */
export async function fetchGitDiff(root?: string): Promise<GitDiffResult | null> {
  try {
    const top = await readableRepository(root)
    return top === null ? null : await readNumbers(top)
  } catch (error) {
    logError(error)
    return null
  }
}

/** The hunks of the same comparison, or an empty map whenever the numbers would be null. */
export async function fetchGitDiffHunks(root?: string): Promise<Map<string, StructuredPatchHunk[]>> {
  try {
    const top = await readableRepository(root)
    const patch = top === null ? null : await runGit(top, diffArgs('HEAD', 'patch'), PATCH_LIMITS)
    return patch === null ? new Map() : parseGitDiff(patch)
  } catch (error) {
    logError(error)
    return new Map()
  }
}

/**
 * A stopped merge or rebase leaves conflict markers and half-applied changes
 * in the tree; showing them as the user's work would mislead, so nothing is
 * shown until the operation is finished or aborted.
 */
async function readableRepository(root: string | undefined): Promise<string | null> {
  const top = repositoryRoot(root)
  if (top === null || (await hasStoppedOperation(top))) return null
  return top
}

/**
 * The totals come first: past the detail limit, a per-file listing could
 * outgrow any buffer, and the untracked files are not looked at.
 */
async function readNumbers(root: string): Promise<GitDiffResult | null> {
  const totalsOutput = await runGit(root, diffArgs('HEAD', 'totals'), GIT_LIMITS)
  if (totalsOutput === null) return null
  const totals = parseShortstat(totalsOutput)
  if (totals !== null && totals.filesCount > MAX_FILES_FOR_DETAIL) {
    return { stats: totals, perFileStats: new Map(), hunks: new Map() }
  }
  const [numbersOutput, untrackedOutput] = await Promise.all([
    runGit(root, diffArgs('HEAD', 'numbers'), GIT_LIMITS),
    runGit(root, UNTRACKED_FILES_ARGS, UNTRACKED_LIMITS),
  ])
  if (numbersOutput === null) return null
  // Without the untracked listing, the tracked numbers still stand.
  return withUntrackedFiles(parseGitNumstat(numbersOutput), parseUntrackedList(untrackedOutput ?? ''))
}
