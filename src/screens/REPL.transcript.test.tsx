// Baseline snapshot for the transcript-related code paths in <REPL>.
//
// LIMITATION: `screen='transcript'` is internal state (ctrl+o toggle), not
// a prop. We can't drive the component into transcript mode from a unit
// test without reaching into internals. Instead we vary `initialMessages`
// — that exercises the Messages-rendering side of the same code path and
// will catch identity/structural regressions in the surrounding container.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToString } from 'src/utils/staticRender.js'
import { AppStateProvider } from 'src/state/AppState.js'
import { REPL } from './REPL.js'
import {
  mockReplProps,
  setupReplMocks,
  teardownReplMocks,
} from './__testutils__/replTestHarness.js'

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)

describe('<REPL> transcript baseline', () => {
  test('empty initialMessages (degenerate)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL {...mockReplProps({ initialMessages: [] })} />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })

  test('initialAgentName + color set (resumed agent context)', async () => {
    const out = await renderToString(
      <AppStateProvider>
        <REPL
          {...mockReplProps({
            initialAgentName: 'sample-agent',
            initialAgentColor: 'cyan',
          })}
        />
      </AppStateProvider>,
      100,
    )
    expect(out).toMatchSnapshot()
  })
})
