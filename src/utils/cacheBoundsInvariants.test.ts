/**
 * Cache bounds invariants — CI guard for ROADMAP item 5.3.
 *
 * Each module-level Map/Set/LRUCache called from a per-turn or per-tool-call
 * hot path must respect its declared cap. If a future change drops or bypasses
 * the eviction call, this test fails before the regression reaches a user
 * session. Companion to scripts/profile/long-session-bench.ts which measures
 * the heap impact; this only asserts container size.
 *
 * Caches covered:
 *   - Markdown.tsx tokenCache (LRU 500)
 *   - queryHelpers.ts toolProgressLastSentTime (FIFO 100)
 *   - imageStore.ts storedImagePaths (FIFO 200)
 *   - LSPDiagnosticRegistry.ts deliveredDiagnostics (LRU 500)
 *   - fileReadCache (FIFO 1000)
 *
 * Not covered (intentional, with reason):
 *   - auth.ts pending401Handlers — finally{ delete } cleanup, requires
 *     OAuth/keychain mocks > test value. Verified by inspection (auth.ts:1383-1390).
 */

import { describe, expect, mock, test } from 'bun:test'

// ── Shared mocks: silence telemetry/analytics/growthbook used by deep imports ──
mock.module('../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_CACHED_WITH_REFRESH: () => false,
  getFeatureValue_DEPRECATED: async () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  checkSecurityRestrictionGate: async () => false,
  hasGrowthBookEnvOverride: () => false,
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => () => {},
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
  getDynamicConfig_BLOCKS_ON_INIT: async () => ({}),
  getDynamicConfig_CACHED_MAY_BE_STALE: () => ({}),
  initializeGrowthBook: async () => null,
  getAllGrowthBookFeatures: () => ({}),
}))
mock.module('../services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  attachAnalyticsSink: () => {},
  stripProtoFields: <V,>(v: V) => v,
  _resetForTesting: () => {},
}))

describe('cache bounds invariants', () => {
  test('Markdown tokenCache LRU cap = 500', async () => {
    const {
      cachedLexer,
      __TEST_ONLY_getTokenCacheSize,
      __TEST_ONLY_resetTokenCache,
    } = await import('../components/markdownTokenCache.js')

    __TEST_ONLY_resetTokenCache()
    // Use markdown syntax (header marker) so cachedLexer takes the cache
    // path instead of the plain-text fast-path that bypasses the LRU.
    for (let i = 0; i < 5000; i++) {
      cachedLexer(`# heading ${i}\n\ncontent ${i}`)
    }
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(500)
  })

  test('toolProgressLastSentTime FIFO cap = 100', async () => {
    const {
      __TEST_ONLY_recordToolProgress,
      __TEST_ONLY_getToolProgressMapSize,
      __TEST_ONLY_resetToolProgressMap,
    } = await import('./queryHelpers.js')

    __TEST_ONLY_resetToolProgressMap()
    for (let i = 0; i < 1000; i++) {
      __TEST_ONLY_recordToolProgress(`tool-call-${i}`)
    }
    expect(__TEST_ONLY_getToolProgressMapSize()).toBe(100)
  })

  test('imageStore storedImagePaths FIFO cap = 200', async () => {
    mock.module('./debug.js', () => ({ logForDebugging: () => {} }))
    mock.module('../bootstrap/state.js', () => ({
      getSessionId: () => 'test-session',
    }))
    mock.module('./envUtils.js', () => ({
      getClaudioConfigHomeDir: () => '/tmp/test-claudio',
      isEnvTruthy: () => false,
    }))
    mock.module('./fsOperations.js', () => ({
      getFsImplementation: () => ({
        readdir: async () => [],
        rm: async () => {},
        rmdir: async () => {},
      }),
    }))

    const {
      cacheImagePath,
      __TEST_ONLY_getStoredImagePathsSize,
      clearStoredImagePaths,
    } = await import('./imageStore.js')

    clearStoredImagePaths()
    for (let i = 0; i < 1000; i++) {
      cacheImagePath({
        type: 'image',
        id: i,
        mediaType: 'image/png',
        content: '',
      })
    }
    expect(__TEST_ONLY_getStoredImagePathsSize()).toBe(200)
  })

  test('deliveredDiagnostics LRU cap = 500', async () => {
    mock.module('../../utils/debug.js', () => ({ logForDebugging: () => {} }))
    mock.module('../../utils/log.js', () => ({ logError: () => {} }))
    mock.module('../../utils/slowOperations.js', () => ({
      jsonStringify: (x: unknown) => JSON.stringify(x),
    }))

    const {
      markDiagnosticsAsDelivered,
      _getDeliveredDiagnosticsCountForTesting,
      _resetDeliveredDiagnosticsForTesting,
    } = await import('../services/lsp/LSPDiagnosticRegistry.js')

    _resetDeliveredDiagnosticsForTesting()
    for (let i = 0; i < 1000; i++) {
      markDiagnosticsAsDelivered([
        {
          uri: `file:///test/file_${i}.ts`,
          diagnostics: [
            {
              message: `diagnostic ${i}`,
              severity: 'Error',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
        } as never, // DiagnosticFile shape — minimal fixture
      ])
    }
    expect(_getDeliveredDiagnosticsCountForTesting()).toBeLessThanOrEqual(500)
  })

  test('fileReadCache cap = 1000', async () => {
    let mtimeCounter = 1000
    mock.module('./fsOperations.js', () => ({
      getFsImplementation: () => ({
        statSync: (_path: string) => ({
          mtimeMs: mtimeCounter++,
          size: 100,
          mode: 0o644,
        }),
        readFileSync: (_path: string, _opts: unknown) => 'fixture',
      }),
    }))
    mock.module('./file.js', () => ({
      detectFileEncoding: () => 'utf8' as const,
    }))

    const { fileReadCache } = await import('./fileReadCache.js')
    fileReadCache.clear()
    for (let i = 0; i < 2000; i++) {
      fileReadCache.readFile(`/tmp/fake_${i}.txt`)
    }
    expect(fileReadCache.getStats().size).toBeLessThanOrEqual(1000)
  })
})
