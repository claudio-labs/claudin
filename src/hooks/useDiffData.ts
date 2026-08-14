import type { StructuredPatchHunk } from 'diff'
import { useEffect, useMemo, useState } from 'react'
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
  type GitDiffStats,
} from 'src/services/git/gitDiff.js'

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
 * Convert a raw GitDiffResult + on-demand hunks into the display file list.
 * Pure — shared by useDiffData (single repo) and useWorkspaceDiff (per root).
 */
export function gitDiffResultToFiles(
  diffResult: GitDiffResult,
  hunks: Map<string, StructuredPatchHunk[]>,
): DiffFile[] {
  const { perFileStats } = diffResult
  const files: DiffFile[] = []

  for (const [path, fileStats] of perFileStats) {
    const fileHunks = hunks.get(path)
    const isUntracked = fileStats.isUntracked ?? false

    // Detect large file (in perFileStats but not in hunks, and not
    // binary/untracked). A pure rename also has a numstat entry with no hunks
    // (git emits no `@@` when the content is identical), so exclude renames —
    // they render as a rename badge, not a "Large file" placeholder.
    const isLargeFile =
      !fileStats.isBinary && !isUntracked && !fileHunks && !fileStats.renamedFrom

    // Detect truncated file (total > limit means we truncated)
    const totalLines = fileStats.added + fileStats.removed
    const isTruncated =
      !isLargeFile && !fileStats.isBinary && totalLines > MAX_LINES_PER_FILE

    files.push({
      path,
      linesAdded: fileStats.added,
      linesRemoved: fileStats.removed,
      isBinary: fileStats.isBinary,
      isLargeFile,
      isTruncated,
      isUntracked,
      ...(fileStats.renamedFrom ? { renamedFrom: fileStats.renamedFrom } : {}),
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/**
 * Hook to fetch git diff data on demand. Fetches both stats and hunks when the
 * component mounts. Pass `cwd` to diff a specific repo root (default: ambient).
 */
export function useDiffData(cwd?: string): DiffData {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [hunks, setHunks] = useState<Map<string, StructuredPatchHunk[]>>(
    new Map(),
  )
  const [loading, setLoading] = useState(true)

  // Fetch diff data on mount
  useEffect(() => {
    let cancelled = false

    async function loadDiffData() {
      try {
        // Fetch both stats and hunks
        const [statsResult, hunksResult] = await Promise.all([
          fetchGitDiff(cwd),
          fetchGitDiffHunks(cwd),
        ])

        if (!cancelled) {
          setDiffResult(statsResult)
          setHunks(hunksResult)
          setLoading(false)
        }
      } catch (_error) {
        if (!cancelled) {
          setDiffResult(null)
          setHunks(new Map())
          setLoading(false)
        }
      }
    }

    void loadDiffData()

    return () => {
      cancelled = true
    }
  }, [cwd])

  return useMemo(() => {
    if (!diffResult) {
      return { stats: null, files: [], hunks: new Map(), loading }
    }

    return {
      stats: diffResult.stats,
      files: gitDiffResultToFiles(diffResult, hunks),
      hunks,
      loading: false,
    }
  }, [diffResult, hunks, loading])
}
