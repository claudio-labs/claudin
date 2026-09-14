import { APIError } from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import { getAssistantMessageFromError } from 'src/providers/transport/errors.js'

function getFirstText(message: ReturnType<typeof getAssistantMessageFromError>): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

test('maps endpoint_not_found category markers to actionable setup guidance', () => {
  const error = APIError.generate(
    404,
    undefined,
    'OpenAI API error 404: Not Found [openai_category=endpoint_not_found] Hint: Confirm OPENAI_BASE_URL includes /v1.',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'qwen2.5-coder:7b')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(text).toContain('Provider endpoint was not found')
  expect(text).toContain('OPENAI_BASE_URL')
  expect(text).toContain('/v1')
})

test('maps tool_call_incompatible category markers to model/tool guidance', () => {
  const error = APIError.generate(
    400,
    undefined,
    'OpenAI API error 400: tool_calls are not supported [openai_category=tool_call_incompatible]',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'qwen2.5-coder:7b')
  const text = getFirstText(message)

  expect(text).toContain('rejected tool-calling payloads')
  expect(text).toContain('/model')
})

test('a 429 gets the unified limit message with its reset, not the flat sentence', () => {
  // The category marker is present and would otherwise win: the shim's
  // rate_limited case has no access to the response headers, so it can only
  // say "retry in a few seconds" for a limit that clears in two hours.
  const resetsInTwoHours = String(Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60)
  const error = APIError.generate(
    429,
    undefined,
    'OpenAI API error 429: rate limit exceeded [openai_category=rate_limited]',
    new Headers({ 'anthropic-ratelimit-unified-reset': resetsInTwoHours }),
  )

  const text = getFirstText(getAssistantMessageFromError(error, 'gpt-5'))

  expect(text).toStartWith('Rate limit reached · ')
  expect(text).toContain('resets in 2h 14m')
  expect(text).not.toContain('Retry in a few seconds')
})

test('a 429 with no reset signal says so instead of inventing one', () => {
  const error = APIError.generate(
    429,
    undefined,
    'OpenAI API error 429: monthly spend limit of $50 exceeded [openai_category=rate_limited]',
    new Headers(),
  )

  const text = getFirstText(getAssistantMessageFromError(error, 'gpt-5'))

  expect(text).toStartWith('Rate limit reached · ')
  expect(text).toContain('no reset time reported')
  // The provider's own reason is what discriminates this from the shim's
  // category fallback, which builds the same head and tail with no detail —
  // without this assertion the test passes with the whole 429 arm deleted.
  expect(text).toContain('monthly spend limit of $50 exceeded')
})

test('billing exhaustion is reported as exhausted, not as a wait', () => {
  const error = APIError.generate(
    429,
    undefined,
    'OpenAI API error 429: You exceeded your current quota [openai_category=rate_limited]',
    new Headers({ 'retry-after': '30' }),
  )

  const text = getFirstText(getAssistantMessageFromError(error, 'gpt-5'))

  expect(text).toStartWith('Quota exhausted · ')
  expect(text).toContain('/provider')
  expect(text).not.toContain('resets in')
})

test('a 1M-context entitlement 429 keeps its own hint instead of a countdown', () => {
  // Not a usage limit: no amount of waiting enables extra usage, so this has
  // to be checked before the unified limit arm claims every 429.
  const error = APIError.generate(
    429,
    undefined,
    'Extra usage is required for long context',
    new Headers({ 'retry-after': '3600' }),
  )

  const text = getFirstText(getAssistantMessageFromError(error, 'claude-opus-5'))

  expect(text).toContain('Extra usage is required for 1M context')
  expect(text).not.toContain('Rate limit reached')
})

test('a JSON envelope is unwrapped to the inner message', () => {
  const error = APIError.generate(
    429,
    undefined,
    '{"type":"error","message":"concurrent requests exceeded"}',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'gpt-5')
  const text = getFirstText(message)

  expect(text).toStartWith('Rate limit reached · ')
  expect(text).toContain('concurrent requests exceeded')
  expect(text).not.toContain('{"type"')
  expect(message.errorDetails).toBe('concurrent requests exceeded')
})

test('a reset time displaces the provider wording from the line', () => {
  // With a countdown to show, the boilerplate reason is noise.
  const error = APIError.generate(
    429,
    undefined,
    'OpenAI API error 429: rate limit exceeded [openai_category=rate_limited]',
    new Headers({ 'retry-after': '7200' }),
  )

  const message = getAssistantMessageFromError(error, 'gpt-5')

  expect(getFirstText(message)).not.toContain('rate limit exceeded')
  expect(message.errorDetails).toContain('rate limit exceeded')
})
