// The turn-end line ("Crunched for 6m 33s · 2 background tasks still running")
// must count work, not the rows the footer panel lists for status. An MCP server
// (#201) and a container (#145) each get a row that stays `running` for as long
// as it is listed, so a project with two MCP servers said "2 background tasks
// still running" after every turn (infra_home_lab, 2026-10-31).
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { createTurnDurationMessage } from 'src/agent/messages/factories.js'
import { SystemTextMessage } from 'src/agent/ui/messages/SystemTextMessage.js'
import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'
import type { TaskState } from 'src/agent/tasks/types.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

async function turnEndLine(tasks: TaskState[]): Promise<string> {
  const initialState = {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
  }
  return stripAnsi(
    await renderToString(
      <AppStateProvider initialState={initialState}>
        <SystemTextMessage message={createTurnDurationMessage(393_000)} addMargin={false} verbose={false} />
      </AppStateProvider>,
      160,
    ),
  )
}

const row = (type: string, id: string) => taskFixture(type, { id }) as unknown as TaskState

describe('the turn-end line counts work in flight, not panel rows', () => {
  test('two connected MCP servers are not "background tasks still running"', async () => {
    const line = await turnEndLine([row('mcp_server', 'p1'), row('mcp_server', 'p2')])
    expect(line).toContain('for 6m 33s')
    expect(line).not.toContain('still running')
  })

  test('a container row is not one either', async () => {
    expect(await turnEndLine([row('container', 'k1')])).not.toContain('still running')
  })

  test('a real shell beside them is counted alone', async () => {
    const line = await turnEndLine([row('mcp_server', 'p1'), row('container', 'k1'), row('local_bash', 'b1')])
    expect(line).toContain('· 1 shell still running')
  })
})
