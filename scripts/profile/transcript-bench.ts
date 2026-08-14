#!/usr/bin/env bun
process.env.FORCE_COLOR ??= '3'

// Transcript-render profile harness.
//
// Measures `applyMarkdown(content, theme, highlight)` across realistic
// message sizes/counts. Models the cost a long conversation pays when the
// transcript is rendered (e.g. on first paint, on `/resume`, after virtual-
// scroll evictions). Markdown.tsx already memoizes via tokenCache LRU(500),
// but a 1000-message session evicts older entries; scrolling back forces
// re-lex and re-highlight.
//
// Two scenarios:
//   cold     — fresh tokenCache, every message paid in full
//   warm     — tokenCache hot, only paths that miss cache pay
//
// (Note: this benchmark calls applyMarkdown directly. The production tokenCache
// lives in Markdown.tsx and isn't reachable from here, so we're measuring the
// per-message cost of the un-cached path. That maps to "what scrolling back to
// an evicted message costs" in the live REPL.)
//
// Usage:
//   bun run scripts/profile/transcript-bench.ts
//   bun run scripts/profile/transcript-bench.ts --counts=100,500,1000

import { performance } from 'node:perf_hooks'
import { applyMarkdown } from '../../src/utils/text/markdown.js'
import { getCliHighlightPromise } from '../../src/utils/text/cliHighlight.js'

type Args = {
  counts: number[]
  iters: number
  warmup: number
  withCode: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    counts: [50, 200, 500, 1000],
    iters: 5,
    warmup: 1,
    withCode: false,
    json: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--with-code') args.withCode = true
    else if (a.startsWith('--counts=')) {
      args.counts = a
        .slice('--counts='.length)
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
    `transcript-bench — measure applyMarkdown across many messages

  --counts=A,B,C   message counts to test (default: 50,200,500,1000)
  --with-code      every 5th message contains a TypeScript code block
  --iters=N        measured iterations per count (default: 5)
  --warmup=N       warmup iterations, discarded (default: 1)
  --json           machine-readable output
  --help           show this help`,
  )
}

// Each message: 200-800 chars of markdown-ish prose with occasional inline
// code, headings, list items. Index in content guarantees uniqueness so
// upstream caches won't dedupe.
function makeMessage(i: number, withCode: boolean): string {
  const variant = i % 4
  const codeBlock = withCode && i % 5 === 0
    ? '\n\n```typescript\nconst result_' + i + ' = compute(input).map(x => x * 2)\nreturn result_' + i + '.filter(Boolean)\n```\n'
    : ''
  if (variant === 0) {
    return `## Step ${i}: analysis

We considered \`option_${i}\` and looked at three candidates. The chosen path uses **partial** evaluation with **lazy** binding. See the diagram for details.${codeBlock}`
  }
  if (variant === 1) {
    return `Looking at the data for entry ${i}, the trend is monotonic. The metric \`p99_${i}\` plateaued around the third week. Possible causes:

- Cache invalidation
- Saturated thread pool
- A regression in the upstream library${codeBlock}`
  }
  if (variant === 2) {
    return `Plain prose answer ${i}. Nothing fancy here, just a longer-form explanation that exercises the no-markdown fast-path in cachedLexer when no markers are present, which covers the majority of short replies the user gets day to day in real conversations.${codeBlock}`
  }
  return `### Detail ${i}

Below is a structured breakdown:

| Field | Value |
| --- | --- |
| id | ${i} |
| status | ok |${codeBlock}`
}

type CountResult = {
  count: number
  iters: number
  withCode: boolean
  meanMs: number
  p50Ms: number
  maxMs: number
  perMsgMs: number
  totalChars: number
}

function summarize(samples: number[]): { meanMs: number; p50Ms: number; maxMs: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    meanMs: sorted.reduce((s, x) => s + x, 0) / sorted.length,
    p50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

async function measureCount(
  count: number,
  iters: number,
  warmup: number,
  withCode: boolean,
  highlight: Awaited<ReturnType<typeof getCliHighlightPromise>>,
): Promise<CountResult> {
  const messages = Array.from({ length: count }, (_, i) => makeMessage(i, withCode))
  const totalChars = messages.reduce((s, m) => s + m.length, 0)

  for (let i = 0; i < warmup; i++) {
    for (const m of messages) applyMarkdown(m, 'dark', highlight)
  }

  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    for (const m of messages) applyMarkdown(m, 'dark', highlight)
    samples.push(performance.now() - t0)
  }

  const sum = summarize(samples)
  return {
    count,
    iters,
    withCode,
    meanMs: sum.meanMs,
    p50Ms: sum.p50Ms,
    maxMs: sum.maxMs,
    perMsgMs: sum.p50Ms / Math.max(1, count),
    totalChars,
  }
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

  const highlight = await getCliHighlightPromise()
  if (!highlight) {
    console.error('cli-highlight failed to load — aborting')
    process.exit(1)
  }

  const results: CountResult[] = []
  for (const count of args.counts) {
    results.push(await measureCount(count, args.iters, args.warmup, args.withCode, highlight))
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ withCode: args.withCode, results }, null, 2) + '\n')
    return
  }

  console.log(`mode: ${args.withCode ? 'every-5th-message has TS code block' : 'prose only'}`)
  console.log(`iters=${args.iters} per count (warmup ${args.warmup})`)
  console.log('')
  console.log(' messages    chars   total ms   per-msg ms')
  for (const r of results) {
    console.log(
      `${String(r.count).padStart(9)}  ${String(r.totalChars).padStart(7)}   ${fmt(r.p50Ms).padStart(8)}   ${fmt(r.perMsgMs, 3).padStart(10)}`,
    )
  }
  console.log('')
  console.log(
    'Note: this measures the un-cached applyMarkdown path. Markdown.tsx caches',
  )
  console.log(
    '      tokens (LRU 500) so warm re-renders are far cheaper. The numbers',
  )
  console.log(
    '      above map to "what /resume pays on first paint" or "scrolling back',
  )
  console.log(
    '      to an evicted message in a 1000-turn session".',
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
