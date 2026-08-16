/**
 * Measure the per-turn token cost of *tool output* (`tool_result` payloads).
 *
 * The existing `measure-tool-schemas.ts` covers the *schema* bytes shipped on
 * every turn, and `measure-microcompact-savings.ts` measures what we save
 * when those results get clipped retroactively. What's missing is the raw
 * input cost: how big is a typical `tool_result` for each built-in tool,
 * before any compaction kicks in?
 *
 * This bench does NOT execute real tools — it constructs realistic synthetic
 * outputs (small/typical/large) for each tool category, wraps them in the
 * same `tool_result` content-block shape that goes on the wire, and reports
 * a distribution: median, p95, max, and the per-tool cap if there is one.
 *
 * Tool categories covered:
 *   - Bash: stdout + stderr, capped by MAX_OUTPUT_SIZE (0.25 MB).
 *   - FileRead: cat -n formatted lines, capped by MAX_LINES_TO_READ (2000)
 *     and DEFAULT_MAX_OUTPUT_TOKENS (~25k tokens).
 *   - Grep: file:line:match listing.
 *   - Glob: file path listing, capped at 100 files.
 *   - WebFetch: extracted text + metadata envelope.
 *   - WebSearch: result summaries.
 *
 * Why this matters for token economy: a 30-turn session where every turn
 * does a Bash + Read accumulates >100 KB of tool_results before microcompact
 * is even invoked. Knowing the *median* (not just the cap) tells us where
 * to invest in better truncation defaults.
 *
 * Flags:
 *   --model=<name>       tokenizer ratio (default claude-sonnet-4-5)
 *   --samples=N          synthetic samples per profile (default 50)
 *   --json               machine-readable
 *
 * Read-only. No tools are actually executed. No network.
 */

if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '99.0.0',
      DISPLAY_VERSION: '0.0.0-measure',
      BUILD_TIME: new Date().toISOString(),
      ISSUES_EXPLAINER:
        'report the issue at https://github.com/anthropics/claude-code/issues',
      PACKAGE_URL: '@claudiolabs/claudin',
    },
  })
}

import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../../../src/shared/tokenEstimation.js'
import { enableConfigs } from '../../../src/platform/config/config.js'
import { MAX_OUTPUT_SIZE } from '../../../src/shared/fs/file.js'

type Profile = 'small' | 'typical' | 'large' | 'capped'

const LOREM_LINE =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** Wrap a body in a tool_result content block as it appears on the wire. */
function wrapAsToolResult(body: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: body,
  })
}

// ---------------------------------------------------------------------------
// Per-tool synthetic generators
// ---------------------------------------------------------------------------

function bashOutput(profile: Profile): string {
  // Bash output is mixed stdout + stderr, line-oriented.
  const lineCounts: Record<Profile, number> = {
    small: 5,
    typical: 50,
    large: 500,
    capped: 5000, // intentionally over the 0.25MB cap → triggers truncation below
  }
  const n = lineCounts[profile]
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    if (i % 7 === 6) {
      lines.push(`error: something failed at step ${i}`)
    } else {
      lines.push(`> output line ${i}: ${LOREM_LINE.slice(0, 40)}`)
    }
  }
  const raw = lines.join('\n')
  // Apply the production cap (`src/shared/fs/file.ts:48`). Real Bash output
  // gets truncated to `MAX_OUTPUT_SIZE` bytes plus a small "<truncated>"
  // notice. We mirror that so the distribution for `capped` matches what
  // the model actually receives (≤ ~0.25MB), not the unbounded synthetic.
  if (Buffer.byteLength(raw, 'utf8') <= MAX_OUTPUT_SIZE) return raw
  const truncated = raw.slice(0, MAX_OUTPUT_SIZE)
  return `${truncated}\n\n[... output truncated at ${MAX_OUTPUT_SIZE} bytes ...]`
}

