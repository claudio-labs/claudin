import { afterEach, describe, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import {
  classifyStreamEnd,
  endsWithStructuredOutputCall,
  type StreamEndFacts,
} from 'src/providers/shims/claude/streamEnd.js'

const facts = (over: Partial<StreamEndFacts>): StreamEndFacts => ({
  sawMessageStart: true,
  blockTypes: ['text'],
  stopReason: 'end_turn',
  answersStructuredOutput: false,
  ...over,
})

describe('endsWithStructuredOutputCall', () => {
  const call = (name: string) =>
    createAssistantMessage({
      content: [{ type: 'tool_use', id: 'call_1', name, input: {} }] as never,
    })
  const result = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] as never,
  })

  test('the last assistant turn called StructuredOutput: true', () => {
    expect(
      endsWithStructuredOutputCall([createUserMessage({ content: 'go' }), call('StructuredOutput'), result]),
    ).toBe(true)
  })

  test('any other last call, or none: false', () => {
    expect(endsWithStructuredOutputCall([createUserMessage({ content: 'go' }), call('Read'), result])).toBe(false)
    expect(endsWithStructuredOutputCall([createUserMessage({ content: 'go' })])).toBe(false)
    expect(
      endsWithStructuredOutputCall([
        createUserMessage({ content: 'go' }),
        call('StructuredOutput'),
        result,
        call('Read'),
        result,
      ]),
    ).toBe(false)
  })
})

describe('classifyStreamEnd', () => {
  test('no message_start: incomplete, whatever else arrived', () => {
    expect(
      classifyStreamEnd(facts({ sawMessageStart: false })),
    ).toEqual({ kind: 'incomplete', reason: 'no-message-start' })
    expect(
      classifyStreamEnd(
        facts({ sawMessageStart: false, blockTypes: [], stopReason: null }),
      ),
    ).toEqual({ kind: 'incomplete', reason: 'no-message-start' })
  })

  test('message_start, no block and no stop_reason: incomplete', () => {
    expect(
      classifyStreamEnd(facts({ blockTypes: [], stopReason: null })),
    ).toEqual({ kind: 'incomplete', reason: 'no-content' })
  })

  test('no block but a stop_reason: complete (structured-output turn 2)', () => {
    expect(
      classifyStreamEnd(facts({ blockTypes: [], stopReason: 'end_turn' })),
    ).toEqual({ kind: 'complete' })
  })

  test('blocks without a stop_reason: complete (providers that skip finish_reason)', () => {
    expect(
      classifyStreamEnd(facts({ blockTypes: ['text'], stopReason: null })),
    ).toEqual({ kind: 'complete' })
  })

  test('text, tool_use and thinking followed by a reply: complete', () => {
    expect(classifyStreamEnd(facts({}))).toEqual({ kind: 'complete' })
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking', 'tool_use'], stopReason: 'tool_use' }),
      ),
    ).toEqual({ kind: 'complete' })
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking', 'text'], stopReason: 'end_turn' }),
      ),
    ).toEqual({ kind: 'complete' })
  })

  test('thinking that ran out of output: complete (max_tokens is handled upstream)', () => {
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking'], stopReason: 'max_tokens' }),
      ),
    ).toEqual({ kind: 'complete' })
  })
})

// A reply that thinks and then ends the turn without a word or a tool call
// left the user with nothing to read; gemini-cli retries it
// (THINKING_ONLY_RESPONSE, geminiChat.ts) and so does every provider here.
describe('classifyStreamEnd: a thinking-only reply', () => {
  const originalSwitch = process.env.CLAUDIN_THINKING_ONLY_RETRY
  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.CLAUDIN_THINKING_ONLY_RETRY
    else process.env.CLAUDIN_THINKING_ONLY_RETRY = originalSwitch
  })

  test('thinking blocks then end_turn: incomplete', () => {
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking'], stopReason: 'end_turn' }),
      ),
    ).toEqual({ kind: 'incomplete', reason: 'thinking-only' })
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking', 'redacted_thinking'], stopReason: 'end_turn' }),
      ),
    ).toEqual({ kind: 'incomplete', reason: 'thinking-only' })
  })

  test('after a StructuredOutput call the model is done: complete', () => {
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking'], stopReason: 'end_turn', answersStructuredOutput: true }),
      ),
    ).toEqual({ kind: 'complete' })
  })

  test('CLAUDIN_THINKING_ONLY_RETRY=0 keeps it complete', () => {
    process.env.CLAUDIN_THINKING_ONLY_RETRY = '0'
    expect(
      classifyStreamEnd(
        facts({ blockTypes: ['thinking'], stopReason: 'end_turn' }),
      ),
    ).toEqual({ kind: 'complete' })
  })
})
