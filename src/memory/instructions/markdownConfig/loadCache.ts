/**
 * Loads cached per key and shared while in flight. A load that fails is
 * dropped as it settles, so the next call tries again instead of repeating
 * the failure until the cache is cleared.
 */
export type CachedLoad<Args extends unknown[], Result> = ((...args: Args) => Promise<Result>) & {
  readonly cache: { clear(): void }
}

export function cacheSuccessfulLoads<Args extends unknown[], Result>(
  load: (...args: Args) => Promise<Result>,
  keyOf: (...args: Args) => string,
): CachedLoad<Args, Result> {
  const loads = new Map<string, Promise<Result>>()
  const cachedLoad = (...args: Args): Promise<Result> => {
    const key = keyOf(...args)
    const cached = loads.get(key)
    if (cached !== undefined) return cached
    const started: Promise<Result> = load(...args).catch((error: unknown) => {
      // After a clear(), the key may already hold a newer load.
      if (loads.get(key) === started) loads.delete(key)
      throw error
    })
    loads.set(key, started)
    return started
  }
  return Object.assign(cachedLoad, { cache: { clear: (): void => loads.clear() } })
}
