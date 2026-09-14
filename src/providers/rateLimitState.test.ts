import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearProviderRateLimit,
  clearProviderRateLimitForModel,
  getProviderRateLimit,
  type ProviderRateLimit,
  publishProviderRateLimit,
  subscribeToProviderRateLimit,
} from 'src/providers/rateLimitState.js'

const LIMIT: ProviderRateLimit = {
  kind: 'window',
  source: 'openai-reset',
  resetsAtMs: 1_700_000_060_000,
  providerLabel: 'OpenAI',
  model: 'gpt-5',
  observedAtMs: 1_700_000_000_000,
}

afterEach(() => {
  clearProviderRateLimit()
})

describe('provider rate-limit store', () => {
  test('starts empty', () => {
    expect(getProviderRateLimit()).toBeNull()
  })

  test('publish makes the limit readable and notifies subscribers', () => {
    const seen: (ProviderRateLimit | null)[] = []
    const unsubscribe = subscribeToProviderRateLimit(limit => seen.push(limit))

    publishProviderRateLimit(LIMIT)

    expect(getProviderRateLimit()).toEqual(LIMIT)
    expect(seen).toEqual([LIMIT])
    unsubscribe()
  })

  test('clear resets the limit and notifies', () => {
    publishProviderRateLimit(LIMIT)
    const seen: (ProviderRateLimit | null)[] = []
    const unsubscribe = subscribeToProviderRateLimit(limit => seen.push(limit))

    clearProviderRateLimit()

    expect(getProviderRateLimit()).toBeNull()
    expect(seen).toEqual([null])
    unsubscribe()
  })

  test('clearing when nothing is set does not notify', () => {
    // The hot path calls this after every successful request, so it has to be
    // free when there is no limit to clear.
    const seen: (ProviderRateLimit | null)[] = []
    const unsubscribe = subscribeToProviderRateLimit(limit => seen.push(limit))

    clearProviderRateLimit()

    expect(seen).toEqual([])
    unsubscribe()
  })

  test('the snapshot keeps its identity between reads', () => {
    // useSyncExternalStore re-renders whenever getSnapshot returns a new
    // reference, so a fresh object per read would loop.
    publishProviderRateLimit(LIMIT)
    expect(getProviderRateLimit()).toBe(getProviderRateLimit())
  })

  test('a second publish replaces the first', () => {
    publishProviderRateLimit(LIMIT)
    const later: ProviderRateLimit = { ...LIMIT, providerLabel: 'Kimi' }
    publishProviderRateLimit(later)
    expect(getProviderRateLimit()).toBe(later)
  })

  test('an unsubscribed listener stops receiving updates', () => {
    const seen: (ProviderRateLimit | null)[] = []
    const unsubscribe = subscribeToProviderRateLimit(limit => seen.push(limit))
    unsubscribe()

    publishProviderRateLimit(LIMIT)

    expect(seen).toEqual([])
  })
})

describe('clearProviderRateLimitForModel', () => {
  test('clears the limit recorded for that model', () => {
    publishProviderRateLimit(LIMIT)
    clearProviderRateLimitForModel('gpt-5')
    expect(getProviderRateLimit()).toBeNull()
  })

  test('leaves a limit recorded for a different model alone', () => {
    // A title or a subagent runs on the small fast model; its success says
    // nothing about the main loop's quota, and clearing here would cancel the
    // countdown and the pending resume for a limit still in force.
    publishProviderRateLimit(LIMIT)
    clearProviderRateLimitForModel('claude-haiku-4-5')
    expect(getProviderRateLimit()).toEqual(LIMIT)
  })

  test('does not notify when it does not clear', () => {
    publishProviderRateLimit(LIMIT)
    const seen: (ProviderRateLimit | null)[] = []
    const unsubscribe = subscribeToProviderRateLimit(limit => seen.push(limit))

    clearProviderRateLimitForModel('some-other-model')

    expect(seen).toEqual([])
    unsubscribe()
  })
})
