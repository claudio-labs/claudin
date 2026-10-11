import { describe, expect, test } from 'bun:test'
import type { SetAppState } from 'src/agent/Task.js'
import {
  generateTaskAttachments,
  holdTerminalTask,
  pinTerminalTask,
  releaseTerminalTask,
} from 'src/agent/tasks/framework.js'
import { isListedBackgroundTask, type TaskState } from 'src/agent/tasks/types.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

// The generic half of "a finished task stays on screen for a while": hold,
// pin while a view shows it, release. Any task type can use it; the
// navigation-map notice (RuleMapTask) is the first.

function finished(id: string): TaskState {
  return {
    id,
    type: 'rule_map',
    status: 'completed',
    notified: true,
    description: 'Navigation map',
    startTime: 1,
    outputFile: '',
    outputOffset: 0,
    result: null,
  } as unknown as TaskState
}

function store(...tasks: TaskState[]) {
  let state = {
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
  } as unknown as AppState
  const setAppState: SetAppState = f => {
    state = f(state)
  }
  const armed: (() => void)[] = []
  const schedule = (evict: () => void) => {
    armed.push(evict)
  }
  return { setAppState, armed, schedule, state: () => state, task: (id: string) => state.tasks[id] }
}

describe('holdTerminalTask', () => {
  test('lists a finished task until its eviction fires', () => {
    const s = store(finished('n1'))
    expect(isListedBackgroundTask(s.task('n1')!)).toBe(false)
    holdTerminalTask('n1', s.setAppState, 8_000, s.schedule)
    expect(isListedBackgroundTask(s.task('n1')!)).toBe(true)
    s.armed[0]!()
    expect(s.task('n1')).toBeUndefined()
  })

  test('the per-turn GC leaves a held task to its own timer', async () => {
    // Without this, the next prompt evicted the notice seconds early.
    const s = store(finished('n1'))
    holdTerminalTask('n1', s.setAppState, 8_000, s.schedule)
    const { evictedTaskIds } = await generateTaskAttachments(s.state())
    expect(evictedTaskIds).toEqual([])
  })
})

describe('pinTerminalTask', () => {
  test('keeps a held task past its eviction while something shows it', () => {
    const s = store(finished('n1'))
    holdTerminalTask('n1', s.setAppState, 8_000, s.schedule)
    pinTerminalTask('n1', s.setAppState)
    s.armed[0]!()
    expect(s.task('n1')).toBeDefined()
  })

  test('the release evicts it at once — it has been seen', () => {
    const s = store(finished('n1'))
    holdTerminalTask('n1', s.setAppState, 8_000, s.schedule)
    pinTerminalTask('n1', s.setAppState)
    releaseTerminalTask('n1', s.setAppState)
    expect(s.task('n1')).toBeUndefined()
  })

  test('a view opened while the task still runs keeps it through the hold', () => {
    const s = store({ ...finished('n1'), status: 'running' } as TaskState)
    pinTerminalTask('n1', s.setAppState)
    s.setAppState(prev => ({
      ...prev,
      tasks: { ...prev.tasks, n1: { ...prev.tasks.n1!, status: 'completed' } },
    }))
    holdTerminalTask('n1', s.setAppState, 8_000, s.schedule)
    s.armed[0]!()
    expect(s.task('n1')).toBeDefined()
    releaseTerminalTask('n1', s.setAppState)
    expect(s.task('n1')).toBeUndefined()
  })

  test('releasing a task that is still running leaves it running, unpinned', () => {
    const s = store({ ...finished('n1'), status: 'running' } as TaskState)
    pinTerminalTask('n1', s.setAppState)
    releaseTerminalTask('n1', s.setAppState)
    expect(s.task('n1')).toMatchObject({ status: 'running', displayUntil: undefined })
  })
})
