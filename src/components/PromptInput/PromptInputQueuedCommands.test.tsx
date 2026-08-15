import React from 'react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderToString } from 'src/components/staticRender.js'

describe('PromptInputQueuedCommands', () => {
  beforeEach(() => {
    mock.module('src/hooks/useCommandQueue.js', () => ({
      useCommandQueue: () => [
        {
          value: 'Use another library',
          mode: 'prompt',
        },
      ],
    }))

    mock.module('src/state/AppState.js', () => ({
      useAppState: (
        selector: (state: { viewingAgentTaskId?: string; isBriefOnly: boolean }) => unknown,
      ) => selector({ viewingAgentTaskId: undefined, isBriefOnly: false }),
    }))
  })

  afterEach(() => {
    mock.restore()
  })

  it('shows a next-turn guidance banner for queued prompt messages', async () => {
    const { PromptInputQueuedCommands } = await import('src/components/PromptInput/PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 100)

    expect(output).toContain('1 message queued for next turn')
    expect(output).toContain('Use another library')
  })
})