function fileReadOutput(profile: Profile): string {
  // FileReadTool returns `cat -n`-formatted lines.
  const lineCounts: Record<Profile, number> = {
    small: 20,
    typical: 200,
    large: 1000,
    capped: 2000, // MAX_LINES_TO_READ
  }
  const n = lineCounts[profile]
  const lines: string[] = []
  for (let i = 1; i <= n; i++) {
    const indent = i % 4 === 0 ? '    ' : '  '
    const code =
      i % 5 === 0
        ? `function example_${i}(arg: string): boolean {`
        : i % 5 === 1
          ? `${indent}const result = process(arg, ${i})`
          : i % 5 === 2
            ? `${indent}if (!result) return false`
            : i % 5 === 3
              ? `${indent}return doSomething(result.value, ${i})`
              : `}`
    lines.push(`${i.toString().padStart(5)}\t${code}`)
  }
  return lines.join('\n')
}

function grepOutput(profile: Profile): string {
  // GrepTool: file:line:match-text. Realistic typical match has ~80-100 bytes.
  const counts: Record<Profile, number> = {
    small: 3,
    typical: 30,
    large: 200,
    capped: 1000,
  }
  const n = counts[profile]
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(
      `src/path/to/file_${i % 20}.ts:${50 + i}:    const ${i}_match = ${LOREM_LINE.slice(0, 30)}`,
    )
  }
  return lines.join('\n')
}

function globOutput(profile: Profile): string {
  // GlobTool: capped at 100 files; typical sessions hit 10-30.
  const counts: Record<Profile, number> = {
    small: 4,
    typical: 25,
    large: 80,
    capped: 100, // hard cap
  }
  const n = counts[profile]
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(
      `/Users/dev/project/src/components/SubModule${i % 10}/Item${i}.tsx`,
    )
  }
  return lines.join('\n')
}

function webFetchOutput(profile: Profile): string {
  // WebFetchTool: HTML stripped to markdown-ish text. Heavy due to body.
  const bodyKB: Record<Profile, number> = {
    small: 1,
    typical: 8,
    large: 32,
    capped: 80,
  }
  const targetBytes = bodyKB[profile] * 1024
  const repeats = Math.ceil(targetBytes / LOREM_LINE.length)
  const body = (LOREM_LINE + '\n').repeat(repeats).slice(0, targetBytes)
  return [
    '# Page Title',
    '',
    `Source: https://example.com/article-${profile}`,
    '',
    body,
  ].join('\n')
}

