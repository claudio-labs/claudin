import { describe, expect, test } from 'bun:test'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  getAssistantMessageContentLength,
  getCurrentUsage,
  getTokenUsage,
  messageTokenCountFromLastAPIResponse,
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from 'src/agent/context/tokens.js'
import {
  INTERRUPT_MESSAGE,
  NO_RESPONSE_REQUESTED,
  SYNTHETIC_MODEL,
} from 'src/agent/messages/constants.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { roughTokenCountEstimationForMessages } from 'src/shared/tokenEstimation.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'

// Every walker here answers "what did the LAST real API response say", and
// each one skips the same two kinds of record to get there: a synthetic
// assistant message (interrupt, no-response, the <synthetic> model) and
// anything that is not an assistant message at all. None of these fixtures
// carries a compact boundary.

type UsageFields = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  iterations?: Array<{ input_tokens: number; output_tokens: number }> | null
}

function real(
  usage: UsageFields,
  opts: { id?: string; content?: string | BetaContentBlock[] } = {},
): AssistantMessage {
  const msg = createAssistantMessage({ content: opts.content ?? 'done' })
  Object.assign(msg.message as Record<string, unknown>, {
    id: opts.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    model: 'claude-sonnet-4',
    usage,
  })
  return msg
}

const user = (text: string): Message => createUserMessage({ content: text })

const USAGE_A: UsageFields = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 4_000,
}
const USAGE_B: UsageFields = {
  input_tokens: 7,
  output_tokens: 3,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 80,
}

describe('getTokenUsage', () => {
  test('returns the usage of a real assistant message', () => {
    const msg = real(USAGE_A)
    expect(getTokenUsage(msg)).toBe(msg.message.usage)
  })

  test('ignores a user message', () => {
    expect(getTokenUsage(user('hi'))).toBeUndefined()
  })

  test('ignores an assistant message from the synthetic model', () => {
    // createAssistantMessage stamps SYNTHETIC_MODEL by default.
    const msg = createAssistantMessage({ content: 'local' })
    expect(msg.message.model).toBe(SYNTHETIC_MODEL)
    expect(getTokenUsage(msg)).toBeUndefined()
  })

  test('ignores a synthetic text message even on a real model', () => {
    expect(getTokenUsage(real(USAGE_A, { content: INTERRUPT_MESSAGE }))).toBeUndefined()
    expect(
      getTokenUsage(real(USAGE_A, { content: NO_RESPONSE_REQUESTED })),
    ).toBeUndefined()
  })

  test('a synthetic string that is not the FIRST block does not disqualify', () => {
    const msg = real(USAGE_A, {
      content: [
        { type: 'text', text: 'real answer', citations: null },
        { type: 'text', text: INTERRUPT_MESSAGE, citations: null },
      ] as BetaContentBlock[],
    })
    expect(getTokenUsage(msg)).toBe(msg.message.usage)
  })

  test('tolerates an undefined entry', () => {
    expect(getTokenUsage(undefined as unknown as Message)).toBeUndefined()
  })
})

