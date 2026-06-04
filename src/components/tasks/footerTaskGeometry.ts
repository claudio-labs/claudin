// Leaf shared by the agent panel and the footer task tree. Must stay free of
// panel/tree imports so both renderers can import from here without cycling.

import type { AppState } from '../../state/AppStateStore.js'
import { isPanelAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

/** Visible coordinator agent rows for the panel, in startTime order. Mirrors
 * `evictAfter !== 0` filter — completed agents stay in the panel briefly. */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0)
    .sort((a, b) => a.startTime - b.startTime)
}

/** Global cursor offset where the tree rows begin (after optional main + agents).
 * `0` when there are no agents; otherwise `1 + agentCount` (the `1` is the
 * `● main` row). Single source of truth — keep callers using this instead of
 * inlining the formula so the panel/tree partition stays consistent. */
export function footerTreeBaseIndex(tasks: AppState['tasks']): number {
  const a = getVisibleAgentTasks(tasks).length
  return a === 0 ? 0 : a + 1
}
