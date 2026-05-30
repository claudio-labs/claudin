import { describe, expect, test } from 'bun:test'

import {
  extractReasoningDelta,
  extractReasoningMessage,
} from './reasoningNormalizer.js'

describe('extractReasoningDelta', () => {
  test('returns reasoning_content when set', () => {
    expect(extractReasoningDelta({ reasoning_content: 'thinking...' })).toBe(
      'thinking...',
    )
  })

  test('returns reasoning (bare alias) when set — OpenRouter shape', () => {
    expect(extractReasoningDelta({ reasoning: 'cot from openrouter' })).toBe(
      'cot from openrouter',
    )
  })

  test('returns reasoning_text when set', () => {
    expect(extractReasoningDelta({ reasoning_text: 'cot text' })).toBe(
      'cot text',
    )
  })

  test('returns null when all aliases are empty strings', () => {
    expect(
      extractReasoningDelta({
        reasoning_content: '',
        reasoning: '',
        reasoning_text: '',
        thinking: '',
      }),
    ).toBeNull()
  })

  test('returns null when no reasoning keys are present', () => {
    expect(extractReasoningDelta({ content: 'hello', role: 'assistant' })).toBeNull()
  })

  test('precedence: reasoning_content wins over reasoning when both set', () => {
    expect(
      extractReasoningDelta({
        reasoning_content: 'primary',
        reasoning: 'fallback',
      }),
    ).toBe('primary')
  })
})

describe('extractReasoningMessage', () => {
  test('mirrors extractReasoningDelta for non-streaming choice.message', () => {
    expect(extractReasoningMessage({ reasoning: 'msg cot' })).toBe('msg cot')
    expect(
      extractReasoningMessage({ reasoning_content: 'msg cot 2' }),
    ).toBe('msg cot 2')
    expect(extractReasoningMessage({})).toBeNull()
  })
})
