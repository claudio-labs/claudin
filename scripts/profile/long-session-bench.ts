#!/usr/bin/env bun
// Long-session memory bench — ROADMAP item 5.3.
//
// Simulates a long-running session by feeding each module-level cache N
// distinct entries, then asserts that observed size never exceeds the
// declared cap and that heap delta per cycle stays bounded. Catches the
// "container that grows unbounded per turn" class of leak that the
// roadmap originally suspected. Companion test (cacheBoundsInvariants)
// runs in CI; this bench produces numbers for the baselines/.
//
// Driver philosophy: import each cache module directly. We DO NOT spin up
// QueryEngine — bootstrap costs 100+ MB of static state and contaminates
// the heap delta we're trying to measure.
//
// Usage:
//   bun run scripts/profile/long-session-bench.ts
//   bun run scripts/profile/long-session-bench.ts --cycles=10000 --json
//
// Required: --expose-gc for honest heap deltas (bin/claudin enables it
// by default). Bench falls back to no-gc and warns.

import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

type Mode = 'isolated' | 'mixed' | 'both'

type Args = {
  cycles: number
  turns: number
  mode: Mode
  warmup: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cycles: 10_000,
    turns: 2_000,
    mode: 'both',
    warmup: 0,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--cycles='))
      args.cycles = Number(a.slice('--cycles='.length))
    else if (a.startsWith('--turns='))
      args.turns = Number(a.slice('--turns='.length))
    else if (a.startsWith('--mode=')) {
      const m = a.slice('--mode='.length) as Mode
      if (m === 'isolated' || m === 'mixed' || m === 'both') args.mode = m
    } else if (a.startsWith('--warmup='))
      args.warmup = Number(a.slice('--warmup='.length))
  }
  return args
}

function printHelp(): void {
  console.log(`long-session-bench — measure cache bounds under sustained load

  --mode=M      'isolated' (per-cache cap test), 'mixed' (interleaved
                large-project session), or 'both' (default)
  --cycles=N    distinct insertions per cache, isolated mode (default: 10000)
  --turns=N     simulated turns in mixed-session mode (default: 2000)
  --warmup=N    warmup iterations, discarded (default: 0)
  --json        machine-readable output for baselines/
  --help        show this help`)
}

