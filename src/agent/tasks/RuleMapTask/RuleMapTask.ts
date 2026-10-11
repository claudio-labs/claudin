// Background task entry for the navigation-map sync
// (src/memory/instructions/ruleMapScheduler.ts).
//
// A sync takes milliseconds, so this row is not a progress bar: it is the
// notice that the map was written, held on screen for RULE_MAP_DISPLAY_MS
// (holdTerminalTask) and then evicted. It is `running` only for a sync slow
// enough to be worth watching. Pure UI — nothing here calls
// enqueuePendingNotification, so the model never hears of it.

import type { SetAppState, TaskStateBase } from 'src/agent/Task.js'
import { createTaskStateBase, generateTaskId } from 'src/agent/Task.js'
import {
  evictTerminalTask,
  holdTerminalTask,
  registerTask,
  type ScheduleEviction,
  updateTaskState,
} from 'src/agent/tasks/framework.js'
import type {
  RuleMapSyncOutcome,
  RuleMapWriteOutcome,
} from 'src/memory/instructions/ruleMapAutoSync.js'

/** How long a written map stays listed — the footer notifications' default. */
export const RULE_MAP_DISPLAY_MS = 8_000

/** A sync still running after this long is listed running, not just finished. */
const SLOW_SYNC_MS = 300

export type RuleMapTaskState = TaskStateBase & {
  type: 'rule_map'
  /** What the sync wrote; null while it is still running. */
  result: RuleMapWriteOutcome | null
}

/** The two timers a tracked sync arms; parameters so a test need not wait. */
export type RuleMapTaskTimers = {
  /** Arms the "still running" row; returns the disarm. */
  afterSlowSync: (show: () => void) => () => void
  evict: ScheduleEviction
}

const TIMERS: RuleMapTaskTimers = {
  afterSlowSync: show => {
    const timer = setTimeout(show, SLOW_SYNC_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
  evict: (evict, delayMs) => {
    setTimeout(evict, delayMs).unref?.()
  },
}

function newTask(status: 'running' | 'completed'): RuleMapTaskState {
  const id = generateTaskId('rule_map')
  return {
    ...createTaskStateBase(id, 'rule_map', 'Navigation map'),
    type: 'rule_map',
    status,
    // Nothing to spool: the row carries everything it shows.
    outputFile: '',
    result: null,
  }
}

/**
 * Lists a sync in the footer while it matters: running if it outlasts
 * SLOW_SYNC_MS, and finished for RULE_MAP_DISPLAY_MS when it wrote. A sync
 * that wrote nothing leaves no row. Resolves to the sync's own outcome.
 */
export async function trackRuleMapSync(
  setAppState: SetAppState,
  sync: Promise<RuleMapSyncOutcome>,
  timers: RuleMapTaskTimers = TIMERS,
): Promise<RuleMapSyncOutcome> {
  // A holder, not a `let`: the timer callback assigns it, and TS would
  // otherwise keep the variable narrowed to its `null` initializer.
  const slow: { id: string | null } = { id: null }
  const disarm = timers.afterSlowSync(() => {
    const task = newTask('running')
    registerTask(task, setAppState)
    slow.id = task.id
  })
  let outcome: RuleMapSyncOutcome
  try {
    outcome = await sync
  } finally {
    disarm()
  }

  const result = outcome.status === 'skipped' ? null : outcome
  let id = slow.id
  if (id === null) {
    if (result === null) return outcome
    const task = newTask('completed')
    registerTask(task, setAppState)
    id = task.id
  }
  // Eviction requires terminal + notified, and there is no model-facing
  // notification to wait for.
  updateTaskState<RuleMapTaskState>(id, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    result,
  }))
  if (result === null) evictTerminalTask(id, setAppState)
  else holdTerminalTask(id, setAppState, RULE_MAP_DISPLAY_MS, timers.evict)
  return outcome
}
