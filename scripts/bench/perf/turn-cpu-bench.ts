#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// turn-cpu-bench — where the MAIN THREAD's CPU goes during a steady-state turn
// ---------------------------------------------------------------------------
//
// Every other bench in this directory measures either cold start
// (`cold-start-bench`, `startup-phases-bench`) or one micro-path
// (`streaming-bench`, `input-bench`, `transcript-bench`, `memory-bench`).
// None of them answers "a turn is burning N ms of CPU — on what?", which is
// the question any parallelization proposal has to clear first.
//
// WHAT THIS COVERS, AND WHAT IT DOES NOT
//
// The four phases originally wanted were: model stream parse, tool execution,
// tool-result summarization, and transcript render. Three of them are measured
// here against REAL product code. The fourth is not, and is not faked:
//
//   MEASURED   search      real ripGrep() over this repo's own src/
//              outline     real buildSymbolsOutput() + scanSymbols/renderOutline
//              summarize   real maybeSummarizeToolResult()
//              render      real applyMarkdown()
//
//   NOT COVERED  model stream parse, and the QueryEngine shell around it
//                (message assembly, permission checks, attachment building).
//
// The omission is a hard constraint, not a shortcut. Driving a real
// `QueryEngine.submitMessage()` from source requires reproducing what
// `scripts/build/build.ts` does at bundle time — the `@growthbook/growthbook`
// and `@anthropic-ai/sandbox-runtime` aliases, the `MACRO.*` `define` map, and
// the whole-module replacements in `scripts/build/no-telemetry-plugin.ts` (of
// which `src/platform/telemetry/sessionTracing` is one). Each stub added
// uncovers the next; re-implementing that list in a preload is building a
// second bundler, and it would drift from the real one silently.
// `memory-e2e-bench.ts` takes that route and, as of this writing, dies during
// bootstrap for exactly this reason. So the split below is three honest
// buckets rather than four invented ones, and the printed output says so.
//
// READING THE NUMBERS
//
// `process.cpuUsage()` is PROCESS-wide, not thread-local: it sums every thread,
// so the `user` column already includes the JavaScriptCore GC helper threads
// and the JIT workers doing work on the main thread's behalf. That is the
// intent — it is the number that matches what `top`/`btop` attributes to the
// process. It does NOT include child processes, so the `search` row is the
// main thread's own cost of driving ripgrep (spawn, pipe drain, UTF-8 decode),
// while ripgrep's own scan is invisible to it, which is correct: that work is
// genuinely off the main thread already.
//
// NO --expose-gc, DELIBERATELY. Almost every sibling `profile:*` script runs
// `bun --expose-gc`, which makes `globalThis.gc` exist. The shipped binary is
// `bun --compile` output with no such flag, so a measurement taken under it
// does not describe what users run — and it hides an entire class of bug (see
// `.claudin/rules/build-system.md`, "What the `--compile` binary is NOT").
//
// Usage:
//   bun run scripts/bench/perf/turn-cpu-bench.ts
//   bun run scripts/bench/perf/turn-cpu-bench.ts --turns=40 --tool-output-kb=200
//   bun run scripts/bench/perf/turn-cpu-bench.ts --json
//
// CPU profile (Bun):
//   bun --cpu-prof scripts/bench/perf/turn-cpu-bench.ts --turns=10
//   # → cpu-*.cpuprofile, open in Chrome DevTools Performance tab
// ---------------------------------------------------------------------------

import { mock } from 'bun:test'

// Build-time module replacements, reproduced for a source run. Both of these
// are `[alias]` entries in bunfig.toml that only apply under `bun test`, and
// `scripts/build/build.ts` swaps them at bundle time — so a plain `bun run`
// dies on a missing package before printing a line. Re-exporting the
// checked-in stub keeps this from drifting into a second hand-written shape.
mock.module('@growthbook/growthbook', () => ({
  GrowthBook: class {
    async init(): Promise<void> {}
    setAttributes(): void {}
    getFeatureValue<T>(_key: string, fallback: T): T {
      return fallback
    }
    isOn(): boolean {
      return false
    }
    destroy(): void {}
  },
}))
const sandboxRuntimeStub = await import(
  '../../../src/stubs/sandbox-runtime-stub.js'
)
mock.module('@anthropic-ai/sandbox-runtime', () => sandboxRuntimeStub)

