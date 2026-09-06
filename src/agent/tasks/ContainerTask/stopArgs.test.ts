import { describe, expect, test } from 'bun:test'
import { stopArgs } from 'src/agent/tasks/ContainerTask/ContainerTask.js'
import { isContainerStoppable } from 'src/agent/tasks/ContainerTask/types.js'
import { containerInfo, taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

describe('stopArgs', () => {
  // Found live against Docker 24.0.2: `docker stop --timeout 10 <id>` exits 125
  // with `unknown flag: --timeout` and never touches the container. The long
  // form only exists from Docker 25. Nothing surfaced it — the row correctly
  // stays `up` when docker refuses a stop, so `x` on a container row was a
  // no-op on every Docker before 25 and looked like the key was unwired.
  test('uses the short -t flag, which every docker version accepts', () => {
    expect(stopArgs('c0ffee')).toEqual(['stop', '-t', '10', 'c0ffee'])
  })

  test('never uses --timeout, which is Docker 25+ only', () => {
    expect(stopArgs('c0ffee')).not.toContain('--timeout')
  })

  test('the container id is the last argument, so it is never read as a flag value', () => {
    expect(stopArgs('c0ffee').at(-1)).toBe('c0ffee')
  })
})

describe('isContainerStoppable', () => {
  const withState = (state: string) =>
    taskFixture('container', { container: containerInfo({ state: state as never }) }) as never

  test('a live container is stoppable', () => {
    for (const state of ['running', 'restarting', 'paused', 'created']) {
      expect(isContainerStoppable(withState(state)), state).toBe(true)
    }
  })

  test('one that already stopped is not', () => {
    for (const state of ['exited', 'dead', 'removing']) {
      expect(isContainerStoppable(withState(state)), state).toBe(false)
    }
  })

  test('it reads the container state, not the task status', () => {
    // The row keeps `status: 'running'` through the grace period after the
    // container dies — the whole reason this predicate exists.
    const exited = taskFixture('container', {
      status: 'running',
      container: containerInfo({ state: 'exited' }),
    })
    expect(isContainerStoppable(exited as never)).toBe(false)
  })
})
