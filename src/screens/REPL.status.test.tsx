// Baseline snapshot for status-bar adjacent <REPL> mounts.
//
// LIMITATION: `isLoading` is internal state — the spinner only appears
// while a query is mid-flight. From prop input alone we can only snapshot
// the idle status bar. Any refactor that moves the status block out of the
// REPL tree will still surface in this snapshot via the surrounding
// container layout.

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

describe('<REPL> status baseline', () => {
  test('idle status (default mount)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps()} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('idle status, narrow terminal (40 cols)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps()} />
      </AppStateProvider>,
      40,
    )
    expect(out).toMatchSnapshot()
  })

  test('idle status, wide terminal (160 cols)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps()} />
      </AppStateProvider>,
      160,
    )
    expect(out).toMatchSnapshot()
  })
})
