// Pure type + guard for the container row, kept apart from the task module so
// the reconcile reducer and the footer geometry can import it without pulling
// in the docker CLI or React.

import type { TaskStateBase } from 'src/agent/Task.js'
import type { ContainerInfo } from 'src/containers/types.js'

export type ContainerTaskState = TaskStateBase & {
  type: 'container'
  /** Latest snapshot of the container this row stands for. */
  container: ContainerInfo
  /** True when this session's Container tool brought it up. The stop dialog
   * says so, because stopping someone else's database deserves a different
   * sentence than stopping the one we started. */
  startedByUs: boolean
  /** Transitions into `restarting` observed since the row appeared. `docker ps`
   * does not expose docker's own RestartCount, so this is what feeds the
   * crash-loop diagnosis. */
  restartCount: number
  /** Signature last reported to the model, so the attachment producer needs no
   * state of its own. Null until the first report. */
  lastNotifiedSignature: string | null
  /** When the container stopped being live, for the short grace period its row
   * stays visible. Null while it is up. */
  diedAt: number | null
}

export function isContainerTask(task: unknown): task is ContainerTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'container'
  )
}
