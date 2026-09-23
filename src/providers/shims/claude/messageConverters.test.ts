import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/shared/types/message.js'
import { getPreviousMessageIdFromMessages } from 'src/providers/shims/claude/messageConverters.js'

const assistant = (id: string): Message =>
  ({ type: 'assistant', message: { id }, uuid: id, timestamp: '' }) as unknown as Message
const user = (): Message =>
  ({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u', timestamp: '' }) as unknown as Message

describe('getPreviousMessageIdFromMessages', () => {
  test('the id of the most recent real response', () => {
    expect(
      getPreviousMessageIdFromMessages([user(), assistant('msg_01A'), user(), assistant('msg_01B'), user()]),
    ).toBe('msg_01B')
  })

  // An API-error or interruption message is not a response the server knows,
  // and naming it would come back as previous_message_not_found.
  test('skips synthetic assistant messages', () => {
    expect(
      getPreviousMessageIdFromMessages([user(), assistant('msg_01A'), assistant('4b3c-uuid')]),
    ).toBe('msg_01A')
  })

  test('undefined on the first turn', () => {
    expect(getPreviousMessageIdFromMessages([user()])).toBeUndefined()
  })
})
