import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { buildChildMessage } from 'src/tools/AgentTool/forkSubagent.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import {
  extractForkDirective,
  UserForkBoilerplateMessage,
} from 'src/components/messages/UserForkBoilerplateMessage.js'

function render(text: string): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <UserForkBoilerplateMessage
        addMargin={false}
        param={{ type: 'text', text }}
      />
    </AppStateProvider>,
  ).then(stripAnsi)
}

describe('UserForkBoilerplateMessage', () => {
  // Regression for the React #130 crash: this module did not exist, so the
  // `require()` in UserTextMessage resolved to the build's missing-module stub
  // (default export only), the destructured component came out `undefined`,
  // and rendering a fork child's first message replaced the whole TUI with an
  // "Element type is invalid" error screen.
  test('renders only the directive of a real fork child message', async () => {
    const out = await render(buildChildMessage('Audit the login flow'))

    expect(out).toContain('Audit the login flow')
    // The boilerplate is identical for every fork — it must not be shown.
    expect(out).not.toContain('STOP. READ THIS FIRST.')
    expect(out).not.toContain('fork-boilerplate')
    expect(out).not.toContain('Your directive:')
  })

  test('renders the text verbatim when there is no boilerplate block', async () => {
    const out = await render('a plain user message')

    expect(out).toContain('a plain user message')
  })
})

describe('extractForkDirective', () => {
  test('drops the boilerplate block and the directive prefix', () => {
    expect(extractForkDirective(buildChildMessage('do the thing'))).toBe(
      'do the thing',
    )
  })

  test('keeps a multi-line directive intact', () => {
    const directive = 'line one\n\nline two'

    expect(extractForkDirective(buildChildMessage(directive))).toBe(directive)
  })

  test('returns empty string for text without the boilerplate tag', () => {
    expect(extractForkDirective('just a prompt')).toBe('')
  })
})
