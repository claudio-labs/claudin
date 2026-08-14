import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/state/AppState.js'
import { renderToString } from 'src/utils/staticRender.js'
import { UserBashInputMessage } from './UserBashInputMessage.js'

function render(text: string): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <UserBashInputMessage addMargin={false} param={{ type: 'text', text }} />
    </AppStateProvider>,
  ).then(stripAnsi)
}

describe('UserBashInputMessage', () => {
  test('renders the command as a Bash(cmd) tool-style header', async () => {
    const out = await render('<bash-input>git status</bash-input>')
    // Header matches the model-initiated Bash tool: "Bash" + "(command)".
    expect(out).toContain('Bash')
    expect(out).toContain('(git status)')
    // The raw mode character must not leak into the rendered command.
    expect(out).not.toContain('! git status')
  })

  test('renders nothing when there is no bash-input tag', async () => {
    const out = await render('plain text with no tag')
    expect(out.trim()).toBe('')
  })
})
