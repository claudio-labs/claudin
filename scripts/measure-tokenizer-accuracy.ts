/**
 * Audit `roughTokenCountEstimation` accuracy across content shapes.
 *
 * The production heuristic is `bytes / bytesPerToken` with a single ratio
 * per model family (see `MODEL_TOKENIZER_CONFIGS`). That works well on
 * average but drifts in either direction depending on what's *inside* the
 * payload:
 *
 *   - Pure prose: real tokenizers pack ~4-5 chars/token. The heuristic at
 *     3.5-4 over-estimates by ~10-20%.
 *   - Dense code (JSON, TypeScript): symbols and short identifiers split
 *     into many tokens. Real packing is ~3 chars/token. The heuristic at
 *     3.5-4 *under*-estimates by ~10-30%. UNDER-counting is worse — it
 *     makes autoCompact fire late and risks hitting the context cap.
 *   - Whitespace-heavy / base64 / repetitive: real tokenizers compress
 *     these aggressively. The heuristic over-estimates substantially.
 *
 * Without a real tokenizer (would require a dep like `tiktoken-bpe`), this
 * bench uses a content-type-aware reference estimator that:
 *
 *   - Counts whitespace runs as 1 token max (BPE-like compression).
 *   - Splits identifiers on transitions (camelCase, snake_case, kebab-case).
 *   - Treats every punctuation/symbol as its own token.
 *
 * The reference is documented in `referenceTokenCount` below; it's NOT a
 * replacement for a real tokenizer, but it captures the *direction* and
 * approximate *magnitude* of the drift better than the bytes/N heuristic.
 *
 * Output: per content-type drift = (reference − heuristic) / reference.
 * Negative = heuristic over-counts; positive = heuristic under-counts.
 *
 * Read-only. No network. No deps.
 *
 * Flags:
 *   --model=<name>   tokenizer ratio under audit (default claude-sonnet-4-5)
 *   --json           machine-readable
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
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/services/config/config.js'

type Fixture = {
  name: string
  contentType:
    | 'prose'
    | 'code-typescript'
    | 'code-json'
    | 'whitespace'
    | 'mixed'
    | 'base64'
  body: string
}

const PROSE = `The agent loop drives the model through a series of tool dispatches and streaming SDK message generation. It accumulates usage statistics, handles compaction, manages permission flows, and coordinates sub-agent spawns when the coordinator mode is enabled. Throughout this process, the engine maintains a careful balance between throughput and observability — every turn carries a fixed bootstrap cost before any user message is sent.

Many of the surfaces that consume tokens are invisible from the outside: the system prompt, tool schemas, environment metadata, and a memory block that varies per project. When something invalidates the prompt cache, that bootstrap cost is paid in full again, even though nothing the user did appears to have changed.`

const TYPESCRIPT = `import type { Tool, ToolUseContext } from 'src/Tool.js'
import { z } from 'zod/v4'

export const fileReadInputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
})

export type FileReadInput = z.infer<typeof fileReadInputSchema>

export const FileReadTool: Tool<FileReadInput> = {
  name: 'Read',
  description: 'Read a file from the local filesystem.',
  inputSchema: fileReadInputSchema,
  async *execute(input: FileReadInput, ctx: ToolUseContext) {
    const handle = await openHandle(input.file_path)
    try {
      yield { type: 'progress', text: 'reading...' }
      const buffer = await handle.readFile({ encoding: 'utf-8' })
      const lines = buffer.split(/\\r?\\n/)
      const sliced = sliceWithBounds(lines, input.offset ?? 0, input.limit ?? 2000)
      return { type: 'result', text: sliced.join('\\n') }
    } finally {
      await handle.close()
    }
  },
}`

const JSON_DENSE = JSON.stringify(
  {
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `tool_${i}`,
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path' },
          offset: { type: 'number', minimum: 0 },
          limit: { type: 'number', minimum: 1, maximum: 2000 },
          flags: {
            type: 'array',
            items: { type: 'string', enum: ['recursive', 'follow_symlinks'] },
          },
        },
        required: ['file_path'],
      },
    })),
  },
  null,
  2,
)

const WHITESPACE = '   '.repeat(500) + '\n'.repeat(200) + '   \t'.repeat(200)

const BASE64 = Array.from({ length: 50 }, () =>
  Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(8))
    .toString('base64'),
).join('\n')

const MIXED = [
  PROSE,
  '```typescript',
  TYPESCRIPT,
  '```',
  '',
  '```json',
  JSON_DENSE.slice(0, 400),
  '```',
].join('\n\n')

const FIXTURES: Fixture[] = [
  { name: 'prose', contentType: 'prose', body: PROSE },
  { name: 'code-typescript', contentType: 'code-typescript', body: TYPESCRIPT },
  { name: 'code-json', contentType: 'code-json', body: JSON_DENSE },
  { name: 'whitespace', contentType: 'whitespace', body: WHITESPACE },
  { name: 'mixed', contentType: 'mixed', body: MIXED },
  { name: 'base64', contentType: 'base64', body: BASE64 },
]

/**
 * Reference token estimator. **NOT a real tokenizer**. It's a regex-based
 * approximation, not ground truth — calibrated to match the qualitative
 * direction of BPE/SentencePiece behavior for prose and code, but
 * **degenerate on whitespace-only or pathologically repetitive input**
 * (where it returns 1 token regardless of input size). Treat magnitude
 * claims downstream as directional, not absolute.
 *
 * To get a real number, vendor `@anthropic-ai/tokenizer` or call
 * `messages.countTokens` from the Anthropic SDK and replace this function.
 *
 * Heuristics:
 *   - Whitespace runs collapse to 1 token.
 *   - Identifiers split on camelCase/snake_case transitions.
 *   - Punctuation and most symbols are individual tokens.
 *   - Long words split every ~4 chars.
 */
