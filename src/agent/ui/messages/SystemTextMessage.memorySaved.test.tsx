import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { createMemorySavedMessage } from 'src/agent/messages/messages.js'
import { SystemTextMessage } from 'src/agent/ui/messages/SystemTextMessage.js'
import type { SystemMemorySavedMessage } from 'src/shared/types/message.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

async function render(message: SystemMemorySavedMessage): Promise<string> {
  return stripAnsi(
    await renderToString(
      <AppStateProvider>
        <SystemTextMessage message={message} addMargin={false} verbose={false} />
      </AppStateProvider>,
      120,
    ),
  )
}

describe('the "Saved …" line of the memory extraction', () => {
  test('says each directory: "Saved 2 global memories, 1 private memory"', async () => {
    const message = {
      ...createMemorySavedMessage(['/g/user-a.md', '/g/user-b.md', '/repo/.claudin/memory/feedback-c.md']),
      memoryCounts: { global: 2, private: 1 },
    }
    const output = await render(message)
    expect(output).toContain('Saved 2 global memories, 1 private memory')
    // Each saved file still has its row
    expect(output).toContain('user-a.md')
    expect(output).toContain('feedback-c.md')
  })

  test('a resumed transcript with the old teamCount still renders', async () => {
    const message = {
      ...createMemorySavedMessage(['/repo/.claudin/memory/a.md', '/repo/.claudin/memory/team/b.md']),
      teamCount: 1,
    }
    expect(await render(message)).toContain('Saved 1 memory, 1 team memory')
  })

  test('one with no counts at all says how many', async () => {
    expect(await render(createMemorySavedMessage(['/repo/.claudin/memory/a.md', '/repo/.claudin/memory/b.md']))).toContain(
      'Saved 2 memories',
    )
  })
})
