import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'
import { BackgroundTasksDialog } from 'src/agent/ui/tasks/BackgroundTasksDialog.js'
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'
import { containerInfo, taskFixture, TASK_FIXTURES } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

const SECOND_CONTAINER = taskFixture('container', {
  id: 'k2',
  container: containerInfo({ id: 'deadbeef', name: 'shop-db-1', service: 'db', ports: [] }),
})

// A row lingers after the container dies, and its TASK status stays `running`
// throughout — so the stop hint cannot be driven by `status`.
const EXITED_CONTAINER = taskFixture('container', {
  container: containerInfo({ state: 'exited', exitCode: 0, ports: [] }),
})

// End-to-end over the path that crashed: the dialog maps EVERY background task
// through toListItem during render, so a running container took the whole TUI
// down — Ink's root swaps the tree for its error screen and never resets, and
// the session could only be killed. Rendering the real component is the only
// check that covers the row renderer and the section JSX together.
//
// Ink logs "Raw mode is not supported" through its own caught-error path under
// a PassThrough stdout. That is the harness, not a failure.
async function renderDialog(tasks: Record<string, BackgroundTaskState>): Promise<string> {
  const state = { ...getDefaultAppState(), tasks }
  return renderToString(
    <AppStateProvider initialState={state as never}>
      <BackgroundTasksDialog onDone={() => {}} toolUseContext={{} as never} />
    </AppStateProvider>,
    100,
  )
}

describe('BackgroundTasksDialog with a container row', () => {
  test('lists containers in their own section instead of throwing', async () => {
    const out = await renderDialog({ k1: TASK_FIXTURES.container!, b1: TASK_FIXTURES.local_bash! })
    expect(out).toContain('Containers (1)')
    expect(out).toContain('api-1 · up · :8080')
    expect(out).toContain('npm run dev')
  })

  test('Enter on a container reads `logs`, and x still stops it', async () => {
    // Two containers, so the mount-time auto-skip does not jump to the detail
    // view and the cursor starts on a container rather than on a shell.
    const out = await renderDialog({ k1: TASK_FIXTURES.container!, k2: SECOND_CONTAINER })
    expect(out).toContain('Enter to logs')
    expect(out).toContain('x to stop container')
  })

  test('a lone container auto-skips into the logs view', async () => {
    // This is the keypress the user reported: it used to be wired to nothing,
    // then to a soft-lock. It must now land on ContainerLogsDialog.
    const out = await renderDialog({ k1: TASK_FIXTURES.container! })
    expect(out).toContain('Logs · api-1')
    expect(out).toContain('nginx:latest')
    expect(out).toContain('x to stop container')
  })

  test('a selected shell still offers both Enter and x', async () => {
    // Two tasks, so the mount-time auto-skip does not jump straight to a
    // detail view. Shells sort before containers (FOOTER_GROUP_ORDER), so the
    // cursor starts on the shell.
    const out = await renderDialog({ b1: TASK_FIXTURES.local_bash!, k1: TASK_FIXTURES.container! })
    expect(out).toContain('Enter to view')
    expect(out).toContain('x to stop')
    expect(out.indexOf('npm run dev')).toBeLessThan(out.indexOf('api-1'))
  })

  test('an exited container still offers its logs but not the stop key', async () => {
    const out = await renderDialog({ k1: EXITED_CONTAINER, k2: SECOND_CONTAINER })
    expect(out).toContain('api-1 · exited (0)')
    expect(out).toContain('Enter to logs')
    expect(out).not.toContain('x to stop')
  })
})
