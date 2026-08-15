import React from 'react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderToString } from 'src/terminal/render/staticRender.js'

// `mock.restore()` does NOT revert `mock.module`, so both stubs below outlive
// this file unless they are re-mocked back. Snapshot the reals as plain objects
// first (never the live namespace, which re-applies the stub), spread them into
// each partial so no export goes missing, and restore them afterwards.
//
// The AppState one is what made this worth fixing: the old stub exported
// `useAppState` alone, dropping `AppStateProvider`, and its selector ran against
// a fixed object with no `settings`. Every later component calling
// `useSettings()` therefore got `undefined` — which is how `Markdown.test.tsx`
// started timing out on `useSettings().syntaxHighlightingDisabled` once the
// reorg changed which file the directory walk reaches first.
const realAppState = { ...(await import('src/terminal/state/AppState.js')) }
const realCommandQueue = { ...(await import('src/hooks/useCommandQueue.js')) }

describe('PromptInputQueuedCommands', () => {
  beforeEach(() => {
    mock.module('src/hooks/useCommandQueue.js', () => ({
      ...realCommandQueue,
      useCommandQueue: () => [
        {
          value: 'Use another library',
          mode: 'prompt',
        },
      ],
    }))

    mock.module('src/terminal/state/AppState.js', () => ({
      ...realAppState,
      useAppState: (
        selector: (state: { viewingAgentTaskId?: string; isBriefOnly: boolean }) => unknown,
      ) => selector({ viewingAgentTaskId: undefined, isBriefOnly: false }),
    }))
  })

  afterEach(() => {
    mock.restore()
    mock.module('src/hooks/useCommandQueue.js', () => realCommandQueue)
    mock.module('src/terminal/state/AppState.js', () => realAppState)
  })

  it('shows a next-turn guidance banner for queued prompt messages', async () => {
    const { PromptInputQueuedCommands } = await import(
      'src/terminal/prompt-input/PromptInputQueuedCommands.js'
    )

    const output = await renderToString(<PromptInputQueuedCommands />, 100)

    expect(output).toContain('1 message queued for next turn')
    expect(output).toContain('Use another library')
  })
})
