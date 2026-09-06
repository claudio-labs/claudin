import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { BackgroundTask } from 'src/agent/ui/tasks/BackgroundTask.js'
import { containerInfo, TASK_FIXTURES, taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

// The row renderer's switch has no `default`, so a type it does not handle
// renders undefined — a blank row rather than a crash, which is why nothing
// caught the missing container arm until toListItem threw first.
describe('BackgroundTask row', () => {
  test('renders a container as name · state · ports', async () => {
    const out = await renderToString(<BackgroundTask task={TASK_FIXTURES.container!} />)
    expect(out.trim()).toBe('api-1 · up · :8080')
  })

  test('renders a stopped container with its exit code', async () => {
    const stopped = taskFixture('container', {
      container: containerInfo({ state: 'exited', exitCode: 137 }),
    })
    expect((await renderToString(<BackgroundTask task={stopped} />)).trim()).toBe('api-1 · exited (137)')
  })

  test('truncates a long container label to maxActivityWidth', async () => {
    const wide = taskFixture('container', {
      container: containerInfo({ project: null, name: 'a-very-long-container-name-indeed' }),
    })
    const out = (await renderToString(<BackgroundTask task={wide} maxActivityWidth={20} />)).trim()
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toStartWith('a-very-long')
  })

  test('a shell row still renders its command', async () => {
    const out = await renderToString(<BackgroundTask task={TASK_FIXTURES.local_bash!} />)
    expect(out).toContain('npm run dev')
  })
})
