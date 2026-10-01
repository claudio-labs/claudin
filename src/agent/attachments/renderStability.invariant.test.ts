/**
 * Invariant: every attachment type renders the same bytes every time it is
 * sent — on each later request of the session, and after a --resume rebuilt
 * the history from the transcript.
 *
 * An attachment is rendered again on every request after it arrives
 * (normalizeAttachmentForAPI), so it is part of the prompt-cache prefix; a
 * renderer that reads live state, or a type the transcript drops while it
 * still renders bytes, moves that prefix and — on Opus 5.5 — drops the thinking
 * after it. The payloads come from __testutils__/attachmentFixtures.ts, a
 * mapped type over the Attachment union: a new type does not compile without
 * one. How the agent loop carries each type into the next turn is checked in
 * src/agent/cache/loopPrefix.invariant.test.ts over the same fixtures.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { ATTACHMENT_FIXTURES } from 'src/agent/attachments/__testutils__/attachmentFixtures.js'
import { wireMessages } from 'src/agent/cache/__testutils__/prefixInvariant.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { deserializeMessages } from 'src/sessions/conversationRecovery.js'
import { ATTACHMENT_PERSISTENCE } from 'src/sessions/pure/attachmentPersistence.js'
import { cleanMessagesForLogging } from 'src/sessions/sessionStorage.js'
import type { Message } from 'src/shared/types/message.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

const TYPES = Object.keys(ATTACHMENT_FIXTURES) as Attachment['type'][]

function render(attachment: Attachment): string {
  return JSON.stringify(normalizeAttachmentForAPI(attachment).map(m => m.message.content))
}

/** A finished turn that received the attachment, as the API sees it. */
function sentWith(history: Message[]): string[] {
  return wireMessages(history, [])
}

describe.each(TYPES)('%s', type => {
  const attachment = ATTACHMENT_FIXTURES[type] as Attachment

  test('renders the same bytes every time', () => {
    expect(render(attachment)).toBe(render(attachment))
  })

  if (ATTACHMENT_PERSISTENCE[type] === 'skip') {
    // `skip` is the transcript's promise that nothing reaches the API: a type
    // that renders bytes but is not persisted is missing after a --resume,
    // and every message after it is written again.
    test('the transcript skips it, so it renders nothing', () => {
      expect(normalizeAttachmentForAPI(attachment)).toEqual([])
    })
  } else {
    test('a --resume re-sends the bytes the live session sent', () => {
      const history: Message[] = [
        createUserMessage({ content: 'do the thing' }),
        createAttachmentMessage(attachment),
        createAssistantMessage({ content: 'done' }),
      ]
      const resumed = deserializeMessages(
        JSON.parse(JSON.stringify(cleanMessagesForLogging(history))),
      )
      expect(sentWith(resumed)).toEqual(sentWith(history))
    })
  }
})
