// ContainerTask — the AppState side of the container panel.
//
// Unlike every other task type, nothing here spawns a process. Rows are
// synthesised from what docker reports, so a stack the user brought up in
// another terminal shows up exactly like one the Container tool started. The
// decision of what changed lives in the pure reducer next door
// (`reconcile.ts`); this module only applies its patch and owns `kill`.

import type { AppState } from 'src/terminal/state/AppState.js'
import type { SetAppState, Task } from 'src/agent/Task.js'
import type { ContainerInfo } from 'src/containers/types.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import { isContainerTask } from 'src/agent/tasks/ContainerTask/types.js'
import { reconcileContainers } from 'src/agent/tasks/ContainerTask/reconcile.js'
import { registerTask, updateTaskState } from 'src/agent/tasks/framework.js'
import { runDocker } from 'src/containers/docker/dockerCli.js'
import { logError } from 'src/shared/log.js'

/** `docker stop` gives the container this long to exit before SIGKILL. */
const STOP_TIMEOUT_S = 10

/**
 * Apply a fresh snapshot to AppState. Returns the number of rows that changed,
 * so the caller can skip a re-render when nothing did.
 */
export function applyContainerSnapshot(
  getAppState: () => AppState,
  setAppState: SetAppState,
  snapshot: readonly ContainerInfo[],
  startedByUs: ReadonlySet<string>,
  now: number = Date.now(),
): number {
  const patch = reconcileContainers(
    getAppState().tasks ?? {},
    snapshot,
    now,
    startedByUs,
  )
  const changed =
    patch.register.length + patch.update.length + patch.remove.length
  if (changed === 0) return 0

  for (const task of patch.register) registerTask(task, setAppState)
  for (const task of patch.update) {
    updateTaskState<ContainerTaskState>(task.id, setAppState, () => task)
  }
  if (patch.remove.length > 0) {
    const removed = new Set(patch.remove)
    setAppState(prev => {
      const next: AppState['tasks'] = {}
      let dropped = false
      for (const [id, task] of Object.entries(prev.tasks ?? {})) {
        if (removed.has(id) && isContainerTask(task)) {
          dropped = true
          continue
        }
        next[id] = task
      }
      return dropped ? { ...prev, tasks: next } : prev
    })
  }
  return changed
}

/**
 * Stop the container behind a row.
 *
 * Reached from the footer's `x` key ONLY after the confirmation dialog — unlike
 * the other task types, where `x` kills a process we own, this can be the
 * user's database. The row is not removed here: the next snapshot reports the
 * container as exited and the reducer handles it, so the UI never claims a stop
 * that docker refused.
 */
async function kill(taskId: string, setAppState: SetAppState): Promise<void> {
  let containerId: string | null = null
  updateTaskState<ContainerTaskState>(taskId, setAppState, task => {
    containerId = task.container.id
    return task
  })
  if (containerId === null) return
  const result = await runDocker(
    ['stop', '--timeout', String(STOP_TIMEOUT_S), containerId],
    { timeout: (STOP_TIMEOUT_S + 5) * 1000 },
  )
  if (result.code !== 0) {
    logError(
      new Error(
        `docker stop failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      ),
    )
  }
}

export const ContainerTask: Task = {
  name: 'Container',
  type: 'container',
  kill,
}
