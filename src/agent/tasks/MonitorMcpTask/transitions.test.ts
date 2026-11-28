import { describe, expect, test } from 'bun:test'

import type { MonitorMcpTaskState } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import { finishedMonitorMcpState, withMonitorMcpStatusMessage } from 'src/agent/tasks/MonitorMcpTask/transitions.js'

function task(over: Partial<MonitorMcpTaskState> = {}): MonitorMcpTaskState {
  return {
    id: 'm1',
    type: 'monitor_mcp',
    kind: 'call',
    serverName: 'srv',
    status: 'running',
    description: 'd',
    startTime: 1,
    outputFile: '/o',
    outputOffset: 0,
    notified: false,
    ...over,
  }
}

describe('finishedMonitorMcpState', () => {
  for (const status of ['completed', 'failed'] as const) {
    test(`a running task becomes ${status}, notified, with an end time`, () => {
      expect(finishedMonitorMcpState(task(), status, 42)).toEqual({ ...task(), status, notified: true, endTime: 42 })
    })
  }

  for (const status of ['killed', 'completed', 'failed', 'pending'] as const) {
    test(`a ${status} task is returned as is`, () => {
      const t = task({ status })
      expect(finishedMonitorMcpState(t, 'completed', 42)).toBe(t)
    })
  }

  test('a running task already notified is not notified twice', () => {
    const t = task({ notified: true })
    expect(finishedMonitorMcpState(t, 'failed', 42)).toBe(t)
  })
})

describe('withMonitorMcpStatusMessage', () => {
  test('sets the progress line on a running task', () => {
    expect(withMonitorMcpStatusMessage(task(), '40%')).toEqual({ ...task(), statusMessage: '40%' })
  })

  test('the same line again is no change', () => {
    const t = task({ statusMessage: '40%' })
    expect(withMonitorMcpStatusMessage(t, '40%')).toBe(t)
  })

  test('a finished task keeps its last line', () => {
    const t = task({ status: 'completed', statusMessage: 'done' })
    expect(withMonitorMcpStatusMessage(t, 'late')).toBe(t)
  })
})
