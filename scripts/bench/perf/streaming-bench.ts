#!/usr/bin/env bun
// Default FORCE_COLOR=3 so chalk emits ANSI even when piped to a file or
// non-TTY consumer — the benchmark only meaningfully maps to the live REPL
// path when colors are on. User can still override with FORCE_COLOR=0.
// Set before any chalk-using import resolves (cli-highlight, etc.).
process.env.FORCE_COLOR ??= '3'

// Streaming markdown profile harness.
//
// Drives a deterministic line-by-line streaming sequence through the actual
// formatToken + cli-highlight pipeline (the exact code path StreamingMarkdown
// exercises in the live REPL — minus React/Ink reconciliation, which is a
// separate measurement domain). Reports wall time, per-line stats, highlight
// invocations, and total chars rendered, so changes to markdown.ts /
// cliHighlight loading can be A/B compared with reproducible numbers.
//
// Strategies (--strategy=):
//   status-quo    highlight every snapshot, every code token (default)
//   defer-fence   skip highlight while a fence is open (return raw text);
//                 final pass once the fence closes
//   lru-text      LRU cache keyed by (lang, hash(text)) — verifies the
//                 "growing-text cache won't hit" claim empirically
//
// Usage:
//   bun run scripts/bench/perf/streaming-bench.ts
//   bun run scripts/bench/perf/streaming-bench.ts --fixture=ts50 --strategy=defer-fence
//   bun run scripts/bench/perf/streaming-bench.ts --compare
//   bun run scripts/bench/perf/streaming-bench.ts --json
//
// CPU profile (Bun):
//   bun --cpu-prof scripts/bench/perf/streaming-bench.ts
//   # → cpu-*.cpuprofile, open in Chrome DevTools Performance tab

import { performance } from 'node:perf_hooks'
import { marked, type Token, type Tokens } from 'marked'
import { configureMarked, formatToken } from '../../../src/shared/text/markdown.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../../../src/shared/text/cliHighlight.js'
import { getFixture, lineSnapshots, listFixtures } from './fixtures.js'

type Strategy = 'status-quo' | 'defer-fence' | 'lru-text'

type Args = {
  fixture: string
  runs: number
  warmup: number
  strategy: Strategy
  noHighlight: boolean
  compare: boolean
  noMemo: boolean
  json: boolean
  list: boolean
  help: boolean
}

const STRATEGIES: Strategy[] = ['status-quo', 'defer-fence', 'lru-text']

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixture: 'ts50',
    runs: 5,
    warmup: 2,
    strategy: 'status-quo',
    noHighlight: false,
    compare: false,
    noMemo: false,
    json: false,
    list: false,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--list') args.list = true
    else if (a === '--no-highlight') args.noHighlight = true
    else if (a === '--compare') args.compare = true
    else if (a === '--no-memo') args.noMemo = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--fixture=')) args.fixture = a.slice('--fixture='.length)
    else if (a.startsWith('--runs=')) args.runs = Number(a.slice('--runs='.length))
    else if (a.startsWith('--warmup=')) args.warmup = Number(a.slice('--warmup='.length))
    else if (a.startsWith('--strategy=')) {
      const s = a.slice('--strategy='.length) as Strategy
      if (!STRATEGIES.includes(s)) {
        throw new Error(`Unknown strategy: ${s}. Available: ${STRATEGIES.join(', ')}`)
      }
      args.strategy = s
    }
  }
  return args
}

function printHelp(): void {
  console.log(
    `streaming-bench — measure the streaming markdown render path

  --fixture=NAME    one of: ${listFixtures().join(', ')} (default: ts50)
  --strategy=NAME   one of: ${STRATEGIES.join(', ')} (default: status-quo)
  --compare         run all strategies on the chosen fixture and tabulate
  --runs=N          measured runs after warmup (default: 5)
  --warmup=N        warmup runs, discarded (default: 2)
  --no-highlight    pass highlight=null (control case)
  --no-memo         disable stablePrefix memoization (matches the live REPL's
                    React Compiler memo on <Markdown>{stablePrefix}</Markdown>;
                    --no-memo recovers the un-memoized harness behavior for
                    apples-to-apples comparison with prior baselines)
  --json            emit machine-readable summary on stdout
  --list            list fixtures and exit
  --help            show this help`,
  )
}

type Counters = {
  highlightCalls: number
  highlightChars: number
  lexCalls: number
  formattedChars: number
  cacheHits: number
  cacheMisses: number
}