import { performance } from 'node:perf_hooks'

const { enableConfigs } = await import('../../../src/platform/config/config.js')
// The summarizer reads getGlobalConfig(); without this it throws
// "Config accessed before allowed" on the first call.
enableConfigs()

const { ripGrep } = await import('../../../src/shared/fs/ripgrep.js')
const { buildSymbolsOutput } = await import(
  '../../../src/tools/GrepTool/symbolsOutput.js'
)
const { maybeSummarizeToolResult } = await import(
  '../../../src/agent/tools/toolResultSummarizer.js'
)
const { applyMarkdown, configureMarked } = await import(
  '../../../src/shared/text/markdown.js'
)
const { scanSymbols, detectOutlineLangFromPath } = await import(
  '../../../src/tools/shared/codeOutline/scanSymbols.js'
)
const { renderOutline } = await import(
  '../../../src/tools/shared/codeOutline/renderOutline.js'
)

// --- Args ---

type Args = {
  turns: number
  toolOutputKb: number
  json: boolean
  verbose: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    turns: 20,
    toolOutputKb: 50,
    json: false,
    verbose: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true
    else if (arg === '--json') a.json = true
    else if (arg === '--verbose') a.verbose = true
    else if (arg.startsWith('--turns=')) a.turns = Number(arg.slice(8)) || a.turns
    else if (arg.startsWith('--tool-output-kb='))
      a.toolOutputKb = Number(arg.slice(17)) || a.toolOutputKb
  }
  return a
}

function printHelp(): void {
  console.log(`turn-cpu-bench — main-thread CPU split across a steady-state turn

  --turns=N            turns to run (default 20)
  --tool-output-kb=K   size of the synthetic assistant/tool payload (default 50)
  --json               emit JSON summary
  --verbose            print a row per turn
  --help

Covers: search, outline, summarize, render — all real product code.
Does NOT cover: model stream parse / QueryEngine shell (see file header).
`)
}

// --- Phase accounting ---

type PhaseName = 'search' | 'outline' | 'summarize' | 'render'

const PHASES: PhaseName[] = ['search', 'outline', 'summarize', 'render']

type Sample = { wallMs: number; userMs: number; systemMs: number }

function emptySample(): Sample {
  return { wallMs: 0, userMs: 0, systemMs: 0 }
}

function addSample(into: Sample, add: Sample): void {
  into.wallMs += add.wallMs
  into.userMs += add.userMs
  into.systemMs += add.systemMs
}

/**
 * Time one phase. `process.cpuUsage(prev)` returns the delta in microseconds
 * since `prev`, summed over every thread in the process.
 */
async function timed<T>(fn: () => Promise<T> | T): Promise<[T, Sample]> {
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const value = await fn()
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  return [value, { wallMs, userMs: cpu.user / 1000, systemMs: cpu.system / 1000 }]
}

// --- Workload ---

// Files read back per turn for the Read auto-outline path. Picked for size
// spread rather than for content: one large barrel, one mid-sized module, one
// small leaf, so the outline bucket is not dominated by a single shape.
const OUTLINE_TARGETS = [
  'src/providers/shims/openaiShim/streamParser.ts',
  'src/agent/tools/toolResultSummarizer.ts',
  'src/tools/GrepTool/symbolsOutput.ts',
]

// The pattern a real symbols-mode Grep runs: broad enough to cross hundreds of
// files, so `buildSymbolsOutput` hits its own SYMBOLS_MAX_FILES cap the way it
// does in a live session.
const SEARCH_PATTERN = 'export (async )?function'

