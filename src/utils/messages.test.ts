import { describe, test, expect } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeAttachmentForAPI,
  stripOldNarrationBlocks,
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

  test('keeps thinking in recent turns with tool_use (reasoning_content continuity)', () => {
    // Providers like Moonshot/DeepSeek need reasoning_content on recent
    // assistant tool-call messages. stripOldThinkingBlocks must preserve
    // thinking blocks in the last N turns so the shim can re-attach them.
    const withThinkingAndTool = (text: string) =>
      createAssistantMessage({
        content: [
          { type: 'thinking', thinking: text, signature: 'sig' } as any,
          { type: 'tool_use', id: `toolu_${text}`, name: 'Bash', input: { command: 'echo' } } as any,
        ],
      })

    const msgs = [
      userMsg(),
      withThinkingAndTool('old1'),
      userMsg(),
      withThinkingAndTool('old2'),
      userMsg(),
      withThinkingAndTool('recent1'),
      userMsg(),
      withThinkingAndTool('recent2'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)

    // Old turns (indices 1, 3) — thinking stripped, tool_use kept
    for (const i of [1, 3]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'thinking')).toBe(false)
      expect(msg.message.content.some((b: any) => b.type === 'tool_use')).toBe(true)
    }

    // Recent turns (indices 5, 7) — both thinking and tool_use intact
    for (const i of [5, 7]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'thinking')).toBe(true)
      expect(msg.message.content.some((b: any) => b.type === 'tool_use')).toBe(true)
    }
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

  test('passthrough when fewer thinking turns than keepRecentTurns', () => {
    // Only 1 thinking turn, keepRecentTurns=2 → nothing stripped
    const msgs = [
      userMsg(),
      assistantWithThinking('only-one'),
      userMsg(),
      assistantTextOnly('no-thinking'),
    ]
    const result = stripOldThinkingBlocks(msgs, 2)
    expect(result).toBe(msgs)
  })
})

// Assistant turn that narrates (text) AND calls a tool in the same message.
function assistantNarrationWithTool(text: string, toolId = text) {
  return createAssistantMessage({
    content: [
      { type: 'text', text } as any,
      { type: 'tool_use', id: `toolu_${toolId}`, name: 'Read', input: {} } as any,
    ],
  })
}

function assistantNarrationWithThinkingAndTool(text: string, toolId = text) {
  return createAssistantMessage({
    content: [
      { type: 'thinking', thinking: `reasoning-${text}`, signature: `sig-${text}` } as any,
      { type: 'text', text } as any,
      { type: 'tool_use', id: `toolu_${toolId}`, name: 'Read', input: {} } as any,
    ],
  })
}

