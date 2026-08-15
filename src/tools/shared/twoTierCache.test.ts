import { describe, expect, test } from 'bun:test'
import { createTwoTierCache, decideCacheAction } from 'src/tools/shared/twoTierCache.js'

describe('decideCacheAction', () => {
  const SOFT = 5_000
  const HARD = 60_000

  test('miss when entry is undefined', () => {
    expect(decideCacheAction(undefined, 0, SOFT, HARD)).toBe('miss')
  })

  test('fresh inside soft window', () => {
    expect(decideCacheAction({ fetchedAt: 0 }, SOFT - 1, SOFT, HARD)).toBe(
      'fresh',
    )
  })

  test('stale exactly at soft boundary', () => {
    expect(decideCacheAction({ fetchedAt: 0 }, SOFT, SOFT, HARD)).toBe('stale')
  })

  test('miss exactly at hard boundary', () => {
    expect(decideCacheAction({ fetchedAt: 0 }, HARD, SOFT, HARD)).toBe('miss')
  })

  test('no-stale mode (soft === hard) skips the stale branch', () => {
    expect(decideCacheAction({ fetchedAt: 0 }, SOFT - 1, SOFT, SOFT)).toBe(
      'fresh',
    )
    expect(decideCacheAction({ fetchedAt: 0 }, SOFT, SOFT, SOFT)).toBe('miss')
  })

  test('clock skew (fetchedAt in future) treats as fresh', () => {
    expect(decideCacheAction({ fetchedAt: 1_000 }, 0, SOFT, HARD)).toBe('fresh')
  })
})

