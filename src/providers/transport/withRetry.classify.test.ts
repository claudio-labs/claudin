// Characterization of withRetry's pure classifiers: shouldRetry, getRetryDelay,
// is529Error, parseMaxTokensContextOverflowError and the two error classes.
// shouldRetry's account questions go through its injected RetryAccountDeps, so
// nothing here depends on the developer's credentials (or on a suite that
// mock.module's auth.js).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import {
  BASE_DELAY_MS,
  CannotRetryError,
  FallbackTriggeredError,
  fallbackReasonFor,
  getDefaultMaxRetries,
  getRetryDelay,
  is529Error,
  isThinkingBlockMismatchError,
  parseMaxTokensContextOverflowError,
  shouldRetry,
} from 'src/providers/transport/withRetry.js'

const ENV_KEYS = ['CLAUDE_CODE_REMOTE', 'CLAUDIN_MAX_RETRIES'] as const
const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
})
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

const PAYG = { isSubscriber: () => false, isEnterprise: () => false }
const SUBSCRIBER = { isSubscriber: () => true, isEnterprise: () => false }
const ENTERPRISE = { isSubscriber: () => true, isEnterprise: () => true }

function apiError(status: number | undefined, message: string, headers: Record<string, string> = {}): APIError {
  return new APIError(status, { message }, message, new Headers(headers))
}

describe('shouldRetry - status classes', () => {
  test.each([500, 502, 503, 504, 529])('%i is retried', status => {
    expect(shouldRetry(apiError(status, 'server'), 1, PAYG)).toBe(true)
  })

  test('408 and 409 are retried', () => {
    expect(shouldRetry(apiError(408, 'request timeout'), 1, PAYG)).toBe(true)
    expect(shouldRetry(apiError(409, 'lock timeout'), 1, PAYG)).toBe(true)
  })

  test.each([400, 404, 413, 422])('%i is not retried', status => {
    expect(shouldRetry(apiError(status, 'client'), 1, PAYG)).toBe(false)
  })

  test('an error with no status is not retried', () => {
    expect(shouldRetry(apiError(undefined, 'no status'), 1, PAYG)).toBe(false)
  })

  test('a connection error is retried', () => {
    expect(shouldRetry(new APIConnectionError({ message: 'Connection error.' }), 1, PAYG)).toBe(true)
  })

  test('a 401 is retried (the loop refreshes the client)', () => {
    expect(shouldRetry(apiError(401, 'invalid x-api-key'), 1, PAYG)).toBe(true)
  })

  test('a 403 is retried only when the OAuth token was revoked', () => {
    expect(shouldRetry(apiError(403, 'OAuth token has been revoked'), 1, PAYG)).toBe(true)
    expect(shouldRetry(apiError(403, 'permission denied'), 1, PAYG)).toBe(false)
  })

  test('the overloaded_error body is retried whatever the status', () => {
    const e = new APIError(400, { type: 'error', error: { type: 'overloaded_error' } }, undefined, new Headers())
    expect(shouldRetry(e, 1, PAYG)).toBe(true)
  })

  test('a max_tokens context overflow is retried', () => {
    const e = apiError(400, 'input length and `max_tokens` exceed context limit: 1 + 2 > 3')
    expect(shouldRetry(e, 1, PAYG)).toBe(true)
  })

  test('a thinking-block mismatch is retried', () => {
    expect(shouldRetry(apiError(400, 'thinking blocks cannot be modified'), 1, PAYG)).toBe(true)
  })
})

