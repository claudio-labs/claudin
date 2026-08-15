#!/usr/bin/env bun
/**
 * Memory E2E Bench — exercises REAL QueryEngine with a fake model.
 *
 * This bench runs a parametric multi-turn agent session using the real
 * Claudin QueryEngine (not a synthetic mirror like
 * memory-turn-by-turn-bench.ts). It injects a fake callModel via
 * QueryDeps to avoid network, and measures heap growth turn-by-turn
 * with a breakdown across 14 retainers.
 *
 * Goal: reproduce the 1.1GB heap observed on user's real running
 * instance (PID 5404 — RSS 1.3GB, heap V8 1.1GB after 13h) and
 * identify which retainer is responsible.
 *
 * Usage:
 *   bun --expose-gc scripts/profile/memory-e2e-bench.ts --mode=text --turns=50
 *   bun --expose-gc scripts/profile/memory-e2e-bench.ts --mode=tool --turns=100
 *   bun --expose-gc scripts/profile/memory-e2e-bench.ts --mode=mixed --turns=500 --csv=out.csv --inflection
 */

import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'

import type { QueryDeps } from '../../src/query/deps.js'
import {
  createFakeCallModel,
  fakeMicrocompact,
  fakeAutocompact,
  turnText,
  turnToolUse,
  type TurnScript,
} from './fakeProviderE2E.js'

// --- Args ---

type Mode = 'text' | 'tool' | 'mixed'

type Args = {
  turns: number
  mode: Mode
  toolOutputKb: number
  csv: string | null
  json: boolean
  inflection: boolean
  help: boolean
  verbose: boolean
  bootstrapOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    turns: 20,
    mode: 'text',
    toolOutputKb: 50,
    csv: null,
    json: false,
    inflection: false,
    help: false,
    verbose: false,
    bootstrapOnly: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true
    else if (arg === '--json') a.json = true
    else if (arg === '--inflection') a.inflection = true
    else if (arg === '--verbose') a.verbose = true
    else if (arg === '--bootstrap-only') a.bootstrapOnly = true
    else if (arg.startsWith('--turns=')) a.turns = Number(arg.slice(8)) || a.turns
    else if (arg.startsWith('--mode=')) {
      const m = arg.slice(7) as Mode
      if (m === 'text' || m === 'tool' || m === 'mixed') a.mode = m
    } else if (arg.startsWith('--tool-output-kb=')) a.toolOutputKb = Number(arg.slice(17)) || a.toolOutputKb
    else if (arg.startsWith('--csv=')) a.csv = arg.slice(6)
  }
  return a
}

function printHelp(): void {
  console.log(`memory-e2e-bench — REAL QueryEngine + fake model driver

  --turns=N            turns to run (default 20)
  --mode=M             text | tool | mixed  (default text)
  --tool-output-kb=K   synthetic tool output size (default 50)
  --csv=PATH           write per-turn CSV
  --inflection         analyze inflection point
  --json               emit JSON summary
  --verbose            log per-call messages
  --help
`)
}

// --- GC + measurement ---

function forceGC(): void {
  if (typeof global.gc === 'function') global.gc()
}

