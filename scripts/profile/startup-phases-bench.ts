#!/usr/bin/env bun
// Startup-phases profile harness.
//
// Drives the bundled CLI with CLAUDIN_PROFILE_STARTUP=1 to collect the
// in-process `profileCheckpoint(...)` timeline (perf_hooks marks). For each
// invocation we run N iterations into an isolated CLAUDIN_CONFIG_DIR, read
// the per-session timeline file the profiler writes, and aggregate the
// median +delta ms per checkpoint. That tells us _which phase_ of boot is
// costing time, not just the total wall.
//
// Different invocations stop at different points along the bootstrap chain,
// so running several is the cheapest way to localize the cost:
//
//   --version    fast path: only cli_entry + (with our exit-flush) the marks
//                from the bare bootstrap. Lower bound on Node + bundle cost.
//   --help       commander parse path — adds program registration + plugins.
//   doctor --help / mcp --help — subcommand registration cost.
//
// Requires `dist/cli.mjs` to exist (run `bun run build` first).
//
// Usage:
//   bun run scripts/profile/startup-phases-bench.ts
//   bun run scripts/profile/startup-phases-bench.ts --runs=10
//   bun run scripts/profile/startup-phases-bench.ts --invocation=help
//   bun run scripts/profile/startup-phases-bench.ts --json

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Args = {
  runs: number
  warmup: number
  json: boolean
  help: boolean
  only: string | null
  keep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runs: 5,
    warmup: 1,
    json: false,
    help: false,
    only: null,
    keep: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--keep-tmp') args.keep = true
    else if (a.startsWith('--runs=')) args.runs = Number(a.slice('--runs='.length))
    else if (a.startsWith('--warmup=')) args.warmup = Number(a.slice('--warmup='.length))
    else if (a.startsWith('--invocation=')) args.only = a.slice('--invocation='.length)
  }
  return args
}

function printHelp(): void {
  console.log(
    `startup-phases-bench — per-checkpoint timeline of CLI boot

  --runs=N           measured runs per invocation (default: 5)
  --warmup=N         warmup runs, discarded (default: 1)
  --invocation=NAME  run only one of: version | help | doctor | mcp
  --keep-tmp         do not delete the throwaway config dir
  --json             machine-readable output
  --help             show this help

Requires dist/cli.mjs (run \`bun run build\` first). Forces
CLAUDIN_PROFILE_STARTUP=1 to collect per-checkpoint marks.`,
  )
}

function findCliPath(): string {
  const cwd = process.cwd()
  const candidates = [
    resolve(cwd, 'dist/cli.mjs'),
    resolve(import.meta.dir, '../../dist/cli.mjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    'Could not find dist/cli.mjs. Run `bun run build` first.\nLooked in:\n' +
      candidates.map(c => `  ${c}`).join('\n'),
  )
}

// Each line in the profiler report has the shape:
//   [+   12.345ms] (+    1.234ms) checkpoint_name [extra] [| RSS: .., Heap: ..]
// Both numeric fields may pad with spaces. Capture in module-level regex.
const TIMELINE_LINE_RE =
  /^\[\+\s*([0-9.]+)ms\]\s*\(\+\s*([0-9.]+)ms\)\s+(\S+)/

type Checkpoint = { name: string; totalMs: number; deltaMs: number }

function parseTimeline(text: string): Checkpoint[] {
  const out: Checkpoint[] = []
  for (const line of text.split('\n')) {
    const m = TIMELINE_LINE_RE.exec(line)
    if (!m) continue
    out.push({
      name: m[3]!,
      totalMs: Number(m[1]),
      deltaMs: Number(m[2]),
    })
  }
  return out
}

type RunResult = {
  invocation: string
  cliArgs: string[]
  runs: number
  exitedCleanly: boolean
  // Aggregated checkpoint stats in timeline order.
  checkpoints: Array<{
    name: string
    medianDeltaMs: number
    medianTotalMs: number
    p95DeltaMs: number
    runs: number
  }>
  // Wall-clock total (last checkpoint's totalMs), summarised across runs.
  totalMs: { median: number; p95: number; mean: number }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function runOne(
  cliPath: string,
  cliArgs: string[],
  configDir: string,
): Checkpoint[] | null {
  // Each run gets a unique session id (the CLI itself generates one), so the
  // profiler will write a new file under startup-perf/. We snapshot dir state
  // before and after to find the new file deterministically.
  const perfDir = join(configDir, 'startup-perf')
  const before = new Set(existsSync(perfDir) ? readdirSync(perfDir) : [])

  const res = spawnSync('node', [cliPath, ...cliArgs], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDIN_PROFILE_STARTUP: '1',
      CLAUDIN_CONFIG_DIR: configDir,
      // Disable update check + statsig + anything that would talk to network.
      // The bundle already stubs telemetry, but belt-and-suspenders.
      CLAUDE_CODE_DISABLE_TELEMETRY: '1',
      CI: '1',
      // Force a known TTY-less mode so commander prints help and exits.
      NO_COLOR: '1',
    },
  })

  const after = existsSync(perfDir) ? readdirSync(perfDir) : []
  const fresh = after.filter(f => !before.has(f))
  if (fresh.length === 0) {
    // Some invocations (--version fast-path) never load the profiler module
    // because cli.tsx returns before importing startupProfiler.ts. Treat as
    // "no timeline available" rather than failing.
    return res.status === 0 ? [] : null
  }
  // Use the most recent file; sort by mtime via filename (session ids are
  // not lexically time-ordered, but only one file is fresh per run).
  const newest = fresh[fresh.length - 1]!
  const raw = readFileSync(join(perfDir, newest), 'utf8')
  return parseTimeline(raw)
}

