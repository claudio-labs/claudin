// The handle a producer drives a monitor_mcp task with, end to end against a
// real store updater: register, progress, the one notification, and every way
// the task can be stopped from outside (TaskStop/dialog, agent exit, process
// exit). Disk, queue and cleanup registry are injected.

import { describe, expect, mock, test } from 'bun:test'

import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { hasMonitorMcpController } from 'src/agent/tasks/MonitorMcpTask/controllers.js'
import {
  killMonitorMcp,
  killMonitorMcpTasksForAgent,
  MonitorMcpTask,
  stopMonitorMcpTask,
} from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js'
import {
  type MonitorMcpTaskDeps,
  type RegisterMonitorMcpTaskInput,
  registerMonitorMcpTask,
} from 'src/agent/tasks/MonitorMcpTask/registerMonitorMcpTask.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import type { AppState } from 'src/terminal/state/AppState.js'

const AGENT = 'agent-1' as AgentId

function world(over: Partial<RegisterMonitorMcpTaskInput> = {}) {
  let state = { tasks: {}, speculation: { status: 'idle' } } as unknown as AppState
  const setAppState = (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  }
  const log: string[] = []
  const queued: QueuedCommand[] = []
  const cleanups: Array<() => Promise<void>> = []
  const unregistered: number[] = []
  let releaseFlush: () => void = () => {}
  const deps: MonitorMcpTaskDeps = {
    initOutput: mock(async () => '/path'),
    appendOutput: (id, text) => log.push(`append ${id} ${text}`),
    flushOutput: id => {
      log.push(`flush ${id}`)
      return new Promise<void>(resolve => {
        releaseFlush = () => {
          log.push('flushed')
          resolve()
        }
        // Settles on its own unless a test holds it.
        queueMicrotask(() => releaseFlush())
      })
    },
    enqueue: command => {
      log.push('enqueue')
      queued.push(command)
    },
    registerCleanup: fn => {
      cleanups.push(fn)
      const at = cleanups.length - 1
      return () => unregistered.push(at)
    },
  }
  const onStop = mock((): void | Promise<void> => {})
  const handle = registerMonitorMcpTask(
    {
      kind: 'call',
      serverName: 'indexer',
      description: 'Index the repo',
      toolUseId: 'toolu_1',
      onStop,
      setAppState,
      ...over,
    },
    deps,
  )
  return {
    handle,
    deps,
    log,
    queued,
    cleanups,
    unregistered,
    onStop,
    setAppState,
    getAppState: () => state,
    task: () => (state.tasks as Record<string, Record<string, unknown>>)[handle.taskId]!,
  }
}

describe('registerMonitorMcpTask', () => {
  test('lists a running task with its kind, server and output file', () => {
    const w = world({ agentId: AGENT })
    expect(w.handle.taskId).toMatch(/^m[0-9a-z]{8}$/)
    expect(w.handle.outputFile).toBe(getTaskOutputPath(w.handle.taskId))
    expect(w.task()).toMatchObject({
      id: w.handle.taskId,
      type: 'monitor_mcp',
      kind: 'call',
      serverName: 'indexer',
      description: 'Index the repo',
      toolUseId: 'toolu_1',
      agentId: AGENT,
      status: 'running',
      notified: false,
      outputFile: w.handle.outputFile,
    })
    // No isBackgrounded:false, which is what /clear kills.
    expect('isBackgrounded' in w.task()).toBe(false)
    expect(w.deps.initOutput).toHaveBeenCalledWith(w.handle.taskId)
    expect(w.cleanups).toHaveLength(1)
    expect(hasMonitorMcpController(w.handle.taskId)).toBe(true)
    void w.handle.finish({ status: 'completed', summary: '' })
  })

  test('a failed output init is logged, not thrown', async () => {
    const w = world()
    await w.handle.finish({ status: 'completed', summary: '' })
    const second = registerMonitorMcpTask(
      { kind: 'events', serverName: 's', description: 'd', onStop: () => {}, setAppState: w.setAppState },
      { ...w.deps, initOutput: () => Promise.reject(new Error('EEXIST')) },
    )
    await Bun.sleep(0)
    expect((w.getAppState().tasks as Record<string, { status: string }>)[second.taskId]!.status).toBe('running')
    await second.finish({ status: 'completed', summary: '' })
  })

  test('appends output and sets the progress line while running', async () => {
    const w = world()
    w.handle.appendOutput('line 1\n')
    w.handle.setStatus('indexing 40%')
    expect(w.log).toEqual([`append ${w.handle.taskId} line 1\n`])
    expect(w.task().statusMessage).toBe('indexing 40%')
    await w.handle.finish({ status: 'completed', summary: '' })
  })
})

