import type { StructuredPatchHunk } from 'diff'

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

export type PerFileStats = {
  added: number
  removed: number
  isBinary: boolean
  isUntracked?: boolean
  renamedFrom?: string
}

export type NumstatResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
  hunks: Map<string, StructuredPatchHunk[]>
}

/** The prompt footer's readout: one of the two measures, or neither. */
export type DiffStatSummary = {
  uncommitted: GitDiffStats | null
  branch: GitDiffStats | null
  branchBase: string | null
}
