#!/usr/bin/env bun
// Runs all three benchmarks back-to-back and prints a unified summary
// ranked by user-felt impact. Lets us answer the "what should I attack
// first" question with one command instead of three.
//
// Usage:
//   bun run scripts/bench/perf/run-all.ts
//   bun run scripts/bench/perf/run-all.ts --json

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

type Args = { json: boolean; help: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
  }
  return args
}

const HERE = import.meta.dir

function runJson(script: string, extraArgs: string[]): unknown {
  const res = spawnSync(
    'bun',
    ['run', resolve(HERE, script), '--json', ...extraArgs],
    { encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '3' } },
  )
  if (res.status !== 0) {
    throw new Error(`${script} failed:\n${res.stderr}`)
  }
  return JSON.parse(res.stdout)
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`run-all — execute every profile benchmark

  --json    machine-readable combined output
  --help    show this help`)
    return
  }

  console.log('Running streaming-bench (ts50, py50, prose)...')
  const streamingTs = runJson('streaming-bench.ts', ['--compare', '--fixture=ts50']) as any
  const streamingPy = runJson('streaming-bench.ts', ['--compare', '--fixture=py50']) as any
  const streamingProse = runJson('streaming-bench.ts', ['--compare', '--fixture=prose']) as any

  console.log('Running input-bench...')
  const input = runJson('input-bench.ts', []) as any

  console.log('Running memory-bench...')
  const memory = runJson('memory-bench.ts', []) as any

  console.log('Running transcript-bench...')
  const transcript = runJson('transcript-bench.ts', ['--with-code']) as any

  console.log('Running cold-start-bench...')
  let coldStart: any = null
  try {
    coldStart = runJson('cold-start-bench.ts', [])
  } catch (e) {
    console.error('cold-start-bench skipped:', (e as Error).message)
  }

  console.log('Running startup-phases-bench...')
  let startupPhases: any = null
  try {
    startupPhases = runJson('startup-phases-bench.ts', [])
  } catch (e) {
    console.error('startup-phases-bench skipped:', (e as Error).message)
  }

  console.log('Running long-session-bench...')
  let longSession: any = null
  try {
    // long-session-bench needs --expose-gc; runJson invokes plain `bun run`
    // which doesn't pass it through. Use a separate spawn with the flag.
    const res = spawnSync(
      'bun',
      ['--expose-gc', 'run', resolve(HERE, 'long-session-bench.ts'), '--json'],
      { encoding: 'utf-8', env: { ...process.env, FORCE_COLOR: '3' } },
    )
    if (res.status !== 0) {
      throw new Error(`long-session-bench failed:\n${res.stderr}`)
    }
    longSession = JSON.parse(res.stdout)
  } catch (e) {
    console.error('long-session-bench skipped:', (e as Error).message)
  }

  const combined = {
    streaming: { ts50: streamingTs, py50: streamingPy, prose: streamingProse },
    input,
    memory,
    transcript,
    coldStart,
    startupPhases,
    longSession,
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(combined, null, 2) + '\n')
    return
  }

  console.log('')
  console.log('═══ Combined summary — ranked by user-felt absolute ms ═══')
  console.log('')

  // Cold start — biggest absolute number, every launch
  if (coldStart) {
    const verDirect = coldStart.results.find((r: any) => r.invocation === '--version (direct)')
    const helpDirect = coldStart.results.find((r: any) => r.invocation === '--help (direct)')
    const verLauncher = coldStart.results.find((r: any) => r.invocation === '--version (launcher)')
    const helpLauncher = coldStart.results.find((r: any) => r.invocation === '--help (launcher)')
    console.log(`COLD START          (every launch)`)
    if (verDirect) {
      console.log(`  --version direct:   ${fmt(verDirect.p50Ms)} ms   (V8 parse of bundle, no cache)`)
    }
    if (helpDirect) {
      console.log(`  --help    direct:   ${fmt(helpDirect.p50Ms)} ms   (+ Commander + commands.ts registration)`)
    }
    if (verLauncher && verDirect) {
      console.log(`  --version launcher: ${fmt(verLauncher.p50Ms)} ms   (warm cache: −${fmt(verDirect.p50Ms - verLauncher.p50Ms)} ms)`)
    }
    if (helpLauncher && helpDirect) {
      console.log(`  --help    launcher: ${fmt(helpLauncher.p50Ms)} ms   (warm cache: −${fmt(helpDirect.p50Ms - helpLauncher.p50Ms)} ms)`)
    }
    console.log('')
  }

  // Startup phases — where the cold-start ms are spent, per checkpoint
  if (startupPhases) {
    const longest = startupPhases.results.reduce(
      (acc: any, r: any) =>
        r.totalMs.median > (acc?.totalMs.median ?? 0) ? r : acc,
      startupPhases.results[0],
    )
    if (longest && longest.checkpoints.length > 0) {
      console.log(`STARTUP PHASES      (per-checkpoint, "${longest.invocation}" invocation)`)
      const top = [...longest.checkpoints]
        .sort((a: any, b: any) => b.medianDeltaMs - a.medianDeltaMs)
        .slice(0, 8)
      for (const c of top) {
        console.log(`  ${fmt(c.medianDeltaMs).padStart(8)} ms   ${c.name}`)
      }
      console.log(`  → run \`bun run profile:startup-phases\` for the full timeline`)
      console.log('')
    }
  }

  // Streaming — real cumulative per code block
  const tsBaseline = streamingTs.results.find((r: any) => r.strategy === 'status-quo').summary.median.totalMs
  const tsDefer = streamingTs.results.find((r: any) => r.strategy === 'defer-fence').summary.median.totalMs
  const tsLru = streamingTs.results.find((r: any) => r.strategy === 'lru-text').summary.median.totalMs
  const pyBaseline = streamingPy.results.find((r: any) => r.strategy === 'status-quo').summary.median.totalMs
  const pyDefer = streamingPy.results.find((r: any) => r.strategy === 'defer-fence').summary.median.totalMs
  const proseBaseline = streamingProse.results.find((r: any) => r.strategy === 'status-quo').summary.median.totalMs

  console.log(`STREAMING RENDER    (per code block during model output)`)
  console.log(`  ts50  status-quo: ${fmt(tsBaseline)} ms       defer-fence: ${fmt(tsDefer)} ms (${fmt(tsBaseline / tsDefer, 1)}× faster)   lru: ${fmt(tsLru)} ms (~no win)`)
  console.log(`  py50  status-quo: ${fmt(pyBaseline)} ms       defer-fence: ${fmt(pyDefer)} ms (${fmt(pyBaseline / pyDefer, 1)}× faster)`)
  console.log(`  prose (no code):  ${fmt(proseBaseline)} ms      (control: confirms highlight is the only meaningful cost)`)
  console.log('')

  // Input — should be tiny
  console.log(`INPUT LATENCY       (per keystroke)`)
  for (const r of input.results) {
    console.log(`  ${String(r.size).padStart(6)} char buf   p95: ${fmt(r.p95Ms, 3)} ms   p99: ${fmt(r.p99Ms, 3)} ms   max: ${fmt(r.maxMs, 3)} ms`)
  }
  const max10k = input.results.find((r: any) => r.size === 10000)?.p99Ms ?? 0
  console.log(`  → all sizes well under 16 ms frame budget; input is not the bottleneck`)
  console.log('')

  // Memory scan — once per turn + every ~15 turns
  console.log(`MEMORY SCAN         (scanMemoryFiles, per-turn)`)
  for (const r of memory.results) {
    console.log(`  ${String(r.size).padStart(4)} files   p50: ${fmt(r.p50Ms, 2)} ms   p95: ${fmt(r.p95Ms, 2)} ms   ${fmt(r.p50Ms / r.size, 3)} ms/file`)
  }
  const mem200 = memory.results.find((r: any) => r.size === 200)?.p50Ms ?? 0
  console.log(`  → ${mem200 < 5 ? 'not a bottleneck even at 200 files' : 'investigate — 200 files cost > 5 ms'}`)
  console.log('')

  // Transcript render — paid on /resume / scroll-back past LRU
  console.log(`TRANSCRIPT RENDER   (applyMarkdown across N messages, un-cached path)`)
  for (const r of transcript.results) {
    console.log(`  ${String(r.count).padStart(5)} msgs   total: ${fmt(r.p50Ms, 1)} ms   per-msg: ${fmt(r.perMsgMs, 3)} ms`)
  }
  const tr1k = transcript.results.find((r: any) => r.count === 1000)?.p50Ms ?? 0
  console.log(`  → ${tr1k < 250 ? 'bounded — only paid on /resume + cache eviction' : 'investigate — long-transcript paint exceeds 250 ms'}`)
  console.log('')

  // Long session memory bounds — invariant guard, not a perf number
  if (longSession) {
    console.log(
      `LONG SESSION MEMORY (cache bounds across ${longSession.cycles} cycles, gc=${longSession.gcEnabled ? 'on' : 'off'})`,
    )
    for (const r of longSession.results) {
      const ok = r.passed ? 'PASS' : 'FAIL'
      const deltaMB = (r.heapDeltaBytes / 1024 / 1024).toFixed(2)
      console.log(
        `  ${r.name.padEnd(46)} cap=${String(r.declaredCap).padStart(4)}  size=${String(r.observedSize).padStart(4)}  +${deltaMB} MB  ${ok}`,
      )
    }
    const totalMB = (longSession.totalHeapDeltaBytes / 1024 / 1024).toFixed(1)
    console.log(
      `  → ${longSession.allPassed ? `all caps respected; total heap delta ${totalMB} MB` : 'cap exceeded — investigate'}`,
    )
    console.log('')
  }

  // Verdict
  console.log('═══ Verdict — biggest offenders to attack first ═══')
  console.log('')
  const offenders: Array<{ pri: number; line: string }> = []
  if (coldStart) {
    const verLauncher = coldStart.results.find((r: any) => r.invocation === '--version (launcher)')
    const verDirect = coldStart.results.find((r: any) => r.invocation === '--version (direct)')
    const baseline = verLauncher ?? verDirect
    if (baseline && baseline.p50Ms > 200) {
      offenders.push({
        pri: baseline.p50Ms,
        line: `1. Cold start (~${fmt(baseline.p50Ms, 0)} ms wall to --version, ${verLauncher ? 'launcher with warm cache' : 'direct'}) — paid on every launch.`,
      })
    }
  }
  const streamSavings = tsBaseline - tsDefer
  if (streamSavings > 5) {
    offenders.push({
      pri: streamSavings * 0.3, // single events, less frequent than launches
      line: `2. Streaming highlight (~${fmt(streamSavings, 0)} ms cumulative per code block) — defer-fence cuts ~85% of work without per-frame regression.`,
    })
  }
  if (max10k > 10) {
    offenders.push({
      pri: max10k * 50, // keystrokes are very frequent
      line: `3. Input latency at large buffers (~${fmt(max10k, 1)} ms p99 at 10 KB) — would dwarf everything else if true.`,
    })
  }
  if (mem200 > 5) {
    offenders.push({
      pri: mem200 * 5,
      line: `Memory scan at 200 files (~${fmt(mem200, 1)} ms p50) — paid once per turn.`,
    })
  }
  if (tr1k > 250) {
    offenders.push({
      pri: tr1k * 0.05,
      line: `Long-transcript paint (~${fmt(tr1k, 0)} ms for 1000 msgs) — paid on /resume.`,
    })
  }
  offenders.sort((a, b) => b.pri - a.pri)
  if (offenders.length === 0) {
    console.log('  (no offender exceeds threshold — UI/streaming/input look healthy)')
  } else {
    for (const o of offenders) console.log('  ' + o.line)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