describe('createTwoTierCache', () => {
  type V = { payload: string }

  function fixedClock(): { now: number; clock: () => number } {
    const state = { now: 1_000_000 }
    return { ...state, clock: () => state.now }
  }

  test('cold key calls fetcher exactly once and stores result', async () => {
    const clk = fixedClock()
    let calls = 0
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    const result = await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'hello' }
    })

    expect(result).toEqual({ payload: 'hello' })
    expect(calls).toBe(1)
    expect(cache.getStats()).toMatchObject({ misses: 1, hits: 0 })
  })

  test('fresh hit serves cached value without calling fetcher', async () => {
    const clk = fixedClock()
    let calls = 0
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'v1' }
    })
    clk.now += 500
    const second = await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'v2' }
    })

    expect(second).toEqual({ payload: 'v1' })
    expect(calls).toBe(1)
    expect(cache.getStats()).toMatchObject({ misses: 1, hits: 1 })
  })

  test('stale entry served immediately + background refresh updates cache', async () => {
    const clk = fixedClock()
    let calls = 0
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })

    clk.now += 5_000 // soft expired, hard not yet
    const stale = await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })

    expect(stale).toEqual({ payload: 'v1' })
    // background refresh resolves on the microtask queue
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(2)
    expect(cache.getStats()).toMatchObject({
      misses: 1,
      stale: 1,
      refreshSuccess: 1,
    })

    // Next call within fresh window returns the refreshed value
    const fresh = await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'should not run' }
    })
    expect(fresh).toEqual({ payload: 'v2' })
  })

  test('no-stale mode never schedules background refresh', async () => {
    const clk = fixedClock()
    let calls = 0
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 1_000, // no-stale
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })

    clk.now += 1_500 // past hard
    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })

    expect(calls).toBe(2)
    expect(cache.getStats()).toMatchObject({ misses: 2, stale: 0 })
  })

  test('concurrent callers coalesce onto one fetch', async () => {
    const clk = fixedClock()
    let calls = 0
    let resolve!: (v: V) => void
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    const fetcher = () => {
      calls++
      return new Promise<V>(r => {
        resolve = r
      })
    }

    const p1 = cache.getOrFetch('k', fetcher)
    const p2 = cache.getOrFetch('k', fetcher)
    const p3 = cache.getOrFetch('k', fetcher)

    expect(calls).toBe(1)
    resolve({ payload: 'shared' })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual({ payload: 'shared' })
    expect(r2).toEqual({ payload: 'shared' })
    expect(r3).toEqual({ payload: 'shared' })
    expect(cache.getStats()).toMatchObject({ misses: 1, coalesced: 2 })
  })

  test('fetcher errors propagate and do not poison cache', async () => {
    const clk = fixedClock()
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await expect(
      cache.getOrFetch('k', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Next call sees miss again (error was not cached)
    const ok = await cache.getOrFetch('k', async () => ({ payload: 'ok' }))
    expect(ok).toEqual({ payload: 'ok' })
    expect(cache.getStats()).toMatchObject({ misses: 2 })
  })

  test('background refresh failure increments refreshFailure, keeps stale entry', async () => {
    const clk = fixedClock()
    let calls = 0
    const errors: unknown[] = []
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
      onRefreshError: e => errors.push(e),
    })

    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'v1' }
    })
    clk.now += 5_000
    const stale = await cache.getOrFetch('k', async () => {
      calls++
      throw new Error('refresh failed')
    })

    expect(stale).toEqual({ payload: 'v1' })
    await new Promise(r => setImmediate(r))
    expect(errors).toHaveLength(1)
    expect(cache.getStats()).toMatchObject({ stale: 1, refreshFailure: 1 })

    // Stale entry still served within hard window
    clk.now += 1_000
    const stillStale = await cache.getOrFetch('k', async () => {
      throw new Error('refresh failed again')
    })
    expect(stillStale).toEqual({ payload: 'v1' })
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test('clear() resets entries, in-flight, and stats', async () => {
    const clk = fixedClock()
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v' }))
    cache.clear()

    expect(cache.getStats()).toEqual({
      hits: 0,
      stale: 0,
      misses: 0,
      coalesced: 0,
      refreshSuccess: 0,
      refreshFailure: 0,
    })
    let calls = 0
    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'v2' }
    })
    expect(calls).toBe(1)
  })

  test('foreground abort propagates to in-flight fetch and to coalesced callers', async () => {
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
    })

    const controller = new AbortController()
    const fetcher = (signal: AbortSignal) =>
      new Promise<V>((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error(`aborted: ${String(signal.reason)}`)),
        )
      })

    const p1 = cache.getOrFetch('k', fetcher, controller.signal)
    const p2 = cache.getOrFetch('k', fetcher)
    controller.abort('user-cancel')

    await expect(p1).rejects.toThrow(/aborted/)
    await expect(p2).rejects.toThrow(/aborted/)
  })

  test('throws when softTtlMs > hardTtlMs', () => {
    expect(() =>
      createTwoTierCache<string, V>({
        name: 'bad',
        softTtlMs: 10,
        hardTtlMs: 5,
      }),
    ).toThrow(/softTtlMs.*hardTtlMs/)
  })

  test('returns a stats snapshot (mutations do not bleed back)', async () => {
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
    })
    const snap = cache.getStats() as { hits: number }
    snap.hits = 999
    expect(cache.getStats().hits).toBe(0)
  })

  test('maxSize + sizeOf path (used by WebFetch in prod)', async () => {
    type Sized = { payload: string; bytes: number }
    const cache = createTwoTierCache<string, Sized>({
      name: 'sized',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      maxSize: 100,
      sizeOf: v => v.bytes,
    })

    // Insert two entries that together fit (60 + 30 = 90 of 100)
    await cache.getOrFetch('a', async () => ({ payload: 'a', bytes: 60 }))
    await cache.getOrFetch('b', async () => ({ payload: 'b', bytes: 30 }))
    expect(cache.getStats()).toMatchObject({ misses: 2 })

    // Both still hit
    let calls = 0
    await cache.getOrFetch('a', async () => {
      calls++
      return { payload: 'x', bytes: 60 }
    })
    await cache.getOrFetch('b', async () => {
      calls++
      return { payload: 'x', bytes: 30 }
    })
    expect(calls).toBe(0)

    // Inserting a third entry that pushes total > maxSize must evict
    await cache.getOrFetch('c', async () => ({ payload: 'c', bytes: 50 }))
    // At least one of {a, b} must have been evicted; re-fetch counts as miss
    let evictedCount = 0
    await cache.getOrFetch('a', async () => {
      evictedCount++
      return { payload: 'a2', bytes: 60 }
    })
    await cache.getOrFetch('b', async () => {
      evictedCount++
      return { payload: 'b2', bytes: 30 }
    })
    expect(evictedCount).toBeGreaterThanOrEqual(1)
  })

  test('sizeOf returning 0 is clamped to 1 (lru-cache requires positive)', async () => {
    type Sized = { payload: string }
    const cache = createTwoTierCache<string, Sized>({
      name: 'zero',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      maxSize: 10,
      sizeOf: () => 0,
    })

    // Must not throw despite sizeOf returning 0
    await cache.getOrFetch('k', async () => ({ payload: 'v' }))
    expect(cache.getStats()).toMatchObject({ misses: 1 })
  })

  // --- Generation gate: clear() during in-flight ---

  test('clear() during in-flight foreground fetch does not resurrect cache', async () => {
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
    })

    let resolve!: (v: V) => void
    const p = cache.getOrFetch(
      'k',
      () => new Promise<V>(r => (resolve = r)),
    )

    cache.clear()
    resolve({ payload: 'late' })
    await p

    // Cache must be empty after clear, even though the fetch resolved late
    let calls = 0
    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'fresh' }
    })
    expect(calls).toBe(1)
    // Counters reflect only the post-clear miss, not the resurrected one
    expect(cache.getStats()).toMatchObject({ misses: 1 })
  })

  test('clear() during background refresh does not increment refreshSuccess', async () => {
    const clk = fixedClock()
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    let resolveRefresh!: (v: V) => void
    cache.getOrFetch('k', () => new Promise<V>(r => (resolveRefresh = r)))

    cache.clear()
    resolveRefresh({ payload: 'late' })
    await new Promise(r => setImmediate(r))

    expect(cache.getStats().refreshSuccess).toBe(0)
  })

  test('clear() during background refresh failure does not increment refreshFailure', async () => {
    const clk = fixedClock()
    const errors: unknown[] = []
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
      onRefreshError: e => errors.push(e),
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    let rejectRefresh!: (err: unknown) => void
    cache.getOrFetch(
      'k',
      () => new Promise<V>((_, rej) => (rejectRefresh = rej)),
    )

    cache.clear()
    rejectRefresh(new Error('post-clear failure'))
    await new Promise(r => setImmediate(r))

    expect(cache.getStats().refreshFailure).toBe(0)
    expect(errors).toHaveLength(0)
  })

  // --- Background-refresh timeout ---

  test('background refresh aborts after refreshTimeoutMs', async () => {
    const clk = fixedClock()
    const errors: unknown[] = []
    const cache = createTwoTierCache<string, V>({
      name: 'timeout-test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      refreshTimeoutMs: 50,
      // Disable cooldown so the post-timeout re-dispatch assertion
      // below tests the timeout-cleanup invariant in isolation.
      refreshFailureCooldownMs: 0,
      clock: () => clk.now,
      onRefreshError: e => errors.push(e),
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    // Background refresh that never resolves naturally
    const stale = await cache.getOrFetch(
      'k',
      signal =>
        new Promise<V>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    expect(stale).toEqual({ payload: 'v1' })

    // Wait past the timeout window + microtask (generous margin for CI)
    await new Promise(r => setTimeout(r, 300))

    expect(cache.getStats().refreshFailure).toBe(1)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/timed out/)

    // Crucially: the key is no longer pinned in inFlight — next stale
    // call schedules a new refresh
    let calls = 0
    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: 'v2' }
    })
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(1)
  })

  // --- Coalescing accounting ---

  test('second stale caller does not double-count as coalesced', async () => {
    const clk = fixedClock()
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    // Two stale calls land while refresh is in-flight (slow fetcher)
    let resolveRefresh!: (v: V) => void
    const fetcher = () => new Promise<V>(r => (resolveRefresh = r))

    cache.getOrFetch('k', fetcher)
    cache.getOrFetch('k', fetcher)

    // Two stale events, zero spurious coalesced — the second stale
    // caller saw the refresh in flight and skipped re-dispatch
    expect(cache.getStats()).toMatchObject({ stale: 2, coalesced: 0 })

    resolveRefresh({ payload: 'v2' })
    await new Promise(r => setImmediate(r))
  })

  // --- Listener cleanup ---

  test('successful foreground fetch removes the abort listener', async () => {
    const cache = createTwoTierCache<string, V>({
      name: 'test',
      softTtlMs: 1_000,
      hardTtlMs: 10_000,
    })

    const controller = new AbortController()
    const addSpy = controller.signal.addEventListener.bind(controller.signal)
    let added = 0
    let removed = 0
    controller.signal.addEventListener = ((
      ...args: Parameters<typeof addSpy>
    ) => {
      if (args[0] === 'abort') added++
      return addSpy(...args)
    }) as typeof addSpy

    const origRemove = controller.signal.removeEventListener.bind(
      controller.signal,
    )
    controller.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ) => {
      if (args[0] === 'abort') removed++
      return origRemove(...args)
    }) as typeof origRemove

    await cache.getOrFetch(
      'k',
      async () => ({ payload: 'v' }),
      controller.signal,
    )

    expect(added).toBeGreaterThanOrEqual(1)
    expect(removed).toBe(added)
  })

  // --- Validation edge cases ---

  // --- Refresh-failure cooldown ---

  test('failed refresh enters cooldown — subsequent stale callers do not re-dispatch', async () => {
    const clk = fixedClock()
    const errors: unknown[] = []
    let dispatched = 0
    const cache = createTwoTierCache<string, V>({
      name: 'cooldown',
      softTtlMs: 1_000,
      hardTtlMs: 100_000,
      refreshFailureCooldownMs: 30_000,
      clock: () => clk.now,
      onRefreshError: e => errors.push(e),
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    // First stale: dispatches and fails
    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('upstream 500')
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(1)
    expect(cache.getStats().refreshFailure).toBe(1)

    // Second + third stale within cooldown: no re-dispatch
    clk.now += 1_000
    await cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('should not run')
    })
    await cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('should not run')
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(1) // still 1
    expect(cache.getStats().stale).toBe(3) // counters still tick
    expect(errors).toHaveLength(1)
  })

  test('cooldown elapses — next stale caller re-dispatches', async () => {
    const clk = fixedClock()
    let dispatched = 0
    const cache = createTwoTierCache<string, V>({
      name: 'cooldown',
      softTtlMs: 1_000,
      hardTtlMs: 100_000,
      refreshFailureCooldownMs: 30_000,
      clock: () => clk.now,
      onRefreshError: () => {},
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(1)

    // Move clock past cooldown
    clk.now += 31_000
    await cache.getOrFetch('k', async () => {
      dispatched++
      return { payload: 'v2' }
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(2)
  })

  test('successful refresh wipes cooldown — next failure starts a fresh window', async () => {
    const clk = fixedClock()
    let dispatched = 0
    const cache = createTwoTierCache<string, V>({
      name: 'cooldown',
      softTtlMs: 1_000,
      hardTtlMs: 100_000,
      refreshFailureCooldownMs: 30_000,
      clock: () => clk.now,
      onRefreshError: () => {},
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    // Failed refresh sets cooldown
    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))

    // Move past cooldown; refresh succeeds
    clk.now += 31_000
    await cache.getOrFetch('k', async () => {
      dispatched++
      return { payload: 'v2' }
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(2)

    // Now within what would have been "old" cooldown if not wiped:
    // entry is fresh (just refreshed), advance to stale again
    clk.now += 5_000
    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail again')
    })
    await new Promise(r => setImmediate(r))
    // Must have re-dispatched: cooldown was wiped by the success
    expect(dispatched).toBe(3)
  })

  test('refreshFailureCooldownMs=0 disables the cooldown', async () => {
    const clk = fixedClock()
    let dispatched = 0
    const cache = createTwoTierCache<string, V>({
      name: 'no-cooldown',
      softTtlMs: 1_000,
      hardTtlMs: 100_000,
      refreshFailureCooldownMs: 0,
      clock: () => clk.now,
      onRefreshError: () => {},
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000

    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))

    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))

    expect(dispatched).toBe(2) // re-dispatch immediately
  })

  test('clear() wipes the cooldown map', async () => {
    const clk = fixedClock()
    let dispatched = 0
    const cache = createTwoTierCache<string, V>({
      name: 'clear-cooldown',
      softTtlMs: 1_000,
      hardTtlMs: 100_000,
      refreshFailureCooldownMs: 30_000,
      clock: () => clk.now,
      onRefreshError: () => {},
    })

    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000
    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))

    cache.clear()

    // Re-populate; stale again — cooldown must NOT block
    await cache.getOrFetch('k', async () => ({ payload: 'v1' }))
    clk.now += 5_000
    cache.getOrFetch('k', async () => {
      dispatched++
      throw new Error('fail')
    })
    await new Promise(r => setImmediate(r))
    expect(dispatched).toBe(2)
  })

  test('softTtlMs === 0 means everything is immediately stale (no-stale is also =0)', async () => {
    const clk = fixedClock()
    let calls = 0
    const cache = createTwoTierCache<string, V>({
      name: 'zero-ttl',
      softTtlMs: 0,
      hardTtlMs: 0,
      clock: () => clk.now,
    })

    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })
    await cache.getOrFetch('k', async () => {
      calls++
      return { payload: `v${calls}` }
    })
    // Every call is a miss when both TTLs are zero
    expect(calls).toBe(2)
  })
})
