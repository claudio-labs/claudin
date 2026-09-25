import { describe, expect, test } from 'bun:test'
import React from 'react'
import { EMPTY_LOOKUPS } from 'src/agent/messages/lookups.js'
import { Message } from 'src/agent/ui/Message.js'
import { thinkingSignature } from 'src/providers/shims/claude/__testutils__/thinkingSignature.js'
import { BLACK_CIRCLE } from 'src/shared/constants/figures.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const UPDATE = 'Found the five call sites; renaming the definition next.'

type MessageProps = React.ComponentProps<typeof Message>

function progressUpdateFrom(model: string): MessageProps['message'] {
  return {
    type: 'assistant',
    uuid: `uuid-${model}`,
    timestamp: '2026-09-25T00:00:00.000Z',
    message: {
      id: `msg-${model}`,
      role: 'assistant',
      model,
      content: [{ type: 'thinking', thinking: UPDATE, signature: thinkingSignature('narration') }],
    },
  } as unknown as MessageProps['message']
}

async function render(model: string): Promise<string> {
  const out = await renderToString(
    <AppStateProvider>
      <Message
        message={progressUpdateFrom(model)}
        lookups={EMPTY_LOOKUPS}
        addMargin={false}
        tools={[]}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set()}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={true}
        isTranscriptMode={false}
        isStatic={true}
      />
    </AppStateProvider>,
  )
  return out.replace(/\s+/g, ' ').trim()
}

// Message hands a progress update the row's dot and the message's model,
// which decides the hint. The prompt view (not ctrl+o) is the case that
// matters: a progress update is the only thinking block it shows.
describe('Message — a progress update', () => {
  test('from Opus 5.5: the dot and the text, no hint', async () => {
    expect(await render('claude-opus-5-5')).toBe(`${BLACK_CIRCLE} ${UPDATE}`)
  })

  test('from Fable 5.1: the dot, the text and " · summarized"', async () => {
    expect(await render('claude-fable-5-1')).toBe(`${BLACK_CIRCLE} ${UPDATE} · summarized`)
  })
})
