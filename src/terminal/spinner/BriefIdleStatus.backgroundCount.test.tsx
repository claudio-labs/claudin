// Brief mode's idle line ("N in background") counts work, not the rows the
// footer panel lists for status: an MCP server (#201) or a container (#145) row
// stays `running` for as long as it is listed. Same bug as the turn-end line
// (SystemTextMessage.backgroundCount.test.tsx).
import { describe, expect, test } from 'bun:test'
import * as React from 'react'

import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { BriefIdleStatus } from 'src/terminal/spinner/Spinner.js'
import { type AppState, AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'

async function briefIdle(types: string[]): Promise<string> {
  const tasks = Object.fromEntries(types.map((type, i) => [`t${i}`, taskFixture(type, { id: `t${i}` })]))
  const state = { ...getDefaultAppState(), tasks } as AppState
  return renderToString(
    <AppStateProvider initialState={state}>
      <BriefIdleStatus />
    </AppStateProvider>,
    120,
  )
}

describe('brief mode counts work in flight, not panel rows', () => {
  test('two MCP servers and a container are nothing in background', async () => {
    expect((await briefIdle(['mcp_server', 'mcp_server', 'container'])).trim()).toBe('')
  })

  test('a shell beside them is counted alone', async () => {
    expect(await briefIdle(['mcp_server', 'container', 'local_bash'])).toContain('1 in background')
  })
})