function summarise(
  invocation: string,
  cliArgs: string[],
  perRun: Checkpoint[][],
): RunResult {
  // Collect a stable checkpoint order from the run with the most checkpoints
  // (different runs occasionally fire different subsets, e.g. cached vs not).
  let template: Checkpoint[] = []
  for (const run of perRun) {
    if (run.length > template.length) template = run
  }

  const checkpoints = template.map(tc => {
    const deltas: number[] = []
    const totals: number[] = []
    for (const run of perRun) {
      const found = run.find(c => c.name === tc.name)
      if (found) {
        deltas.push(found.deltaMs)
        totals.push(found.totalMs)
      }
    }
    return {
      name: tc.name,
      medianDeltaMs: median(deltas),
      medianTotalMs: median(totals),
      p95DeltaMs: p95(deltas),
      runs: deltas.length,
    }
  })

  const totals = perRun
    .map(run => run[run.length - 1]?.totalMs)
    .filter((x): x is number => typeof x === 'number')

  return {
    invocation,
    cliArgs,
    runs: perRun.length,
    exitedCleanly: perRun.every(r => r.length > 0),
    checkpoints,
    totalMs: {
      median: median(totals),
      p95: p95(totals),
      mean: mean(totals),
    },
  }
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

type Invocation = { name: string; args: string[] }

const ALL_INVOCATIONS: Invocation[] = [
  { name: 'version', args: ['--version'] },
  { name: 'help', args: ['--help'] },
  { name: 'doctor', args: ['doctor', '--help'] },
  { name: 'mcp', args: ['mcp', '--help'] },
]

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const cliPath = findCliPath()
  const configDir = mkdtempSync(join(tmpdir(), 'claudin-bench-'))

  const invocations = args.only
    ? ALL_INVOCATIONS.filter(i => i.name === args.only)
    : ALL_INVOCATIONS

  if (invocations.length === 0) {
    throw new Error(
      `Unknown --invocation. Choose one of: ${ALL_INVOCATIONS.map(i => i.name).join(', ')}`,
    )
  }

  const results: RunResult[] = []
  try {
    for (const inv of invocations) {
      // Warmup primes OS file cache and V8 compile cache.
      for (let i = 0; i < args.warmup; i++) {
        runOne(cliPath, inv.args, configDir)
      }
      const perRun: Checkpoint[][] = []
      for (let i = 0; i < args.runs; i++) {
        const tl = runOne(cliPath, inv.args, configDir)
        if (tl !== null) perRun.push(tl)
      }
      results.push(summarise(inv.name, inv.args, perRun))
    }
  } finally {
    if (!args.keep) {
      try {
        rmSync(configDir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup; not fatal.
      }
    }
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ cliPath, configDir: args.keep ? configDir : null, results }, null, 2) +
        '\n',
    )
    return
  }

  console.log(`cli           ${cliPath}`)
  console.log(`runs          ${args.runs} measured (after ${args.warmup} warmup)`)
  if (args.keep) console.log(`config dir    ${configDir}`)
  console.log('')

  for (const r of results) {
    const argv = r.cliArgs.join(' ')
    console.log(`── invocation: ${r.invocation}  (node dist/cli.mjs ${argv})`)
    if (r.checkpoints.length === 0) {
      console.log(
        '   (no startup-perf timeline emitted — fast path exits before profiler loads)',
      )
      console.log('')
      continue
    }
    console.log(
      `   ${'checkpoint'.padEnd(42)} ${'+delta(ms)'.padStart(11)} ${'p95Δ(ms)'.padStart(10)} ${'total(ms)'.padStart(11)}`,
    )
    for (const c of r.checkpoints) {
      console.log(
        `   ${c.name.padEnd(42)} ${fmt(c.medianDeltaMs).padStart(11)} ${fmt(c.p95DeltaMs).padStart(10)} ${fmt(c.medianTotalMs).padStart(11)}`,
      )
    }
    console.log(
      `   ── total: median ${fmt(r.totalMs.median)} ms  p95 ${fmt(r.totalMs.p95)} ms  mean ${fmt(r.totalMs.mean)} ms`,
    )
    console.log('')
  }

  // Top-5 hottest steps across the longest invocation — what to attack first.
  const longest = results.reduce(
    (acc, r) => (r.totalMs.median > acc.totalMs.median ? r : acc),
    results[0]!,
  )
  if (longest.checkpoints.length > 0) {
    const top = [...longest.checkpoints]
      .sort((a, b) => b.medianDeltaMs - a.medianDeltaMs)
      .slice(0, 5)
    console.log(`Top 5 hottest checkpoints in "${longest.invocation}":`)
    for (const c of top) {
      console.log(
        `  ${fmt(c.medianDeltaMs).padStart(8)} ms  ${c.name}`,
      )
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
