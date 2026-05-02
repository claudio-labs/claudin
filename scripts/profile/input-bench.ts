#!/usr/bin/env bun
// Input-latency profile harness.
//
// Measures the keystroke path: `Cursor.fromText(value, columns, offset)` →
// `new MeasuredText(text, columns-1)` (calls text.normalize('NFC')) →
// `cursor.render(...)` (lazy `wrapAnsi` + grapheme segmentation per line).
//
// Each iteration simulates one keystroke at the end of a buffer of size N.
// Reports mean/p95/max ms per keystroke, broken out by buffer size, so we can
// see where the user actually starts to feel input latency.
//
// Usage:
//   bun run scripts/profile/input-bench.ts
//   bun run scripts/profile/input-bench.ts --sizes=100,1000,5000,10000
//   bun run scripts/profile/input-bench.ts --json

import { performance } from 'node:perf_hooks'
import { Cursor } from '../../src/utils/Cursor.js'

type Args = {
  sizes: number[]
  iters: number
  warmup: number
  columns: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sizes: [100, 500, 2000, 5000, 10000],
    iters: 500,
    warmup: 50,
    columns: 100,
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
    else if (a.startsWith('--columns=')) args.columns = Number(a.slice('--columns='.length))
  }
  return args
}

function printHelp(): void {
  console.log(
    `input-bench — measure keystroke latency through Cursor.fromText + render

  --sizes=A,B,C    buffer sizes to test (default: 100,500,2000,5000,10000)
  --iters=N        keystrokes per size (default: 500)
  --warmup=N       warmup iterations, discarded (default: 50)
  --columns=N      terminal width passed to Cursor.fromText (default: 100)
  --json           machine-readable output
  --help           show this help`,
  )
}

// Realistic-shape buffer: ASCII prose with occasional newlines, like a
// multi-line prompt. Avoids pathological all-ASCII or all-emoji cases.
function makeBuffer(size: number): string {
  const sentence = 'The quick brown fox jumps over the lazy dog. '
  const out: string[] = []
  let len = 0
  while (len < size) {
    out.push(sentence)
    len += sentence.length
    if (out.length % 12 === 0) {
      out.push('\n')
      len += 1
    }
  }
  return out.join('').slice(0, size)
}

type SizeResult = {
  size: number
  iters: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

function summarizeSamples(samples: number[]): Omit<SizeResult, 'size' | 'iters'> {
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

// Simulate one keystroke at the END of a buffer of length `size`. Each call
// rebuilds Cursor + MeasuredText (the no-cache path useTextInput.ts:171
// takes — Cursor.fromText runs on every render). Then calls render() to
// trigger lazy wrapAnsi + grapheme segmentation.
function measureSize(
  size: number,
  iters: number,
  warmup: number,
  columns: number,
): SizeResult {
  const buf = makeBuffer(size)
  const offset = buf.length

  // Use a no-op invert; we don't need ANSI for the cost we care about.
  const noop = (s: string): string => s

  for (let i = 0; i < warmup; i++) {
    const c = Cursor.fromText(buf, columns, offset)
    c.render('|', '', noop)
  }

  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    const c = Cursor.fromText(buf, columns, offset)
    c.render('|', '', noop)
    samples.push(performance.now() - t0)
  }

  return { size, iters, ...summarizeSamples(samples) }
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const results = args.sizes.map(s =>
    measureSize(s, args.iters, args.warmup, args.columns),
  )

  if (args.json) {
    process.stdout.write(JSON.stringify({ columns: args.columns, results }, null, 2) + '\n')
    return
  }

  console.log(`columns=${args.columns}  iters=${args.iters} (warmup ${args.warmup})`)
  console.log('')
  console.log(
    'buffer size  mean ms   p50 ms   p95 ms   p99 ms   max ms',
  )
  for (const r of results) {
    console.log(
      `${String(r.size).padStart(11)}  ${fmt(r.meanMs).padStart(7)}  ${fmt(r.p50Ms).padStart(7)}  ${fmt(r.p95Ms).padStart(7)}  ${fmt(r.p99Ms).padStart(7)}  ${fmt(r.maxMs).padStart(7)}`,
    )
  }
  console.log('')
  console.log(
    'Note: each iter = full Cursor.fromText + MeasuredText (NFC normalize) +',
  )
  console.log(
    '      cursor.render() (lazy wrapAnsi + grapheme segmentation).',
  )
  console.log(
    '      User-perceived input lag threshold ≈ 16 ms (one frame).',
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
