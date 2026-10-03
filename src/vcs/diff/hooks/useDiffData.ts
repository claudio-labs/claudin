import type { StructuredPatchHunk } from 'diff'
import type { GitDiffResult, GitDiffStats, PerFileStats } from 'src/vcs/git/gitDiff.js'

const MAX_LINES_PER_FILE = 400

export type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean
  isTruncated: boolean
  isNewFile?: boolean
  isUntracked?: boolean
  /** Original path when git detected a rename. */
  renamedFrom?: string
}

export type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}

/**
 * Convert a raw GitDiffResult + on-demand hunks into the display file list,
 * ordered by `localeCompare` (case-insensitive, unlike git's byte order).
 */
export function gitDiffResultToFiles(
  diffResult: GitDiffResult,
  hunks: Map<string, StructuredPatchHunk[]>,
): DiffFile[] {
  const files: DiffFile[] = []
  for (const [path, stats] of diffResult.perFileStats) {
    files.push(toDiffFile(path, stats, hunks.has(path)))
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function toDiffFile(path: string, stats: PerFileStats, hasHunks: boolean): DiffFile {
  const isUntracked = stats.isUntracked === true
  const isRename = stats.renamedFrom !== undefined
  // No hunks for a tracked text file means the hunk fetch gave up on size. A
  // mode-only change and an empty new file land here too (vcs/gitDiff, finding 16).
  const isLargeFile = !stats.isBinary && !isUntracked && !isRename && !hasHunks
  const isTruncated = !isLargeFile && !stats.isBinary && stats.added + stats.removed > MAX_LINES_PER_FILE
  return {
    path,
    linesAdded: stats.added,
    linesRemoved: stats.removed,
    isBinary: stats.isBinary,
    isLargeFile,
    isTruncated,
    isUntracked,
    ...(isRename ? { renamedFrom: stats.renamedFrom } : {}),
  }
}