describe('stripOldNarrationBlocks', () => {
  test('strips narration text from old turns, keeps last N', () => {
    // 5 narration turns (text + tool_use); keepRecentTurns=2 → first 3 stripped
    const msgs = [
      userMsg(),
      assistantNarrationWithTool('n1'),
      userMsg(),
      assistantNarrationWithTool('n2'),
      userMsg(),
      assistantNarrationWithTool('n3'),
      userMsg(),
      assistantNarrationWithTool('n4'),
      userMsg(),
      assistantNarrationWithTool('n5'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)

    // Assistant indices: 1, 3, 5, 7, 9. Last 2 (7, 9) kept; first 3 (1, 3, 5) stripped.
    for (const i of [1, 3, 5]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'text')).toBe(false)
      // tool_use survives — turn never becomes empty
      expect(msg.message.content.some((b: any) => b.type === 'tool_use')).toBe(true)
    }
    for (const i of [7, 9]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'text')).toBe(true)
      expect(msg.message.content.some((b: any) => b.type === 'tool_use')).toBe(true)
    }
  })

  test('never strips final-answer text (text without tool_use)', () => {
    // Old assistant turns with ONLY text (no tool_use) are final answers, kept.
    const msgs = [
      userMsg(),
      assistantTextOnly('answer-1'),
      userMsg(),
      assistantNarrationWithTool('n1'),
      userMsg(),
      assistantNarrationWithTool('n2'),
      userMsg(),
      assistantNarrationWithTool('n3'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    // The text-only message at index 1 is untouched (not a narration turn).
    const answer = result[1] as ReturnType<typeof createAssistantMessage>
    expect(answer.message.content.some((b: any) => b.type === 'text')).toBe(true)
  })

  test('stripped narration turn keeps its tool_use (never empty)', () => {
    const msgs = [
      userMsg(),
      assistantNarrationWithTool('old'),
      userMsg(),
      assistantNarrationWithTool('keep1'),
      userMsg(),
      assistantNarrationWithTool('keep2'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    const stripped = result[1] as ReturnType<typeof createAssistantMessage>
    expect(stripped.message.content).toEqual([
      { type: 'tool_use', id: 'toolu_old', name: 'Read', input: {} },
    ])
  })

  test('passthrough when no narration turns (text-only / tool-only)', () => {
    const toolOnly = createAssistantMessage({
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} } as any],
    })
    const msgs = [
      userMsg('a'),
      assistantTextOnly('r1'),
      userMsg('b'),
      toolOnly,
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    // No turn mixes text + tool_use → same reference, no mutation.
    expect(result).toBe(msgs)
  })

  test('passthrough when fewer narration turns than keepRecentTurns', () => {
    const msgs = [
      userMsg(),
      assistantNarrationWithTool('only-one'),
      userMsg(),
      assistantTextOnly('plain'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    expect(result).toBe(msgs)
  })

  test('user messages are never modified', () => {
    const user1 = userMsg('first')
    const user2 = userMsg('second')
    const msgs = [
      user1,
      assistantNarrationWithTool('n1'),
      user2,
      assistantNarrationWithTool('n2'),
      userMsg(),
      assistantNarrationWithTool('keep'),
    ]
    const result = stripOldNarrationBlocks(msgs, 1)
    expect(result[0]).toBe(user1)
    expect(result[2]).toBe(user2)
  })

  // Regression: stripping text from a [thinking, text, tool_use] turn shifts
  // the remaining block indices, which invalidates the signed-thinking
  // position chain the API requires byte-identical. Server rejects with 400:
  // "thinking or redacted_thinking blocks in the latest assistant message
  // cannot be modified." Diagnosed on Opus 4.8 + adaptive thinking.
  test('never strips text from turns that also contain a thinking block', () => {
    const msgs = [
      userMsg(),
      assistantNarrationWithThinkingAndTool('t1'),
      userMsg(),
      assistantNarrationWithThinkingAndTool('t2'),
      userMsg(),
      assistantNarrationWithThinkingAndTool('t3'),
      userMsg(),
      assistantNarrationWithThinkingAndTool('t4'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    // None of the thinking-bearing turns should lose their text block.
    for (const i of [1, 3, 5, 7]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'text')).toBe(true)
      expect(msg.message.content.some((b: any) => b.type === 'thinking')).toBe(true)
    }
    // No mutation — same reference passes through.
    expect(result).toBe(msgs)
  })

  test('strips only thinking-free narration turns when history is mixed', () => {
    const msgs = [
      userMsg(),
      assistantNarrationWithTool('plain-1'),               // index 1: strippable
      userMsg(),
      assistantNarrationWithThinkingAndTool('thinks-1'),   // index 3: protected
      userMsg(),
      assistantNarrationWithTool('plain-2'),               // index 5: strippable
      userMsg(),
      assistantNarrationWithThinkingAndTool('thinks-2'),   // index 7: protected
      userMsg(),
      assistantNarrationWithTool('keep'),                  // index 9: kept (last 1)
    ]
    const result = stripOldNarrationBlocks(msgs, 1)
    // Plain narration turns 1 and 5 get stripped; 9 kept.
    expect((result[1] as ReturnType<typeof createAssistantMessage>).message.content.some((b: any) => b.type === 'text')).toBe(false)
    expect((result[5] as ReturnType<typeof createAssistantMessage>).message.content.some((b: any) => b.type === 'text')).toBe(false)
    expect((result[9] as ReturnType<typeof createAssistantMessage>).message.content.some((b: any) => b.type === 'text')).toBe(true)
    // Thinking-bearing turns stay intact regardless of position.
    for (const i of [3, 7]) {
      const msg = result[i] as ReturnType<typeof createAssistantMessage>
      expect(msg.message.content.some((b: any) => b.type === 'text')).toBe(true)
      expect(msg.message.content.some((b: any) => b.type === 'thinking')).toBe(true)
    }
  })

  test('treats redacted_thinking the same as thinking (also protects the turn)', () => {
    const withRedacted = createAssistantMessage({
      content: [
        { type: 'redacted_thinking', data: 'opaque' } as any,
        { type: 'text', text: 'narration' } as any,
        { type: 'tool_use', id: 'toolu_r', name: 'Read', input: {} } as any,
      ],
    })
    const msgs = [
      userMsg(),
      withRedacted,
      userMsg(),
      assistantNarrationWithTool('k1'),
      userMsg(),
      assistantNarrationWithTool('k2'),
      userMsg(),
      assistantNarrationWithTool('k3'),
    ]
    const result = stripOldNarrationBlocks(msgs, 2)
    const protectedMsg = result[1] as ReturnType<typeof createAssistantMessage>
    expect(protectedMsg.message.content.some((b: any) => b.type === 'text')).toBe(true)
    expect(protectedMsg.message.content.some((b: any) => b.type === 'redacted_thinking')).toBe(true)
  })
})

describe('normalizeAttachmentForAPI — relevant_memories collapse', () => {
  test('produces exactly one UserMessage regardless of memory count', () => {
    const memories = Array.from({ length: 5 }, (_, i) => ({
      path: `/m${i}.md`,
      content: `body-${i}`,
      mtimeMs: 1_700_000_000_000 + i * 1000,
      header: `Saved ${i}d ago — m${i}.md`,
    }))
    const out = normalizeAttachmentForAPI({
      type: 'relevant_memories',
      memories,
    })
    expect(out).toHaveLength(1)
    const text = String(
      typeof out[0]!.message.content === 'string'
        ? out[0]!.message.content
        : JSON.stringify(out[0]!.message.content),
    )
    // All headers and bodies must survive the collapse.
    for (let i = 0; i < memories.length; i++) {
      expect(text).toContain(`m${i}.md`)
      expect(text).toContain(`body-${i}`)
    }
    // Separator between bodies preserves visual boundaries.
    expect(text).toContain('---')
    // System-reminder wrapper applied once (not N times).
    const reminderOpens = text.split('<system-reminder>').length - 1
    expect(reminderOpens).toBe(1)
  })

  test('empty memories array returns no messages', () => {
    const out = normalizeAttachmentForAPI({
      type: 'relevant_memories',
      memories: [],
    })
    expect(out).toEqual([])
  })

  test('output is byte-stable across two consecutive calls (cache invariant)', () => {
    // Memory team rule: tool_result/attachment compression must produce
    // byte-identical output across turns or the prompt cache busts.
    const memories = [
      {
        path: '/m.md',
        content: 'b',
        mtimeMs: 1_700_000_000_000,
        header: 'Saved 1d ago — m.md',
      },
    ]
    const a = normalizeAttachmentForAPI({ type: 'relevant_memories', memories })
    const b = normalizeAttachmentForAPI({ type: 'relevant_memories', memories })
    expect(a[0]!.message.content).toBe(b[0]!.message.content)
  })
})
