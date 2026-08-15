#!/usr/bin/env bun
/**
 * Memory Retainers Probe — exercises production singletons directly.
 *
 * Doesn't boot QueryEngine (too much config surface). Instead, drives each
 * of the 14 suspect retainers directly with N iterations, measures growth
 * and caps, and reports per-retainer memory cost.
 *
 * Goal: answer the question "which singleton grows when a real Claudin
 * session runs for hours?" without requiring a full provider setup.
 *
 * Usage:
 *   bun --expose-gc scripts/profile/memory-retainers-probe.ts
 *   bun --expose-gc scripts/profile/memory-retainers-probe.ts --iterations=10000
 */

import { performance } from 'node:perf_hooks'

type Args = {
  iterations: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { iterations: 2000, json: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true
    else if (arg === '--json') a.json = true
    else if (arg.startsWith('--iterations=')) a.iterations = Number(arg.slice(13)) || a.iterations
  }
  return a
}

function forceGC(): void {
  if (typeof global.gc === 'function') global.gc()
}
async function idle(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}
function heapBytes(): number {
  return process.memoryUsage().heapUsed
}
function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type Result = {
  name: string
  iterations: number
  declaredCap: number | 'unbounded' | 'unknown'
  observedSize: number
  heapDeltaBytes: number
  heapDeltaBytesPerIteration: number
  wallMs: number
  note?: string
}

