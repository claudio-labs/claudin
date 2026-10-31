// Union of all concrete task state types
// Use this for components that need to work with any task type

import { isTerminalTaskStatus } from 'src/agent/Task.js'
import type { DreamTaskState } from 'src/agent/tasks/DreamTask/DreamTask.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { InProcessTeammateTaskState } from 'src/agent/tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from 'src/agent/tasks/LocalShellTask/guards.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import type { McpServerTaskState } from 'src/agent/tasks/McpServerTask/types.js'
import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { RemoteAgentTaskState } from 'src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { RuleMapTaskState } from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
  | ContainerTaskState
  | McpServerTaskState
  | RuleMapTaskState

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
  | McpServerTaskState
  | RuleMapTaskState

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
 * Whether a task is work still in flight, for the lines that say so: the
 * turn-end "· N background tasks still running" and brief mode's "N in
 * background". An MCP server (#201) or a container (#145) row stays `running`
 * for as long as the footer panel lists it, so `isBackgroundTask` accepts it;
 * counted here, two MCP servers read as "2 background tasks still running"
 * after every turn.
 */
export function isBackgroundWork(task: TaskState): task is BackgroundTaskState {
  return isBackgroundTask(task) && task.type !== 'mcp_server' && task.type !== 'container'
}

/**
 * Whether `-p` waits for this task before it exits (`turnLoop.ts`): every
 * background task, except the two that run until something stops them. A
 * teammate lives as long as its team (gh-30008), and an adopted leftover
 * (`LocalShellTask/leftovers.ts`) is a server nobody asked to wait for. Both
 * are stopped by the exit itself, so waiting on them never ends.
 */
export function holdsHeadlessExit(task: TaskState): boolean {
  if (!isBackgroundTask(task)) return false
  if (task.type === 'in_process_teammate') return false
  return !(task.type === 'local_bash' && task.adopted === true)
}

/**
 * Whether the footer and the background-tasks dialog list a task: every
 * background task, plus a finished one held on screen (`displayUntil`, set by
 * holdTerminalTask — whose timer, not this check, decides when it leaves).
 *
 * Separate from `isBackgroundTask` on purpose. That one also answers "is
 * there still work in flight" — the headless turn loop waits on it, and the
 * running-task pill, the running counts and the kill hints read it — so a
 * finished task must keep answering no there even while it is still listed.
 */
export function isListedBackgroundTask(task: TaskState): task is BackgroundTaskState {
  // Terminal first: the two unions are the same set, so a failed
  // isBackgroundTask guard would narrow `task` to never.
  if (isTerminalTaskStatus(task.status)) {
    return task.displayUntil !== undefined
  }
  return isBackgroundTask(task)
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
