/**
 * A repository's changes, as the diff reviewer, the explorer's change tint
 * and the prompt footer read them, and the parsers for git's diff output that
 * the reviewer's log and stash tabs and the Git tool share. The modules live
 * in gitDiff/: the parsers are pure, and only the fetchers run git.
 */
export { buildAddedFileHunks } from 'src/vcs/git/gitDiff/addedFileHunks.js'
export { fetchDiffStatSummary } from 'src/vcs/git/gitDiff/diffStatSummary.js'
export { chooseDiffStatScope, type DiffStatScope } from 'src/vcs/git/gitDiff/diffStatScope.js'
export { parseGitNumstat } from 'src/vcs/git/gitDiff/numstat.js'
export { parseShortstat } from 'src/vcs/git/gitDiff/shortstat.js'
export type {
  DiffStatSummary,
  GitDiffResult,
  GitDiffStats,
  NumstatResult,
  PerFileStats,
} from 'src/vcs/git/gitDiff/types.js'
export { parseGitDiff } from 'src/vcs/git/gitDiff/unifiedDiff.js'
export { fetchGitDiff, fetchGitDiffHunks } from 'src/vcs/git/gitDiff/workingTree.js'