function referenceTokenCount(s: string): number {
  // Split into rough tokens: identifiers, numbers, single non-alpha chars,
  // and whitespace runs.
  const tokens: string[] = []
  const re = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|\s+|[^\w\s]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const piece = m[0]
    if (/^\s+$/.test(piece)) {
      tokens.push(' ') // whitespace run = 1 token regardless of size
    } else if (piece.length > 6) {
      // Long words — BPE typically splits ~every 4-5 chars.
      tokens.push(...Array(Math.ceil(piece.length / 4)).fill('x'))
    } else {
      tokens.push(piece)
    }
  }
  return tokens.length
}

export type AccuracyRow = {
  fixture: string
  contentType: string
  bytes: number
  heuristicTokens: number
  referenceTokens: number
  /** (reference − heuristic) / reference. + means heuristic under-counts. */
  driftPct: number
  /** Whether the fixture is degenerate for the reference estimator
   *  (returns ~1 token for any input, so percentages are meaningless). */
  isDegenerateForReference: boolean
}

export type TokenizerAccuracyResult = {
  model: string
  bytesPerToken: number
  rows: AccuracyRow[]
  /** Mean absolute drift across **non-degenerate** fixtures only. The
   *  whitespace fixture is excluded because its reference count of 1
   *  produces nonsense percentages. */
  meanAbsDriftPct: number
  /** Note about the reference estimator's limits. */
  caveat: string
}

export async function measureTokenizerAccuracy(options: {
  model?: string
} = {}): Promise<TokenizerAccuracyResult> {
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const rows: AccuracyRow[] = []
  let absDriftSum = 0
  let nonDegenerateCount = 0

  for (const fixture of FIXTURES) {
    const heuristic = roughTokenCountEstimation(fixture.body, ratio)
    const reference = referenceTokenCount(fixture.body)
    const driftPct = reference === 0 ? 0 : ((reference - heuristic) / reference) * 100
    // The reference estimator collapses pure whitespace runs to 1 token —
    // that's BPE-correct in spirit, but it makes a percentage drift
    // (where reference = 1) explode by orders of magnitude. Mark such
    // fixtures so the aggregate doesn't misleadingly include them.
    const isDegenerateForReference = reference < 5

    rows.push({
      fixture: fixture.name,
      contentType: fixture.contentType,
      bytes: Buffer.byteLength(fixture.body, 'utf8'),
      heuristicTokens: heuristic,
      referenceTokens: reference,
      driftPct: Math.round(driftPct * 10) / 10,
      isDegenerateForReference,
    })

    if (!isDegenerateForReference) {
      absDriftSum += Math.abs(driftPct)
      nonDegenerateCount++
    }
  }

  rows.sort((a, b) => b.driftPct - a.driftPct)

  return {
    model,
    bytesPerToken: ratio,
    rows,
    meanAbsDriftPct:
      nonDegenerateCount === 0
        ? 0
        : Math.round((absDriftSum / nonDegenerateCount) * 10) / 10,
    caveat:
      'Reference estimator is a regex heuristic, not a real tokenizer. ' +
      'Magnitude claims are directional only; vendor @anthropic-ai/tokenizer ' +
      'or use SDK messages.countTokens for ground truth. Degenerate fixtures ' +
      '(reference < 5) are excluded from meanAbsDriftPct.',
  }
}

function formatTable(result: TokenizerAccuracyResult): string {
  const lines: string[] = []
  lines.push(
    `# Tokenizer accuracy — model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push('')
  const headers = ['fixture', 'type', 'bytes', 'heuristic', 'reference', 'drift %']
  const data = result.rows.map(r => [
    r.fixture,
    r.contentType,
    r.bytes.toLocaleString('en-US'),
    r.heuristicTokens.toLocaleString('en-US'),
    r.referenceTokens.toLocaleString('en-US'),
    r.isDegenerateForReference
      ? `${r.driftPct.toFixed(1)}% (degenerate)`
      : `${r.driftPct.toFixed(1)}%`,
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  lines.push(fmt(headers))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of data) lines.push(fmt(row))
  lines.push('')
  lines.push(
    `Mean |drift| (non-degenerate fixtures): ${result.meanAbsDriftPct.toFixed(1)}%`,
  )
  lines.push(`Legend: + = heuristic under-counts → autoCompact fires late.`)
  lines.push(`Caveat: ${result.caveat}`)
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): { model: string; asJson: boolean } {
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureTokenizerAccuracy(opts)
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
