#!/usr/bin/env bun
// Memory-scan profile harness.
//
// Measures `scanMemoryFiles(memoryDir, signal)` — called on every turn that
// invokes findRelevantMemories AND every ~15 turns for extractMemories. The
// cost scales linearly with the number of `.md` files in
// `~/.claudin/projects/<dir>/memory/`. Heavy users accumulate 30–100+ files.
//
// Builds a synthetic memory dir under os.tmpdir() with N files, runs the
// real scanMemoryFiles against it. Reports wall ms per N, syscall
// amplification, and (best estimate) bytes read.
//
// Usage:
//   bun run scripts/bench/perf/memory-bench.ts
//   bun run scripts/bench/perf/memory-bench.ts --sizes=10,50,200,500

import { performance } from 'node:perf_hooks'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMemoryFiles } from '../../../src/memory/memdir/memoryScan.js'

type Args = {
  sizes: number[]
  iters: number
  warmup: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sizes: [10, 50, 100, 200],
    iters: 20,
    warmup: 3,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--sizes=')) {
      args.sizes = a
        .slice('--sizes='.length)
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0)
    } else if (a.startsWith('--iters=')) args.iters = Number(a.slice('--iters='.length))
    else if (a.startsWith('--warmup=')) args.warmup = Number(a.slice('--warmup='.length))
  }
  return args
}

function printHelp(): void {
  console.log(
    `memory-bench — measure scanMemoryFiles cost across directory sizes

  --sizes=A,B,C   memory file counts to test (default: 10,50,100,200)
  --iters=N       measured iterations per size (default: 20)
  --warmup=N      warmup iterations, discarded (default: 3)
  --json          machine-readable output
  --help          show this help`,
  )
}

// Synthesize a realistic memory file: ~30-line frontmatter + a few paragraphs
// of body. Mirrors what the auto-memory system writes (see CLAUDE.md "auto
// memory" section).
function makeMemoryFile(i: number): string {
  const types = ['user', 'feedback', 'project', 'reference']
  const type = types[i % types.length]
  return `---
name: synthetic memory ${i}
description: deterministic fixture used by memory-bench, file index ${i}
type: ${type}
---

This is a synthesized memory file for benchmarking scanMemoryFiles. The
content beyond frontmatter is irrelevant to the scan (it reads only the
first 30 lines per FRONTMATTER_MAX_LINES) but we include realistic body
so the file size is comparable to production memory entries.

The memdir scan should ignore everything past the frontmatter. If the body
length somehow influences scan time, that's a finding worth surfacing.

Index: ${i}.
`
}

async function buildFixture(dir: string, count: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  const ops: Promise<unknown>[] = []
  for (let i = 0; i < count; i++) {
    ops.push(writeFile(join(dir, `memory_${i}.md`), makeMemoryFile(i)))
  }
  // Add a MEMORY.md index so the realistic shape includes the file the scan
  // explicitly excludes (basename === 'MEMORY.md').
  ops.push(
    writeFile(
      join(dir, 'MEMORY.md'),
      Array.from({ length: count }, (_, i) => `- [memory_${i}](memory_${i}.md) — entry ${i}`).join('\n'),
    ),
  )
  await Promise.all(ops)
}

type SizeResult = {
  size: number
  iters: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  resultCount: number
}

function summarize(samples: number[]): Omit<SizeResult, 'size' | 'iters' | 'resultCount'> {
  const sorted = [...samples].sort((a, b) => a - b)
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length
  return {
    meanMs: mean,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

async function measureSize(
  size: number,
  iters: number,
  warmup: number,
): Promise<SizeResult> {
  const dir = join(tmpdir(), `claudin-mem-bench-${size}-${process.pid}`)
  await rm(dir, { recursive: true, force: true })
  await buildFixture(dir, size)

  const ac = new AbortController()
  let resultCount = 0
  for (let i = 0; i < warmup; i++) {
    const r = await scanMemoryFiles(dir, ac.signal)
    resultCount = r.length
  }

  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    await scanMemoryFiles(dir, ac.signal)
    samples.push(performance.now() - t0)
  }

  await rm(dir, { recursive: true, force: true })

  return { size, iters, resultCount, ...summarize(samples) }
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

  const results: SizeResult[] = []
  for (const size of args.sizes) {
    results.push(await measureSize(size, args.iters, args.warmup))
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n')
    return
  }

  console.log(`iters=${args.iters} per size (warmup ${args.warmup}); fixtures in ${tmpdir()}`)
  console.log('')
  console.log(' files   p50 ms   p95 ms   p99 ms   max ms   results  ms/file')
  for (const r of results) {
    const perFile = r.p50Ms / Math.max(1, r.size)
    console.log(
      `${String(r.size).padStart(6)}  ${fmt(r.p50Ms).padStart(7)}  ${fmt(r.p95Ms).padStart(7)}  ${fmt(r.p99Ms).padStart(7)}  ${fmt(r.maxMs).padStart(7)}  ${String(r.resultCount).padStart(7)}  ${fmt(perFile, 3)}`,
    )
  }
  console.log('')
  console.log(
    'Note: scanMemoryFiles is called once per turn (findRelevantMemories) and',
  )
  console.log(
    '      every ~15 turns (extractMemories). Per-file cost should be flat;',
  )
  console.log(
    '      sublinear scaling means the dominant cost is fixed (readdir).',
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
