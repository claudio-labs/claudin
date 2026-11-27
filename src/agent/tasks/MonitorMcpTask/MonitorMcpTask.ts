// MonitorMcpTask — background work an MCP server drives, in two kinds:
//
//   'call'    a tools/call the server turned into a long-running task, polled
//             in the background once it outlives the auto-background timer
//   'events'  an MCP event stream the model watches through the Monitor tool
//
// A shell Monitor is still a LocalShellTask (type 'local_bash', kind
// 'monitor'); this type is only for the MCP-backed ones. Producers create a
// task through registerMonitorMcpTask.ts and talk to it through the handle it
// returns. This module holds the state type and the stop path that TaskStop,
// the background-tasks dialog, agent exit and process exit all go through.
//
// The task has no isBackgrounded flag, so /clear keeps it, and nothing is
// persisted for it, so --resume does not bring it back.

import type { AppState } from 'src/terminal/state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from 'src/agent/Task.js'
import type { AgentId } from 'src/shared/types/ids.js'
import { logForDebugging } from 'src/shared/debug.js'
import { dequeueAllMatching } from 'src/agent/messageQueueManager.js'
import { emitTaskTerminatedSdk } from 'src/agent/sdkEventQueue.js'
import { evictTaskOutput } from 'src/agent/tasks/diskOutput.js'
import { updateTaskState } from 'src/agent/tasks/framework.js'
import { isLocalShellTask } from 'src/agent/tasks/LocalShellTask/guards.js'
import { killTask } from 'src/agent/tasks/LocalShellTask/killShellTasks.js'
import { stopWithin, takeMonitorMcpController } from 'src/agent/tasks/MonitorMcpTask/controllers.js'

export type MonitorMcpKind = 'call' | 'events'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  kind: MonitorMcpKind
  /** The MCP server the work runs on, as configured (the /mcp name). */
  serverName: string
  /** The producer's latest progress line (a task's statusMessage). */
  statusMessage?: string
  agentId?: AgentId
}

/**
 * How long a stop may hold the caller that awaits it — the exit cleanup.
 * Under the shutdown budget, so one silent server cannot eat all of it.
 */
export const MONITOR_MCP_STOP_BUDGET_MS = 1_000

function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'monitor_mcp'
  )
}

/**
 * Kills one task and runs its producer's stop. Resolves once the stop does or
 * its budget runs out: the exit cleanup awaits that, TaskStop does not.
 *
 * No notification: the task is marked notified, as a stopped shell is. The
 * model either asked for the stop (TaskStop answers it) or the user did.
 */
export function stopMonitorMcpTask(taskId: string, setAppState: SetAppState): Promise<void> {
  let killed = undefined as MonitorMcpTaskState | undefined
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    killed = task
    return {
      ...task,
      status: 'killed',
      notified: true,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
  // Taken even when the state was already gone or terminal: whatever still
  // runs behind the id is stopped once, and only once.
  const controller = takeMonitorMcpController(taskId)
  if (killed) {
    // notified:true also silences print.ts's parsed task_notification, so the
    // SDK stream hears the close from here, as stopTask does for a shell.
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId: killed.toolUseId,
      summary: killed.description,
      outputFile: killed.outputFile,
    })
  }
  if (!controller) return Promise.resolve()
  controller.unregisterCleanup()
  return stopWithin(controller.stop, MONITOR_MCP_STOP_BUDGET_MS)
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState) {
    // Not awaited: tasks/cancel is a network round trip, and TaskStop or the
    // dialog's `x` must not wait on a server to report the task stopped.
    void stopMonitorMcpTask(taskId, setAppState)
  },
}

/**
 * Kill one monitor_mcp task by id — the shape `BackgroundTasksDialog` binds its
 * "kill" affordance to (`monitorMcpModule?.killMonitorMcp`). A thin named alias
 * for `MonitorMcpTask.kill` so the dialog does not reach through the registry
 * entry.
 */
export function killMonitorMcp(taskId: string, setAppState: SetAppState): void {
  void MonitorMcpTask.kill(taskId, setAppState)
}

/**
 * Kill all monitor tasks owned by a given agent.
 *
 * MonitorTool spawns tasks as local_bash with kind='monitor'. When an agent
 * exits, killShellTasksForAgent already handles those. This function provides
 * additional cleanup for any monitor_mcp-typed tasks and also kills any
 * local_bash tasks with kind='monitor' that might have been missed (belt and
 * suspenders). Finally, it purges queued notifications for the dead agent.
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}

  for (const [taskId, task] of Object.entries(tasks)) {
    // Kill monitor_mcp tasks for this agent
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing monitor_mcp task ${taskId} (agent ${agentId} exiting)`,
      )
      void MonitorMcpTask.kill(taskId, setAppState)
    }

    // Also kill local_bash tasks with kind='monitor' for this agent
    // (killShellTasksForAgent already does this, but being explicit
    // guards against ordering issues)
    if (
      isLocalShellTask(task) &&
      task.kind === 'monitor' &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing monitor shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }

  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them.
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