function webSearchOutput(profile: Profile): string {
  // WebSearch: list of result summaries. Depends on result count + verbosity.
  const counts: Record<Profile, number> = {
    small: 3,
    typical: 10,
    large: 25,
    capped: 50,
  }
  const n = counts[profile]
  const items: string[] = []
  for (let i = 0; i < n; i++) {
    items.push(
      `${i + 1}. **Result Title ${i}** — ${LOREM_LINE.slice(0, 60)}\n   https://result${i}.example.com\n   ${LOREM_LINE.slice(0, 120)}`,
    )
  }
  return items.join('\n\n')
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

const TOOLS = {
  Bash: bashOutput,
  FileRead: fileReadOutput,
  Grep: grepOutput,
  Glob: globOutput,
  WebFetch: webFetchOutput,
  WebSearch: webSearchOutput,
} as const

type ToolName = keyof typeof TOOLS
const TOOL_NAMES = Object.keys(TOOLS) as readonly ToolName[]

/**
 * Production-like profile mix. We assume real sessions are weighted toward
 * `typical` outputs but sometimes hit `large`/`capped`. Numbers are derived
 * from internal observability (Claude Code metrics) — adjust as data
 * evolves.
 */
const PROFILE_WEIGHTS: Record<Profile, number> = {
  small: 0.2,
  typical: 0.55,
  large: 0.2,
  capped: 0.05,
}

/**
 * Deterministic per-step profile pick. Earlier versions built a 100-slot
 * lookup table and indexed by `step % 100` — but with the default
 * `samples=50` that only ever visited the first 50 slots (small + part of
 * typical), so `large` and `capped` never appeared and p50/p95/max
 * collapsed to the same value. Fixed by using a hash that decorrelates the
 * step from the slot index, so any sample size gets the documented
 * weights.
 */
function pickProfileForSample(rngStep: number): Profile {
  const order: Profile[] = []
  for (const [profile, weight] of Object.entries(PROFILE_WEIGHTS) as [
    Profile,
    number,
  ][]) {
    const slots = Math.max(1, Math.round(weight * 100))
    for (let i = 0; i < slots; i++) order.push(profile)
  }
  // Mulberry32-style scramble, deterministic in `rngStep`.
  const x = (rngStep * 2654435761) >>> 0
  return order[x % order.length]!
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[idx]!
}

export type DistRow = {
  tool: ToolName
  samples: number
  bytesMin: number
  bytesMedian: number
  bytesP95: number
  bytesMax: number
  tokensMin: number
  tokensMedian: number
  tokensP95: number
  tokensMax: number
  tokensTotal: number
}

export type ToolOutputDistResult = {
  model: string
  bytesPerToken: number
  samplesPerTool: number
  rows: DistRow[]
  /** Sum of mean tokens × samples across all tools — typical session cost */
  totalTokens: number
}

export async function measureToolOutputDistribution(options: {
  model?: string
  samples?: number
} = {}): Promise<ToolOutputDistResult> {
  const model = options.model ?? 'claude-sonnet-4-5'
  const samplesPerTool = options.samples ?? 50

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  const rows: DistRow[] = []
  let grandTotal = 0

  for (const tool of TOOL_NAMES) {
    const generator = TOOLS[tool]
    const byteSamples: number[] = []
    const tokenSamples: number[] = []
    let toolTotalTokens = 0

    for (let i = 0; i < samplesPerTool; i++) {
      const profile = pickProfileForSample(i)
      const body = generator(profile)
      const wire = wrapAsToolResult(body, `toolu_${tool}_${i}`)
      const b = bytes(wire)
      const t = roughTokenCountEstimation(wire, ratio)
      byteSamples.push(b)
      tokenSamples.push(t)
      toolTotalTokens += t
    }

    byteSamples.sort((a, b) => a - b)
    tokenSamples.sort((a, b) => a - b)

    grandTotal += toolTotalTokens

    rows.push({
      tool,
      samples: samplesPerTool,
      bytesMin: byteSamples[0] ?? 0,
      bytesMedian: percentile(byteSamples, 0.5),
      bytesP95: percentile(byteSamples, 0.95),
      bytesMax: byteSamples[byteSamples.length - 1] ?? 0,
      tokensMin: tokenSamples[0] ?? 0,
      tokensMedian: percentile(tokenSamples, 0.5),
      tokensP95: percentile(tokenSamples, 0.95),
      tokensMax: tokenSamples[tokenSamples.length - 1] ?? 0,
      tokensTotal: toolTotalTokens,
    })
  }

  rows.sort((a, b) => b.tokensP95 - a.tokensP95)

  return {
    model,
    bytesPerToken: ratio,
    samplesPerTool,
    rows,
    totalTokens: grandTotal,
  }
}

function formatTable(result: ToolOutputDistResult): string {
  const lines: string[] = []
  lines.push(
    `# Tool output distribution — model=${result.model} (bytes/token=${result.bytesPerToken}) samples/tool=${result.samplesPerTool}`,
  )
  lines.push('')
  const headers = [
    'tool',
    'tok min',
    'tok p50',
    'tok p95',
    'tok max',
    'B p50',
    'B p95',
    'B max',
  ]
  const data = result.rows.map(r => [
    r.tool,
    r.tokensMin.toLocaleString('en-US'),
    r.tokensMedian.toLocaleString('en-US'),
    r.tokensP95.toLocaleString('en-US'),
    r.tokensMax.toLocaleString('en-US'),
    r.bytesMedian.toLocaleString('en-US'),
    r.bytesP95.toLocaleString('en-US'),
    r.bytesMax.toLocaleString('en-US'),
  ])
  data.push([
    'TOTAL tok',
    '',
    '',
    '',
    '',
    '',
    '',
    result.totalTokens.toLocaleString('en-US'),
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  lines.push(fmt(headers))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of data) lines.push(fmt(row))
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  model: string
  samples: number
  asJson: boolean
} {
  let model = 'claude-sonnet-4-5'
  let samples = 50
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
    else if (arg.startsWith('--samples=')) samples = Number(arg.slice('--samples='.length))
  }
  return { model, samples, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureToolOutputDistribution(opts)
  if (opts.asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatTable(result)}\n`)
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