function newCounters(): Counters {
  return {
    highlightCalls: 0,
    highlightChars: 0,
    lexCalls: 0,
    formattedChars: 0,
    cacheHits: 0,
    cacheMisses: 0,
  }
}

// Hash for the LRU strategy. djb2 — fast, good enough for cache keys here.
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h
}

// Detects an unclosed code fence, given a `code` token's `raw`. marked emits
// a `code` token even for unclosed fences, with `raw` being everything from
// the opening backticks to the current end of input (no closing fence). When
// the closing ``` arrives, raw ends with the closing fence (possibly + EOL).
function isOpenFence(rawText: string): boolean {
  const trimmed = rawText.trimEnd()
  // Closed if the trimmed body ends with ``` AND there's at least one newline
  // before it (so we don't false-match a one-line ``` foo ``` indent block).
  // marked's tokenizer requires the closing fence on its own line in standard
  // markdown, so a closed block ends with `\n```` (after trim).
  if (!trimmed.endsWith('```')) return true
  // Single-line fenced blocks are rare in streaming; treat them as closed.
  return false
}

// Wrap CliHighlight to count + (optionally) cache. Different strategies plug
// in different wrappers without touching formatToken.
function makeHighlightAdapter(
  hl: CliHighlight | null,
  strategy: Strategy,
  counters: Counters,
): { hl: CliHighlight | null; renderToken: TokenRenderer } {
  if (!hl) {
    return {
      hl: null,
      renderToken: (tok: Token, fmt: FormatFn) => fmt(tok, null),
    }
  }

  const counted: CliHighlight = {
    supportsLanguage: hl.supportsLanguage,
    highlight: (text, opts) => {
      counters.highlightCalls++
      counters.highlightChars += text.length
      return hl.highlight(text, opts)
    },
  }

  switch (strategy) {
    case 'status-quo':
      return {
        hl: counted,
        renderToken: (tok, fmt) => fmt(tok, counted),
      }

    case 'defer-fence':
      // For `code` tokens whose fence is still open, render plain text.
      // Once the fence closes, fall back to the normal highlight path.
      return {
        hl: counted,
        renderToken: (tok, fmt) => {
          if (tok.type === 'code') {
            const codeTok = tok as Tokens.Code
            if (isOpenFence(codeTok.raw)) {
              return codeTok.text + '\n'
            }
          }
          return fmt(tok, counted)
        },
      }

    case 'lru-text': {
      // LRU cache keyed by (lang, hash(text)). Tests the round-3 claim that
      // hit rate is structurally zero during streaming (each new line yields
      // a longer text → different hash → miss).
      const cap = 200
      const cache = new Map<string, string>()
      const lruHl: CliHighlight = {
        supportsLanguage: hl.supportsLanguage,
        highlight: (text, opts) => {
          const lang = opts?.language ?? 'plaintext'
          const key = `${lang}\0${djb2(text)}`
          const hit = cache.get(key)
          if (hit !== undefined) {
            counters.cacheHits++
            // Preserve LRU ordering
            cache.delete(key)
            cache.set(key, hit)
            return hit
          }
          counters.cacheMisses++
          counters.highlightCalls++
          counters.highlightChars += text.length
          const out = hl.highlight(text, opts)
          if (cache.size >= cap) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.set(key, out)
          return out
        },
      }
      return {
        hl: lruHl,
        renderToken: (tok, fmt) => fmt(tok, lruHl),
      }
    }
  }
}

type FormatFn = (tok: Token, hl: CliHighlight | null) => string
type TokenRenderer = (tok: Token, fmt: FormatFn) => string

const fmtToken: FormatFn = (tok, hl) =>
  formatToken(tok, 'dark', 0, null, null, hl)

// Mirrors StreamingMarkdown's algorithm (Markdown.tsx:186-235) without React.
function advance(
  stripped: string,
  prevStable: string,
  counters: Counters,
): { stablePrefix: string; unstableSuffix: string } {
  const startStable = stripped.startsWith(prevStable) ? prevStable : ''
  const boundary = startStable.length
  const tokens = marked.lexer(stripped.substring(boundary))
  counters.lexCalls++
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advanceBy = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advanceBy += tokens[i]!.raw.length
  }
  const newStable =
    advanceBy > 0
      ? stripped.substring(0, boundary + advanceBy)
      : startStable
  return {
    stablePrefix: newStable,
    unstableSuffix: stripped.substring(newStable.length),
  }
}

