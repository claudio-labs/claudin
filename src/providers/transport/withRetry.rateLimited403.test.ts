import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import { shouldRetry } from 'src/providers/transport/withRetry.js'

// A 403 the OpenAI-compatible shim marks rate_limited retries like a 429, so
// it has to stop where a 429 stops: a reset hours out (Azure API Management's
// quota policy answers 403 + Retry-After of hours) and an exhausted quota.
const PAYG = { isSubscriber: () => false, isEnterprise: () => false }

function shimError(status: number, wording: string, headers: Record<string, string> = {}): APIError {
  const message = `OpenAI API error ${status}: ${wording} [openai_category=rate_limited] Hint: Provider rate-limited the request.`
  const error = new APIError(status, { error: { message: wording } }, message, new Headers(headers))
  // What throwClassifiedHttpError does after APIError.generate.
  error.message = `${status} ${message}`
  return error
}

describe('a rate_limited 403', () => {
  test('a 429 with an 8 h Retry-After is not retried (control)', () => {
    expect(shouldRetry(shimError(429, 'slow down', { 'retry-after': '28800' }), 1, PAYG)).toBe(false)
  })

  test('with an 8 h Retry-After is not retried either', () => {
    expect(shouldRetry(shimError(403, 'quota', { 'retry-after': '28800' }), 1, PAYG)).toBe(false)
  })

  test('that says the quota is exhausted is not retried', () => {
    expect(shouldRetry(shimError(403, 'You exceeded your current quota'), 1, PAYG)).toBe(false)
  })

  test('with a short Retry-After is still retried', () => {
    expect(shouldRetry(shimError(403, 'slow down', { 'retry-after': '2' }), 1, PAYG)).toBe(true)
  })
})
