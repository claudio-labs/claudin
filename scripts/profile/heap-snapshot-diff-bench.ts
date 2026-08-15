#!/usr/bin/env bun
// Heap snapshot diff bench (developer tool — not for CI).
//
// Writes V8 heap snapshots at two checkpoints (before / after a workload)
// so you can diff them in Chrome DevTools and identify retainer chains.
// Useful for chasing leaks the aggregate-byte benches can't pinpoint.
//
// The workload is the same mixed-session pattern as long-session-bench
// but executes against the real cache modules and a synthetic message
// history. Compare the two .heapsnapshot files in DevTools (Memory tab →
// Load Profile → diff against the second).
//
// Usage:
//   bun --expose-gc run scripts/profile/heap-snapshot-diff-bench.ts
//   bun --expose-gc run scripts/profile/heap-snapshot-diff-bench.ts --turns=2000 --out=/tmp/claudin-heap

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as v8 from 'node:v8'

type Args = {
  turns: number
  out: string
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    turns: 1000,
    out: join(tmpdir(), 'claudin-heap'),
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('--turns=')) args.turns = Number(a.slice(8)) || args.turns
    else if (a.startsWith('--out=')) args.out = a.slice(6)
  }
  return args
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc()
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: bun --expose-gc run scripts/profile/heap-snapshot-diff-bench.ts [options]

Options:
  --turns=N    number of synthetic turns to simulate (default 1000)
  --out=PATH   directory for .heapsnapshot files (default: $TMPDIR/claudin-heap)
  --help       this message

Output: two .heapsnapshot files; load both into Chrome DevTools (Memory tab,
"Load Profile") and use "Comparison" to inspect retainer chains for objects
that grew between the two checkpoints.
`)
    return
  }

  if (typeof global.gc !== 'function') {
    console.warn('WARN: --expose-gc not enabled; pre-snapshot GC will be skipped.\n')
  }

  mkdirSync(args.out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  // Pre-load everything we'll touch so the "before" snapshot already
  // contains the module graph — diff will highlight only data growth.
  const { cachedLexer, __TEST_ONLY_resetTokenCache } = await import('../../src/components/markdownTokenCache.js')
  const { fileReadCache } = await import('../../src/shared/fs/fileReadCache.js')
  __TEST_ONLY_resetTokenCache()
  fileReadCache.clear()

  // Warm up V8 with a tiny workload so JITed code is in place.
  for (let i = 0; i < 10; i++) cachedLexer(`# warm ${i}\n\nbody ${i}\n`)

  gc()
  await new Promise(r => setTimeout(r, 100))
  gc()

  const beforePath = join(args.out, `before-${stamp}.heapsnapshot`)
  console.log(`Writing baseline snapshot → ${beforePath}`)
  v8.writeHeapSnapshot(beforePath)
  const beforeMem = process.memoryUsage()

  // Workload — same shape as long-session mixed mode, but always
  // distinct keys per turn so caches saturate honestly.
  console.log(`Running ${args.turns} synthetic turns...`)
  const messages: Array<{ role: string; content: string }> = []
  const sample = '```ts\nfunction f() { return 1 }\n```'
  for (let turn = 0; turn < args.turns; turn++) {
    cachedLexer(`# Turn ${turn} message\n\nSome **bold** text and ${sample}\n`)
    messages.push({ role: 'user', content: `prompt ${turn}` })
    messages.push({ role: 'assistant', content: `reply ${turn}: value=${turn * 7}` })
  }

  gc()
  await new Promise(r => setTimeout(r, 100))
  gc()

  const afterPath = join(args.out, `after-${stamp}.heapsnapshot`)
  console.log(`Writing post-workload snapshot → ${afterPath}`)
  v8.writeHeapSnapshot(afterPath)
  const afterMem = process.memoryUsage()

  console.log('')
  console.log('memory delta (post-workload − baseline):')
  console.log(`  heapUsed:     ${fmtBytes(afterMem.heapUsed - beforeMem.heapUsed)}`)
  console.log(`  rss:          ${fmtBytes(afterMem.rss - beforeMem.rss)}`)
  console.log(`  external:     ${fmtBytes(afterMem.external - beforeMem.external)}`)
  console.log(`  arrayBuffers: ${fmtBytes(afterMem.arrayBuffers - beforeMem.arrayBuffers)}`)
  console.log('')
  console.log('Open both .heapsnapshot files in Chrome DevTools (Memory tab):')
  console.log(`  1. Open chrome://inspect/ → "Open dedicated DevTools for Node"`)
  console.log(`  2. Memory tab → "Load Profile" → load both files`)
  console.log(`  3. Switch the second one to "Comparison" view`)
  console.log(`  4. Sort by "# Delta" to find growing object types`)
  console.log('')
  console.log(`Files: ${beforePath}`)
  console.log(`       ${afterPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