describe('tokenCountFromLastAPIResponse', () => {
  test('sums input, both cache counts and output of the last response', () => {
    const history = [user('a'), real(USAGE_B), user('b'), real(USAGE_A)]
    expect(tokenCountFromLastAPIResponse(history)).toBe(100 + 300 + 4_000 + 20)
  })

  test('walks back past trailing user and synthetic messages', () => {
    const history = [
      real(USAGE_A),
      user('next'),
      createAssistantMessage({ content: 'synthetic' }),
    ]
    expect(tokenCountFromLastAPIResponse(history)).toBe(4_420)
  })

  test('treats missing cache counts as zero', () => {
    const history = [
      real({
        input_tokens: 5,
        output_tokens: 6,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ]
    expect(tokenCountFromLastAPIResponse(history)).toBe(11)
  })

  test('answers 0 when no message carries real usage', () => {
    expect(tokenCountFromLastAPIResponse([])).toBe(0)
    expect(tokenCountFromLastAPIResponse([user('only')])).toBe(0)
  })
})

describe('finalContextTokensFromLastResponse', () => {
  test('uses the last iteration when the server ran a tool loop', () => {
    const history = [
      real({
        ...USAGE_A,
        iterations: [
          { input_tokens: 1, output_tokens: 2 },
          { input_tokens: 50, output_tokens: 9 },
        ],
      }),
    ]
    expect(finalContextTokensFromLastResponse(history)).toBe(59)
  })

  test('falls back to top-level input + output, excluding cache', () => {
    expect(finalContextTokensFromLastResponse([real(USAGE_A)])).toBe(120)
    expect(
      finalContextTokensFromLastResponse([real({ ...USAGE_A, iterations: [] })]),
    ).toBe(120)
  })

  test('reads the LAST real response and skips trailing non-usage records', () => {
    const history = [real(USAGE_A), real(USAGE_B), user('after')]
    expect(finalContextTokensFromLastResponse(history)).toBe(10)
  })

  test('answers 0 with no usage', () => {
    expect(finalContextTokensFromLastResponse([user('x')])).toBe(0)
  })
})

describe('messageTokenCountFromLastAPIResponse', () => {
  test('is only the output tokens of the last response', () => {
    const history = [real(USAGE_A), user('x'), real(USAGE_B), user('y')]
    expect(messageTokenCountFromLastAPIResponse(history)).toBe(3)
  })

  test('answers 0 with no usage', () => {
    expect(messageTokenCountFromLastAPIResponse([])).toBe(0)
  })
})

describe('getCurrentUsage', () => {
  test('returns the four fields of the last real response', () => {
    const history = [real(USAGE_B), user('x'), real(USAGE_A), user('y')]
    expect(getCurrentUsage(history)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 4_000,
    })
  })

  test('normalizes missing cache counts to 0', () => {
    expect(
      getCurrentUsage([
        real({
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: undefined,
        }),
      ]),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test('answers null when nothing carries real usage', () => {
    expect(getCurrentUsage([])).toBeNull()
    expect(
      getCurrentUsage([user('x'), createAssistantMessage({ content: 'local' })]),
    ).toBeNull()
  })

  test('a compact boundary hides the usage of the responses before it', () => {
    const history = [real(USAGE_A), user('x'), createCompactBoundaryMessage('manual', 4_420), user('summary')]
    expect(getCurrentUsage(history)).toBeNull()
  })

  test('after a compact boundary, the first new response is the current usage', () => {
    const history = [real(USAGE_A), createCompactBoundaryMessage('auto', 4_420), user('summary'), real(USAGE_B)]
    expect(getCurrentUsage(history)).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 80,
    })
  })
})

describe('doesMostRecentAssistantMessageExceed200k', () => {
  test('is true only above 200k on the most recent assistant message', () => {
    const big = real({ input_tokens: 200_000, output_tokens: 1 })
    const exact = real({ input_tokens: 199_999, output_tokens: 1 })
    expect(doesMostRecentAssistantMessageExceed200k([big])).toBe(true)
    expect(doesMostRecentAssistantMessageExceed200k([exact])).toBe(false)
  })

  test('counts cache tokens toward the threshold', () => {
    const msg = real({
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 200_000,
    })
    expect(doesMostRecentAssistantMessageExceed200k([msg])).toBe(true)
  })

  test('looks at the most recent assistant only, not further back', () => {
    const big = real({ input_tokens: 300_000, output_tokens: 0 })
    // A synthetic last assistant has no usage, so the answer is false even
    // though an earlier one was over.
    const synthetic = createAssistantMessage({ content: 'local' })
    expect(doesMostRecentAssistantMessageExceed200k([big, user('x')])).toBe(true)
    expect(doesMostRecentAssistantMessageExceed200k([big, synthetic])).toBe(false)
  })

  test('is false with no assistant message', () => {
    expect(doesMostRecentAssistantMessageExceed200k([user('x')])).toBe(false)
  })
})

describe('getAssistantMessageContentLength', () => {
  test('counts text, thinking, redacted thinking and tool_use input', () => {
    const msg = real(USAGE_A, {
      content: [
        { type: 'text', text: 'abcd', citations: null },
        { type: 'thinking', thinking: 'xyz', signature: 'ignored-signature' },
        { type: 'redacted_thinking', data: '12345' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { a: 1 } },
      ] as BetaContentBlock[],
    })
    // '{"a":1}' is 7 characters; the signature does not count.
    expect(getAssistantMessageContentLength(msg)).toBe(4 + 3 + 5 + 7)
  })

  test('is 0 for blocks it does not count', () => {
    const msg = real(USAGE_A, {
      content: [
        {
          type: 'server_tool_use',
          id: 's1',
          name: 'web_search',
          input: { query: 'long query text' },
        },
      ] as unknown as BetaContentBlock[],
    })
    expect(getAssistantMessageContentLength(msg)).toBe(0)
  })
})

describe('tokenCountWithEstimation', () => {
  test('is the last response sum when nothing arrived after it', () => {
    expect(tokenCountWithEstimation([user('go'), real(USAGE_A)])).toBe(4_420)
  })

  test('adds a rough estimate of everything after the last response', () => {
    const tail = [user('a follow-up message with some words in it')]
    const history = [user('go'), real(USAGE_A), ...tail]
    const estimate = roughTokenCountEstimationForMessages(tail)
    expect(estimate).toBeGreaterThan(0)
    expect(tokenCountWithEstimation(history)).toBe(4_420 + estimate)
  })

  test('with no usage at all, estimates the whole history', () => {
    const history = [user('first words'), user('second words')]
    expect(tokenCountWithEstimation(history)).toBe(
      roughTokenCountEstimationForMessages(history),
    )
  })

  test('anchors at the FIRST split of a parallel-tool response so every interleaved result is estimated', () => {
    const r1 = user('tool result number one, fairly long text')
    const r2 = user('tool result number two, also long text')
    const history = [
      user('go'),
      real(USAGE_A, { id: 'resp_A' }),
      r1,
      real(USAGE_A, { id: 'resp_A' }),
      r2,
    ]
    // Anchored at the first resp_A record: r1, the second split and r2 are
    // all in the estimate, not just r2.
    expect(tokenCountWithEstimation(history)).toBe(
      4_420 + roughTokenCountEstimationForMessages(history.slice(2)),
    )
    expect(tokenCountWithEstimation(history)).toBeGreaterThan(
      4_420 + roughTokenCountEstimationForMessages([r2]),
    )
  })

  test('stops walking back at a different API response', () => {
    const between = user('between the two responses')
    const r1 = user('result after the split')
    const history = [
      real(USAGE_B, { id: 'resp_B' }),
      between,
      real(USAGE_A, { id: 'resp_A' }),
      r1,
    ]
    // Anchored at resp_A: only r1 is estimated, not `between`.
    expect(tokenCountWithEstimation(history)).toBe(
      4_420 + roughTokenCountEstimationForMessages([r1]),
    )
  })

  test('skips trailing synthetic assistant messages when finding the anchor', () => {
    const synthetic = createAssistantMessage({ content: 'local' })
    const history = [real(USAGE_B), synthetic]
    expect(tokenCountWithEstimation(history)).toBe(
      100 + roughTokenCountEstimationForMessages([synthetic]),
    )
  })
})
