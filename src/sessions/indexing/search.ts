/**
 * Finding sessions by title, across every worktree of the current repository.
 *
 * A thin filter: the worktree listing (`crossProject.ts`) gives one stat-only
 * record per session id, and enrichment supplies the title, so hidden
 * sessions never match and an AI title counts as a title.
 */

import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { getWorktreePaths } from 'src/vcs/git/getWorktreePaths.js'
import { getStatOnlyLogsForWorktrees } from 'src/sessions/indexing/crossProject.js'
import { enrichLogs } from 'src/sessions/indexing/liteMetadata.js'

function normalized(text: string): string {
  return text.toLowerCase().trim()
}

function titleMatches(title: string | undefined, query: string, exact: boolean): boolean {
  if (!title) return false
  const candidate = normalized(title)
  return exact ? candidate === query : candidate.includes(query)
}

export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const listed = await getStatOnlyLogsForWorktrees(await getWorktreePaths(getOriginalCwd()))
  const { logs } = await enrichLogs(listed, 0, listed.length)
  const wanted = normalized(query)
  const exact = options?.exact ?? false
  // The listing comes sorted newest first, and filtering keeps its order.
  const found = logs.filter(log => titleMatches(log.customTitle, wanted, exact))
  return options?.limit ? found.slice(0, options.limit) : found
}
