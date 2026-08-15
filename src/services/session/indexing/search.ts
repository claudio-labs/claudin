/**
 * Session search by custom title — extracted Wave 4 of the 11c sessionStorage
 * split.
 *
 * Walks the same worktree-aware lite listing as `loadSameRepoMessageLogs`,
 * enriches every result (needs customTitle metadata for matching), then
 * filters + dedupes by sessionId. Byte-walker primitives live in
 * `boundaryScan.ts` (no in-search consumers today, but the file is the
 * permanent home for the indexing-side scan helpers — see boundaryScan.ts
 * docstring).
 */

import type { UUID } from 'crypto'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { LogOption } from 'src/types/logs.js'
import { getWorktreePaths } from 'src/vcs/git/getWorktreePaths.js'
import { getStatOnlyLogsForWorktrees } from 'src/services/session/indexing/crossProject.js'
import {
  enrichLogs,
  getSessionIdFromLog,
} from 'src/services/session/indexing/liteMetadata.js'

/**
 * Searches for sessions by custom title match.
 * Returns matches sorted by recency (newest first).
 * Uses case-insensitive matching for better UX.
 * Deduplicates by sessionId (keeps most recent per session).
 * Searches across same-repo worktrees by default.
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  // Use worktree-aware loading to search across same-repo sessions
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // Enrich all logs to access customTitle metadata
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // Deduplicate by sessionId - multiple logs can have the same sessionId
  // if they're different branches of the same conversation. Keep most recent.
  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  // Sort by recency
  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  // Apply limit if specified
  if (limit) {
    return deduplicated.slice(0, limit)
  }

  return deduplicated
}
