#!/usr/bin/env bun
// File-read cache saturation bench.
//
// fileReadCache (src/utils/fileReadCache.ts) caps at 1000 entries × 256 KB
// each → theoretical max ≈ 256 MB. This is the largest bounded cache in
// the codebase. The long-session bench reads 5 files/turn from a pool of
// 5000, never holding more than 1000 simultaneously — but we never measure
// the case where every cached entry is at the per-entry maximum.
//
// This bench fills the cache to its true ceiling and reports actual RSS.
// Two phases:
//   (1) saturate — fill 1000 distinct entries with 256 KB content each
//   (2) churn   — keep reading new files; LRU should evict, RSS should plateau
//
// Usage:
//   bun --expose-gc run scripts/profile/file-read-cache-saturation-bench.ts
//   bun --expose-gc run scripts/profile/file-read-cache-saturation-bench.ts --entries=2000 --size-kb=200

import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

type Args = {
  entries: number
  sizeKb: number
  churnRounds: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    entries: 1500, // > cap so we trigger eviction
    sizeKb: 256,
    churnRounds: 3,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--entries=')) args.entries = Number(a.slice(10)) || args.entries
    else if (a.startsWith('--size-kb=')) args.sizeKb = Number(a.slice(10)) || args.sizeKb
    else if (a.startsWith('--churn-rounds=')) args.churnRounds = Number(a.slice(15)) || args.churnRounds
  }
  return args
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type Snap = { heap: number; rss: number; ext: number }
function snap(): Snap {
  const m = process.memoryUsage()
  return { heap: m.heapUsed, rss: m.rss, ext: m.external }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: bun --expose-gc run scripts/profile/file-read-cache-saturation-bench.ts [options]

Options:
  --entries=N           total file pool to read (default 1500, > cap=1000)
  --size-kb=N           size of each fixture file in KB (default 256, the per-entry cap)
  --churn-rounds=N      additional sweeps after initial fill (default 3)
  --json                emit JSON
  --help                this message
`)
    return
  }

  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; heap deltas will be noisy.\n')
  }

  console.log(`File-read cache saturation`)
  console.log(`  pool: ${args.entries} files × ${args.sizeKb} KB each (~${fmtBytes(args.entries * args.sizeKb * 1024)} on disk)`)
  console.log(`  cap: 1000 entries × 256 KB max → theoretical ceiling 256 MB`)
  console.log('')

  const dir = join(tmpdir(), `claudio-frc-bench-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // Fixture: each file unique so V8 can't share string refs. Cap target
  // at 95% of size limit so stats.size <= cache.maxEntryBytes (256 KB) and
  // every read gets cached.
  const targetBytes = Math.min(args.sizeKb * 1024, 256 * 1024 - 4096)
  console.log(`Generating ${args.entries} fixture files (target ${fmtBytes(targetBytes)} each)...`)
  for (let i = 0; i < args.entries; i++) {
    const lines: string[] = []
    let total = 0
    let lineNo = 1
    while (total < targetBytes) {
      const line = `${String(lineNo).padStart(5, ' ')}: file_${i} unique_${Math.random().toString(36).slice(2)}\n`
      if (total + line.length > targetBytes) break
      lines.push(line)
      total += line.length
      lineNo++
    }
    writeFileSync(join(dir, `f_${i}.txt`), lines.join(''))
  }

  const { fileReadCache } = await import('../../src/utils/fileReadCache.js')
  fileReadCache.clear()

  gc()
  await new Promise(r => setTimeout(r, 10))
  gc()
  const baseline = snap()

  type Phase = { name: string; cacheSize: number; ms: number; mem: Snap; deltaRss: number; deltaHeap: number; deltaExt: number }
  const phases: Phase[] = []

  function recordPhase(name: string, t0: number): void {
    gc()
    const m = snap()
    phases.push({
      name,
      cacheSize: fileReadCache.getStats().size,
      ms: performance.now() - t0,
      mem: m,
      deltaRss: m.rss - baseline.rss,
      deltaHeap: m.heap - baseline.heap,
      deltaExt: m.ext - baseline.ext,
    })
  }

  // Phase 1: saturate (read up to cap)
  let t0 = performance.now()
  for (let i = 0; i < Math.min(1000, args.entries); i++) {
    fileReadCache.readFile(join(dir, `f_${i}.txt`))
  }
  recordPhase('saturate-to-cap', t0)

  // Phase 2: overflow (force evictions if pool > cap)
  if (args.entries > 1000) {
    t0 = performance.now()
    for (let i = 1000; i < args.entries; i++) {
      fileReadCache.readFile(join(dir, `f_${i}.txt`))
    }
    recordPhase('overflow-evict', t0)
  }

  // Phase 3: churn (continuous eviction at steady state)
  for (let round = 0; round < args.churnRounds; round++) {
    t0 = performance.now()
    for (let i = 0; i < args.entries; i++) {
      fileReadCache.readFile(join(dir, `f_${(i + round * 137) % args.entries}.txt`))
    }
    recordPhase(`churn-round-${round + 1}`, t0)
  }

  // Phase 4: cache.clear() — should release everything
  t0 = performance.now()
  fileReadCache.clear()
  recordPhase('after-clear', t0)

  rmSync(dir, { recursive: true, force: true })

  if (args.json) {
    console.log(JSON.stringify({ args, baseline, phases }, null, 2))
    return
  }

  console.log('')
  console.log(`baseline:  heap=${fmtBytes(baseline.heap)}  RSS=${fmtBytes(baseline.rss)}  ext=${fmtBytes(baseline.ext)}`)
  console.log('')
  console.log('phase                      cacheSize    wall       Δheap         ΔRSS        Δexternal')
  for (const p of phases) {
    console.log(
      `${p.name.padEnd(24)}  ${String(p.cacheSize).padStart(8)}  ${`${p.ms.toFixed(1)}ms`.padStart(8)}  ${fmtBytes(p.deltaHeap).padStart(10)}  ${fmtBytes(p.deltaRss).padStart(10)}  ${fmtBytes(p.deltaExt).padStart(10)}`,
    )
  }
  console.log('')

  const churnPhases = phases.filter(p => p.name.startsWith('churn-round'))
  if (churnPhases.length >= 2) {
    const firstChurn = churnPhases[0]
    const lastChurn = churnPhases[churnPhases.length - 1]
    if (!firstChurn || !lastChurn) return
    const first = firstChurn.deltaRss
    const last = lastChurn.deltaRss
    const drift = last - first
    const driftPct = first === 0 ? 0 : (drift / first) * 100
    console.log(`churn drift: RSS moved ${fmtBytes(drift)} between round 1 and round ${churnPhases.length} (${driftPct.toFixed(1)}%)`)
    console.log(
      drift < 1024 * 1024 || Math.abs(driftPct) < 5
        ? `  → PASS: cache plateaus under churn`
        : `  → INVESTIGATE: RSS still drifting after saturation`,
    )
  }

  const afterClear = phases.find(p => p.name === 'after-clear')
  const tailChurn = churnPhases[churnPhases.length - 1]
  if (afterClear && tailChurn) {
    const recovered = tailChurn.deltaRss - afterClear.deltaRss
    console.log(`clear() released: ${fmtBytes(recovered)} RSS (${((recovered / tailChurn.deltaRss) * 100).toFixed(1)}% of saturated state)`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
