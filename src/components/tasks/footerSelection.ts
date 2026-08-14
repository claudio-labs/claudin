// Shared geometry for the footer's unified selection model.
//
// The footer cursor (AppState.coordinatorTaskIndex) indexes ONE ordered list of
// selectable rows so the agent panel (CoordinatorTaskPanel) and the grouped task
// tree (BackgroundTaskGroupTree) share a single focus model — the same model
// that, via footerSelection==='tasks', takes focus away from the prompt
// TextInput so x/enter act on the selection instead of typing.
//
// Global index layout (top → bottom, matching render order):
//   -1            tasks pill (BackgroundTaskStatus), only when bg-task pill exists
//    0            `● main`, only when at least one agent row exists
//    1 .. A       agent rows (A = visible coordinator agents)
//    base .. base+T-1   grouped tree rows (base = footerTreeBaseIndex)
//
// base === the agent partition size (A===0 ? 0 : A+1), which is also the value
// useCoordinatorTaskCount returns for the agent portion — so tree rows sit
// immediately after agents with no gap.

import type { AppState } from 'src/state/AppStateStore.js'
import { isBackgroundTask, type TaskState } from 'src/tasks/types.js'
import { buildFooterTaskRows, type FooterTaskRow } from './BackgroundTaskGroupTree.js'
import { footerTreeBaseIndex } from './footerTaskGeometry.js'

/**
 * Cheap row-count for useCoordinatorTaskCount: counts headers + visible items
 * per group without allocating the full row list. Mirrors buildFooterTaskRows'
 * partition and collapse logic so the count stays exact even at 1s render tick
 * with many tasks — building+discarding the row list every render was the
 * hot-path identified by the perf review.
 */
export function countFooterTaskRows(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
  collapsedTaskGroups: readonly string[],
): number {
  if (!tasks) return 0
  const collapsed = new Set(collapsedTaskGroups)
  // Same filter as buildFooterTaskRows: non-teammate background tasks excluding
  // the foregrounded one. Inlined to skip the intermediate array+sort.
  const groupCounts = new Map<string, number>()
  for (const t of Object.values(tasks)) {
    if (!isBackgroundTask(t)) continue
    if (t.type === 'in_process_teammate') continue
    if (t.id === foregroundedTaskId) continue
    const key = matchGroupKey(t)
    if (!key) continue
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1)
  }
  let total = 0
  for (const [key, n] of groupCounts) {
    total += 1 // header
    if (!collapsed.has(key)) total += n
  }
  return total
}

// Local copy of the group-match logic. Kept here (not exported from the tree
// module) so changing GROUP_ORDER doesn't silently desync the row count.
function matchGroupKey(t: TaskState): string | undefined {
  switch (t.type) {
    case 'local_bash':
      return t.kind === 'monitor' ? 'monitors' : 'shells'
    case 'monitor_mcp':
      return 'monitors'
    case 'remote_agent':
      return 'remote'
    case 'local_workflow':
      return 'workflows'
    case 'dream':
      return 'dreams'
    default:
      return undefined
  }
}

/** Resolve a global cursor index to the tree row it points at, or undefined if
 * the cursor is on the pill / main / an agent row (i.e. before the tree). */
export function resolveFooterTreeRow(
  tasks: AppState['tasks'],
  foregroundedTaskId: string | undefined,
  collapsedTaskGroups: readonly string[],
  coordinatorTaskIndex: number,
): FooterTaskRow | undefined {
  const base = footerTreeBaseIndex(tasks)
  if (coordinatorTaskIndex < base) return undefined
  const { rows } = buildFooterTaskRows(
    tasks as Record<string, TaskState> | undefined,
    foregroundedTaskId,
    new Set(collapsedTaskGroups),
  )
  return rows[coordinatorTaskIndex - base]
}