function renderToAnsi(
  text: string,
  renderToken: TokenRenderer,
  counters: Counters,
): number {
  if (!text) return 0
  const tokens = marked.lexer(text)
  counters.lexCalls++
  let chars = 0
  for (const tok of tokens) {
    chars += renderToken(tok, fmtToken).length
  }
  return chars
}

type RunResult = {
  totalMs: number
  highlightCalls: number
  highlightChars: number
  lexCalls: number
  formattedChars: number
  snapshotCount: number
  cacheHits: number
  cacheMisses: number
  perSnapshotMsMax: number
  perSnapshotMsP95: number
  perSnapshotMsMean: number
}

function runOnce(
  fixtureText: string,
  baseHl: CliHighlight | null,
  strategy: Strategy,
  memoizeStable = true,
): RunResult {
  configureMarked()
  const snapshots = lineSnapshots(fixtureText)
  const counters = newCounters()
  const adapter = makeHighlightAdapter(baseHl, strategy, counters)

  let stablePrefix = ''
  // Models <Markdown>{stablePrefix}</Markdown>'s memoization in
  // src/terminal/markdown/Markdown.tsx:133 — when `children` doesn't change between
  // renders, MarkdownBody returns its cached output and no formatToken runs.
  // The stablePrefix only advances forward, so a single previousStable
  // comparison is sufficient.
  let lastStableRendered = ''
  let cachedStableChars = 0

  const perSnapshotMs: number[] = []
  const t0 = performance.now()
  for (const snap of snapshots) {
    const s0 = performance.now()
    const { stablePrefix: nextStable, unstableSuffix } = advance(
      snap,
      stablePrefix,
      counters,
    )
    stablePrefix = nextStable

    if (memoizeStable && stablePrefix === lastStableRendered) {
      // Memo hit — MarkdownBody returns the cached element tree, no work.
      counters.formattedChars += cachedStableChars
    } else {
      cachedStableChars = renderToAnsi(stablePrefix, adapter.renderToken, counters)
      counters.formattedChars += cachedStableChars
      lastStableRendered = stablePrefix
    }
    // unstableSuffix changes every snapshot → no memo benefit, always re-render.
    counters.formattedChars += renderToAnsi(unstableSuffix, adapter.renderToken, counters)
    perSnapshotMs.push(performance.now() - s0)
  }
  const totalMs = performance.now() - t0

  perSnapshotMs.sort((a, b) => a - b)
  const p95Idx = Math.min(
    perSnapshotMs.length - 1,
    Math.floor(perSnapshotMs.length * 0.95),
  )
  const mean = perSnapshotMs.reduce((s, x) => s + x, 0) / perSnapshotMs.length

  return {
    totalMs,
    highlightCalls: counters.highlightCalls,
    highlightChars: counters.highlightChars,
    lexCalls: counters.lexCalls,
    formattedChars: counters.formattedChars,
    snapshotCount: snapshots.length,
    cacheHits: counters.cacheHits,
    cacheMisses: counters.cacheMisses,
    perSnapshotMsMax: perSnapshotMs[perSnapshotMs.length - 1] ?? 0,
    perSnapshotMsP95: perSnapshotMs[p95Idx] ?? 0,
    perSnapshotMsMean: mean,
  }
}

