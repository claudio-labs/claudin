import { describe, expect, test } from 'bun:test'
import { killBackgroundTask } from 'src/agent/ui/tasks/taskActions.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { ContainerInfo } from 'src/containers/types.js'

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
    name: 'legendarr-sonarr-1',
    image: 'sonarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [],
    project: 'legendarr',
    service: 'sonarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

function task(over: Partial<ContainerTaskState> = {}): ContainerTaskState {
  return {
    id: 'cc0ffee',
    type: 'container',
    status: 'running',
    description: 'sonarr',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    container: container(),
    startedByUs: false,
    restartCount: 0,
    lastNotifiedSignature: null,
    diedAt: null,
    ...over,
  }
}

/** Minimal AppState stand-in: only the field the container arm writes. */
function makeState(): {
  setAppState: (updater: (prev: AppState) => AppState) => void
  current: () => AppState
} {
  let state = { pendingContainerStop: null } as unknown as AppState
  return {
    setAppState: updater => {
      state = updater(state)
    },
    current: () => state,
  }
}

describe('killBackgroundTask on a container row', () => {
  test('parks a confirmation instead of stopping the container', () => {
    // The guard this pins: every other arm calls a `kill` that acts
    // immediately. If the container arm ever gains a `ContainerTask.kill` call,
    // `x` silently stops the user's database with no confirmation.
    const { setAppState, current } = makeState()
    killBackgroundTask(task(), setAppState)
    expect(current().pendingContainerStop).toEqual({
      taskId: 'cc0ffee',
      name: 'sonarr-1',
      startedByUs: false,
    })
  })

  test('carries startedByUs through, so the dialog can say which case it is', () => {
    const { setAppState, current } = makeState()
    killBackgroundTask(task({ startedByUs: true }), setAppState)
    expect(current().pendingContainerStop?.startedByUs).toBe(true)
  })

  test('shortens the compose name for the prompt', () => {
    const { setAppState, current } = makeState()
    killBackgroundTask(
      task({ container: container({ name: 'legendarr-legendarr-1' }) }),
      setAppState,
    )
    expect(current().pendingContainerStop?.name).toBe('legendarr-1')
  })

  test('a row that is not running raises nothing', () => {
    const { setAppState, current } = makeState()
    killBackgroundTask(task({ status: 'completed' }), setAppState)
    expect(current().pendingContainerStop).toBeNull()
  })
})
