// Pure builder behind FooterTaskSummary — the one-line, icon-per-group digest
// of the footer's background work. Split out of the .tsx so it can be unit
// tested without importing the Ink renderer.

import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { isPanelAgentTask } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  countFinishedAgentTasks,
  countVisibleAgentTasks,
  FOOTER_GROUP_ORDER,
  type FooterGroupKey,
  getFooterGroupCounts,
} from 'src/agent/ui/tasks/footerTaskGeometry.js'

/** Flip the whole footer task area between the one-line summary and the full
 * agent panel + task tree. Shared by Enter (PromptInput's footer:openSelected
 * and footer:down) and the summary line's own click handler. */
export function toggleFooterTasksCollapsed(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => ({
    ...prev,
    footerTasksCollapsed: !prev.footerTasksCollapsed,
  }))
}

export type FooterSummarySegment = {
  key: FooterGroupKey
  /** Items in the group — the same number the expanded header prints. */
  count: number
  /** How many of `count` already finished and are only still on screen
   * because their eviction deadline has not passed. Agents only: every other
   * group is filtered by `isBackgroundTask`, which drops anything that is not
   * running or pending. */
  finished: number
  /** Theme color for the icon when an agent needs attention. */
  tone?: 'error' | 'warning'
}

/**
 * One segment per non-empty group. A group with zero items produces no
 * segment, so the caller renders nothing at all when the result is empty.
 */
export function buildFooterSummarySegments(
  tasks: AppState['tasks'] | undefined,
  foregroundedTaskId: string | undefined,
): FooterSummarySegment[] {
  if (!tasks) return []
  const treeCounts = getFooterGroupCounts(tasks, foregroundedTaskId)
  const agentCount = countVisibleAgentTasks(tasks)
  const segments: FooterSummarySegment[] = []
  // FOOTER_GROUP_ORDER is the expanded view's own top-to-bottom order, so the
  // icons read left-to-right in the same sequence the rows appear once opened.
  for (const key of FOOTER_GROUP_ORDER) {
    if (key === 'agents') {
      if (agentCount === 0) continue
      segments.push({
        key,
        count: agentCount,
        finished: countFinishedAgentTasks(tasks),
        tone: agentAttentionTone(tasks),
      })
      continue
    }
    const count = treeCounts.get(key) ?? 0
    if (count === 0) continue
    segments.push({ key, count, finished: 0 })
  }
  return segments
}

/**
 * Worst attention state among the visible panel agents, so the collapsed line
 * can say "something went wrong in here" without spelling out which agent.
 * A failure outranks a kill; a healthy panel is undefined (default color).
 *
 * There is deliberately no "awaiting approval" tone: LocalAgentTaskState has
 * no approval field — that belongs to in-process teammates, which never reach
 * this panel.
 */
function agentAttentionTone(
  tasks: AppState['tasks'],
): 'error' | 'warning' | undefined {
  let tone: 'error' | 'warning' | undefined
  for (const t of Object.values(tasks)) {
    if (!isPanelAgentTask(t) || t.evictAfter === 0) continue
    if (t.status === 'failed' || (t.error !== undefined && t.error !== '')) {
      return 'error'
    }
    if (t.status === 'killed') tone = 'warning'
  }
  return tone
}

/**
 * `(2)`, or `(2/1)` when part of the group has finished. The suffix is omitted
 * at zero so the common case stays as short as the group header's own `(N)`.
 */
export function formatSegmentCount(segment: FooterSummarySegment): string {
  return segment.finished > 0
    ? `(${segment.count}/${segment.finished})`
    : `(${segment.count})`
}