async function idle(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

type MemSample = {
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  arrayBuffers: number
}

function sampleMem(): MemSample {
  const m = process.memoryUsage()
  return {
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    rss: m.rss,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  }
}

function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// --- Retainer probes ---
//
// Each probe returns a Record<string, number> with sizes of structures we
// suspect. Failures are swallowed (some probes import heavy modules that
// may not be loaded yet — we just skip them if import fails).

type RetainerSnapshot = Record<string, number>

async function probeRetainers(): Promise<RetainerSnapshot> {
  const out: RetainerSnapshot = {}

  // #1 perKeyClippedIds
  try {
    const mod = await import('../../src/services/compact/stableStubState.js')
    out['perKeyClippedIds.keys'] = mod._getClippedIdsMapSizeForTesting()
    out['perKeyClippedIds.totalIds'] = mod._getClippedIdsTotalCountForTesting()
  } catch {}

  // #3 MCP memoize cache
  try {
    const mod = await import('../../src/services/mcp/client.js')
    if (typeof mod.__TEST_ONLY_getMemoizeCacheSize === 'function') {
      out['mcp.connectToServer.cache'] = mod.__TEST_ONLY_getMemoizeCacheSize()
    }
  } catch {}

  // #5 fileReadCache
  try {
    const mod = await import('../../src/shared/fs/fileReadCache.js')
    out['fileReadCache.size'] = mod.fileReadCache.size
  } catch {}

  // #7 sessionIngress
  try {
    const mod = await import('../../src/services/api/sessionIngress.js')
    if (typeof mod._getLastUuidMapSize === 'function') {
      out['sessionIngress.lastUuidMap'] = mod._getLastUuidMapSize()
    }
    if (typeof mod._getSequentialAppendBySessionSize === 'function') {
      out['sessionIngress.sequentialAppend'] = mod._getSequentialAppendBySessionSize()
    }
  } catch {}

  // #8 diagnosticTracker
  try {
    const mod = await import('../../src/services/diagnosticTracking.js')
    if (typeof mod.__TEST_ONLY_getDiagnosticTrackerSizes === 'function') {
      const sizes = mod.__TEST_ONLY_getDiagnosticTrackerSizes()
      for (const [k, v] of Object.entries(sizes)) {
        out[`diag.${k}`] = v as number
      }
    }
  } catch {}

  // #9 agentTranscriptSubdirs
  try {
    const mod = await import('../../src/services/session/sessionStorage.js')
    if (typeof mod.__TEST_ONLY_getAgentTranscriptSubdirsSize === 'function') {
      out['sessionStorage.agentTranscriptSubdirs'] =
        mod.__TEST_ONLY_getAgentTranscriptSubdirsSize()
    }
  } catch {}

  // #10 sentBashGitInstructions
  try {
    const mod = await import('../../src/services/attachments/attachments.js')
    if (typeof mod.__TEST_ONLY_getBashGitInstructionsSize === 'function') {
      out['attachments.sentBashGitInstructions'] =
        mod.__TEST_ONLY_getBashGitInstructionsSize()
    }
  } catch {}

  // #13 classifierApprovals
  try {
    const mod = await import('../../src/utils/classifierApprovalsHook.js')
    if (typeof mod.__TEST_ONLY_getClassifierApprovalsSize === 'function') {
      out['classifierApprovals.size'] = mod.__TEST_ONLY_getClassifierApprovalsSize()
    }
  } catch {}

  // #11 markdown token cache
  try {
    const mod = await import('../../src/components/markdownTokenCache.js')
    if (typeof mod.__TEST_ONLY_getTokenCacheSize === 'function') {
      out['markdownTokenCache'] = mod.__TEST_ONLY_getTokenCacheSize()
    }
  } catch {}

  return out
}

// --- Script generators ---

function buildScript(mode: Mode, turns: number, toolOutputKb: number): TurnScript[] {
  const script: TurnScript[] = []
  for (let t = 0; t < turns; t++) {
    switch (mode) {
      case 'text':
        script.push(turnText(`Turn ${t + 1}: hello from the fake model.`, 50))
        break
      case 'tool':
        // Every turn emits a tool_use for a simple Bash command. The
        // QueryEngine will route to the real tool executor, which is
        // where the real code path runs.
        script.push(
          turnToolUse('Bash', {
            command: `echo "turn ${t + 1}"`,
            description: 'echo turn',
          }),
        )
        break
      case 'mixed':
        // Rotate: text, tool, text, tool...
        if (t % 2 === 0) {
          script.push(turnText(`Turn ${t + 1}: investigating`, 50))
        } else {
          script.push(
            turnToolUse('Bash', {
              command: `echo turn ${t + 1}`,
              description: 'echo turn',
            }),
          )
        }
        break
    }
  }
  // Final turn always ends with text so the loop terminates cleanly
  script.push(turnText('Done.', 5))
  return script
}

// --- Bench driver ---

type TurnRecord = {
  turn: number
  ts: number
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  arrayBuffers: number
  retainers: RetainerSnapshot
}

type BootstrapStage = {
  label: string
  heapBefore: number
  heapAfter: number
  rssBefore: number
  rssAfter: number
  delta: number
  retainersBefore: RetainerSnapshot
  retainersAfter: RetainerSnapshot
}

async function measureStages(): Promise<BootstrapStage[]> {
  const stages: BootstrapStage[] = []

  async function stage(
    label: string,
    fn: () => Promise<unknown> | unknown,
  ): Promise<void> {
    forceGC()
    await idle(20)
    forceGC()
    const before = sampleMem()
    const retainersBefore = await probeRetainers()
    await fn()
    forceGC()
    await idle(20)
    forceGC()
    const after = sampleMem()
    const retainersAfter = await probeRetainers()
    stages.push({
      label,
      heapBefore: before.heapUsed,
      heapAfter: after.heapUsed,
      rssBefore: before.rss,
      rssAfter: after.rss,
      delta: after.heapUsed - before.heapUsed,
      retainersBefore,
      retainersAfter,
    })
    console.error(
      `[stage] ${label.padEnd(30)} heap Δ=${fmtBytes(after.heapUsed - before.heapUsed).padStart(10)}  rss Δ=${fmtBytes(after.rss - before.rss).padStart(10)}  (heap=${fmtBytes(after.heapUsed)})`,
    )
  }

  // Each stage imports a subgraph and measures the cost.
  await stage('00 baseline', async () => {})
  await stage('01 utils/log', async () => {
    await import('../../src/shared/log.js')
  })
  await stage('02 utils/config', async () => {
    await import('../../src/services/config/config.js')
  })
  await stage('03 services/api/providerConfig', async () => {
    await import('../../src/services/api/providerConfig.js')
  })
  await stage('04 services/api/client', async () => {
    await import('../../src/services/api/client.js')
  })
  await stage('05 services/api/openaiShim', async () => {
    await import('../../src/services/api/openaiShim.js')
  })
  await stage('06 services/api/claude', async () => {
    await import('../../src/services/api/claude.js')
  })
  await stage('07 services/mcp/client', async () => {
    await import('../../src/services/mcp/client.js')
  })
  await stage('08 tools/FileReadTool', async () => {
    await import('../../src/tools/FileReadTool/index.js').catch(() => {})
  })
  await stage('09 tools/BashTool', async () => {
    await import('../../src/tools/BashTool/index.js').catch(() => {})
  })
  await stage('10 tools/GrepTool', async () => {
    await import('../../src/tools/GrepTool/index.js').catch(() => {})
  })
  await stage('11 tools/AgentTool', async () => {
    await import('../../src/tools/AgentTool/index.js').catch(() => {})
  })
  await stage('12 services/compact/*', async () => {
    await import('../../src/services/compact/microCompact.js')
    await import('../../src/services/compact/autoCompact.js')
    await import('../../src/services/compact/stableStubState.js')
  })
  await stage('13 utils/toolResultStorage', async () => {
    await import('../../src/services/tools/toolResultStorage.js')
  })
  await stage('14 QueryEngine', async () => {
    await import('../../src/QueryEngine.js')
  })
  await stage('15 screens/REPL', async () => {
    await import('../../src/screens/REPL.js').catch(() => {})
  })

  // Phase B: actually construct a QueryEngine
  await stage('16 new QueryEngine()', async () => {
    const [{ QueryEngine }, fileStateCacheMod] = await Promise.all([
      import('../../src/QueryEngine.js'),
      import('../../src/shared/fs/fileStateCache.js'),
    ])
    const {
      createFileStateCacheWithSizeLimit,
      READ_FILE_STATE_CACHE_SIZE,
    } = fileStateCacheMod
    const cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    // Intentionally cast — we're measuring construction cost, not running it
    new QueryEngine({
      cwd: process.cwd(),
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
      getAppState: () =>
        ({
          mode: 'default',
          todos: [],
          isLoading: false,
        }) as never,
      setAppState: () => {},
      readFileCache: cache,
    } as never)
  })

  // Phase C: provoke heavy graphs — MCP connect server cache, skill loading etc.
  await stage('17 activeProvider resolve', async () => {
    const mod = await import('../../src/services/api/activeProvider.js')
    try {
      mod.tryGetActiveProvider()
    } catch {}
  })

  return stages
}

async function runBench(args: Args): Promise<{
  baseline: MemSample
  history: TurnRecord[]
  wallMs: number
}> {
  // --- Phase 1: bootstrap (heavy imports, real modules) ---
  console.error('[bootstrap] importing real QueryEngine modules...')

  const { QueryEngine } = await import('../../src/QueryEngine.js')
  const {
    createFileStateCacheWithSizeLimit,
    READ_FILE_STATE_CACHE_SIZE,
  } = await import('../../src/shared/fs/fileStateCache.js')

  // --- Phase 2: construct config with fake deps ---
  const script = buildScript(args.mode, args.turns, args.toolOutputKb)
  const fakeCallModel = createFakeCallModel(script, {
    onCall: args.verbose
      ? (i, turn) => console.error(`  [fake] call ${i} kind=${turn.kind}`)
      : undefined,
  })

  const deps: QueryDeps = {
    callModel: fakeCallModel,
    microcompact: fakeMicrocompact as unknown as QueryDeps['microcompact'],
    autocompact: fakeAutocompact as unknown as QueryDeps['autocompact'],
    uuid: () => crypto.randomUUID(),
  }

  const readFileCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  // Minimal config. Many fields are required — we fill with benign defaults.
  // If the real loop touches a field that's undefined, we'll crash here
  // and fill it with something sane.
  const engine = new QueryEngine({
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }),
    getAppState: () => ({
      mode: 'default' as const,
      todos: [],
      isLoading: false,
      toolJSX: undefined,
      autoUpdaterResult: null,
      toolPermissionContext: {} as never,
      messages: [],
    }) as never,
    setAppState: () => {},
    readFileCache,
    verbose: false,
    maxTurns: 10, // cap so tool_use loops terminate
    deps,
  } as never)

  // --- Phase 3: lock baseline AFTER bootstrap ---
  forceGC()
  await idle(20)
  forceGC()
  const baseline = sampleMem()
  console.error(
    `[baseline] heap=${fmtBytes(baseline.heapUsed)} rss=${fmtBytes(baseline.rss)}`,
  )

  const t0 = performance.now()
  const history: TurnRecord[] = []

  // --- Phase 4: loop turns ---
  for (let turn = 1; turn <= args.turns; turn++) {
    // Drive one turn
    try {
      for await (const _msg of engine.submitMessage(`Turn ${turn} prompt`)) {
        // Consume all messages; we don't need to do anything with them
      }
    } catch (err) {
      // Log only the error class — a full error object can embed request
      // config (API keys, oauthAccount) from the failing call (CodeQL
      // js/clear-text-logging).
      console.error(
        `[turn ${turn}] error: ${err instanceof Error ? err.name : typeof err}`,
      )
      break
    }

    if (turn % 10 === 0) forceGC()

    const mem = sampleMem()
    const retainers = await probeRetainers()
    history.push({
      turn,
      ts: performance.now() - t0,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      retainers,
    })

    if (args.verbose || turn % Math.max(1, Math.floor(args.turns / 10)) === 0) {
      console.error(
        `  turn=${turn} heap=${fmtBytes(mem.heapUsed)} rss=${fmtBytes(mem.rss)} Δheap=${fmtBytes(mem.heapUsed - baseline.heapUsed)}`,
      )
    }
  }

  return { baseline, history, wallMs: performance.now() - t0 }
}