function buildAssistantText(kb: number, turn: number): string {
  const block = `## Turn ${turn}

Prose with **bold**, _emphasis_, \`inline code\` and a [link](https://example.invalid).

\`\`\`ts
export function sample${turn}(a: number): number {
  return a * ${turn}
}
\`\`\`

- first bullet
- second bullet
`
  const target = kb * 1024
  let out = ''
  while (out.length < target) out += block
  return out
}

type TurnRecord = {
  turn: number
  phases: Record<PhaseName, Sample>
  rgLines: number
  symbolFiles: number
  summarizedFrom: number
  summarizedTo: number
}

async function runTurn(turn: number, args: Args, root: string): Promise<TurnRecord> {
  const phases: Record<PhaseName, Sample> = {
    search: emptySample(),
    outline: emptySample(),
    summarize: emptySample(),
    render: emptySample(),
  }

  const abort = new AbortController()

  // Phase 1 — search. Real ripgrep, real args, this repo's own src/.
  const [rgLines, searchSample] = await timed(() =>
    ripGrep(['-n', '-e', SEARCH_PATTERN], root, abort.signal),
  )
  addSample(phases.search, searchSample)

  // Phase 2a — outline: the symbols-mode Grep path (scanSymbols per file).
  const [symbols, symbolsSample] = await timed(() => buildSymbolsOutput(rgLines))
  addSample(phases.outline, symbolsSample)

  // Phase 2b — outline: the Read auto-outline path on real source files.
  const [, readOutlineSample] = await timed(async () => {
    for (const rel of OUTLINE_TARGETS) {
      const source = await Bun.file(`${root}/../${rel}`).text()
      const lang = detectOutlineLangFromPath(rel)
      if (!lang) continue
      const entries = scanSymbols(source, lang)
      renderOutline(entries, rel, source.split('\n').length)
    }
  })
  addSample(phases.outline, readOutlineSample)

  // Phase 3 — summarize. The raw rg payload is what a live Grep hands the
  // summarizer, so this is the real reduction path, not a synthetic string.
  const rawPayload = rgLines.join('\n')
  const [summarized, summarizeSample] = await timed(() =>
    maybeSummarizeToolResult(
      { type: 'tool_result', tool_use_id: `toolu_${turn}`, content: rawPayload },
      'Grep',
    ),
  )
  addSample(phases.summarize, summarizeSample)
  const summarizedText =
    typeof summarized.content === 'string' ? summarized.content : ''

  // Phase 4 — render. Assistant prose plus the tool result the user sees.
  const assistantText = buildAssistantText(args.toolOutputKb, turn)
  const [, renderSample] = await timed(() => {
    applyMarkdown(assistantText)
    applyMarkdown(symbols.content)
  })
  addSample(phases.render, renderSample)

  return {
    turn,
    phases,
    rgLines: rgLines.length,
    symbolFiles: symbols.numFiles,
    summarizedFrom: rawPayload.length,
    summarizedTo: summarizedText.length,
  }
}

// --- Formatting ---

function pct(part: number, total: number): string {
  if (total <= 0) return '  0.0%'
  return `${((part / total) * 100).toFixed(1)}%`.padStart(6)
}

