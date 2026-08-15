import { useEffect, useState } from 'react'
import { getCwd } from 'src/shared/fs/cwd.js'
import { type DiffStatSummary, fetchDiffStatSummary } from 'src/services/git/gitDiff.js'

/**
 * Slower than the cwd/branch poll (2s): this one spawns git, and the numbers
 * only move when a file is written or a commit lands.
 */
const POLL_INTERVAL_MS = 3000

const EMPTY: DiffStatSummary = { uncommitted: null, branch: null, branchBase: null }

function sameSummary(a: DiffStatSummary, b: DiffStatSummary): boolean {
  return (
    a.branchBase === b.branchBase &&
    a.uncommitted?.linesAdded === b.uncommitted?.linesAdded &&
    a.uncommitted?.linesRemoved === b.uncommitted?.linesRemoved &&
    a.branch?.linesAdded === b.branch?.linesAdded &&
    a.branch?.linesRemoved === b.branch?.linesRemoved
  )
}

/**
 * Git-backed diff totals for the prompt's top rule: uncommitted work, and what
 * the branch adds over its base. Complements `useSessionDiffStat`, which counts
 * what THIS session wrote regardless of what git thinks.
 *
 * A tick is skipped while the previous fetch is still in flight, so a slow repo
 * degrades to a lower refresh rate instead of queueing git processes. Returns
 * the previous object identity when nothing moved.
 */
export function useGitDiffStat(): DiffStatSummary {
  const cwd = getCwd()
  const [summary, setSummary] = useState<DiffStatSummary>(EMPTY)

  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const refresh = () => {
      if (inFlight) return
      inFlight = true
      fetchDiffStatSummary()
        .then(next => {
          if (cancelled) return
          setSummary(prev => (sameSummary(prev, next) ? prev : next))
        })
        .catch(() => {
          if (!cancelled) setSummary(prev => (sameSummary(prev, EMPTY) ? prev : EMPTY))
        })
        .finally(() => {
          inFlight = false
        })
    }

    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cwd])

  return summary
}
