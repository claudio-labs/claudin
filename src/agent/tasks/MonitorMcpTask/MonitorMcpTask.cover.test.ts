// Characterization of the monitor_mcp registry entry as it stands before MCP
// events and long tool calls give it real kinds: what kill does to the state,
// and what agent-scoped cleanup kills and purges.
//
// taskActions.test.ts used to mock.module this file, which Bun applies for the
// whole run; it spies MonitorMcpTask.kill now, so these see the real exports.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { enqueuePendingNotification, getCommandQueue, resetCommandQueue } from 'src/agent/messageQueueManager.js'
import {
  killMonitorMcp,
  killMonitorMcpTasksForAgent,
  MonitorMcpTask,
} from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { AppState } from 'src/terminal/state/AppState.js'

const NOW = 1_700_000_000_000
const AGENT = 'agent-dying' as AgentId
const OTHER = 'agent-living' as AgentId

type Shell = { kill: ReturnType<typeof mock>; cleanup: ReturnType<typeof mock> }

function harness(tasks: Record<string, unknown>) {
  let state = { tasks } as unknown as AppState
  const setAppState = mock((updater: (prev: AppState) => AppState) => {
    state = updater(state)
  })
  return {
    setAppState,
    getAppState: () => state,
    task: (id: string) => (state.tasks as Record<string, Record<string, unknown>>)[id]!,
  }
}

const mcpTask = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'monitor_mcp',
  status: 'running',
  description: `monitor ${id}`,
  startTime: 1,
  notified: false,
  ...over,
})

function shellTask(id: string, over: Record<string, unknown> = {}): Record<string, unknown> & { shellCommand: Shell } {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    kind: 'monitor',
    command: 'tail -f log',
    startTime: 1,
    notified: false,
    shellCommand: { kill: mock(() => {}), cleanup: mock(() => {}) },
    ...over,
  } as Record<string, unknown> & { shellCommand: Shell }
}

let dateNow: ReturnType<typeof spyOn>

beforeEach(() => {
  resetCommandQueue()
  dateNow = spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  dateNow.mockRestore()
  resetCommandQueue()
})

describe('MonitorMcpTask registry entry', () => {
  test('is registered under monitor_mcp', () => {
    expect(MonitorMcpTask.name).toBe('MonitorMcpTask')
    expect(MonitorMcpTask.type).toBe('monitor_mcp')
  })
})

describe('MonitorMcpTask.kill', () => {
  test('a running task becomes killed, notified, with an end time', async () => {
    const h = harness({ m1: mcpTask('m1') })
    await MonitorMcpTask.kill('m1', h.setAppState)
    expect(h.task('m1')).toEqual({ ...mcpTask('m1'), status: 'killed', notified: true, endTime: NOW })
  })

  // notified:true is what keeps the generic exit notice from firing afterwards.
  test('kill itself enqueues no notification', async () => {
    const h = harness({ m1: mcpTask('m1') })
    await MonitorMcpTask.kill('m1', h.setAppState)
    expect(getCommandQueue()).toEqual([])
  })

  for (const status of ['completed', 'failed', 'killed', 'pending']) {
    test(`a ${status} task is left as is, same state object`, async () => {
      const h = harness({ m1: mcpTask('m1', { status }) })
      const before = h.getAppState()
      await MonitorMcpTask.kill('m1', h.setAppState)
      expect(h.getAppState()).toBe(before)
      expect(h.task('m1').status).toBe(status)
      expect(h.task('m1').endTime).toBeUndefined()
    })
  }

  test('an unknown id changes nothing', async () => {
    const h = harness({ m1: mcpTask('m1') })
    const before = h.getAppState()
    await MonitorMcpTask.kill('nope', h.setAppState)
    expect(h.getAppState()).toBe(before)
  })

  test('the other tasks keep their identity', async () => {
    const other = mcpTask('m2')
    const h = harness({ m1: mcpTask('m1'), m2: other })
    await MonitorMcpTask.kill('m1', h.setAppState)
    expect(h.task('m2')).toBe(other)
  })
})

describe('killMonitorMcp', () => {
  test('kills synchronously, through MonitorMcpTask.kill', () => {
    const kill = spyOn(MonitorMcpTask, 'kill')
    try {
      const h = harness({ m1: mcpTask('m1') })
      killMonitorMcp('m1', h.setAppState)
      expect(kill).toHaveBeenCalledWith('m1', h.setAppState)
      expect(h.task('m1')).toMatchObject({ status: 'killed', notified: true, endTime: NOW })
    } finally {
      kill.mockRestore()
    }
  })
})

