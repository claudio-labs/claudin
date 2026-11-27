// Creates a monitor_mcp task and hands its producer the only way to drive it.
//
// The producer (a backgrounded MCP task poll, an MCP event stream) owns the
// work; this owns everything the rest of the app sees: the AppState row, the
// output file, the one notification at the end, and the stop at process exit.

import { createTaskStateBase, generateTaskId, type SetAppState } from 'src/agent/Task.js'
import { enqueuePendingNotification } from 'src/agent/messageQueueManager.js'
import { appendTaskOutput, evictTaskOutput, initTaskOutput } from 'src/agent/tasks/diskOutput.js'
import { registerTask, updateTaskState } from 'src/agent/tasks/framework.js'
import {
  addMonitorMcpController,
  hasMonitorMcpController,
  type MonitorMcpStop,
  takeMonitorMcpController,
} from 'src/agent/tasks/MonitorMcpTask/controllers.js'
import {
  type MonitorMcpKind,
  type MonitorMcpTaskState,
  stopMonitorMcpTask,
} from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  formatMonitorMcpNotification,
  type MonitorMcpResult,
  monitorMcpNotificationPriority,
} from 'src/agent/tasks/MonitorMcpTask/notification.js'
import { finishedMonitorMcpState, withMonitorMcpStatusMessage } from 'src/agent/tasks/MonitorMcpTask/transitions.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logError } from 'src/shared/log.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import { abortSpeculation } from 'src/terminal/prompt-suggestion/speculation.js'

export type RegisterMonitorMcpTaskInput = {
  kind: MonitorMcpKind
  serverName: string
  description: string
  agentId?: AgentId
  toolUseId?: string
  /**
   * Stops the work behind the task: TaskStop, the dialog's `x`, the owning
   * agent's exit and process exit all call it, once. A returned promise is
   * awaited only by process exit, and only for MONITOR_MCP_STOP_BUDGET_MS.
   */
  onStop: MonitorMcpStop
  setAppState: SetAppState
}

export type MonitorMcpTaskHandle = {
  taskId: string
  outputFile: string
  /** Appends to the output file; dropped once the task has ended. */
  appendOutput(text: string): void
  /** The progress line the footer and the detail view show. */
  setStatus(message: string): void
  /**
   * Ends the task and tells the model, once. A no-op after a kill or an
   * earlier finish. Resolves after the output is on disk and the
   * notification is queued, so the file the notification names is complete.
   */
  finish(result: MonitorMcpResult): Promise<void>
}

/** The I/O a task does, injectable so the handle is testable without disk or a queue. */
export type MonitorMcpTaskDeps = {
  initOutput: (taskId: string) => Promise<unknown>
  appendOutput: (taskId: string, text: string) => void
  flushOutput: (taskId: string) => Promise<void>
  enqueue: (command: QueuedCommand) => void
  registerCleanup: (cleanup: () => Promise<void>) => () => void
}

const defaultDeps: MonitorMcpTaskDeps = {
  initOutput: initTaskOutput,
  appendOutput: appendTaskOutput,
  flushOutput: evictTaskOutput,
  enqueue: enqueuePendingNotification,
  registerCleanup,
}

export function registerMonitorMcpTask(
  input: RegisterMonitorMcpTaskInput,
  deps: MonitorMcpTaskDeps = defaultDeps,
): MonitorMcpTaskHandle {
  const { kind, serverName, description, agentId, toolUseId, onStop, setAppState } = input
  const taskId = generateTaskId('monitor_mcp')

  // Created before the row exists, so a reader never finds the path missing;
  // output arrives through appendTaskOutput, not a TaskOutput.
  deps.initOutput(taskId).catch((e: unknown) => logError(e))

  const unregisterCleanup = deps.registerCleanup(() => stopMonitorMcpTask(taskId, setAppState))
  addMonitorMcpController(taskId, { stop: onStop, unregisterCleanup })

  const task: MonitorMcpTaskState = {
    ...createTaskStateBase(taskId, 'monitor_mcp', description, toolUseId),
    type: 'monitor_mcp',
    status: 'running',
    kind,
    serverName,
    agentId,
  }
  registerTask(task, setAppState)

  return {
    taskId,
    outputFile: task.outputFile,
    appendOutput(text) {
      if (!hasMonitorMcpController(taskId)) return
      deps.appendOutput(taskId, text)
    },
    setStatus(message) {
      if (!hasMonitorMcpController(taskId)) return
      updateTaskState<MonitorMcpTaskState>(taskId, setAppState, t => withMonitorMcpStatusMessage(t, message))
    },
    async finish(result) {
      // The producer is done either way, so its exit cleanup goes now —
      // even when a kill got here first and there is nothing to tell.
      takeMonitorMcpController(taskId)?.unregisterCleanup()
      let ended = undefined as MonitorMcpTaskState | undefined
      updateTaskState<MonitorMcpTaskState>(taskId, setAppState, t => {
        const next = finishedMonitorMcpState(t, result.status, Date.now())
        if (next !== t) ended = next
        return next
      })
      if (!ended) return
      // Background state changed, so a speculated reply may rest on stale
      // output; the shell notification does the same.
      abortSpeculation(setAppState)
      await deps.flushOutput(taskId)
      deps.enqueue({
        value: formatMonitorMcpNotification(ended, result),
        mode: 'task-notification',
        priority: monitorMcpNotificationPriority(kind),
        agentId,
      })
    },
  }
}
