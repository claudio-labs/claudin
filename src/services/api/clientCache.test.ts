import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

// clientCache derives its key from tryGetActiveProvider(). Mock at that
// boundary so tests can control transport/apiKey/baseUrl. Spread the real
// module so other exports stay shape-compatible and restore in afterAll.
const realActiveProvider = { ...(await import('./activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = {
  transport?: string
  apiKey?: string
  baseUrl?: string
} | null

let resolvedOverride: ResolvedProvider = null

mock.module('./activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

// config.js registers an onGlobalConfigChange listener at import time; stub it
// to a no-op so importing the module under test doesn't wire into real config.
const realConfig = { ...(await import('../../utils/config.js')) }
const realConfigSnapshot = { ...realConfig }
mock.module('../../utils/config.js', () => ({
  ...realConfigSnapshot,
  onGlobalConfigChange: () => {},
}))

afterAll(() => {
  mock.module('./activeProvider.js', () => realActiveProviderSnapshot)
  mock.module('../../utils/config.js', () => realConfigSnapshot)
})

const { getCachedAnthropicClient, invalidateClientCache } = await import('./clientCache.js')

// A fake "client" — the cache treats it opaquely, so any object works.
function fakeClient(tag: string): any {
  return { tag }
}

type Params = Parameters<typeof getCachedAnthropicClient>[1]

function baseParams(over: Partial<Params> = {}): Params {
  return { maxRetries: 0, model: 'm', ...over }
}

beforeEach(() => {
  resolvedOverride = { transport: 'anthropic', apiKey: 'k', baseUrl: 'https://api' }
  invalidateClientCache()
})

test('returns the same client on a hit (same key)', async () => {
  let calls = 0
  const factory = async () => {
    calls++
    return fakeClient(`c${calls}`)
  }

  const a = await getCachedAnthropicClient(factory, baseParams())
  const b = await getCachedAnthropicClient(factory, baseParams())

  expect(a).toBe(b)
  expect(calls).toBe(1)
})

test('maxRetries discriminates the cache key', async () => {
  let calls = 0
  const factory = async () => fakeClient(`c${++calls}`)

  const r0 = await getCachedAnthropicClient(factory, baseParams({ maxRetries: 0 }))
  const r1 = await getCachedAnthropicClient(factory, baseParams({ maxRetries: 1 }))

  expect(r0).not.toBe(r1)
  expect(calls).toBe(2)
})

test('fetchOverride identity discriminates the cache key', async () => {
  let calls = 0
  const factory = async () => fakeClient(`c${++calls}`)
  const fetchA = (async () => new Response()) as any
  const fetchB = (async () => new Response()) as any

  const a1 = await getCachedAnthropicClient(factory, baseParams({ fetchOverride: fetchA }))
  const a2 = await getCachedAnthropicClient(factory, baseParams({ fetchOverride: fetchA }))
  const b = await getCachedAnthropicClient(factory, baseParams({ fetchOverride: fetchB }))
  const none = await getCachedAnthropicClient(factory, baseParams())

  expect(a1).toBe(a2) // same fetch fn → same client
  expect(a1).not.toBe(b) // different fetch fn → different client
  expect(a1).not.toBe(none) // absent fetch → different client
  expect(calls).toBe(3)
})

test('explicit apiKey takes precedence and discriminates the key', async () => {
  let calls = 0
  const factory = async () => fakeClient(`c${++calls}`)

  // Same active provider, but two different explicit candidate keys (as
  // verifyApiKey would pass) must not collide.
  const k1 = await getCachedAnthropicClient(factory, baseParams({ apiKey: 'candidate-1' }))
  const k2 = await getCachedAnthropicClient(factory, baseParams({ apiKey: 'candidate-2' }))

  expect(k1).not.toBe(k2)
  expect(calls).toBe(2)
})

test('single-flight dedups concurrent cold-start callers', async () => {
  let calls = 0
  let resolveFactory: (c: any) => void = () => {}
  const factory = () =>
    new Promise<any>(resolve => {
      calls++
      resolveFactory = resolve
    })

  // Both start before any cache entry exists.
  const p1 = getCachedAnthropicClient(factory, baseParams())
  const p2 = getCachedAnthropicClient(factory, baseParams())

  resolveFactory(fakeClient('shared'))
  const [a, b] = await Promise.all([p1, p2])

  expect(a).toBe(b)
  expect(calls).toBe(1) // construction ran once despite two concurrent callers
})

test('invalidation during an in-flight fill does not repopulate the cache', async () => {
  let resolveFactory: (c: any) => void = () => {}
  const factory = () =>
    new Promise<any>(resolve => {
      resolveFactory = resolve
    })

  const inflight = getCachedAnthropicClient(factory, baseParams())

  // Provider/credentials change mid-construction.
  invalidateClientCache()

  resolveFactory(fakeClient('stale'))
  await inflight // awaiter still gets its client...

  // ...but the stale client must not have been written to the cache.
  let secondCalls = 0
  const factory2 = async () => fakeClient(`fresh${++secondCalls}`)
  const fresh = await getCachedAnthropicClient(factory2, baseParams())

  expect((fresh as any).tag).toBe('fresh1')
  expect(secondCalls).toBe(1)
})

test('expired entries are reconstructed after TTL', async () => {
  let calls = 0
  const factory = async () => fakeClient(`c${++calls}`)

  const original = Date.now
  try {
    let now = 1_000_000
    Date.now = () => now
    await getCachedAnthropicClient(factory, baseParams())
    // Advance past the 5-minute TTL.
    now += 5 * 60 * 1000 + 1
    await getCachedAnthropicClient(factory, baseParams())
  } finally {
    Date.now = original
  }

  expect(calls).toBe(2)
})
