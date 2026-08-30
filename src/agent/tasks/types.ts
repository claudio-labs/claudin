// Union of all concrete task state types
// Use this for components that need to work with any task type

import type { DreamTaskState } from 'src/agent/tasks/DreamTask/DreamTask.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { InProcessTeammateTaskState } from 'src/agent/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/agent/tasks/LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { RemoteAgentTaskState } from 'src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js'

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
  | ContainerTaskState

// Task types that can appear in the background tasks indicator
export type BackgroundTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
  | ContainerTaskState

/**
 * Check if a task should be shown in the background tasks indicator.
 * A task is considered a background task if:
 * 1. It is running or pending
 * 2. It has been explicitly backgrounded (not a foreground task)
 */
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') {
    return false
  }
  // Foreground tasks (isBackgrounded === false) are not yet "background tasks"
  if ('isBackgrounded' in task && task.isBackgrounded === false) {
    return false
  }
  return true
}

/**
 * Whether a task spools its output to disk.
 *
 * `generateTaskAttachments` reads a delta for every running task on every turn;
 * a container row has no spool (its logs are fetched on demand), so without
 * this it would pay one disk read per container per turn for nothing. A
 * capability predicate rather than a `type === 'container'` check, so the next
 * spool-less task type is covered by construction.
 */
export function taskSpoolsOutput(task: TaskState): boolean {
  return task.outputFile !== ''
}