describe('shouldRetry - rate limits and the account', () => {
  test('a short 429 is retried for pay-as-you-go and enterprise, not for a subscriber', () => {
    const e = () => apiError(429, 'rate limited', { 'retry-after': '3' })
    expect(shouldRetry(e(), 1, PAYG)).toBe(true)
    expect(shouldRetry(e(), 1, ENTERPRISE)).toBe(true)
    expect(shouldRetry(e(), 1, SUBSCRIBER)).toBe(false)
  })

  test('a long 429 is never retried, even for enterprise', () => {
    const e = apiError(429, 'rate limited', { 'retry-after': '7200' })
    expect(shouldRetry(e, 1, PAYG)).toBe(false)
    expect(shouldRetry(e, 1, ENTERPRISE)).toBe(false)
  })

  test('a quota-exhausted 429 is not retried', () => {
    expect(shouldRetry(apiError(429, 'You exceeded your current quota'), 1, PAYG)).toBe(false)
    expect(shouldRetry(apiError(429, 'Quota exceeded, limit: 0'), 1, PAYG)).toBe(false)
  })

  test('x-should-retry: true is obeyed except for a non-enterprise subscriber', () => {
    const e = () => apiError(400, 'bad', { 'x-should-retry': 'true' })
    expect(shouldRetry(e(), 1, PAYG)).toBe(true)
    expect(shouldRetry(e(), 1, ENTERPRISE)).toBe(true)
    // Falls through to the status: a 400 is final.
    expect(shouldRetry(e(), 1, SUBSCRIBER)).toBe(false)
  })

  test('x-should-retry: false beats a retriable status', () => {
    expect(shouldRetry(apiError(503, 'x', { 'x-should-retry': 'false' }), 1, PAYG)).toBe(false)
  })

  test('under CLAUDE_CODE_REMOTE a 401/403 is retried even against x-should-retry: false', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(shouldRetry(apiError(403, 'permission denied', { 'x-should-retry': 'false' }), 1, PAYG)).toBe(true)
    expect(shouldRetry(apiError(401, 'invalid', { 'x-should-retry': 'false' }), 1, PAYG)).toBe(true)
    // Other statuses are untouched.
    expect(shouldRetry(apiError(400, 'bad'), 1, PAYG)).toBe(false)
  })

  test('without CLAUDE_CODE_REMOTE that 403 is final', () => {
    expect(shouldRetry(apiError(403, 'permission denied', { 'x-should-retry': 'false' }), 1, PAYG)).toBe(false)
  })
})

describe('getRetryDelay', () => {
  test('a retry-after hint wins, zero included', () => {
    expect(getRetryDelay(1, 0)).toBe(0)
    expect(getRetryDelay(5, 1234)).toBe(1234)
  })

  test('a negative or missing hint falls back to exponential backoff with up to 25% jitter', () => {
    for (const [attempt, base] of [[1, BASE_DELAY_MS], [2, 1000], [4, 4000]] as const) {
      const d = getRetryDelay(attempt, -1)
      expect(d).toBeGreaterThanOrEqual(base)
      expect(d).toBeLessThanOrEqual(base * 1.25)
      const n = getRetryDelay(attempt, null)
      expect(n).toBeGreaterThanOrEqual(base)
      expect(n).toBeLessThanOrEqual(base * 1.25)
    }
  })

  test('the backoff is capped at maxDelayMs (32 s by default)', () => {
    const d = getRetryDelay(20)
    expect(d).toBeGreaterThanOrEqual(32000)
    expect(d).toBeLessThanOrEqual(40000)
    const c = getRetryDelay(20, undefined, 1000)
    expect(c).toBeGreaterThanOrEqual(1000)
    expect(c).toBeLessThanOrEqual(1250)
  })

  test('BASE_DELAY_MS is 500', () => {
    expect(BASE_DELAY_MS).toBe(500)
  })
})

describe('getDefaultMaxRetries', () => {
  test('defaults to 10', () => {
    expect(getDefaultMaxRetries()).toBe(10)
  })

  test('reads CLAUDIN_MAX_RETRIES', () => {
    process.env.CLAUDIN_MAX_RETRIES = '4'
    expect(getDefaultMaxRetries()).toBe(4)
  })
})

describe('is529Error', () => {
  test('a 529 status or an overloaded_error body', () => {
    expect(is529Error(apiError(529, 'Overloaded'))).toBe(true)
    expect(is529Error(apiError(500, '{"type":"overloaded_error"}'))).toBe(true)
  })

  test('not another status, and not a non-SDK error', () => {
    expect(is529Error(apiError(503, 'unavailable'))).toBe(false)
    expect(is529Error(Object.assign(new Error('x'), { status: 529 }))).toBe(false)
  })
})

