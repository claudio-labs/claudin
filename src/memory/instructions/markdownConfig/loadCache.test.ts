import { describe, expect, test } from 'bun:test'

import { cacheSuccessfulLoads } from 'src/memory/instructions/markdownConfig/loadCache.js'

/** A load that answers each call with the next outcome, and records the keys it was called with. */
function scriptedLoad(outcomes: ReadonlyArray<string | Error>): {
  load: (key: string) => Promise<string>
  calls: string[]
} {
  const calls: string[] = []
  const load = async (key: string): Promise<string> => {
    const outcome = outcomes[calls.length] ?? new Error(`no outcome scripted for call ${calls.length + 1}`)
    calls.push(key)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return { load, calls }
}

const byKey = (key: string): string => key

describe('cacheSuccessfulLoads', () => {
  test('a load that failed is not kept: the next call loads again', async () => {
    const { load, calls } = scriptedLoad([new Error('disk busy'), 'loaded'])
    const cached = cacheSuccessfulLoads(load, byKey)
    await expect(cached('agents')).rejects.toThrow('disk busy')
    expect(await cached('agents')).toBe('loaded')
    expect(calls).toEqual(['agents', 'agents'])
  })

  test('a load that succeeded is kept until cache.clear()', async () => {
    const { load, calls } = scriptedLoad(['first', 'second'])
    const cached = cacheSuccessfulLoads(load, byKey)
    expect(await cached('agents')).toBe('first')
    expect(await cached('agents')).toBe('first')
    cached.cache.clear()
    expect(await cached('agents')).toBe('second')
    expect(calls).toEqual(['agents', 'agents'])
  })

  test('callers share a load in flight, a failing one included', async () => {
    const { load, calls } = scriptedLoad([new Error('boom')])
    const cached = cacheSuccessfulLoads(load, byKey)
    const [one, two] = [cached('agents'), cached('agents')]
    expect(two).toBe(one)
    await expect(one).rejects.toThrow('boom')
    expect(calls).toEqual(['agents'])
  })

  test('each key is a load of its own', async () => {
    const { load, calls } = scriptedLoad(['for agents', 'for commands'])
    const cached = cacheSuccessfulLoads(load, byKey)
    expect(await cached('agents')).toBe('for agents')
    expect(await cached('commands')).toBe('for commands')
    expect(calls).toEqual(['agents', 'commands'])
  })

  test('an older load that fails after cache.clear() leaves the newer one cached', async () => {
    const pending: Array<PromiseWithResolvers<string>> = []
    const cached = cacheSuccessfulLoads((_key: string) => {
      const next = Promise.withResolvers<string>()
      pending.push(next)
      return next.promise
    }, byKey)
    const older = cached('agents')
    cached.cache.clear()
    const newer = cached('agents')
    pending[0]!.reject(new Error('stale'))
    await expect(older).rejects.toThrow('stale')
    pending[1]!.resolve('fresh')
    expect(await newer).toBe('fresh')
    expect(cached('agents')).toBe(newer)
  })
})
