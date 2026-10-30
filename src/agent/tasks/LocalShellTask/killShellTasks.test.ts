import { afterEach, describe, expect, test } from 'bun:test'

import { enqueue, getCommandQueue, resetCommandQueue } from 'src/agent/messageQueueManager.js'
import { killShellTasksForAgent, killTask } from 'src/agent/tasks/LocalShellTask/killShellTasks.js'

type Tasks = Record<string, Record<string, unknown>>
type State = { tasks: Tasks }

function store(tasks: Tasks) {
  const state = { current: { tasks } as State }
  return {
    state,
    getAppState: () => state.current as never,
    setAppState: (f: (prev: never) => never) => {
      state.current = f(state.current as never) as State
    },
  }
}

function shellTask(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const task = {
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    command: 'sleep 100',
    notified: false,
    shellCommand: {
      kill: () => calls.push('kill'),
      cleanup: () => calls.push('cleanup'),
    },
    unregisterCleanup: () => calls.push('unregister'),
    ...over,
  }
  return { task, calls }
}

afterEach(() => resetCommandQueue())

describe('killTask', () => {
  test('kills a running shell task, unregisters its cleanup and marks it killed and notified', () => {
    const timer = setTimeout(() => {}, 60_000)
    const { task, calls } = shellTask({ cleanupTimeoutId: timer })
    const s = store({ b1: task })
    killTask('b1', s.setAppState)
    expect(calls).toEqual(['kill', 'cleanup', 'unregister'])
    const after = s.state.current.tasks.b1!
    expect(after.status).toBe('killed')
    expect(after.notified).toBe(true)
    expect(after.shellCommand).toBeNull()
    expect(after.unregisterCleanup).toBeUndefined()
    expect(after.cleanupTimeoutId).toBeUndefined()
    expect(after.endTime).toBeNumber()
    clearTimeout(timer)
  })

  test('a task that is not running, or not a shell, is left alone', () => {
    const done = shellTask({ status: 'completed' })
    const agent = { id: 'a1', type: 'local_agent', status: 'running' }
    const s = store({ b1: done.task, a1: agent })
    const before = s.state.current
    killTask('b1', s.setAppState)
    killTask('a1', s.setAppState)
    killTask('missing', s.setAppState)
    expect(s.state.current).toBe(before)
    expect(done.calls).toEqual([])
  })

  test('a kill that throws still marks the task killed', () => {
    const { task } = shellTask({
      shellCommand: {
        kill: () => {
          throw new Error('kill failed')
        },
        cleanup: () => {},
      },
    })
    const s = store({ b1: task })
    killTask('b1', s.setAppState)
    expect(s.state.current.tasks.b1!.status).toBe('killed')
  })
})

describe('killShellTasksForAgent', () => {
  test("kills only that agent's running shell tasks and drops its queued notifications", () => {
    const mine = shellTask({ id: 'm', agentId: 'agent-a' })
    const finished = shellTask({ id: 'f', agentId: 'agent-a', status: 'completed' })
    const theirs = shellTask({ id: 't', agentId: 'agent-b' })
    const main = shellTask({ id: 'n' })
    const s = store({ m: mine.task, f: finished.task, t: theirs.task, n: main.task })
    enqueue({ value: 'for a', mode: 'task-notification', agentId: 'agent-a' } as never)
    enqueue({ value: 'for b', mode: 'task-notification', agentId: 'agent-b' } as never)

    killShellTasksForAgent('agent-a' as never, s.getAppState, s.setAppState)

    expect(s.state.current.tasks.m!.status).toBe('killed')
    expect(s.state.current.tasks.f!.status).toBe('completed')
    expect(s.state.current.tasks.t!.status).toBe('running')
    expect(s.state.current.tasks.n!.status).toBe('running')
    expect(getCommandQueue().map(c => c.value)).toEqual(['for b'])
  })

  test('an empty task map is fine', () => {
    const s = store(undefined as never)
    expect(() => killShellTasksForAgent('agent-a' as never, s.getAppState, s.setAppState)).not.toThrow()
  })
})
