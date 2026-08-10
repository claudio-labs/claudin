import { useEffect, useState } from 'react'
import { getTotalLinesAdded, getTotalLinesRemoved } from '../cost-tracker.js'

/** Same cadence as the other footer indicators (cwd/branch, tokens). */
const POLL_INTERVAL_MS = 1000

export interface SessionDiffStat {
  added: number
  removed: number
}

function readSnapshot(): SessionDiffStat {
  return { added: getTotalLinesAdded(), removed: getTotalLinesRemoved() }
}

/**
 * Session-wide lines added/removed, as accumulated by `countLinesChanged` on
 * every Edit/Write/apply_patch. These are in-memory counters with no event
 * API, so they are polled — but the read is two property lookups, so there is
 * no git subprocess or filesystem work behind this hook.
 *
 * Returns the previous object identity when nothing changed, so a footer that
 * renders it doesn't re-render once a second.
 */
export function useSessionDiffStat(): SessionDiffStat {
  const [stat, setStat] = useState<SessionDiffStat>(readSnapshot)

  useEffect(() => {
    const interval = setInterval(() => {
      setStat(prev => {
        const next = readSnapshot()
        return prev.added === next.added && prev.removed === next.removed ? prev : next
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  return stat
}
