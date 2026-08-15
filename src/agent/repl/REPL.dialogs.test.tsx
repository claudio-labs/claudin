// Baseline snapshot for <REPL> dialog-adjacent prop variants.
//
// LIMITATION: dialogs (tool-use confirm, hook prompts, MCP approvals, plan
// mode exit) are all driven by INTERNAL state managed inside REPL.tsx and
// cannot be triggered from outside the component. This file therefore
// snapshots prop configurations that are *close* to the dialog code path —
// any future split that breaks the dialog block will still show a diff
// because the surrounding container/footer ordering would change.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { REPL } from 'src/agent/repl/REPL.js'
import {
  mockReplProps,
  setupReplMocks,
  teardownReplMocks,
} from 'src/agent/repl/__testutils__/replTestHarness.js'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)

describe('<REPL> dialogs baseline', () => {
  test('disabled prop (suppresses prompt, dialog container still mounts)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ disabled: true })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('disableSlashCommands (alternate command path)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ disableSlashCommands: true })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('mcpClients empty array (mcp dialog code path reachable)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ mcpClients: [] })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })
})
