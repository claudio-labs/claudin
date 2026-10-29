import { describe, expect, test } from 'bun:test'
import {
  classifyStreamEnd,
  type StreamEndFacts,
} from 'src/providers/shims/claude/streamEnd.js'

const facts = (over: Partial<StreamEndFacts>): StreamEndFacts => ({
  sawMessageStart: true,
  blockTypes: ['text'],
  stopReason: 'end_turn',
  ...over,
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
