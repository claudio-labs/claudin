// Every place that shows a prompt back to the user shows it as it was before
// prompts carried <pasted_content> tags: the transcript, the copy action, the
// sticky header's and the message-actions' "is this a real prompt" check,
// re-submit after rewind, and editing a queued prompt.
import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { wrapPastedText } from 'src/agent/input/pastedContent.js'
import { enqueue, popAllEditable, resetCommandQueue } from 'src/agent/messageQueueManager.js'
import { createUserMessage } from 'src/agent/messages/factories.js'
import { textForResubmit } from 'src/agent/messages/text.js'
import { copyTextOf, isNavigableMessage, userTextOf } from 'src/agent/ui/messageActions.js'
import { UserPromptMessage } from 'src/agent/ui/messages/UserPromptMessage.js'
import { renderToString } from 'src/terminal/render/staticRender.js'

const PASTE_ONLY = wrapPastedText('npm ERR! missing script: test', 'beef')
const MIXED = `why does this fail? ${PASTE_ONLY}`

afterEach(() => resetCommandQueue())

describe('pasted text shown back to the user', () => {
  test('the transcript shows the paste without its tags', async () => {
    const out = await renderToString(<UserPromptMessage addMargin={false} param={{ type: 'text', text: MIXED }} />)
    expect(out).toContain('why does this fail? npm ERR! missing script: test')
    expect(out).not.toContain('pasted_content')
  })

  test('a paste-only prompt is still a prompt the user can act on', () => {
    // Normalized: one text block, as the transcript list holds it.
    const message = createUserMessage({ content: [{ type: 'text', text: PASTE_ONLY }] })
    expect(userTextOf(PASTE_ONLY)).toBe('npm ERR! missing script: test')
    expect(isNavigableMessage(message as never)).toBe(true)
    expect(copyTextOf(message as never)).toBe('npm ERR! missing script: test')
  })

  test('re-submitting after a rewind puts back the text, not the tags', () => {
    expect(textForResubmit(createUserMessage({ content: MIXED }) as never)).toEqual({
      text: 'why does this fail? npm ERR! missing script: test',
      mode: 'prompt',
    })
  })

  test('editing a queued prompt brings back the text, not the tags', () => {
    enqueue({ value: MIXED, mode: 'prompt' })
    expect(popAllEditable('', 0)?.text).toBe('why does this fail? npm ERR! missing script: test')
  })
})
