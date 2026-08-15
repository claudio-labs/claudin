import { beforeEach, describe, expect, test } from 'bun:test'
import { clearWebFetchCache, getWebFetchCacheStats } from 'src/tools/WebFetchTool/utils.js'

// Soft/hard TTL boundary logic now lives in src/tools/shared/twoTierCache.ts
// and is tested in twoTierCache.test.ts. This file keeps only the integration
// surface: stats wiring and clear() lifecycle.

describe('getWebFetchCacheStats', () => {
  beforeEach(() => {
    clearWebFetchCache()
  })

  test('starts at zero after clearWebFetchCache', () => {
    expect(getWebFetchCacheStats()).toEqual({
      hits: 0,
      stale: 0,
      misses: 0,
      coalesced: 0,
      refreshSuccess: 0,
      refreshFailure: 0,
    })
  })

  test('returns a readonly snapshot — mutating it does not affect internal state', () => {
    const snapshot = getWebFetchCacheStats() as {
      hits: number
    }
    snapshot.hits = 999
    expect(getWebFetchCacheStats().hits).toBe(0)
  })
})
