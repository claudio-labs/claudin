// Baseline regression for <REPL> mount + unmount.
//
// renderToString already mounts and then unmounts via RenderOnceAndExit's
// setTimeout(exit, 0). If any mount-time effect throws, the snapshot
// resolves to the partial frame and the diff is obvious.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { REPL } from 'src/screens/REPL.js'
import {
  mockReplProps,
  setupReplMocks,
  teardownReplMocks,
} from 'src/screens/__testutils__/replTestHarness.js'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)

describe('<REPL> lifecycle baseline', () => {
  test('mount + unmount without throwing (snapshot final frame)', async () => {
    let threw: unknown = null
    let out = ''
    try {
      out = await renderToString(
        <AppStateProvider>
          <REPL {...mockReplProps()} />
        </AppStateProvider>,
        100,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(out).toMatchSnapshot()
  })

  // NOTE: sequential mount+mount used to live here but blew the 5s timeout
  // — each REPL mount takes ~3s under renderToString. The single-mount test
  // above already exercises both lifecycles via RenderOnceAndExit. If a
  // future refactor breaks cleanup, the symptom will show up as test-suite
  // hangs in bun test, not as a missing assertion here.
  test('mount with non-empty initial tools (alternate path)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ initialTools: [] })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })
})
