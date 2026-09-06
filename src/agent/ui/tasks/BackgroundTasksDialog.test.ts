import { describe, expect, test } from 'bun:test'
import { toListItem } from 'src/agent/ui/tasks/BackgroundTasksDialog.js'
import { TASK_FIXTURES, TASK_TYPES } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

describe('toListItem', () => {
  test('maps every background task type to a row', () => {
    // The reported crash: a running container reached this function, hit the
    // throwing default, and Ink's root replaced the whole tree with the error
    // screen — the session could only be killed. Every route into the
    // background-tasks dialog maps EVERY background task, so one unhandled
    // type takes the dialog down whatever the user was selecting.
    for (const type of TASK_TYPES) {
      const item = toListItem(TASK_FIXTURES[type]!)
      expect(String(item.type), `wrong row type for ${type}`).toBe(type)
      expect(item.id).toBe(TASK_FIXTURES[type]!.id)
      expect(item.label, `no label for ${type}`).not.toBe('')
      expect(item.status).toBe('running')
    }
  })

  test('a container row carries the task through, so `x` can dispatch on it', () => {
    const item = toListItem(TASK_FIXTURES.container!)
    expect(item.type).toBe('container')
    expect(item.task).toBe(TASK_FIXTURES.container!)
  })

  test('still throws loudly on a type nobody wired up', () => {
    expect(() => toListItem({ type: 'not_a_task', id: 'x', status: 'running' } as never)).toThrow(/unhandled task type not_a_task/)
  })
})
