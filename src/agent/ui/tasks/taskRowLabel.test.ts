import { describe, expect, test } from 'bun:test'
import { taskRowLabel } from 'src/agent/ui/tasks/taskRowLabel.js'
import { containerInfo, TASK_FIXTURES, TASK_TYPES, taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

describe('taskRowLabel', () => {
  test('every background task type gets a non-empty label', () => {
    // The guard PR #145 lacked: it added `container` to the task union and to
    // the footer tree, but the dialog's copy of this switch kept throwing.
    for (const type of TASK_TYPES) {
      expect(taskRowLabel(TASK_FIXTURES[type]!), `no label for ${type}`).not.toBe('')
    }
  })

  test('a monitor shell is labelled by its description, a plain one by its command', () => {
    expect(taskRowLabel(taskFixture('local_bash', { kind: 'monitor', description: 'tail -f app.log' }))).toBe('tail -f app.log')
    expect(taskRowLabel(taskFixture('local_bash'))).toBe('npm run dev')
  })

  test('a container reads name · state · ports', () => {
    expect(taskRowLabel(TASK_FIXTURES.container!)).toBe('api-1 · up · :8080')
  })

  test('a stopped container drops its ports and carries the exit code', () => {
    const stopped = taskFixture('container', {
      container: containerInfo({ state: 'exited', exitCode: 137, status: 'Exited (137) 1 minute ago' }),
    })
    expect(taskRowLabel(stopped)).toBe('api-1 · exited (137)')
  })

  test('an unknown type falls back to an empty label instead of throwing', () => {
    expect(taskRowLabel({ type: 'not_a_task' } as never)).toBe('')
  })
})
