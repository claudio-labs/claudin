/**
 * Display order for the TodoV2 task list.
 *
 * WHY THIS EXISTS: `TaskListV2` had two different orders. When the list fit on
 * screen it sorted by id alone, so a task stayed exactly where it started no
 * matter how much of it was done — a plan seeded 1..8 kept its finished items
 * scattered among the open ones. Only the truncated path grouped by status, and
 * only because it had to decide what to drop. Since `maxDisplay` is
 * `min(10, max(3, rows - 14))`, a normal plan on a normal terminal never
 * reached the path that ordered properly.
 *
 * Finished work sinks: `in_progress`, then `pending`, then `completed`. Within
 * `pending`, tasks whose blockers are still open go last — they are the least
 * actionable thing on the list.
 *
 * This is only the *display* order. Which tasks survive truncation is a
 * separate decision that still belongs to `TaskListV2`, which keeps a 30s
 * window where a just-completed task is guaranteed a slot so you can see it
 * land. Both paths run their result through here, so crossing the truncation
 * threshold no longer reshuffles the list under the reader.
 *
 * Lives in a plain `.ts` beside `footerTaskGeometry.ts` and `taskActions.ts`
 * because ink is stubbed under `bun test` — ordering rules that live inside the
 * `.tsx` cannot be tested.
 */

import type { Task } from 'src/tasks/tasks.js'

/** Numeric where possible so #10 sorts after #9, lexicographic otherwise. */
function byIdAsc(a: Task, b: Task): number {
  const aNum = parseInt(a.id, 10)
  const bNum = parseInt(b.id, 10)
  if (!isNaN(aNum) && !isNaN(bNum)) {
    return aNum - bNum
  }
  return a.id.localeCompare(b.id)
}

/**
 * Group by status — in progress, then open, then done — sorting by id inside
 * each group. Blocked pending tasks sort after unblocked ones; a task counts as
 * blocked only while a blocker is still unresolved within `tasks`.
 */
export function orderTasksForDisplay(tasks: Task[]): Task[] {
  const unresolvedIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  const isBlocked = (t: Task): boolean =>
    t.blockedBy.some(id => unresolvedIds.has(id))

  const inProgress = tasks
    .filter(t => t.status === 'in_progress')
    .sort(byIdAsc)
  const pending = tasks
    .filter(t => t.status === 'pending')
    .sort((a, b) => {
      const aBlocked = isBlocked(a)
      const bBlocked = isBlocked(b)
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1
      return byIdAsc(a, b)
    })
  const completed = tasks.filter(t => t.status === 'completed').sort(byIdAsc)

  return [...inProgress, ...pending, ...completed]
}
