/**
 * The pure side of an agent task shown in the REPL's main view: handing the
 * view back, and deciding when the task's messages must be sent again.
 */
import type { AppState } from 'src/terminal/state/AppState.js'

/** What the main view was last sent: whose messages, and how many. */
export type MirroredMessages = { taskId: string; count: number }

/** The foreground released: the task (if it still exists) goes to the background. */
export function releaseForeground(state: AppState, taskId: string): AppState {
  const task = state.tasks[taskId]
  if (!task) return { ...state, foregroundedTaskId: undefined }
  return {
    ...state,
    foregroundedTaskId: undefined,
    tasks: { ...state.tasks, [taskId]: { ...task, isBackgrounded: true } },
  }
}

/**
 * Whether the task's messages must go to the main view. A count belongs to
 * the task it was taken from, so another task is always sent; with nothing
 * sent yet, an empty list has nothing to show.
 */
export function shouldMirror(last: MirroredMessages | null, taskId: string, count: number): boolean {
  if (last === null) return count > 0
  return last.taskId !== taskId || last.count !== count
}
