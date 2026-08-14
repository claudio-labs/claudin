import { describe, expect, test } from 'bun:test'
import type {
  BetaContextManagementResponse,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { applyMessageDeltaToLastMessage } from 'src/services/api/claude/streaming.js'

// Derive the message type from the function under test instead of importing
// src/types/message.js (tsc can't resolve that module in this fork).
type LastMessage = NonNullable<
  Parameters<typeof applyMessageDeltaToLastMessage>[0]
>

// message_delta write-back: usage/stop_reason always, context_management
// when present (it is only delivered on message_delta — dropping it would
// blind Read's dedup to server-side clear_tool_uses).

function makeUsage(outputTokens: number): BetaUsage {
  return {
    input_tokens: 100,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as BetaUsage
}

function makeAssistantMessage(): LastMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000000',
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hi', citations: null }],
      stop_reason: null,
      stop_sequence: null,
      usage: makeUsage(0),
      container: null,
      context_management: null,
    },
  } as unknown as LastMessage
}

describe('applyMessageDeltaToLastMessage', () => {
  test('writes usage and stop_reason via direct mutation', () => {
    const msg = makeAssistantMessage()
    const inner = msg.message

    applyMessageDeltaToLastMessage(msg, makeUsage(42), 'end_turn', null)

    expect(msg.message).toBe(inner) // same reference — transcript queue holds it
    expect(msg.message.usage.output_tokens).toBe(42)
    expect(msg.message.stop_reason).toBe('end_turn')
    expect(msg.message.context_management).toBeNull()
  })

  test('copies context_management when the delta carries applied edits', () => {
    const msg = makeAssistantMessage()
    const cm: BetaContextManagementResponse = {
      applied_edits: [
        {
          type: 'clear_tool_uses_20250919',
          cleared_tool_uses: 7,
          cleared_input_tokens: 50_000,
        },
      ],
    }

    applyMessageDeltaToLastMessage(msg, makeUsage(1), 'tool_use', cm)

    expect(msg.message.context_management).toEqual(cm)
  })

  test('a delta without context_management leaves the existing value alone', () => {
    const msg = makeAssistantMessage()
    const cm: BetaContextManagementResponse = {
      applied_edits: [
        {
          type: 'clear_tool_uses_20250919',
          cleared_tool_uses: 1,
          cleared_input_tokens: 9,
        },
      ],
    }
    applyMessageDeltaToLastMessage(msg, makeUsage(1), null, cm)

    // A later delta with no context_management must not erase the evidence.
    applyMessageDeltaToLastMessage(msg, makeUsage(2), 'end_turn', undefined)
    expect(msg.message.context_management).toEqual(cm)
  })

  test('tolerates a missing last message', () => {
    expect(() =>
      applyMessageDeltaToLastMessage(undefined, makeUsage(1), null, null),
    ).not.toThrow()
  })
})
