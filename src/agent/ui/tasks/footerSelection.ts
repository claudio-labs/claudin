// Shared geometry for the footer's unified selection model.
//
// The footer cursor (AppState.coordinatorTaskIndex) indexes ONE ordered list of
// selectable rows so the agent panel (CoordinatorTaskPanel) and the grouped task
// tree (BackgroundTaskGroupTree) share a single focus model — the same model
// that, via footerSelection==='tasks', takes focus away from the prompt
// TextInput so x/enter act on the selection instead of typing.
//
// Global index layout (top → bottom, matching render order):
//   -1            tasks pill (BackgroundTaskStatus), only while expanded
//    0            the collapsed-summary header (FooterTaskSummary), always
//    1            `● main`, only when at least one agent row exists
//    2 .. A+1     agent rows (A = visible coordinator agents)
//    base .. base+T-1   grouped tree rows (base = getFooterPanelLayout().treeBase)
//
// The whole layout is derived in ONE place, getFooterPanelLayout, so tree rows
// sit immediately after the agents with no gap and no caller re-derives the
// offsets. Collapsed, only the summary row exists and the cursor cannot leave
// index 0.

import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { TaskState } from 'src/agent/tasks/types.js'
import { buildFooterTaskRows, type FooterTaskRow } from 'src/agent/ui/tasks/BackgroundTaskGroupTree.js'
import { getFooterPanelLayout } from 'src/agent/ui/tasks/footerTaskGeometry.js'

/** Resolve a global cursor index to the tree row it points at, or undefined if
 * the cursor is on the pill / summary / main / an agent row (before the tree). */
export function resolveFooterTreeRow(
  tasks: AppState['tasks'],
  foregroundedTaskId: string | undefined,
  collapsedTaskGroups: readonly string[],
  coordinatorTaskIndex: number,
): FooterTaskRow | undefined {
  const base = getFooterPanelLayout(tasks).treeBase
  if (coordinatorTaskIndex < base) return undefined
  const { rows } = buildFooterTaskRows(
    tasks as Record<string, TaskState> | undefined,
    foregroundedTaskId,
    new Set(collapsedTaskGroups),
  )
  return rows[coordinatorTaskIndex - base]
}
