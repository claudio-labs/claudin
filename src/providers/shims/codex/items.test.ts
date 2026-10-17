import { describe, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  callStateFor,
  codexStateOf,
  isCodexReasoningBlock,
  messageStateFor,
  reasoningBlockFor,
  reasoningItemFor,
  stripCodexItems,
} from 'src/providers/shims/codex/items.js'
import type { AssistantMessage, UserMessage } from 'src/shared/types/message.js'

const REASONING = { type: 'thinking', thinking: '', signature: '', codex: { id: 'rs_1', encrypted_content: 'enc-1' } }
const COMMENTARY = { type: 'text', text: 'Reading.', citations: [], codex: { id: 'msg_1', phase: 'commentary' } }
const CALL = { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' }, codex: { id: 'fc_1' } }

function assistant(blocks: unknown[]): AssistantMessage {
  return createAssistantMessage({ content: blocks as never })
}

describe('reading Codex item state off a block', () => {
  test('a well-formed state, with only the fields that are strings', () => {
    expect(codexStateOf(REASONING)).toEqual({ id: 'rs_1', encrypted_content: 'enc-1' })
    expect(codexStateOf(COMMENTARY)).toEqual({ id: 'msg_1', phase: 'commentary' })
    expect(codexStateOf({ codex: { id: 'fc_1', phase: 3, encrypted_content: null } })).toEqual({ id: 'fc_1' })
  })

  test.each([[null], ['text'], [[]], [{ type: 'text' }], [{ codex: 'x' }], [{ codex: [] }], [{ codex: { id: 7 } }]])(
    'no state on %p',
    block => {
      expect(codexStateOf(block)).toBeUndefined()
    },
  )

  test('a reasoning block is a thinking block with a codex field, well-formed or not', () => {
    expect(isCodexReasoningBlock(REASONING)).toBe(true)
    expect(isCodexReasoningBlock({ type: 'thinking', thinking: '', codex: {} })).toBe(true)
    expect(isCodexReasoningBlock({ type: 'thinking', thinking: 'deep', signature: 'sig' })).toBe(false)
    expect(isCodexReasoningBlock(COMMENTARY)).toBe(false)
    expect(isCodexReasoningBlock(undefined)).toBe(false)
  })
})

describe('turning output items into block state', () => {
  test('a reasoning item becomes an empty thinking block carrying its payload', () => {
    expect(reasoningBlockFor({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' })).toEqual(
      REASONING,
    )
  })

  test('a reasoning item without an id or a payload has nothing to replay', () => {
    expect(reasoningBlockFor({ type: 'reasoning', id: 'rs_1', summary: [] })).toBeUndefined()
    expect(reasoningBlockFor({ type: 'reasoning', encrypted_content: 'enc' })).toBeUndefined()
  })

  test('a message keeps its id and phase; a call keeps its id', () => {
    expect(messageStateFor({ id: 'msg_1', phase: 'final_answer' })).toEqual({ id: 'msg_1', phase: 'final_answer' })
    expect(messageStateFor({ id: 'msg_1' })).toEqual({ id: 'msg_1' })
    expect(messageStateFor({ phase: 'commentary' })).toBeUndefined()
    expect(callStateFor({ id: 'fc_1', call_id: 'call_1' })).toEqual({ id: 'fc_1' })
    expect(callStateFor({ call_id: 'call_1' })).toBeUndefined()
  })
})

describe('turning a thinking block back into an input item', () => {
  test('a Codex reasoning block replays as the item the CLI sends', () => {
    expect(reasoningItemFor(REASONING)).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'enc-1',
    })
  })

  test.each([
    [{ type: 'thinking', thinking: 'deep', signature: 'sig' }],
    [{ type: 'thinking', thinking: '', codex: { id: 'rs_1' } }],
    [{ type: 'text', text: 'x', codex: { id: 'rs_1', encrypted_content: 'enc' } }],
    [null],
  ])('nothing to replay for %p', block => {
    expect(reasoningItemFor(block)).toBeUndefined()
  })
})

describe('stripCodexItems, for every provider other than the Codex backend', () => {
  test('a history without Codex state comes back as the same array', () => {
    const messages: (UserMessage | AssistantMessage)[] = [
      createUserMessage({ content: 'hi' }),
      assistant([{ type: 'thinking', thinking: 'deep', signature: 'sig' }, { type: 'text', text: 'ok', citations: [] }]),
      createUserMessage({ content: [{ type: 'text', text: 'more' }] }),
    ]
    expect(stripCodexItems(messages)).toBe(messages)
  })

  test('reasoning blocks go, the codex field leaves text and tool_use, the rest is untouched', () => {
    const anthropicThinking = { type: 'thinking', thinking: 'deep', signature: 'sig' }
    const plain = assistant([{ type: 'text', text: 'untouched', citations: [] }])
    const messages: (UserMessage | AssistantMessage)[] = [
      createUserMessage({ content: 'hi' }),
      assistant([anthropicThinking, REASONING, COMMENTARY, CALL]),
      plain,
    ]
    const stripped = stripCodexItems(messages)

    expect(stripped).not.toBe(messages)
    expect(stripped[0]).toBe(messages[0]!)
    expect(stripped[2]).toBe(plain)
    expect((stripped[1] as AssistantMessage).message.content).toEqual([
      anthropicThinking,
      { type: 'text', text: 'Reading.', citations: [] },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } },
    ] as never)
    expect(JSON.stringify(stripped)).not.toContain('enc-1')
    expect(JSON.stringify(stripped)).not.toContain('"codex"')
    // The input history is not mutated.
    expect((messages[1] as AssistantMessage).message.content).toHaveLength(4)
  })

  test('a message left with only thinking gets the placeholder', () => {
    const [stripped] = stripCodexItems([assistant([REASONING])])
    expect((stripped as AssistantMessage).message.content).toEqual([
      { type: 'text', text: '[thinking omitted]', citations: [] },
    ] as never)

    const [withAnthropic] = stripCodexItems([
      assistant([{ type: 'redacted_thinking', data: 'opaque' }, REASONING]),
    ])
    expect((withAnthropic as AssistantMessage).message.content).toEqual([
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '[thinking omitted]', citations: [] },
    ] as never)
  })

  test('an assistant message with string content is left alone', () => {
    const message = assistant([])
    ;(message.message as { content: unknown }).content = 'plain'
    const messages = [message]
    expect(stripCodexItems(messages)).toBe(messages)
  })
})
