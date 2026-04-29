import { describe, test, expect } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
  stripOldThinkingBlocks,
} from './messages.js'

// Inline fixture helpers
function assistantWithThinking(text = 'reasoning') {
  return createAssistantMessage({
    content: [
      { type: 'thinking', thinking: text, signature: 'sig' } as any,
      { type: 'text', text: 'response' } as any,
    ],
  })
}

function assistantTextOnly(text = 'plain') {
  return createAssistantMessage({ content: text })
}

function userMsg(text = 'hello') {
  return createUserMessage({ content: text })
}

describe('stripOldThinkingBlocks', () => {
  test('strips thinking from old messages, keeps last N', () => {
    // 5 assistant messages with thinking; keepRecentTurns=2 → first 3 stripped
    const msgs = [
      userMsg(),
      assistantWithThinking('t1'),
      userMsg(),
      assistantWithThinking('t2'),
      userMsg(),
      assistantWithThinking('t3'),
      userMsg(),
      assistantWithThinking('t4'),
      userMsg(),
      assistantWithThinking('t5'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)

    // Indices of assistant messages: 1, 3, 5, 7, 9
    // Last 2 thinking turns = indices 7 and 9 → intact
    // First 3 thinking turns = indices 1, 3, 5 → stripped

    const stripped = [1, 3, 5].map(i => result[i] as ReturnType<typeof assistantWithThinking>)
    for (const msg of stripped) {
      const hasThinking = msg.message.content.some((b: any) => b.type === 'thinking')
      expect(hasThinking).toBe(false)
    }

    const kept = [7, 9].map(i => result[i] as ReturnType<typeof assistantWithThinking>)
    for (const msg of kept) {
      const hasThinking = msg.message.content.some((b: any) => b.type === 'thinking')
      expect(hasThinking).toBe(true)
    }
  })

  test('empty content after strip gets placeholder text block', () => {
    // Message has only a thinking block — after stripping it should get a placeholder
    const thinkingOnly = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'inner', signature: 'sig' } as any],
    })
    const msgs = [
      userMsg(),
      thinkingOnly,
      userMsg(),
      assistantWithThinking('keep1'),
      userMsg(),
      assistantWithThinking('keep2'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)
    const stripped = result[1] as ReturnType<typeof assistantWithThinking>
    expect(stripped.message.content).toEqual([
      { type: 'text', text: '[thinking omitted]', citations: [] },
    ])
  })

  test('never strips redacted_thinking blocks', () => {
    const withRedacted = createAssistantMessage({
      content: [
        { type: 'redacted_thinking', data: 'opaque' } as any,
        { type: 'text', text: 'visible' } as any,
      ],
    })
    // Put it as an old turn — it should still survive
    const msgs = [
      userMsg(),
      withRedacted,
      userMsg(),
      assistantWithThinking('k1'),
      userMsg(),
      assistantWithThinking('k2'),
      userMsg(),
      assistantWithThinking('k3'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)
    const maybeStripped = result[1] as ReturnType<typeof assistantWithThinking>
    const redactedBlock = maybeStripped.message.content.find(
      (b: any) => b.type === 'redacted_thinking',
    )
    expect(redactedBlock).toBeDefined()
    expect(redactedBlock).toMatchObject({ type: 'redacted_thinking', data: 'opaque' })
  })

  test('passthrough when no thinking blocks in history', () => {
    const msgs = [
      userMsg('a'),
      assistantTextOnly('r1'),
      userMsg('b'),
      assistantTextOnly('r2'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)
    // Same reference — no mutation occurred
    expect(result).toBe(msgs)
  })

  test('ISP layout: strips thinking blocks interleaved with tool_use in old messages', () => {
    // ISP: thinking block appears before tool_use in the same message
    const ispMsg = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'pre-tool reasoning', signature: 'sig' } as any,
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } as any,
      ],
    })
    const msgs = [
      userMsg(),
      ispMsg,
      userMsg(),
      assistantWithThinking('k1'),
      userMsg(),
      assistantWithThinking('k2'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)
    const strippedMsg = result[1] as ReturnType<typeof assistantWithThinking>
    const hasThinking = strippedMsg.message.content.some((b: any) => b.type === 'thinking')
    expect(hasThinking).toBe(false)
    // tool_use block should remain
    const hasToolUse = strippedMsg.message.content.some((b: any) => b.type === 'tool_use')
    expect(hasToolUse).toBe(true)
  })

  test('user messages are never modified', () => {
    const user1 = userMsg('first')
    const user2 = userMsg('second')
    const msgs = [
      user1,
      assistantWithThinking('t1'),
      user2,
      assistantWithThinking('t2'),
      userMsg(),
      assistantWithThinking('keep'),
    ]
    const result = stripOldThinkingBlocks(msgs, 1)
    // User messages at indices 0, 2, 4 must be identical references
    expect(result[0]).toBe(user1)
    expect(result[2]).toBe(user2)
  })
})