async function measure(
  name: string,
  declaredCap: number | 'unbounded' | 'unknown',
  iterations: number,
  setup: () => Promise<void> | void,
  exercise: (i: number) => Promise<void> | void,
  observe: () => Promise<number> | number,
  note?: string,
): Promise<Result> {
  await setup()
  forceGC()
  await idle(10)
  forceGC()
  const h0 = heapBytes()
  const t0 = performance.now()

  for (let i = 0; i < iterations; i++) {
    await exercise(i)
  }

  const wallMs = performance.now() - t0
  const observedSize = await observe()
  forceGC()
  await idle(10)
  forceGC()
  const h1 = heapBytes()
  const heapDeltaBytes = Math.max(0, h1 - h0)

  return {
    name,
    iterations,
    declaredCap,
    observedSize,
    heapDeltaBytes,
    heapDeltaBytesPerIteration: heapDeltaBytes / Math.max(1, iterations),
    wallMs,
    note,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`memory-retainers-probe — probe all known retainers

  --iterations=N    iterations per probe (default 2000)
  --json            emit JSON
  --help
`)
    return
  }
  if (typeof global.gc !== 'function') {
    console.warn('WARN: run with --expose-gc for accurate heap deltas\n')
  }

  const N = args.iterations
  const results: Result[] = []

  // Silence heavy analytics/growthbook that some retainers import
  const { mock } = await import('bun:test')
  mock.module('../../src/platform/analytics/growthbook.js', () => ({
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
  mock.module('../../src/platform/analytics/index.js', () => ({
    logEvent: () => {},
    logEventAsync: async () => {},
    attachAnalyticsSink: () => {},
    stripProtoFields: <V,>(v: V) => v,
    _resetForTesting: () => {},
  }))

  // --- #1 perKeyClippedIds -------------------------------------------------
  try {
    const mod = await import('../../src/agent/compact/stableStubState.js')
    results.push(
      await measure(
        '#1 perKeyClippedIds (addClippedIds)',
        16, // MAX_TRACKED_KEYS
        N,
        () => mod._resetAllClippedIdsForTesting(),
        i => mod.addClippedIds([`toolu_${i}`]),
        () => mod._getClippedIdsMapSizeForTesting(),
        'Set inside per-key bucket has no cap; mapSize capped at 16 keys',
      ),
    )
    // Also measure total ids (per-bucket growth)
    mod._resetAllClippedIdsForTesting()
    results.push(
      await measure(
        '#1b perKeyClippedIds.totalIds',
        'unbounded',
        N,
        () => mod._resetAllClippedIdsForTesting(),
        i => mod.addClippedIds([`id_${i}`]),
        () => mod._getClippedIdsTotalCountForTesting(),
        'Grows monotonically with tool_use_ids until pruneOrphanClippedIds runs',
      ),
    )
  } catch (e) {
    console.error('#1 perKeyClippedIds: SKIP', (e as Error).message)
  }

  // --- #2 ContentReplacementState (direct manipulation) -------------------
  try {
    const mod = await import('../../src/agent/tools/toolResultStorage.js')
    const state = mod.createContentReplacementState()
    results.push(
      await measure(
        '#2a ContentReplacementState.seenIds',
        'unbounded',
        N,
        () => {},
        i => {
          state.seenIds.add(`id_${i}`)
        },
        () => state.seenIds.size,
        'Per-turn reset on REPL only; SDK path grows monotonically',
      ),
    )
    results.push(
      await measure(
        '#2b ContentReplacementState.replacements',
        'unbounded',
        N,
        () => {},
        i => {
          state.replacements.set(
            `id_${i}`,
            `<persisted-output>/tmp/turn-${i}</persisted-output>`,
          )
        },
        () => state.replacements.size,
        'Stores replacement strings (~60 bytes each); without prune grows linearly',
      ),
    )
  } catch (e) {
    console.error('#2 ContentReplacementState: SKIP', (e as Error).message)
  }

  // --- #3 MCP connectToServer memoize cache -------------------------------
  try {
    const mod = await import('../../src/services/mcp/client.js')
    const get = mod.__TEST_ONLY_getMemoizeCacheSize
    if (typeof get === 'function') {
      results.push({
        name: '#3 MCP connectToServer.cache (observed)',
        iterations: 0,
        declaredCap: 'unbounded',
        observedSize: get(),
        heapDeltaBytes: 0,
        heapDeltaBytesPerIteration: 0,
        wallMs: 0,
        note:
          'lodash memoize — unbounded by design. Observed at probe time only.',
      })
    }
  } catch (e) {
    console.error('#3 MCP cache: SKIP', (e as Error).message)
  }

  // --- #5 fileReadCache ----------------------------------------------------
  try {
    const mod = await import('../../src/shared/fs/fileReadCache.js')
    const cache = mod.fileReadCache
    results.push({
      name: '#5 fileReadCache (observed)',
      iterations: 0,
      declaredCap: 1000,
      observedSize: cache.size,
      heapDeltaBytes: 0,
      heapDeltaBytesPerIteration: 0,
      wallMs: 0,
      note: 'LRU 1000 × 256KB/entry ceiling. Observed at probe time.',
    })
  } catch (e) {
    console.error('#5 fileReadCache: SKIP', (e as Error).message)
  }

  // --- #7 sessionIngress ---------------------------------------------------
  try {
    const mod = await import('../../src/providers/transport/sessionIngress.js')
    if (typeof mod._getSessionCountForTesting === 'function') {
      results.push({
        name: '#7 sessionIngress total sessions (observed)',
        iterations: 0,
        declaredCap: 'unbounded',
        observedSize: mod._getSessionCountForTesting(),
        heapDeltaBytes: 0,
        heapDeltaBytesPerIteration: 0,
        wallMs: 0,
        note: 'lastUuidMap + sequentialAppendBySession — no cap, cleared by clearAllSessions',
      })
    }
  } catch (e) {
    console.error('#7 sessionIngress: SKIP', (e as Error).message)
  }

  // --- #8 diagnosticTracker -----------------------------------------------
  try {
    const mod = await import('../../src/platform/diagnosticTracking.js')
    if (typeof mod.__TEST_ONLY_getDiagnosticTrackerSizes === 'function') {
      const sizes = mod.__TEST_ONLY_getDiagnosticTrackerSizes()
      let i = 0
      for (const [k, v] of Object.entries(sizes)) {
        results.push({
          name: `#8${'abcdef'[i++]} diag.${k} (observed)`,
          iterations: 0,
          declaredCap: 'unbounded',
          observedSize: v as number,
          heapDeltaBytes: 0,
          heapDeltaBytesPerIteration: 0,
          wallMs: 0,
        })
      }
    }
  } catch (e) {
    console.error('#8 diagnosticTracker: SKIP', (e as Error).message)
  }

  // --- #9 agentTranscriptSubdirs -----------------------------------------
  try {
    const mod = await import('../../src/sessions/sessionStorage.js')
    if (typeof mod.__TEST_ONLY_getAgentTranscriptSubdirsSize === 'function') {
      results.push({
        name: '#9 agentTranscriptSubdirs (observed)',
        iterations: 0,
        declaredCap: 'unbounded',
        observedSize: mod.__TEST_ONLY_getAgentTranscriptSubdirsSize(),
        heapDeltaBytes: 0,
        heapDeltaBytesPerIteration: 0,
        wallMs: 0,
      })
    }
  } catch (e) {
    console.error('#9 agentTranscriptSubdirs: SKIP', (e as Error).message)
  }

  // --- #10 sentBashGitInstructions ---------------------------------------
  try {
    const mod = await import('../../src/agent/attachments/attachments.js')
    if (typeof mod.__TEST_ONLY_getBashGitInstructionsSize === 'function') {
      results.push({
        name: '#10 sentBashGitInstructions (observed)',
        iterations: 0,
        declaredCap: 'unbounded',
        observedSize: mod.__TEST_ONLY_getBashGitInstructionsSize(),
        heapDeltaBytes: 0,
        heapDeltaBytesPerIteration: 0,
        wallMs: 0,
      })
    }
  } catch (e) {
    console.error('#10 sentBashGitInstructions: SKIP', (e as Error).message)
  }

  // --- #11 markdownTokenCache --------------------------------------------
  try {
    const mod = await import('../../src/terminal/markdown/markdownTokenCache.js')
    // Use cache hot path (cachedLexer) to fill it
    results.push(
      await measure(
        '#11 markdownTokenCache (LRU 500)',
        500,
        N,
        () => mod.__TEST_ONLY_resetTokenCache(),
        i => {
          mod.cachedLexer(`# heading ${i}\n\nbody ${i} with \`code\`\n`)
        },
        () => mod.__TEST_ONLY_getTokenCacheSize(),
        'LRU bounded; measure heap cost per filled entry',
      ),
    )
  } catch (e) {
    console.error('#11 markdownTokenCache: SKIP', (e as Error).message)
  }

  // --- #13 classifierApprovals -------------------------------------------
  try {
    const mod = await import('../../src/permissions/classifierApprovalsHook.js')
    if (typeof mod.__TEST_ONLY_getClassifierApprovalsSize === 'function') {
      results.push({
        name: '#13 classifierApprovals (observed)',
        iterations: 0,
        declaredCap: 'unbounded',
        observedSize: mod.__TEST_ONLY_getClassifierApprovalsSize(),
        heapDeltaBytes: 0,
        heapDeltaBytesPerIteration: 0,
        wallMs: 0,
      })
    }
  } catch (e) {
    console.error('#13 classifierApprovals: SKIP', (e as Error).message)
  }

  // --- Output ------------------------------------------------------------
  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    console.log('\nRetainer probe results:\n')
    console.log(
      '  Name'.padEnd(46) +
        'cap'.padStart(12) +
        'observed'.padStart(12) +
        'heap Δ'.padStart(14) +
        'Δ/iter'.padStart(14) +
        'wall'.padStart(10),
    )
    console.log('  ' + '─'.repeat(104))
    for (const r of results) {
      const cap = typeof r.declaredCap === 'number' ? String(r.declaredCap) : r.declaredCap
      console.log(
        `  ${r.name.padEnd(44)} ${cap.padStart(10)}  ${String(r.observedSize).padStart(10)}  ${fmtBytes(r.heapDeltaBytes).padStart(12)}  ${fmtBytes(r.heapDeltaBytesPerIteration).padStart(12)}  ${r.wallMs.toFixed(0)}ms`,
      )
      if (r.note) console.log(`    ${r.note}`)
    }
    console.log('\nLegend: observed = structure size at end of iterations; heap Δ = RSS-independent heap growth; Δ/iter = bytes per iteration')
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
