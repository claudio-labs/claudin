import { afterEach, describe, expect, test } from 'bun:test'

import type { SetAppState } from 'src/agent/Task.js'
import { drainSdkEvents } from 'src/agent/sdkEventQueue.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { stopTask, StopTaskError } from 'src/agent/tasks/stopTask.js'
import { getIsNonInteractiveSession, setIsInteractive } from 'src/platform/bootstrap/state.js'

type State = { tasks: Record<string, Record<string, unknown>> }

function ctx(tasks: State['tasks']) {
  const state = { current: { tasks } as State }
  const setAppState: SetAppState = f => {
    state.current = f(state.current as unknown as AppState) as unknown as State
  }
  return { state, context: { getAppState: () => state.current as unknown as AppState, setAppState } }
}

const wasInteractive = !getIsNonInteractiveSession()
afterEach(() => {
  setIsInteractive(wasInteractive)
  drainSdkEvents()
})

async function stopError(taskId: string, tasks: State['tasks']): Promise<StopTaskError> {
  try {
    await stopTask(taskId, ctx(tasks).context)
  } catch (e) {
    return e as StopTaskError
  }
  throw new Error('stopTask did not throw')
}

describe('stopTask', () => {
  test('refuses an unknown, a finished and an unsupported task, with a code for each', async () => {
    const missing = await stopError('nope', {})
    expect(missing).toBeInstanceOf(StopTaskError)
    expect(missing.code).toBe('not_found')
    expect(missing.message).toBe('No task found with ID: nope')

    const done = await stopError('b1', { b1: { id: 'b1', type: 'local_bash', status: 'completed' } })
    expect(done.code).toBe('not_running')
    expect(done.message).toBe('Task b1 is not running (status: completed)')

    const odd = await stopError('x', { x: { id: 'x', type: 'no_such_type', status: 'running' } })
    expect(odd.code).toBe('unsupported_type')
    expect(odd.name).toBe('StopTaskError')
  })

  test('kills a running shell task and returns its command', async () => {
    const killed: string[] = []
    const { state, context } = ctx({
      b1: {
        id: 'b1',
        type: 'local_bash',
        status: 'running',
        command: 'npm run dev',
        description: 'dev server',
        notified: false,
        shellCommand: { kill: () => killed.push('kill'), cleanup: () => {} },
      },
    })
    setIsInteractive(false)

    const result = await stopTask('b1', context)

    expect(result).toEqual({ taskId: 'b1', taskType: 'local_bash', command: 'npm run dev' })
    expect(killed).toEqual(['kill'])
    expect(state.current.tasks.b1!.status).toBe('killed')
    expect(state.current.tasks.b1!.notified).toBe(true)
    // The kill already marks the task notified, so the "stopped" SDK event this
    // function would emit for an un-notified shell task does not fire.
    expect(drainSdkEvents()).toEqual([])
  })
})
