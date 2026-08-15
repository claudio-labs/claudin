// Baseline snapshot for the /resume code path of <REPL>.
//
// The resume callback (~210 lines inside REPL.tsx) is scheduled for
// extraction in Etapa 3 of the split. This file exercises the mount-time
// resume seed via props: initialMessages, initialFileHistorySnapshots and
// initialContentReplacements. Coverage is structural only — the resumed
// session state is mostly internal; the surrounding container/footer
// remains the regression target.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToString } from 'src/components/staticRender.js'
import { AppStateProvider } from 'src/state/AppState.js'
import { REPL } from 'src/screens/REPL.js'
import {
  mockReplProps,
  setupReplMocks,
  teardownReplMocks,
} from 'src/screens/__testutils__/replTestHarness.js'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)

describe('<REPL> resume baseline', () => {
  test('resume props all empty (default)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL
          {...mockReplProps({
            initialMessages: [],
            initialFileHistorySnapshots: [],
            initialContentReplacements: [],
          })}
        />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('resume with agent context (name + color)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL
          {...mockReplProps({
            initialMessages: [],
            initialFileHistorySnapshots: [],
            initialContentReplacements: [],
            initialAgentName: 'resumed-agent',
            initialAgentColor: 'purple',
          })}
        />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })
})
