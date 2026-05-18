// Baseline regression snapshot for <REPL>. This file does NOT validate
// behavior — it freezes the rendered tree at three mount-time prop
// configurations so the upcoming refactor (REPL split, ROADMAP 11e) can be
// reviewed against an unchanging shape.
//
// The renderer is `renderToString` (Ink → string, ANSI stripped). Internal
// state (transcript mode, dialog visibility, etc.) cannot be flipped from
// outside the component, so each test below only varies props. The dialogs/
// transcript/status companion files target other prop angles.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToString } from '../utils/staticRender.js'
import { AppStateProvider } from '../state/AppState.js'
import { REPL } from './REPL.js'
import {
  mockReplProps,
  setupReplMocks,
  teardownReplMocks,
} from './__testutils__/replTestHarness.js'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)

describe('<REPL> smoke baseline', () => {
  test('default mount (prompt mode, empty conversation)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps()} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('disabled prop (no prompt input)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ disabled: true })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('debug mode on', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ debug: true })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })
})