function ms(n: number): string {
  return n.toFixed(1).padStart(9)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  configureMarked()
  const root = `${process.cwd()}/src`

  // One warm-up turn: first ripgrep pays binary resolution and the first
  // scanSymbols pays JIT warm-up, neither of which recurs in a live session.
  console.error('[warmup] one untimed turn...')
  await runTurn(0, args, root)

  const totals: Record<PhaseName, Sample> = {
    search: emptySample(),
    outline: emptySample(),
    summarize: emptySample(),
    render: emptySample(),
  }
  const history: TurnRecord[] = []

  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()

  for (let turn = 1; turn <= args.turns; turn++) {
    const rec = await runTurn(turn, args, root)
    history.push(rec)
    for (const p of PHASES) addSample(totals[p], rec.phases[p])
    if (args.verbose) {
      const turnCpu = PHASES.reduce((acc, p) => acc + rec.phases[p].userMs, 0)
      console.error(
        `  turn=${String(turn).padStart(3)} user=${turnCpu.toFixed(1)}ms ` +
          PHASES.map(p => `${p}=${rec.phases[p].userMs.toFixed(1)}`).join(' '),
      )
    }
  }

  const wallMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  const totalUserMs = cpu.user / 1000
  const totalSystemMs = cpu.system / 1000

  const accountedUser = PHASES.reduce((acc, p) => acc + totals[p].userMs, 0)
  const last = history[history.length - 1]

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          turns: args.turns,
          toolOutputKb: args.toolOutputKb,
          wallMs: Math.round(wallMs),
          totalUserMs: Math.round(totalUserMs),
          totalSystemMs: Math.round(totalSystemMs),
          accountedUserMs: Math.round(accountedUser),
          unaccountedUserMs: Math.round(totalUserMs - accountedUser),
          coversModelStreamParse: false,
          phases: Object.fromEntries(
            PHASES.map(p => [
              p,
              {
                wallMs: Math.round(totals[p].wallMs),
                userMs: Math.round(totals[p].userMs),
                systemMs: Math.round(totals[p].systemMs),
                perTurnUserMs: Number((totals[p].userMs / args.turns).toFixed(2)),
                shareOfAccounted: Number(
                  ((totals[p].userMs / Math.max(accountedUser, 1)) * 100).toFixed(1),
                ),
              },
            ]),
          ),
          workload: last
            ? {
                rgLines: last.rgLines,
                symbolFiles: last.symbolFiles,
                summarizedFrom: last.summarizedFrom,
                summarizedTo: last.summarizedTo,
              }
            : null,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`\nturn-cpu-bench — ${args.turns} turns, ${args.toolOutputKb} KB payload`)
  console.log(
    `  wall ${(wallMs / 1000).toFixed(1)}s   CPU user ${totalUserMs.toFixed(0)} ms   system ${totalSystemMs.toFixed(0)} ms   (process-wide: main thread + GC/JIT helpers)`,
  )
  console.log(
    `  CPU per turn: ${(totalUserMs / args.turns).toFixed(1)} ms user, ${(totalSystemMs / args.turns).toFixed(1)} ms system\n`,
  )

  console.log(
    '  phase'.padEnd(14) +
      'user ms'.padStart(10) +
      'sys ms'.padStart(10) +
      'wall ms'.padStart(10) +
      '  per turn'.padStart(11) +
      '   share',
  )
  for (const p of PHASES) {
    const t = totals[p]
    console.log(
      `  ${p.padEnd(12)}${ms(t.userMs)}${ms(t.systemMs)}${ms(t.wallMs)}${ms(t.userMs / args.turns)}  ${pct(t.userMs, accountedUser)}`,
    )
  }
  console.log(
    `  ${'—'.padEnd(12)}${ms(accountedUser)}${' '.repeat(20)}${ms(accountedUser / args.turns)}   accounted`,
  )
  console.log(
    `  ${'unaccounted'.padEnd(12)}${ms(totalUserMs - accountedUser)}${' '.repeat(20)}${ms((totalUserMs - accountedUser) / args.turns)}   GC/JIT/loop overhead not inside a timed phase`,
  )

  if (last) {
    console.log(`\n  workload per turn:`)
    console.log(`    ripgrep lines            ${last.rgLines}`)
    console.log(`    files scanned for symbols ${last.symbolFiles}  (SYMBOLS_MAX_FILES caps this)`)
    console.log(
      `    summarizer               ${last.summarizedFrom} → ${last.summarizedTo} chars`,
    )
  }

  console.log(
    `\n  NOT COVERED: model stream parse and the QueryEngine shell around it —` +
      `\n  unreachable from a source run without re-implementing the build's module` +
      `\n  stubs. See the file header.`,
  )
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
