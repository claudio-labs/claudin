import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  _resetH1OnlyForTesting,
  _resetKeepAliveForTesting,
  isProviderH1Only,
} from '../../utils/proxy.js'
import {
  fetchWithProxyRetry,
  isRetryableFetchError,
} from './fetchWithProxyRetry.js'

type FetchType = typeof globalThis.fetch

const originalFetch = globalThis.fetch
const originalEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
}

function restoreEnv(key: 'HTTP_PROXY' | 'HTTPS_PROXY', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(() => {
  process.env.HTTP_PROXY = 'http://127.0.0.1:15236'
  delete process.env.HTTPS_PROXY
  _resetKeepAliveForTesting() // full clear — intentional, clears all provider buckets
  _resetH1OnlyForTesting()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreEnv('HTTP_PROXY', originalEnv.HTTP_PROXY)
  restoreEnv('HTTPS_PROXY', originalEnv.HTTPS_PROXY)
  _resetKeepAliveForTesting() // full clear — intentional, clears all provider buckets
  _resetH1OnlyForTesting()
})

test('isRetryableFetchError matches Bun socket-closed failures', () => {
  expect(
    isRetryableFetchError(
      new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
    ),
  ).toBe(true)
})

test('fetchWithProxyRetry retries once with keepalive disabled after socket closure (with provider)', async () => {
  const calls: Array<RequestInit | undefined> = []

  globalThis.fetch = (async (_input, init) => {
    calls.push(init)
    if (calls.length === 1) {
      throw new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      )
    }
    return new Response('ok')
  }) as FetchType

  const response = await fetchWithProxyRetry(
    'https://example.com/search',
    { method: 'POST' },
    { provider: 'deepseek' },
  )

  expect(await response.text()).toBe('ok')
  expect(calls).toHaveLength(2)
  expect((calls[0] as RequestInit & { proxy?: string }).proxy).toBe(
    'http://127.0.0.1:15236',
  )
  expect((calls[0] as RequestInit).keepalive).toBeUndefined()
  expect((calls[1] as RequestInit).keepalive).toBe(false)
})

test('fetchWithProxyRetry retries with keepalive disabled even without provider (websearch path)', async () => {
  const calls: Array<RequestInit | undefined> = []

  globalThis.fetch = (async (_input, init) => {
    calls.push(init)
    if (calls.length === 1) {
      throw new Error('ECONNRESET')
    }
    return new Response('ok')
  }) as FetchType

  // No provider passed (e.g. WebSearchTool)
  const response = await fetchWithProxyRetry('https://example.com/search', { method: 'GET' })

  expect(await response.text()).toBe('ok')
  expect(calls).toHaveLength(2)
  expect((calls[0] as RequestInit).keepalive).toBeUndefined()
  expect((calls[1] as RequestInit).keepalive).toBe(false)
})

test('provider-less ECONNRESET does NOT leak keep-alive disable to subsequent provider-less calls', async () => {
  // First call: provider-less, hits ECONNRESET, retries with keepalive:false.
  let n = 0
  globalThis.fetch = (async (_input, _init) => {
    n++
    if (n === 1) throw new Error('ECONNRESET')
    return new Response('ok')
  }) as FetchType

  await fetchWithProxyRetry('https://duckduckgo.com/?q=foo', { method: 'GET' })

  // Second provider-less call: must start with keepalive UNDEFINED, not
  // forced false by a sticky 'unknown' bucket from the previous call.
  const secondCalls: Array<RequestInit | undefined> = []
  globalThis.fetch = (async (_input, init) => {
    secondCalls.push(init)
    return new Response('ok')
  }) as FetchType

  await fetchWithProxyRetry('https://example.com/feed', { method: 'GET' })
  expect((secondCalls[0] as RequestInit).keepalive).toBeUndefined()
})

test('ECONNRESET on one provider does not disable keep-alive for another', async () => {
  const deepseekCalls: Array<RequestInit | undefined> = []
  const anthropicCalls: Array<RequestInit | undefined> = []

  // First fetch for deepseek fails, second succeeds
  let deepseekAttempt = 0
  globalThis.fetch = (async (_input, init) => {
    deepseekCalls.push(init)
    deepseekAttempt++
    if (deepseekAttempt === 1) {
      throw new Error('ECONNRESET')
    }
    return new Response('deepseek-ok')
  }) as FetchType

  await fetchWithProxyRetry('https://api.deepseek.com', {}, { provider: 'deepseek' })

  // Now simulate an anthropic fetch — keepalive must NOT be false
  globalThis.fetch = (async (_input, init) => {
    anthropicCalls.push(init)
    return new Response('anthropic-ok')
  }) as FetchType

  await fetchWithProxyRetry('https://api.anthropic.com', {}, { provider: 'anthropic' })

  // deepseek retry disabled keepalive for deepseek
  expect((deepseekCalls[1] as RequestInit).keepalive).toBe(false)
  // anthropic call was NOT affected
  expect((anthropicCalls[0] as RequestInit).keepalive).toBeUndefined()
})

test('fetchWithProxyRetry handles h2-then-keepalive fallback within a single attempt budget', async () => {
  // Attempt 1: h2 error → withH2Fallback marks h1-only and retries inner
  //   fetch → that retry hits ECONNRESET → withH2Fallback rethrows (not h2)
  //   → outer retry loop catches retryable network error and triggers
  //   disableKeepAlive.
  // Attempt 2: keepalive:false → succeeds.
  let n = 0
  globalThis.fetch = (async (_input, _init) => {
    n++
    if (n === 1) throw new Error('HTTP/2 stream refused')
    if (n === 2) throw new Error('ECONNRESET')
    return new Response('ok')
  }) as FetchType

  const response = await fetchWithProxyRetry(
    'https://lmstudio.local/v1/chat',
    {},
    { provider: 'openai_compat' },
  )
  expect(await response.text()).toBe('ok')
  expect(n).toBe(3)
  expect(isProviderH1Only('openai_compat')).toBe(true)
})

test('fetchWithProxyRetry does not retry non-network errors', async () => {
  let attempts = 0

  globalThis.fetch = (async () => {
    attempts += 1
    throw new Error('400 bad request')
  }) as FetchType

  await expect(fetchWithProxyRetry('https://example.com')).rejects.toThrow(
    '400 bad request',
  )
  expect(attempts).toBe(1)
})
