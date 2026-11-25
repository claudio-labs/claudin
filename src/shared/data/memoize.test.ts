import { describe, expect, mock, test } from 'bun:test'
import {
  memoizeWithLRU,
  memoizeWithLRUExceptFailures,
  memoizeWithTTLAsync,
} from 'src/shared/data/memoize.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('memoizeWithTTLAsync', () => {
  test('computes once and serves the cached value while fresh', async () => {
    const f = mock(async (n: number) => n * 2)
    const memoized = memoizeWithTTLAsync(f, 60_000)
    expect(await memoized(2)).toBe(4)
    expect(await memoized(2)).toBe(4)
    expect(await memoized(3)).toBe(6)
    expect(f).toHaveBeenCalledTimes(2)
  })

  test('shares one call between concurrent cold misses', async () => {
    const pending = deferred<string>()
    const f = mock(() => pending.promise)
    const memoized = memoizeWithTTLAsync(f, 60_000)
    const both = Promise.all([memoized(), memoized()])
    pending.resolve('v')
    expect(await both).toEqual(['v', 'v'])
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('caches nothing when the cold miss rejects', async () => {
    let calls = 0
    const memoized = memoizeWithTTLAsync(async () => {
      calls++
      if (calls === 1) throw new Error('first fails')
      return 'second'
    }, 60_000)
    await expect(memoized()).rejects.toThrow('first fails')
    expect(await memoized()).toBe('second')
  })

  test('returns a stale value and refreshes it in the background', async () => {
    let value = 'old'
    const memoized = memoizeWithTTLAsync(async () => value, 1)
    expect(await memoized()).toBe('old')
    await Bun.sleep(5)
    value = 'new'
    expect(await memoized()).toBe('old')
    await Bun.sleep(0)
    expect(await memoized()).toBe('new')
  })

  test('drops a stale entry whose background refresh fails', async () => {
    let calls = 0
    const memoized = memoizeWithTTLAsync(async () => {
      calls++
      if (calls === 2) throw new Error('refresh fails')
      return `v${calls}`
    }, 1)
    expect(await memoized()).toBe('v1')
    await Bun.sleep(5)
    expect(await memoized()).toBe('v1')
    await Bun.sleep(0)
    expect(await memoized()).toBe('v3')
  })

  test('a clear during a cold miss keeps that result out of the cache', async () => {
    const pending = deferred<string>()
    let calls = 0
    const memoized = memoizeWithTTLAsync(async () => {
      calls++
      return calls === 1 ? pending.promise : 'fresh'
    }, 60_000)
    const first = memoized()
    memoized.cache.clear()
    pending.resolve('stale')
    expect(await first).toBe('stale')
    expect(await memoized()).toBe('fresh')
  })
})

describe('memoizeWithLRU', () => {
  test('caches by key and exposes the cache', () => {
    const f = mock((s: string) => s.toUpperCase())
    const memoized = memoizeWithLRU(f, s => s, 10)
    expect(memoized('a')).toBe('A')
    expect(memoized('a')).toBe('A')
    expect(f).toHaveBeenCalledTimes(1)
    expect(memoized.cache.size()).toBe(1)
    expect(memoized.cache.has('a')).toBe(true)
    expect(memoized.cache.get('a')).toBe('A')
    expect(memoized.cache.delete('a')).toBe(true)
    expect(memoized('a')).toBe('A')
    expect(f).toHaveBeenCalledTimes(2)
    memoized.cache.clear()
    expect(memoized.cache.size()).toBe(0)
  })

  test('evicts the least recently used entry, and get() does not promote', () => {
    const memoized = memoizeWithLRU((s: string) => s.toUpperCase(), s => s, 2)
    memoized('a')
    memoized('b')
    memoized.cache.get('a')
    memoized('c')
    expect(memoized.cache.has('a')).toBe(false)
    expect(memoized.cache.has('b')).toBe(true)

    memoized('b')
    memoized('d')
    expect(memoized.cache.has('b')).toBe(true)
    expect(memoized.cache.has('c')).toBe(false)
  })

  test('defaults to 100 entries', () => {
    const memoized = memoizeWithLRU((n: number) => n, n => String(n))
    for (let i = 0; i <= 100; i++) memoized(i)
    expect(memoized.cache.size()).toBe(100)
    expect(memoized.cache.has('0')).toBe(false)
  })
})

describe('memoizeWithLRUExceptFailures', () => {
  test('memoizes a success', async () => {
    const f = mock(async (s: string) => s.toUpperCase())
    const memoized = memoizeWithLRUExceptFailures(f, () => '', s => s)
    expect(await memoized('a')).toBe('A')
    expect(await memoized('a')).toBe('A')
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('answers the fallback for a failure and fetches again next time', async () => {
    let calls = 0
    const onFailure = mock((error: unknown, s: string) => `fallback ${s}: ${String(error)}`)
    const memoized = memoizeWithLRUExceptFailures(
      async (s: string) => {
        calls++
        if (calls === 1) throw new Error('down')
        return s.toUpperCase()
      },
      onFailure,
      s => s,
    )
    expect(await memoized('a')).toBe('fallback a: Error: down')
    expect(memoized.cache.has('a')).toBe(false)
    expect(await memoized('a')).toBe('A')
    expect(await memoized('a')).toBe('A')
    expect(calls).toBe(2)
  })

  test('a failing stale call does not evict the entry that replaced it', async () => {
    const pending = deferred<string>()
    let calls = 0
    const memoized = memoizeWithLRUExceptFailures(
      async () => {
        calls++
        return calls === 1 ? pending.promise : 'fresh'
      },
      () => 'fallback',
      () => 'key',
    )
    const stale = memoized()
    memoized.cache.delete('key')
    expect(await memoized()).toBe('fresh')
    pending.reject(new Error('old connection closed'))
    expect(await stale).toBe('fallback')
    expect(memoized.cache.has('key')).toBe(true)
    expect(await memoized()).toBe('fresh')
    expect(calls).toBe(2)
  })
})
