// The state moves of a monitor_mcp task, as pure functions. Each returns the
// same object when nothing changes, which updateTaskState reads as a no-op.

import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'

/** How a producer can end its task; `killed` belongs to kill alone. */
export type MonitorMcpEndStatus = 'completed' | 'failed'

/**
 * The task after its producer ends it, or the same object when it already
 * ended: killed by TaskStop or the dialog, or finished once before. Marking
 * it notified in the same step is what makes the notification go out once.
 */
export function finishedMonitorMcpState(
  task: MonitorMcpTaskState,
  status: MonitorMcpEndStatus,
  now: number,
): MonitorMcpTaskState {
  if (task.status !== 'running' || task.notified) return task
  return { ...task, status, notified: true, endTime: now }
}

/** The task with a new progress line; a finished task keeps its last one. */
export function withMonitorMcpStatusMessage(
  task: MonitorMcpTaskState,
  message: string,
): MonitorMcpTaskState {
  if (task.status !== 'running' || task.statusMessage === message) return task
  return { ...task, statusMessage: message }
}