describe('killMonitorMcpTasksForAgent', () => {
  function world() {
    const tasks = {
      mine: mcpTask('mine', { agentId: AGENT }),
      mineDone: mcpTask('mineDone', { agentId: AGENT, status: 'completed' }),
      theirs: mcpTask('theirs', { agentId: OTHER }),
      mainThread: mcpTask('mainThread'),
      myMonitor: shellTask('myMonitor', { agentId: AGENT }),
      myShell: shellTask('myShell', { agentId: AGENT, kind: 'bash' }),
      myPlainShell: shellTask('myPlainShell', { agentId: AGENT, kind: undefined }),
      myMonitorDone: shellTask('myMonitorDone', { agentId: AGENT, status: 'completed' }),
      theirMonitor: shellTask('theirMonitor', { agentId: OTHER }),
      agent: { id: 'agent', type: 'local_agent', status: 'running', agentId: AGENT, startTime: 1 },
    }
    return { tasks, h: harness(tasks) }
  }

  test("kills the agent's running monitor_mcp tasks and nobody else's", () => {
    const { h } = world()
    killMonitorMcpTasksForAgent(AGENT, h.getAppState, h.setAppState)
    expect(h.task('mine')).toMatchObject({ status: 'killed', notified: true, endTime: NOW })
    expect(h.task('mineDone').status).toBe('completed')
    expect(h.task('theirs').status).toBe('running')
    expect(h.task('mainThread').status).toBe('running')
    expect(h.task('agent').status).toBe('running')
  })

  test("kills the agent's running shell monitors through killTask, not its plain shells", () => {
    const { tasks, h } = world()
    killMonitorMcpTasksForAgent(AGENT, h.getAppState, h.setAppState)

    expect(h.task('myMonitor')).toMatchObject({
      status: 'killed',
      notified: true,
      shellCommand: null,
      endTime: NOW,
    })
    expect(tasks.myMonitor.shellCommand.kill).toHaveBeenCalledTimes(1)
    expect(tasks.myMonitor.shellCommand.cleanup).toHaveBeenCalledTimes(1)

    for (const id of ['myShell', 'myPlainShell', 'theirMonitor'] as const) {
      expect(h.task(id).status).toBe('running')
      expect(tasks[id].shellCommand.kill).not.toHaveBeenCalled()
    }
    expect(h.task('myMonitorDone').status).toBe('completed')
    expect(tasks.myMonitorDone.shellCommand.kill).not.toHaveBeenCalled()
  })

  test('purges the notifications queued for the agent, keeps the rest in order', () => {
    const { h } = world()
    enqueuePendingNotification({ value: 'for the dying agent', mode: 'task-notification', agentId: AGENT })
    enqueuePendingNotification({ value: 'for the main thread', mode: 'task-notification' })
    enqueuePendingNotification({ value: 'for another agent', mode: 'task-notification', agentId: OTHER })
    enqueuePendingNotification({ value: 'dying again', mode: 'task-notification', agentId: AGENT, priority: 'next' })

    killMonitorMcpTasksForAgent(AGENT, h.getAppState, h.setAppState)

    expect(getCommandQueue().map(c => [c.value, c.agentId, c.priority])).toEqual([
      ['for the main thread', undefined, 'later'],
      ['for another agent', OTHER, 'later'],
    ])
  })

  test('purges the queue even when the agent owns no task', () => {
    const h = harness({})
    enqueuePendingNotification({ value: 'stale', mode: 'task-notification', agentId: AGENT })
    killMonitorMcpTasksForAgent(AGENT, h.getAppState, h.setAppState)
    expect(getCommandQueue()).toEqual([])
    expect(h.setAppState).not.toHaveBeenCalled()
  })

  test('tolerates an app state with no tasks map', () => {
    const state = {} as AppState
    const setAppState = mock(() => {})
    expect(() => killMonitorMcpTasksForAgent(AGENT, () => state, setAppState)).not.toThrow()
    expect(setAppState).not.toHaveBeenCalled()
  })

  test('goes through MonitorMcpTask.kill once per matching task', () => {
    const kill = spyOn(MonitorMcpTask, 'kill')
    try {
      const { h } = world()
      killMonitorMcpTasksForAgent(AGENT, h.getAppState, h.setAppState)
      expect(kill.mock.calls.map(c => c[0])).toEqual(['mine'])
    } finally {
      kill.mockRestore()
    }
  })
})