describe('parseMaxTokensContextOverflowError', () => {
  test('reads the three numbers', () => {
    const e = apiError(400, 'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000')
    expect(parseMaxTokensContextOverflowError(e)).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    })
  })

  test('undefined for another status, another message or a malformed one', () => {
    const msg = 'input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000'
    expect(parseMaxTokensContextOverflowError(apiError(500, msg))).toBeUndefined()
    expect(parseMaxTokensContextOverflowError(apiError(400, 'prompt is too long'))).toBeUndefined()
    expect(
      parseMaxTokensContextOverflowError(apiError(400, 'input length and `max_tokens` exceed context limit: a + b > c')),
    ).toBeUndefined()
  })
})

describe('isThinkingBlockMismatchError', () => {
  test('false for a non-SDK error and for a 400 that does not mention thinking', () => {
    expect(isThinkingBlockMismatchError(new Error('thinking cannot be modified'))).toBe(false)
    expect(isThinkingBlockMismatchError(apiError(400, 'signature cannot be modified'))).toBe(false)
  })
})

describe('the error classes', () => {
  test('CannotRetryError carries the original error, its message and its stack', () => {
    const original = new Error('boom')
    const ctx = { model: 'm', thinkingConfig: { type: 'disabled' as const } }
    const e = new CannotRetryError(original, ctx)
    expect(e.name).toBe('RetryError')
    expect(e.message).toBe('boom')
    expect(e.stack).toBe(original.stack)
    expect(e.originalError).toBe(original)
    expect(e.retryContext).toBe(ctx)
  })

  test('CannotRetryError over a non-Error keeps its own stack', () => {
    const e = new CannotRetryError('plain string', { model: 'm', thinkingConfig: { type: 'disabled' } })
    expect(e.message).toBe('plain string')
    expect(e.stack).toContain('RetryError')
  })

  test('FallbackTriggeredError names both models', () => {
    const e = new FallbackTriggeredError('a', 'b')
    expect(e.originalModel).toBe('a')
    expect(e.fallbackModel).toBe('b')
    expect(e.message).toBe('Model fallback triggered: a -> b')
  })
})

describe('fallbackReasonFor', () => {
  test('overload, at any point', () => {
    expect(fallbackReasonFor(apiError(529, 'Overloaded'), false)).toBe('overloaded')
  })

  test('server and connection errors', () => {
    expect(fallbackReasonFor(apiError(503, 'unavailable'), true)).toBe('server_error')
    expect(fallbackReasonFor(apiError(500, 'no'), false)).toBe('server_error')
    expect(fallbackReasonFor(new APIConnectionError({ message: 'Connection error.' }), true)).toBe('server_error')
  })

  test('a rate limit only when it is long or outlasted the retries', () => {
    expect(fallbackReasonFor(apiError(429, 'slow down', { 'retry-after': '7200' }), false)).toBe('rate_limited')
    expect(fallbackReasonFor(apiError(429, 'slow down', { 'retry-after': '1' }), true)).toBe('rate_limited')
    expect(fallbackReasonFor(apiError(429, 'slow down', { 'retry-after': '1' }), false)).toBeNull()
  })

  test('never auth, a bad request, a status-less error or a non-SDK error', () => {
    expect(fallbackReasonFor(apiError(401, 'unauthorized'), true)).toBeNull()
    expect(fallbackReasonFor(apiError(400, 'bad'), true)).toBeNull()
    expect(fallbackReasonFor(apiError(undefined, 'odd'), true)).toBeNull()
    expect(fallbackReasonFor(new Error('boom'), true)).toBeNull()
  })

  test('the error carries its reason, overloaded by default', () => {
    expect(new FallbackTriggeredError('a', 'b').reason).toBe('overloaded')
    expect(new FallbackTriggeredError('a', 'b', 'rate_limited').reason).toBe('rate_limited')
  })
})
