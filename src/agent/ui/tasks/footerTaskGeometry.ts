// Leaf shared by the agent panel and the footer task tree. Must stay free of
// panel/tree imports so both renderers can import from here without cycling.

import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { isPanelAgentTask, type LocalAgentTaskState } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask, type TaskState } from 'src/agent/tasks/types.js'
import { isTerminalStatus } from 'src/agent/ui/tasks/taskStatusUtils.js'

/** The groups the footer partitions background work into, top to bottom.
 * `agents` is the panel's own group; the rest are the tree's GROUP_ORDER. */
export type FooterGroupKey =
  | 'agents'
  | 'shells'
  | 'monitors'
  | 'remote'
  | 'workflows'
  | 'dreams'

/** Render order, top to bottom — and, because the footer cursor walks the rows
 * in render order, the navigation order too. The tree
 * (BackgroundTaskGroupTree, which skips `agents`) and the collapsed summary
 * both iterate this, so a new group is declared in ONE place. */
export const FOOTER_GROUP_ORDER: readonly FooterGroupKey[] = [
  'agents',
  'shells',
  'monitors',
  'remote',
  'workflows',
  'dreams',
]

/** The word for each group. Shared so the tree's `Shells (2)` header and the
 * collapsed summary's Nerd-Font-free fallback cannot drift apart. */
export const FOOTER_GROUP_LABELS: Record<FooterGroupKey, string> = {
  agents: 'Agents',
  shells: 'Shells',
  monitors: 'Monitors',
  remote: 'Remote',
  workflows: 'Workflows',
  dreams: 'Dreams',
}

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

/** Panel agents that already reached a terminal status and are only still on
 * screen: either their eviction deadline has not passed yet, or the UI is
 * holding them (`retain`, which clears `evictAfter` entirely). Always a subset
 * of `countVisibleAgentTasks`, which is why the summary prints it as `(N/M)`. */
export function countFinishedAgentTasks(tasks: AppState['tasks']): number {
  let count = 0
  for (const t of Object.values(tasks)) {
    if (isPanelAgentTask(t) && t.evictAfter !== 0 && isTerminalStatus(t.status)) count++
  }
  return count
}

/** Tree group a background task belongs to, or undefined when the footer shows
 * it somewhere else: `local_agent` renders in the panel and
 * `in_process_teammate` in the spinner tree. THE partition: the tree's row
 * builder, the row count and the collapsed summary all call this, so a new
 * task type is classified once and cannot desync one surface from another. */
export function matchGroupKey(t: TaskState): FooterGroupKey | undefined {
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

/** Per-group item counts for the tree portion, keyed by group. Mirrors
 * buildFooterTaskRows' filter: non-teammate background tasks excluding the
 * foregrounded one (which the main UI is already showing). */
export function getFooterGroupCounts(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
): Map<FooterGroupKey, number> {
  const counts = new Map<FooterGroupKey, number>()
  if (!tasks) return counts
  for (const t of Object.values(tasks)) {
    if (!isBackgroundTask(t)) continue
    if (t.type === 'in_process_teammate') continue
    if (t.id === foregroundedTaskId) continue
    const key = matchGroupKey(t)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Cheap row-count for the footer's selection bounds: headers + visible items
 * per group, without allocating the row list. Shares `getFooterGroupCounts`
 * with the tree so the count cannot drift from what is painted — building and
 * discarding the row list every render was the hot path the perf review found.
 */
export function countFooterTaskRows(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
  collapsedTaskGroups: readonly string[],
): number {
  const collapsed = new Set(collapsedTaskGroups)
  let total = 0
  for (const [key, n] of getFooterGroupCounts(tasks, foregroundedTaskId)) {
    total += 1 // header
    if (!collapsed.has(key)) total += n
  }
  return total
}

/** Cursor geometry of the footer's panel portion. Single source of truth —
 * keep callers reading these fields instead of inlining the offsets, so the
 * summary/main/agents/tree partition stays consistent.
 *
 * Index layout (top → bottom, matching render order):
 *   -1                    tasks pill, only while expanded
 *    0                    the collapsed-summary header row (always present)
 *    mainIndex            `● main`, only when at least one agent row exists
 *    agentStart ..        agent rows
 *    treeBase ..          grouped tree rows
 */
export type FooterPanelLayout = {
  /** The summary header. It renders whenever the footer task area renders at
   * all, so it is the one row the cursor can always reach. */
  summaryIndex: number
  /** `● main`, or -1 when there are no agents. */
  mainIndex: number
  /** First agent row, or -1 when there are none. `agentCount` rows follow. */
  agentStart: number
  agentCount: number
  /** Where the grouped tree rows begin. */
  treeBase: number
}

export function getFooterPanelLayout(tasks: AppState['tasks']): FooterPanelLayout {
  const agentCount = countVisibleAgentTasks(tasks)
  const hasAgents = agentCount > 0
  return {
    summaryIndex: 0,
    mainIndex: hasAgents ? 1 : -1,
    agentStart: hasAgents ? 2 : -1,
    agentCount,
    treeBase: hasAgents ? agentCount + 2 : 1,
  }
}
