/**
 * Adopting what a shell command left running (`CLAUDIN_ADOPT_LEFTOVERS`,
 * src/shared/proc/processGroup.ts).
 *
 * A command whose shell exits with processes still in its group — a script
 * that backgrounds a server, `cmd &` — hands them over as a background shell
 * task. That task is what the model already knows how to stop with TaskStop,
 * what a sub-agent's exit stops (`killShellTasksForAgent`), and what the
 * session's end stops, as it stops every background task. The result of the
 * command names the processes and the task, so the next step is TaskStop
 * rather than `pgrep`, `ss` and `kill <pid>`.
 *
 * Pure of React, like `killShellTasks.ts`: BashTool and the background task
 * both call it.
 */
import type { SetAppState } from 'src/agent/Task.js'
import { createTaskStateBase, generateTaskId } from 'src/agent/Task.js'
import { registerTask, updateTaskState } from 'src/agent/tasks/framework.js'
import type { LocalShellTaskState } from 'src/agent/tasks/LocalShellTask/guards.js'
import { killTask } from 'src/agent/tasks/LocalShellTask/killShellTasks.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import type { ShellCommand } from 'src/shared/proc/ShellCommand.js'
import {
  findProcessGroup,
  type ProcessGroup,
  type ProcessGroupDeps,
  stopProcessGroup,
} from 'src/shared/proc/processGroup.js'
import type { AgentId } from 'src/shared/types/ids.js'

/** How often an adopted group is checked for having ended on its own. */
const WATCH_INTERVAL_MS = 5_000
/** Members named by command before the rest is counted. */
const NAMED_MEMBERS = 2
/** A command line past this is cut in the note. */
const MAX_COMMAND_CHARS = 80

function shortCommand(command: string): string {
  return command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS - 1)}…` : command
}

/** The line a result carries about the processes it left and the task holding them. */
export function describeLeftovers(group: ProcessGroup, taskId: string): string {
  const named = group.members.slice(0, NAMED_MEMBERS).map(m => `pid ${m.pid} \`${shortCommand(m.command)}\``)
  const rest = group.members.length - named.length
  const who = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ')
  const it = group.members.length === 1 ? 'it' : 'them'
  return `Still running after the command exited: ${who} — adopted as task ${taskId}. TaskStop stops ${it}; the end of the session does too.`
}

type AdoptInput = {
  command: string
  description: string
  toolUseId?: string
  agentId?: AgentId
}

/**
 * Register `group` as a running background shell task and return its id.
 * Stopping the task stops the group (`stopProcessGroup`); a group that ends on
 * its own marks the task completed, without a notification — nothing the
 * model is waiting on finished.
 */
export function adoptLeftovers(
  group: ProcessGroup,
  input: AdoptInput,
  setAppState: SetAppState,
  opts: { deps?: ProcessGroupDeps; pollMs?: number } = {},
): string {
  const taskId = generateTaskId('local_bash')
  const watch = setInterval(() => {
    if (findProcessGroup(group.pgid, opts.deps) !== null) return
    clearInterval(watch)
    updateTaskState<LocalShellTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      task.unregisterCleanup?.()
      return {
        ...task,
        status: 'completed',
        notified: true,
        shellCommand: null,
        unregisterCleanup: undefined,
        endTime: Date.now(),
      }
    })
  }, opts.pollMs ?? WATCH_INTERVAL_MS)
  watch.unref()

  // What killTask drives: kill() stops the group, cleanup() ends the watch.
  const handle = {
    kill: () => {
      stopProcessGroup(group, opts.deps)
    },
    cleanup: () => clearInterval(watch),
  } as unknown as ShellCommand
  const unregisterCleanup = registerCleanup(async () => {
    killTask(taskId, setAppState)
  })

  const task: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', input.description, input.toolUseId),
    type: 'local_bash',
    status: 'running',
    command: input.command,
    completionStatusSentInAttachment: false,
    shellCommand: handle,
    unregisterCleanup,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    agentId: input.agentId,
    adopted: true,
  }
  registerTask(task, setAppState)
  return taskId
}

/** Adopt `group` and return the line the result or notification carries about it. */
export function adoptLeftoversNote(group: ProcessGroup, input: AdoptInput, setAppState: SetAppState): string {
  return describeLeftovers(group, adoptLeftovers(group, input, setAppState))
}
