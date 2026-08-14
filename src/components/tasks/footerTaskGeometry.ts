// Leaf shared by the agent panel and the footer task tree. Must stay free of
// panel/tree imports so both renderers can import from here without cycling.

import type { AppState } from 'src/state/AppStateStore.js'
import { isPanelAgentTask, type LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'

/** One panel row: the agent plus the tree geometry needed to draw it. */
export type AgentPanelRow = {
  task: LocalAgentTaskState
  /** 0 = spawned from the main thread; 1+ = spawned by another agent. */
  depth: number
  /** Tree connector including ancestor guides, e.g. `│  └─` for the last
   * child of a parent that still has siblings below it. */
  connector: string
}

const CONNECTOR_LAST = '└─'
const CONNECTOR_MID = '├─'
// Ancestor guide columns, 3 wide so they line up with `├─ ` / `└─ `.
const GUIDE_LINE = '│  '
const GUIDE_BLANK = '   '

/** Visible panel agents as rows, depth-first: each agent is followed by the
 * agents IT spawned, indented under it. Mirrors the `evictAfter !== 0` filter
 * — completed agents stay in the panel briefly.
 *
 * The index into this list IS the footer cursor's agent index, so the panel
 * and the enter/x handlers must both take their order from here. */
export function getAgentPanelRows(tasks: AppState['tasks']): AgentPanelRow[] {
  const visible = Object.values(tasks)
    .filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0)
    .sort((a, b) => a.startTime - b.startTime)
  const byId = new Map(visible.map(t => [t.id, t]))
  const childrenOf = new Map<string, LocalAgentTaskState[]>()
  const roots: LocalAgentTaskState[] = []
  for (const task of visible) {
    // Attach only to a parent that is on screen AND started earlier. Both
    // guards matter: a parent that already finished and was evicted would
    // otherwise orphan its children (they belong at the root), and the
    // startTime rule keeps the parent links a strict DAG — so the walk below
    // cannot loop and every visible task lands on exactly one row, which is
    // the invariant the footer cursor's index space depends on.
    const parent = task.parentAgentId ? byId.get(task.parentAgentId) : undefined
    if (!parent || parent.id === task.id || parent.startTime >= task.startTime) {
      roots.push(task)
      continue
    }
    const siblings = childrenOf.get(parent.id)
    if (siblings) siblings.push(task)
    else childrenOf.set(parent.id, [task])
  }
  const rows: AgentPanelRow[] = []
  const walk = (
    task: LocalAgentTaskState,
    depth: number,
    guides: string,
    isLast: boolean,
  ): void => {
    rows.push({ task, depth, connector: guides + (isLast ? CONNECTOR_LAST : CONNECTOR_MID) })
    const children = childrenOf.get(task.id)
    if (!children) return
    const childGuides = guides + (isLast ? GUIDE_BLANK : GUIDE_LINE)
    children.forEach((child, i) =>
      walk(child, depth + 1, childGuides, i === children.length - 1),
    )
  }
  roots.forEach((root, i) => walk(root, 0, '', i === roots.length - 1))
  return rows
}

/** Visible coordinator agent tasks, in panel row order (see
 * getAgentPanelRows). */
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return getAgentPanelRows(tasks).map(row => row.task)
}

/** Panel row count without building the tree — nesting only reorders and
 * indents rows, it never adds or drops one, so this equals
 * `getAgentPanelRows(tasks).length`. Kept cheap because the footer's
 * selection-bounds selector runs on every AppState change. */
export function countVisibleAgentTasks(tasks: AppState['tasks']): number {
  let count = 0
  for (const t of Object.values(tasks)) {
    if (isPanelAgentTask(t) && t.evictAfter !== 0) count++
  }
  return count
}

/** Global cursor offset where the tree rows begin (after optional main + agents).
 * `0` when there are no agents; otherwise `1 + agentCount` (the `1` is the
 * `● main` row). Single source of truth — keep callers using this instead of
 * inlining the formula so the panel/tree partition stays consistent. */
export function footerTreeBaseIndex(tasks: AppState['tasks']): number {
  const a = countVisibleAgentTasks(tasks)
  return a === 0 ? 0 : a + 1
}