function summarize(runs: RunResult[]): {
  median: RunResult
  min: RunResult
  max: RunResult
} {
  const sorted = [...runs].sort((a, b) => a.totalMs - b.totalMs)
  return {
    min: sorted[0]!,
    median: sorted[Math.floor(sorted.length / 2)]!,
    max: sorted[sorted.length - 1]!,
  }
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

function runStrategy(
  fixtureText: string,
  hl: CliHighlight | null,
  strategy: Strategy,
  warmup: number,
  runs: number,
  memoizeStable: boolean,
): { strategy: Strategy; runs: RunResult[]; summary: ReturnType<typeof summarize> } {
  for (let i = 0; i < warmup; i++) runOnce(fixtureText, hl, strategy, memoizeStable)
  const out: RunResult[] = []
  for (let i = 0; i < runs; i++) out.push(runOnce(fixtureText, hl, strategy, memoizeStable))
  return { strategy, runs: out, summary: summarize(out) }
}

function printSingle(
  fixtureName: string,
  fixtureText: string,
  strategy: Strategy,
  highlight: CliHighlight | null,
  args: Args,
  result: { runs: RunResult[]; summary: ReturnType<typeof summarize> },
): void {
  const med = result.summary.median
  console.log(`fixture            ${fixtureName} (${fixtureText.length} chars, ${med.snapshotCount} snapshots)`)
  console.log(`strategy           ${strategy}`)
  console.log(`highlight          ${highlight ? 'on (cli-highlight)' : 'off'}`)
  console.log(`runs               ${args.runs} measured (after ${args.warmup} warmup)`)
  console.log('')
  console.log(`total ms           min=${fmt(result.summary.min.totalMs)}  median=${fmt(med.totalMs)}  max=${fmt(result.summary.max.totalMs)}`)
  console.log(`per-snap ms (med)  mean=${fmt(med.perSnapshotMsMean, 3)}  p95=${fmt(med.perSnapshotMsP95, 3)}  max=${fmt(med.perSnapshotMsMax, 3)}`)
  console.log(`highlight calls    ${med.highlightCalls}  (${med.highlightChars} chars total, avg ${fmt(med.highlightChars / Math.max(1, med.highlightCalls), 0)} chars/call)`)
  if (strategy === 'lru-text') {
    const total = med.cacheHits + med.cacheMisses
    const hitPct = total > 0 ? (med.cacheHits / total) * 100 : 0
    console.log(`cache              hits=${med.cacheHits}  misses=${med.cacheMisses}  hitrate=${fmt(hitPct, 1)}%`)
  }
  console.log(`marked.lexer calls ${med.lexCalls}`)
  console.log(`output bytes       ${med.formattedChars}`)
}

function printCompare(
  fixtureName: string,
  fixtureText: string,
  highlight: CliHighlight | null,
  results: Array<{ strategy: Strategy; runs: RunResult[]; summary: ReturnType<typeof summarize> }>,
): void {
  console.log(`fixture            ${fixtureName} (${fixtureText.length} chars, ${results[0]!.summary.median.snapshotCount} snapshots)`)
  console.log(`highlight          ${highlight ? 'on (cli-highlight)' : 'off'}`)
  console.log('')
  const baselineMs = results.find(r => r.strategy === 'status-quo')!.summary.median.totalMs
  const header = ['strategy', 'total ms (med)', 'p95 ms', 'hl calls', 'hl chars', 'speedup', 'cache hit%']
  const rows: string[][] = [header]
  for (const r of results) {
    const m = r.summary.median
    const speedup = baselineMs / m.totalMs
    const total = m.cacheHits + m.cacheMisses
    const hitPct = total > 0 ? `${fmt((m.cacheHits / total) * 100, 1)}%` : '—'
    rows.push([
      r.strategy,
      fmt(m.totalMs),
      fmt(m.perSnapshotMsP95, 3),
      String(m.highlightCalls),
      String(m.highlightChars),
      `${fmt(speedup, 2)}×`,
      hitPct,
    ])
  }
  // Pretty-print as a table
  const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  for (const r of rows) {
    console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  '))
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.list) {
    console.log(listFixtures().join('\n'))
    return
  }
  const fixture = getFixture(args.fixture)

  const highlight = args.noHighlight ? null : await getCliHighlightPromise()
  if (!args.noHighlight && !highlight) {
    console.error('cli-highlight failed to load — running with highlight=null')
  }
  // FORCE_COLOR=3 is set at module top so chalk emits ANSI even when
  // piped — the benchmark only meaningfully maps to the live REPL when
  // colors are on. Override with FORCE_COLOR=0 to model the no-color path.

  if (args.compare) {
    const results = STRATEGIES.map(s =>
      runStrategy(fixture.text, highlight, s, args.warmup, args.runs, !args.noMemo),
    )
    if (args.json) {
      process.stdout.write(JSON.stringify({ fixture: fixture.name, highlight: !!highlight, results }, null, 2) + '\n')
      return
    }
    printCompare(fixture.name, fixture.text, highlight, results)
    return
  }

  const result = runStrategy(fixture.text, highlight, args.strategy, args.warmup, args.runs, !args.noMemo)
  if (args.json) {
    process.stdout.write(JSON.stringify({ fixture: fixture.name, highlight: !!highlight, ...result }, null, 2) + '\n')
    return
  }
  printSingle(fixture.name, fixture.text, args.strategy, highlight, args, result)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