type CacheResult = {
  name: string
  declaredCap: number
  observedSize: number
  heapDeltaBytes: number
  heapDeltaBytesPerCycle: number
  wallMs: number
  passed: boolean
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function heapBytes(): number {
  return process.memoryUsage().heapUsed
}

function memSnap(): { heap: number; rss: number; ext: number; ab: number } {
  const m = process.memoryUsage()
  return { heap: m.heapUsed, rss: m.rss, ext: m.external, ab: m.arrayBuffers }
}

async function measure<T>(
  name: string,
  declaredCap: number,
  cycles: number,
  setup: () => Promise<T> | T,
  exercise: (ctx: T, i: number) => Promise<void> | void,
  observe: (ctx: T) => Promise<number> | number,
): Promise<CacheResult> {
  const ctx = await setup()
  // Stabilize: GC + small wait, then take baseline.
  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const heap0 = heapBytes()
  const t0 = performance.now()

  for (let i = 0; i < cycles; i++) {
    await exercise(ctx, i)
  }

  const wallMs = performance.now() - t0
  const observedSize = await observe(ctx)
  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const heap1 = heapBytes()
  const heapDeltaBytes = Math.max(0, heap1 - heap0)

  return {
    name,
    declaredCap,
    observedSize,
    heapDeltaBytes,
    heapDeltaBytesPerCycle: heapDeltaBytes / Math.max(1, cycles),
    wallMs,
    passed: observedSize <= declaredCap,
  }
}

async function exerciseTokenCache(cycles: number): Promise<CacheResult> {
  const {
    cachedLexer,
    __TEST_ONLY_resetTokenCache,
    __TEST_ONLY_getTokenCacheSize,
  } = await import('../../src/components/markdownTokenCache.js')

  return measure(
    'Markdown.tokenCache',
    500,
    cycles,
    () => __TEST_ONLY_resetTokenCache(),
    (_ctx, i) => {
      // Markdown syntax (header) so cache path is taken.
      cachedLexer(`# heading ${i}\n\nbody ${i} with some inline \`code\`.\n`)
    },
    () => __TEST_ONLY_getTokenCacheSize(),
  )
}

async function exerciseToolProgress(cycles: number): Promise<CacheResult> {
  // Mock heavy upstream deps before importing queryHelpers — it transitively
  // pulls in tools/, sessionStorage, analytics, etc. We only need
  // recordToolProgress + size accessor.
  const { mock } = await import('bun:test')
  mock.module('../../src/services/analytics/growthbook.js', () => ({
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
  mock.module('../../src/services/analytics/index.js', () => ({
    logEvent: () => {},
    logEventAsync: async () => {},
    attachAnalyticsSink: () => {},
    stripProtoFields: <V,>(v: V) => v,
    _resetForTesting: () => {},
  }))

  const {
    __TEST_ONLY_recordToolProgress,
    __TEST_ONLY_resetToolProgressMap,
    __TEST_ONLY_getToolProgressMapSize,
  } = await import('../../src/utils/queryHelpers.js')

  return measure(
    'queryHelpers.toolProgressLastSentTime',
    100,
    cycles,
    () => __TEST_ONLY_resetToolProgressMap(),
    (_ctx, i) => {
      __TEST_ONLY_recordToolProgress(`tool-call-${i}`)
    },
    () => __TEST_ONLY_getToolProgressMapSize(),
  )
}

async function exerciseImageStore(cycles: number): Promise<CacheResult> {
  const { mock } = await import('bun:test')
  mock.module('../../src/utils/debug.js', () => ({ logForDebugging: () => {} }))
  mock.module('../../src/bootstrap/state.js', () => ({
    getSessionId: () => 'bench-session',
  }))
  mock.module('../../src/utils/envUtils.js', () => ({
    getClaudinConfigHomeDir: () => '/tmp/claudin-bench',
    isEnvTruthy: () => false,
  }))
  // Note: fsOperations intentionally not mocked — cacheImagePath does no fs I/O,
  // and mocking fsOperations here would taint the real-fs fileReadCache exerciser.
  const {
    cacheImagePath,
    clearStoredImagePaths,
    __TEST_ONLY_getStoredImagePathsSize,
  } = await import('../../src/utils/imageStore.js')

  return measure(
    'imageStore.storedImagePaths',
    200,
    cycles,
    () => clearStoredImagePaths(),
    (_ctx, i) => {
      cacheImagePath({
        type: 'image',
        id: i,
        mediaType: 'image/png',
        // @ts-expect-error minimal fixture
        content: '',
      })
    },
    () => __TEST_ONLY_getStoredImagePathsSize(),
  )
}

async function exerciseLSPDelivered(cycles: number): Promise<CacheResult> {
  const { mock } = await import('bun:test')
  mock.module('../../src/utils/debug.js', () => ({ logForDebugging: () => {} }))
  mock.module('../../src/utils/log.js', () => ({ logError: () => {} }))
  mock.module('../../src/utils/slowOperations.js', () => ({
    jsonStringify: (x: unknown) => JSON.stringify(x),
  }))

  const {
    markDiagnosticsAsDelivered,
    _resetDeliveredDiagnosticsForTesting,
    _getDeliveredDiagnosticsCountForTesting,
  } = await import('../../src/services/lsp/LSPDiagnosticRegistry.js')

  return measure(
    'LSPDiagnosticRegistry.deliveredDiagnostics',
    500,
    cycles,
    () => _resetDeliveredDiagnosticsForTesting(),
    (_ctx, i) => {
      markDiagnosticsAsDelivered([
        {
          uri: `file:///bench/file_${i}.ts`,
          diagnostics: [
            {
              message: `diagnostic ${i}`,
              severity: 'Error',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: minimal DiagnosticFile fixture
        } as any,
      ])
    },
    () => _getDeliveredDiagnosticsCountForTesting(),
  )
}

async function exerciseFileReadCache(cycles: number): Promise<CacheResult> {
  // Real fs path: build N tiny fixtures in tmpdir, read each via the cache.
  // No mocks — measures the real production path.
  const dir = join(tmpdir(), `claudin-long-session-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // Pre-create fixtures (don't include this in heap delta).
  for (let i = 0; i < cycles; i++) {
    writeFileSync(join(dir, `f_${i}.txt`), `content ${i}`)
  }

  const { fileReadCache } = await import('../../src/utils/fileReadCache.js')

  const result = await measure(
    'fileReadCache',
    1000,
    cycles,
    () => fileReadCache.clear(),
    (_ctx, i) => {
      fileReadCache.readFile(join(dir, `f_${i}.txt`))
    },
    () => fileReadCache.getStats().size,
  )

  rmSync(dir, { recursive: true, force: true })
  return result
}

/**
 * Mixed-session exerciser. Simulates a long Claudin session on a large
 * project — each "turn" interleaves the workload mix observed in real
 * sessions:
 *   - 5 file reads via fileReadCache (Read/Edit/Grep tool results)
 *   - 3 markdown renders via tokenCache (assistant message bodies)
 *   - 2 LSP diagnostics published (after edits)
 *   - 2 bash progress events (long-running tool throttling)
 *   - 1 image paste every 50 turns (rare, but big content)
 *
 * Snapshot heap usage every 10% of turns to surface the *growth curve*,
 * not just start vs end. A leak shows as monotonic growth across
 * snapshots; bounded behavior shows as a plateau after caches hit cap.
 */
type SessionSnapshot = {
  turn: number
  heapUsedBytes: number
  heapDeltaBytes: number
  rssBytes: number
  rssDeltaBytes: number
  externalBytes: number
  arrayBuffersBytes: number
  caches: {
    tokenCache: number
    toolProgress: number
    storedImagePaths: number
    deliveredDiagnostics: number
    fileReadCache: number
  }
}

type MixedResult = {
  turns: number
  totalFileReads: number
  totalMarkdownRenders: number
  totalDiagnostics: number
  totalProgress: number
  totalImages: number
  baselineHeapBytes: number
  finalHeapBytes: number
  finalHeapDeltaBytes: number
  finalHeapDeltaMB: number
  wallMs: number
  snapshots: SessionSnapshot[]
  // True if heap grew monotonically across the second half of snapshots
  // (i.e. caches saturated by midpoint and stayed flat). False if growth
  // continues past saturation — that's the leak signature.
  saturated: boolean
}

async function exerciseMixedSession(turns: number): Promise<MixedResult> {
  // Imports must happen AFTER any prior mock.module calls from
  // exerciseToolProgress / exerciseImageStore / exerciseLSPDelivered, since
  // mock.module is process-global and persists. Mixed-session is run last
  // when mode=both, so by here mocks are already installed for queryHelpers,
  // imageStore, LSP. fileReadCache uses real fs.
  const {
    cachedLexer,
    __TEST_ONLY_resetTokenCache,
    __TEST_ONLY_getTokenCacheSize,
  } = await import('../../src/components/markdownTokenCache.js')
  const {
    __TEST_ONLY_recordToolProgress,
    __TEST_ONLY_resetToolProgressMap,
    __TEST_ONLY_getToolProgressMapSize,
  } = await import('../../src/utils/queryHelpers.js')
  const {
    cacheImagePath,
    clearStoredImagePaths,
    __TEST_ONLY_getStoredImagePathsSize,
  } = await import('../../src/utils/imageStore.js')
  const {
    markDiagnosticsAsDelivered,
    _resetDeliveredDiagnosticsForTesting,
    _getDeliveredDiagnosticsCountForTesting,
  } = await import('../../src/services/lsp/LSPDiagnosticRegistry.js')

  // Real fs fixtures for fileReadCache: create a pool of files larger than
  // the cap so we trigger evictions (turns × 5 reads / 1000 cap = many evictions).
  const dir = join(tmpdir(), `claudin-mixed-session-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const POOL_SIZE = 5000 // unique files; reads pick `turn*5+i` so we sweep through
  for (let i = 0; i < POOL_SIZE; i++) {
    writeFileSync(join(dir, `f_${i}.txt`), `// file ${i}\nexport const x = ${i}\n`)
  }
  // We don't know what FileReadCache singleton exists; mocks may have been
  // installed by other exercisers but fileReadCache.ts is imported fresh.
  const { fileReadCache } = await import('../../src/utils/fileReadCache.js')

  // Reset all caches so snapshots start clean.
  __TEST_ONLY_resetTokenCache()
  __TEST_ONLY_resetToolProgressMap()
  clearStoredImagePaths()
  _resetDeliveredDiagnosticsForTesting()
  fileReadCache.clear()

  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const baselineHeap = heapBytes()
  const baselineRss = process.memoryUsage().rss
  const t0 = performance.now()

  const snapshots: SessionSnapshot[] = []
  const snapshotInterval = Math.max(1, Math.floor(turns / 10))

  let totalFileReads = 0
  let totalMarkdownRenders = 0
  let totalDiagnostics = 0
  let totalProgress = 0
  let totalImages = 0

  const sampleCode = '```ts\nfunction f() { return 1 }\n```'

  for (let turn = 0; turn < turns; turn++) {
    // 5 file reads — sweep through pool so we exceed cap (1000) and force evict.
    for (let r = 0; r < 5; r++) {
      const fileIdx = (turn * 5 + r) % POOL_SIZE
      fileReadCache.readFile(join(dir, `f_${fileIdx}.txt`))
      totalFileReads++
    }

    // 3 markdown renders — distinct content per turn (distinct hash → distinct
    // cache entry).
    for (let m = 0; m < 3; m++) {
      cachedLexer(
        `# Turn ${turn} message ${m}\n\nSome **bold** text and ${sampleCode}\n`,
      )
      totalMarkdownRenders++
    }

    // 2 LSP diagnostics — distinct file URIs.
    for (let d = 0; d < 2; d++) {
      markDiagnosticsAsDelivered([
        {
          uri: `file:///mixed/turn_${turn}_${d}.ts`,
          diagnostics: [
            {
              message: `diagnostic at turn ${turn}`,
              severity: 'Error',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
        } as any,
      ])
      totalDiagnostics++
    }

    // 2 progress events — distinct tool-call ids.
    for (let p = 0; p < 2; p++) {
      __TEST_ONLY_recordToolProgress(`turn_${turn}_call_${p}`)
      totalProgress++
    }

    // 1 image every 50 turns.
    if (turn % 50 === 0) {
      cacheImagePath({
        type: 'image',
        id: turn,
        mediaType: 'image/png',
        content: '',
      })
      totalImages++
    }

    // Snapshot at every 10% boundary (and final).
    if ((turn + 1) % snapshotInterval === 0 || turn === turns - 1) {
      gc()
      const memNow = process.memoryUsage()
      const heapNow = memNow.heapUsed
      snapshots.push({
        turn: turn + 1,
        heapUsedBytes: heapNow,
        heapDeltaBytes: heapNow - baselineHeap,
        rssBytes: memNow.rss,
        rssDeltaBytes: memNow.rss - baselineRss,
        externalBytes: memNow.external,
        arrayBuffersBytes: memNow.arrayBuffers,
        caches: {
          tokenCache: __TEST_ONLY_getTokenCacheSize(),
          toolProgress: __TEST_ONLY_getToolProgressMapSize(),
          storedImagePaths: __TEST_ONLY_getStoredImagePathsSize(),
          deliveredDiagnostics: _getDeliveredDiagnosticsCountForTesting(),
          fileReadCache: fileReadCache.getStats().size,
        },
      })
    }
  }

  const wallMs = performance.now() - t0
  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const finalHeap = heapBytes()

  rmSync(dir, { recursive: true, force: true })

  // Saturation check: across snapshots in the second half, heap delta
  // should not grow by more than 5% of the midpoint value. Allow slack for
  // GC noise.
  const half = Math.floor(snapshots.length / 2)
  const secondHalf = snapshots.slice(half)
  const midDelta = snapshots[half]?.heapDeltaBytes ?? 0
  const maxDelta = Math.max(...secondHalf.map(s => s.heapDeltaBytes))
  const saturated = midDelta === 0
    ? maxDelta < 1024 * 1024 // <1 MB total in 2nd half is "no growth"
    : (maxDelta - midDelta) / midDelta < 0.05

  return {
    turns,
    totalFileReads,
    totalMarkdownRenders,
    totalDiagnostics,
    totalProgress,
    totalImages,
    baselineHeapBytes: baselineHeap,
    finalHeapBytes: finalHeap,
    finalHeapDeltaBytes: Math.max(0, finalHeap - baselineHeap),
    finalHeapDeltaMB: Math.max(0, finalHeap - baselineHeap) / 1024 / 1024,
    wallMs,
    snapshots,
    saturated,
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  if (typeof global.gc !== 'function') {
    console.error(
      'WARN: global.gc unavailable — run with `bun --expose-gc` or `node --expose-gc` for honest heap deltas. Continuing without forced GC.',
    )
  }

  // Order matters: exerciseFileReadCache uses real fs and must run before
  // any exerciser that mock.module's '../../src/utils/fsOperations.js'.
  // Bun's mock.module is process-global and not unwound between awaits.
  // Mixed-session runs LAST because it relies on mocks installed by the
  // isolated exercisers above.
  const isolatedExercisers: Array<(c: number) => Promise<CacheResult>> = [
    exerciseFileReadCache,
    exerciseTokenCache,
    exerciseToolProgress,
    exerciseImageStore,
    exerciseLSPDelivered,
  ]

  const results: CacheResult[] = []
  if (args.mode === 'isolated' || args.mode === 'both') {
    for (const ex of isolatedExercisers) {
      try {
        const r = await ex(args.cycles)
        results.push(r)
      } catch (err) {
        console.error(`Isolated bench failed: ${(err as Error).message}`)
        console.error((err as Error).stack)
        process.exitCode = 1
      }
    }
  }

  let mixed: MixedResult | null = null
  if (args.mode === 'mixed' || args.mode === 'both') {
    try {
      mixed = await exerciseMixedSession(args.turns)
    } catch (err) {
      console.error(`Mixed-session bench failed: ${(err as Error).message}`)
      console.error((err as Error).stack)
      process.exitCode = 1
    }
  }

  const totalHeapDeltaBytes = results.reduce(
    (s, r) => s + r.heapDeltaBytes,
    0,
  )
  const allPassed =
    results.every(r => r.passed) && (mixed ? mixed.saturated : true)

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          cycles: args.cycles,
          turns: args.turns,
          mode: args.mode,
          gcEnabled: typeof global.gc === 'function',
          allPassed,
          totalHeapDeltaBytes,
          totalHeapDeltaMB: totalHeapDeltaBytes / 1024 / 1024,
          results,
          mixed,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  if (results.length > 0) {
    console.log(
      `Isolated mode: cycles=${args.cycles} per cache; gc=${typeof global.gc === 'function' ? 'on' : 'off'}\n`,
    )
    console.log(
      'cache                                            cap   size   delta       /cycle    wall      ok',
    )
    for (const r of results) {
      const ok = r.passed ? 'PASS' : 'FAIL'
      console.log(
        `${r.name.padEnd(46)} ${String(r.declaredCap).padStart(5)} ${String(r.observedSize).padStart(6)}  ${fmtBytes(r.heapDeltaBytes).padStart(8)}  ${fmtBytes(r.heapDeltaBytesPerCycle).padStart(8)}  ${fmt(r.wallMs).padStart(7)}ms  ${ok}`,
      )
    }
    console.log('')
    console.log(`total isolated heap delta: ${fmtBytes(totalHeapDeltaBytes)}`)
    console.log('')
  }

  if (mixed) {
    console.log(`Mixed-session mode: ${mixed.turns} turns simulated`)
    console.log(
      `  workload: ${mixed.totalFileReads} file reads, ${mixed.totalMarkdownRenders} markdown renders, ${mixed.totalDiagnostics} LSP diagnostics, ${mixed.totalProgress} tool progress events, ${mixed.totalImages} images`,
    )
    console.log(`  wall: ${fmt(mixed.wallMs)}ms\n`)
    console.log(
      'turn       heap used   Δheap        RSS    ΔRSS    ext    arrBuf  tokenC  toolPr  imgs  lspD  fileRC',
    )
    for (const s of mixed.snapshots) {
      console.log(
        `${String(s.turn).padStart(5)}  ${fmtBytes(s.heapUsedBytes).padStart(10)}  ${fmtBytes(s.heapDeltaBytes).padStart(9)}  ${fmtBytes(s.rssBytes).padStart(8)}  ${fmtBytes(s.rssDeltaBytes).padStart(7)}  ${fmtBytes(s.externalBytes).padStart(6)}  ${fmtBytes(s.arrayBuffersBytes).padStart(7)}  ${String(s.caches.tokenCache).padStart(6)}  ${String(s.caches.toolProgress).padStart(6)}  ${String(s.caches.storedImagePaths).padStart(4)}  ${String(s.caches.deliveredDiagnostics).padStart(4)}  ${String(s.caches.fileReadCache).padStart(6)}`,
      )
    }
    console.log('')
    console.log(
      `  final heap delta: ${fmtBytes(mixed.finalHeapDeltaBytes)} (${mixed.finalHeapDeltaMB.toFixed(2)} MB)`,
    )
    console.log(
      `  saturation check: ${mixed.saturated ? 'PASS — caches plateau in 2nd half (no monotonic growth)' : 'FAIL — heap continues to grow past midpoint'}`,
    )
    console.log('')
  }

  console.log(
    `overall: ${allPassed ? 'PASS' : 'FAIL — see results above'}`,
  )
  console.log('')
  console.log(
    'Note: heap delta is best-effort even with --expose-gc. Treat per-cycle values <2 KB as noise.',
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
