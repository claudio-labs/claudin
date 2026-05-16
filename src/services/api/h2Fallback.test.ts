import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  _resetH1OnlyForTesting,
  isProviderH1Only,
} from '../../utils/proxy.js'
import { isH2FailureError, withH2Fallback } from './h2Fallback.js'

beforeEach(() => {
  _resetH1OnlyForTesting()
})

afterEach(() => {
  _resetH1OnlyForTesting()
})

test('isH2FailureError matches HTTP/2 protocol errors', () => {
  expect(isH2FailureError(new Error('HTTP/2 stream was reset'))).toBe(true)
  expect(isH2FailureError(new Error('H2_PROTOCOL_ERROR'))).toBe(true)
  expect(isH2FailureError(new Error('ALPN negotiation failed'))).toBe(true)
  const e = new Error('boom') as Error & { code: string }
  e.code = 'ERR_HTTP2_STREAM_ERROR'
  expect(isH2FailureError(e)).toBe(true)
})

test('isH2FailureError ignores bare GOAWAY (graceful server restart, not a real h2 failure)', () => {
  // A healthy h2 server emits GOAWAY on rollover/graceful shutdown. Matching
  // on bare GOAWAY would permanently degrade a session to h1 on the next
  // server restart with zero recovery path.
  expect(isH2FailureError(new Error('GOAWAY frame received'))).toBe(false)
  expect(isH2FailureError(new Error('connection closed: GOAWAY'))).toBe(false)
})

test('isH2FailureError ignores generic network errors and aborts', () => {
  expect(isH2FailureError(new Error('ECONNRESET'))).toBe(false)
  expect(isH2FailureError(new Error('400 bad request'))).toBe(false)
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  expect(isH2FailureError(abort)).toBe(false)
})

test('isH2FailureError does not false-positive on prose mentioning HTTP/2', () => {
  // Server might echo a 4xx body like this; must NOT mis-mark the provider.
  expect(
    isH2FailureError(
      new Error('Server requires HTTP/2 but received HTTP/1.1 instead'),
    ),
  ).toBe(false)
  expect(
    isH2FailureError(new Error('upgrade to HTTP/2 recommended for performance')),
  ).toBe(false)
})

test('withH2Fallback retries once on h2 failure and marks provider h1-only', async () => {
  let attempt = 0
  const result = await withH2Fallback('openai_compat', async () => {
    attempt++
    if (attempt === 1) throw new Error('HTTP/2 stream refused')
    return 'ok'
  })
  expect(result).toBe('ok')
  expect(attempt).toBe(2)
  expect(isProviderH1Only('openai_compat')).toBe(true)
})

test('withH2Fallback propagates non-h2 errors without retry', async () => {
  let attempt = 0
  await expect(
    withH2Fallback('anthropic', async () => {
      attempt++
      throw new Error('400 bad request')
    }),
  ).rejects.toThrow('400 bad request')
  expect(attempt).toBe(1)
  expect(isProviderH1Only('anthropic')).toBe(false)
})

test('withH2Fallback propagates the h1 retry error', async () => {
  let attempt = 0
  await expect(
    withH2Fallback('gemini', async () => {
      attempt++
      if (attempt === 1) throw new Error('HTTP/2 protocol error')
      throw new Error('connection refused')
    }),
  ).rejects.toThrow('connection refused')
  expect(attempt).toBe(2)
  expect(isProviderH1Only('gemini')).toBe(true)
})

test('subsequent call does not retry once provider is sticky h1-only', async () => {
  // First call marks gemini as h1-only.
  let attemptA = 0
  await withH2Fallback('gemini', async () => {
    attemptA++
    if (attemptA === 1) throw new Error('H2_PROTOCOL_ERROR')
    return 'a'
  })
  expect(isProviderH1Only('gemini')).toBe(true)

  // Second call: an h2 error here should NOT trigger another retry, because
  // the provider is already marked. (In practice the dispatcher is h1 by
  // now, so we should not even see h2 errors anymore.)
  let attemptB = 0
  await expect(
    withH2Fallback('gemini', async () => {
      attemptB++
      throw new Error('HTTP/2 stream refused')
    }),
  ).rejects.toThrow('HTTP/2 stream refused')
  expect(attemptB).toBe(1)
})

test('withH2Fallback skips fallback when provider is undefined', async () => {
  let attempt = 0
  await expect(
    withH2Fallback(undefined, async () => {
      attempt++
      throw new Error('HTTP/2 stream refused')
    }),
  ).rejects.toThrow('HTTP/2 stream refused')
  expect(attempt).toBe(1)
})
