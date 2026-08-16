#!/usr/bin/env bun
// Cold-start profile harness.
//
// Measures end-to-end wall time for the bundled CLI to launch, do a piece of
// work, and exit. Several invocations are exercised to triangulate which
// parts of the import chain cost what:
//
//   --version    fast path in cli.tsx — measures Node + minimal imports only
//   --help       commander parse path — exercises commands.ts registration
//
// Each invocation is run N times and we report median wall ms. The delta
// between the fastest invocation (version) and the slowest (--help) is a
// rough lower bound on the "extra import surface" cost beyond the bare boot.
//
// Requires `dist/cli.mjs` to exist (run `bun run build` first).
//
// Usage:
//   bun run scripts/bench/perf/cold-start-bench.ts
//   bun run scripts/bench/perf/cold-start-bench.ts --runs=20

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'

type Args = {
  runs: number
  warmup: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 10, warmup: 2, json: false, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--runs=')) args.runs = Number(a.slice('--runs='.length))
    else if (a.startsWith('--warmup=')) args.warmup = Number(a.slice('--warmup='.length))
  }
  return args
}

function printHelp(): void {
  console.log(
    `cold-start-bench — measure CLI launch wall time

  --runs=N    measured runs per invocation (default: 10)
  --warmup=N  warmup runs, discarded (default: 2)
  --json      machine-readable output
  --help      show this help

Requires dist/cli.mjs (run \`bun run build\` first).`,
  )
}

function findCliPath(): string {
  const cwd = process.cwd()
  const candidates = [
    resolve(cwd, 'dist/cli.mjs'),
    resolve(cwd, '../dist/cli.mjs'),
    resolve(REPO_ROOT, 'dist/cli.mjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    'Could not find dist/cli.mjs. Run `bun run build` first.\nLooked in:\n' +
      candidates.map(c => `  ${c}`).join('\n'),
  )
}

function findLauncherPath(): string | null {
  const candidates = [
    resolve(process.cwd(), 'bin/claudin'),
    resolve(REPO_ROOT, 'bin/claudin'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

type RunResult = {
  invocation: string
  args: string[]
  runs: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  exitedCleanly: boolean
}

function summarize(samples: number[]): Omit<RunResult, 'invocation' | 'args' | 'runs' | 'exitedCleanly'> {
  const sorted = [...samples].sort((a, b) => a - b)
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return {
    meanMs: sorted.reduce((s, x) => s + x, 0) / sorted.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

function runInvocation(
  cliPath: string,
  invocationName: string,
  cliArgs: string[],
  runs: number,
  warmup: number,
): RunResult {
  // Warmup — primes OS file cache for the bundle.
  for (let i = 0; i < warmup; i++) {
    spawnSync('node', [cliPath, ...cliArgs], { stdio: 'ignore' })
  }

  const samples: number[] = []
  let allClean = true
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    const res = spawnSync('node', [cliPath, ...cliArgs], { stdio: 'ignore' })
    const elapsed = performance.now() - t0
    samples.push(elapsed)
    if (res.status !== 0) allClean = false
  }

  return {
    invocation: invocationName,
    args: cliArgs,
    runs,
    exitedCleanly: allClean,
    ...summarize(samples),
  }
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const cliPath = findCliPath()
  const launcherPath = findLauncherPath()

  // Direct invocations against dist/cli.mjs measure the bundle's V8 parse
  // cost — independent of launcher overhead or any cache wiring there.
  const directInvocations: Array<[string, string]> = [
    ['--version (direct)', cliPath],
    ['--help (direct)', cliPath],
  ]
  // Through bin/claudin: includes whatever the launcher does (e.g. enabling
  // V8 compile cache). This is the actual user-facing path.
  const launcherInvocations: Array<[string, string]> = launcherPath
    ? [
        ['--version (launcher)', launcherPath],
        ['--help (launcher)', launcherPath],
      ]
    : []

  const allInvocations = [...directInvocations, ...launcherInvocations]
  const results = allInvocations.map(([name, target]) => {
    const flag = name.startsWith('--version') ? '--version' : '--help'
    return runInvocation(target, name, [flag], args.runs, args.warmup)
  })

  if (args.json) {
    process.stdout.write(JSON.stringify({ cliPath, results }, null, 2) + '\n')
    return
  }

  console.log(`cli                ${cliPath}`)
  if (launcherPath) console.log(`launcher           ${launcherPath}`)
  console.log(`runs               ${args.runs} measured (after ${args.warmup} warmup)`)
  console.log('')
  console.log('invocation             runs  mean ms   p50 ms   p95 ms   max ms   clean')
  for (const r of results) {
    console.log(
      `${r.invocation.padEnd(21)}  ${String(r.runs).padStart(4)}  ${fmt(r.meanMs).padStart(7)}  ${fmt(r.p50Ms).padStart(7)}  ${fmt(r.p95Ms).padStart(7)}  ${fmt(r.maxMs).padStart(7)}  ${r.exitedCleanly ? 'yes' : 'no '}`,
    )
  }

  const verDirect = results.find(r => r.invocation === '--version (direct)')
  const helpDirect = results.find(r => r.invocation === '--help (direct)')
  const verLauncher = results.find(r => r.invocation === '--version (launcher)')
  const helpLauncher = results.find(r => r.invocation === '--help (launcher)')

  if (verDirect && helpDirect) {
    console.log('')
    console.log(`extra import surface beyond fast path:  ~${fmt(helpDirect.p50Ms - verDirect.p50Ms)} ms (p50 --help − p50 --version, direct)`)
  }
  if (verLauncher && helpLauncher && verDirect && helpDirect) {
    console.log('')
    console.log(`launcher savings (warm cache):`)
    console.log(`  --version: ${fmt(verDirect.p50Ms)} ms direct → ${fmt(verLauncher.p50Ms)} ms launcher  (${fmt(verDirect.p50Ms - verLauncher.p50Ms)} ms saved)`)
    console.log(`  --help:    ${fmt(helpDirect.p50Ms)} ms direct → ${fmt(helpLauncher.p50Ms)} ms launcher  (${fmt(helpDirect.p50Ms - helpLauncher.p50Ms)} ms saved)`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
