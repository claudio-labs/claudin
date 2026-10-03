import { describe, expect, test } from 'bun:test'
import {
  type MirroredMessages,
  releaseForeground,
  shouldMirror,
} from 'src/sessions/hooks/sessionBackgrounding/foreground.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

describe('shouldMirror', () => {
  const cases: Array<{ name: string; last: MirroredMessages | null; taskId: string; count: number; send: boolean }> = [
    { name: 'nothing sent, no messages', last: null, taskId: 'a', count: 0, send: false },
    { name: 'nothing sent, some messages', last: null, taskId: 'a', count: 2, send: true },
    { name: 'same task, same count', last: { taskId: 'a', count: 2 }, taskId: 'a', count: 2, send: false },
    { name: 'same task, a new message', last: { taskId: 'a', count: 2 }, taskId: 'a', count: 3, send: true },
    { name: 'another task with the same count', last: { taskId: 'a', count: 2 }, taskId: 'b', count: 2, send: true },
    { name: 'another task with no messages', last: { taskId: 'a', count: 2 }, taskId: 'b', count: 0, send: true },
  ]
  for (const { name, last, taskId, count, send } of cases) {
    test(name, () => {
      expect(shouldMirror(last, taskId, count)).toBe(send)
    })
  }
})

describe('releaseForeground', () => {
  const withTask = (): AppState => ({
    ...getDefaultAppState(),
    foregroundedTaskId: 'a',
    tasks: { a: { id: 'a', isBackgrounded: false } as never, b: { id: 'b', isBackgrounded: false } as never },
  })

  test('the task goes to the background and the foreground is cleared; other tasks are left alone', () => {
    const before = withTask()
    const after = releaseForeground(before, 'a')
    expect(after.foregroundedTaskId).toBeUndefined()
    expect((after.tasks.a as { isBackgrounded: boolean }).isBackgrounded).toBe(true)
    expect(after.tasks.b).toBe(before.tasks.b)
    expect((before.tasks.a as { isBackgrounded: boolean }).isBackgrounded).toBe(false)
  })

  test('a task that is gone only clears the foreground', () => {
    const before = withTask()
    const after = releaseForeground(before, 'missing')
    expect(after.foregroundedTaskId).toBeUndefined()
    expect(after.tasks).toBe(before.tasks)
  })
})
