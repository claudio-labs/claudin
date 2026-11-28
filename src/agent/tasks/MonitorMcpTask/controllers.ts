// The live side of each running monitor_mcp task: the stop callback its
// producer handed in (send tasks/cancel, close an event stream) and the exit
// cleanup that calls it. Kept out of AppState on purpose: a callback is not
// state, and AppState is what /clear, the dialogs and the footer copy around.
//
// An entry exists exactly while the task's producer may still write to it —
// finish and kill both take it out — so its presence is also how the handle
// knows to drop output that arrives after the end.

import { logError } from 'src/shared/log.js'

/** What stops the work behind a task. May return a promise (a network call). */
export type MonitorMcpStop = () => void | Promise<void>

export type MonitorMcpController = {
  stop: MonitorMcpStop
  unregisterCleanup: () => void
}

const controllers = new Map<string, MonitorMcpController>()

export function addMonitorMcpController(taskId: string, controller: MonitorMcpController): void {
  controllers.set(taskId, controller)
}

export function hasMonitorMcpController(taskId: string): boolean {
  return controllers.has(taskId)
}

/** Removes and returns the controller, so only one caller ever stops a task. */
export function takeMonitorMcpController(taskId: string): MonitorMcpController | undefined {
  const controller = controllers.get(taskId)
  controllers.delete(taskId)
  return controller
}

/**
 * Runs `stop` and settles when it does or after `budgetMs`, whichever is
 * first; never rejects. The exit cleanup awaits this, and a server that does
 * not answer tasks/cancel must not hold the shutdown past its budget.
 */
export function stopWithin(stop: MonitorMcpStop, budgetMs: number): Promise<void> {
  let result: void | Promise<void>
  try {
    result = stop()
  } catch (e) {
    logError(e)
    return Promise.resolve()
  }
  if (!(result instanceof Promise)) return Promise.resolve()
  const pending = result
  return new Promise(resolve => {
    const timer = setTimeout(resolve, budgetMs)
    timer.unref?.()
    pending.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (e: unknown) => {
        logError(e)
        clearTimeout(timer)
        resolve()
      },
    )
  })
}