// --- CSV output ---

function writeCSV(path: string, baseline: MemSample, history: TurnRecord[]): void {
  if (history.length === 0) return
  const retainerKeys = Array.from(
    new Set(history.flatMap(r => Object.keys(r.retainers))),
  ).sort()

  const header = [
    'turn',
    'ts_ms',
    'heapUsed',
    'heapTotal',
    'rss',
    'external',
    'arrayBuffers',
    'heapDelta',
    'rssDelta',
    ...retainerKeys,
  ].join(',')

  const rows = history.map(r => {
    const base = [
      r.turn,
      r.ts.toFixed(1),
      r.heapUsed,
      r.heapTotal,
      r.rss,
      r.external,
      r.arrayBuffers,
      r.heapUsed - baseline.heapUsed,
      r.rss - baseline.rss,
    ]
    const ret = retainerKeys.map(k => r.retainers[k] ?? '')
    return [...base, ...ret].join(',')
  })

  writeFileSync(path, [header, ...rows].join('\n') + '\n')
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  if (args.bootstrapOnly) {
    const stages = await measureStages()
    console.log('\nBootstrap cost per stage (sorted by delta):')
    const sorted = [...stages].sort((a, b) => b.delta - a.delta)
    console.log(
      '  stage'.padEnd(34) +
        'heap Δ'.padStart(12) +
        '  heap after'.padStart(14) +
        '  rss after'.padStart(13),
    )
    for (const s of sorted) {
      console.log(
        `  ${s.label.padEnd(32)} ${fmtBytes(s.delta).padStart(10)}  ${fmtBytes(s.heapAfter).padStart(11)}  ${fmtBytes(s.rssAfter).padStart(10)}`,
      )
    }
    const totalDelta = stages.reduce((acc, s) => acc + s.delta, 0)
    const last = stages[stages.length - 1]
    console.log(
      `\n  Total heap delta across stages: ${fmtBytes(totalDelta)}`,
    )
    if (last) {
      console.log(
        `  Final heap: ${fmtBytes(last.heapAfter)}  Final RSS: ${fmtBytes(last.rssAfter)}`,
      )
    }
    if (args.json) {
      console.log(
        '\n' +
          JSON.stringify(
            stages.map(s => ({
              label: s.label,
              delta: s.delta,
              heapAfter: s.heapAfter,
              rssAfter: s.rssAfter,
              retainersAfter: s.retainersAfter,
            })),
            null,
            2,
          ),
      )
    }
    return
  }

  const { baseline, history, wallMs } = await runBench(args)

  if (args.csv) writeCSV(args.csv, baseline, history)

  const last = history[history.length - 1]
  const summary = {
    mode: args.mode,
    turns: args.turns,
    wallMs: Math.round(wallMs),
    baseline: {
      heapUsed: baseline.heapUsed,
      rss: baseline.rss,
    },
    final: last
      ? {
          turn: last.turn,
          heapUsed: last.heapUsed,
          heapDelta: last.heapUsed - baseline.heapUsed,
          rss: last.rss,
          rssDelta: last.rss - baseline.rss,
          retainers: last.retainers,
        }
      : null,
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`\nmemory-e2e-bench — ${args.mode} × ${args.turns} turns`)
    console.log(`  wall: ${(wallMs / 1000).toFixed(1)}s`)
    console.log(
      `  baseline: heap=${fmtBytes(baseline.heapUsed)} rss=${fmtBytes(baseline.rss)}`,
    )
    if (last) {
      console.log(
        `  final:    heap=${fmtBytes(last.heapUsed)} (+${fmtBytes(last.heapUsed - baseline.heapUsed)})`,
      )
      console.log(
        `            rss=${fmtBytes(last.rss)} (+${fmtBytes(last.rss - baseline.rss)})`,
      )
      console.log(`  retainers (final):`)
      for (const [k, v] of Object.entries(last.retainers).sort()) {
        console.log(`    ${k.padEnd(45)} = ${v}`)
      }
    }
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