describe('finish', () => {
  test('ends the task, flushes the output, then queues one notification', async () => {
    const w = world({ agentId: AGENT })
    await w.handle.finish({ status: 'completed', summary: '412 files' })
    expect(w.task()).toMatchObject({ status: 'completed', notified: true })
    expect(typeof w.task().endTime).toBe('number')
    expect(w.log).toEqual([`flush ${w.handle.taskId}`, 'flushed', 'enqueue'])
    expect(w.queued).toHaveLength(1)
    const [note] = w.queued
    expect(note).toMatchObject({ mode: 'task-notification', priority: 'later', agentId: AGENT })
    expect(note!.value).toContain(`<task-id>${w.handle.taskId}</task-id>`)
    expect(note!.value).toContain(`<output-file>${w.handle.outputFile}</output-file>`)
    expect(note!.value).toContain('<status>completed</status>')
    expect(note!.value).toContain('MCP task "Index the repo" on server "indexer" completed: 412 files')
    // The exit cleanup is gone and the producer's stop will not run.
    expect(w.unregistered).toEqual([0])
    expect(w.onStop).not.toHaveBeenCalled()
  })

  test('an events task reports at once (priority next) and says it failed', async () => {
    const w = world({ kind: 'events', description: 'CI failures' })
    await w.handle.finish({ status: 'failed', summary: 'stream closed' })
    expect(w.queued[0]).toMatchObject({ priority: 'next' })
    expect(w.queued[0]!.value).toContain('MCP events monitor "CI failures" on server "indexer" failed: stream closed')
    expect(w.task().status).toBe('failed')
  })

  test('a second finish tells nobody and keeps the first status', async () => {
    const w = world()
    await w.handle.finish({ status: 'completed', summary: 'a' })
    await w.handle.finish({ status: 'failed', summary: 'b' })
    expect(w.queued).toHaveLength(1)
    expect(w.task().status).toBe('completed')
  })

  test('two finishes racing still queue one notification', async () => {
    const w = world()
    await Promise.all([
      w.handle.finish({ status: 'completed', summary: 'a' }),
      w.handle.finish({ status: 'failed', summary: 'b' }),
    ])
    expect(w.queued).toHaveLength(1)
  })

  test('output and progress after the end are dropped', async () => {
    const w = world()
    await w.handle.finish({ status: 'completed', summary: '' })
    w.log.length = 0
    w.handle.appendOutput('late\n')
    w.handle.setStatus('late')
    expect(w.log).toEqual([])
    expect(w.task().statusMessage).toBeUndefined()
  })

  test('aborts an active speculation, as a shell notification does', async () => {
    const w = world()
    const abort = mock(() => {})
    w.setAppState(prev => ({ ...prev, speculation: { status: 'active', id: 'spec1', abort } }) as unknown as AppState)
    await w.handle.finish({ status: 'completed', summary: '' })
    expect(abort).toHaveBeenCalledTimes(1)
    expect((w.getAppState().speculation as { status: string }).status).toBe('idle')
  })
})

describe('stopping from outside', () => {
  test('MonitorMcpTask.kill marks it killed and runs the stop once, with no notification', async () => {
    const w = world()
    await MonitorMcpTask.kill(w.handle.taskId, w.setAppState)
    await MonitorMcpTask.kill(w.handle.taskId, w.setAppState)
    expect(w.task()).toMatchObject({ status: 'killed', notified: true })
    expect(w.onStop).toHaveBeenCalledTimes(1)
    expect(w.unregistered).toEqual([0])
    expect(hasMonitorMcpController(w.handle.taskId)).toBe(false)
    // The producer learns of the stop and finishes; nothing more is said.
    await w.handle.finish({ status: 'failed', summary: 'cancelled' })
    expect(w.queued).toEqual([])
    expect(w.task().status).toBe('killed')
  })

  test('killMonitorMcp (the dialog) stops it the same way', () => {
    const w = world()
    killMonitorMcp(w.handle.taskId, w.setAppState)
    expect(w.task().status).toBe('killed')
    expect(w.onStop).toHaveBeenCalledTimes(1)
  })

  test("the owning agent's exit stops it", () => {
    const w = world({ agentId: AGENT })
    killMonitorMcpTasksForAgent(AGENT, w.getAppState, w.setAppState)
    expect(w.task().status).toBe('killed')
    expect(w.onStop).toHaveBeenCalledTimes(1)
  })

  test('the exit cleanup stops it and waits for the stop', async () => {
    const w = world()
    let cancelled = false
    w.onStop.mockImplementation(async () => {
      await Bun.sleep(5)
      cancelled = true
    })
    await w.cleanups[0]!()
    expect(cancelled).toBe(true)
    expect(w.task()).toMatchObject({ status: 'killed', notified: true })
  })

  test('a stop that throws is logged, and the task is still killed', async () => {
    const w = world()
    w.onStop.mockImplementation(() => {
      throw new Error('cancel failed')
    })
    await expect(stopMonitorMcpTask(w.handle.taskId, w.setAppState)).resolves.toBeUndefined()
    expect(w.task().status).toBe('killed')
  })

  test('a finished task is not stopped', async () => {
    const w = world()
    await w.handle.finish({ status: 'completed', summary: '' })
    await stopMonitorMcpTask(w.handle.taskId, w.setAppState)
    expect(w.onStop).not.toHaveBeenCalled()
    expect(w.task().status).toBe('completed')
  })
})
