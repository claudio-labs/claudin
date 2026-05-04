/**
 * Measure how many tokens microCompact / stable-stub compression saves on a
 * realistic multi-turn session.
 *
 * `src/services/api/stableStub.benchmark.test.ts` already measures wire
 * BYTES per engine, but it never converts those to tokens (which is what
 * users pay for) and it doesn't sweep across session sizes. This script
 * fills that gap:
 *
 *   - Build a synthetic N-turn session of assistant tool_use → user
 *     tool_result pairs (same shape as the in-tree benchmark fixture).
 *   - For each N, measure tokens of the messages array:
 *       (a) baseline: nothing clipped
 *       (b) compressed: all but the most recent K compactable ids clipped,
 *           routed through `applyStableStubs` (the production rewrite).
 *   - Report tokens-saved + percentage.
 *
 * Flags:
 *   --turns=10,30,60       comma-separated session sizes (default 10,30,60)
 *   --kb=4                 avg tool_result size in KiB (default 4)
 *   --keep-recent=2        most-recent compactable ids kept un-clipped (default 2)
 *   --model=<name>         tokenizer ratio (default claude-sonnet-4-5)
 *   --json                 machine-readable
 *
 * Read-only. No network. No side effects beyond the per-session
 * `clippedIds` Set, which is reset between profile runs.
 */

if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '99.0.0',
      DISPLAY_VERSION: '0.0.0-measure',
      BUILD_TIME: new Date().toISOString(),
      ISSUES_EXPLAINER:
        'report the issue at https://github.com/anthropics/claude-code/issues',
      PACKAGE_URL: '@claudiolabs/claudio',
    },
  })
}

import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} from '../src/services/compact/stableStubState.js'
import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/utils/config.js'

type AnyMsg = {
  type?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  role?: string
}

const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Glob']

function buildSyntheticSession(opts: {
  turns: number
  avgToolResultKB: number
}): { wrapped: AnyMsg[]; toolUseIds: string[] } {
  const wrapped: AnyMsg[] = []
  const toolUseIds: string[] = []
  const blob = 'lorem ipsum dolor sit amet '.repeat(
    Math.ceil((opts.avgToolResultKB * 1024) / 27),
  )

  for (let i = 0; i < opts.turns; i++) {
    const toolUseId = `toolu_${i.toString().padStart(4, '0')}`
    const toolName = TOOL_NAMES[i % TOOL_NAMES.length]!
    toolUseIds.push(toolUseId)

    wrapped.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Calling ${toolName} (turn ${i})` },
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: { path: `/tmp/file_${i}.txt` },
          },
        ],
      },
    })

    wrapped.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `${blob}\n---turn ${i}---`,
          },
        ],
      },
    })
  }

  // Final user question
  wrapped.push({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'What did you find overall?' }],
    },
  })

  return { wrapped, toolUseIds }
}

function messagesToWire(messages: AnyMsg[]): string {
  return JSON.stringify(messages)
}

export type MicrocompactRow = {
  turns: number
  baselineBytes: number
  compressedBytes: number
  baselineTokens: number
  compressedTokens: number
  bytesSaved: number
  tokensSaved: number
  tokensPctSaved: number
  clippedCount: number
}

export type MicrocompactResult = {
  model: string
  bytesPerToken: number
  avgToolResultKB: number
  keepRecent: number
  rows: MicrocompactRow[]
}

export async function measureMicrocompactSavings(options: {
  turns?: readonly number[]
  avgToolResultKB?: number
  keepRecent?: number
  model?: string
} = {}): Promise<MicrocompactResult> {
  const turns = options.turns ?? [10, 30, 60]
  const avgToolResultKB = options.avgToolResultKB ?? 4
  const keepRecent = options.keepRecent ?? 2
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const rows: MicrocompactRow[] = []

  for (const N of turns) {
    _resetAllClippedIdsForTesting()
    const { wrapped, toolUseIds } = buildSyntheticSession({
      turns: N,
      avgToolResultKB,
    })

    const baselineWire = messagesToWire(wrapped)
    const baselineBytes = Buffer.byteLength(baselineWire, 'utf8')
    const baselineTokens = roughTokenCountEstimation(baselineWire, ratio)

    // Clip everything except the most recent `keepRecent` ids — same policy
    // microcompactMessages applies once the size threshold is breached.
    const clipCount = Math.max(0, toolUseIds.length - keepRecent)
    if (clipCount > 0) {
      addClippedIds(toolUseIds.slice(0, clipCount))
    }

    const compressed = applyStableStubs(wrapped) as AnyMsg[]
    const compressedWire = messagesToWire(compressed)
    const compressedBytes = Buffer.byteLength(compressedWire, 'utf8')
    const compressedTokens = roughTokenCountEstimation(compressedWire, ratio)

    rows.push({
      turns: N,
      baselineBytes,
      compressedBytes,
      baselineTokens,
      compressedTokens,
      bytesSaved: baselineBytes - compressedBytes,
      tokensSaved: baselineTokens - compressedTokens,
      tokensPctSaved:
        baselineTokens === 0
          ? 0
          : Math.round(((baselineTokens - compressedTokens) / baselineTokens) * 1000) / 10,
      clippedCount: clipCount,
    })
  }

  _resetAllClippedIdsForTesting()
  return { model, bytesPerToken: ratio, avgToolResultKB, keepRecent, rows }
}

function formatTable(result: MicrocompactResult): string {
  const lines: string[] = []
  lines.push(
    `# microCompact savings — model=${result.model} (bytes/token=${result.bytesPerToken}) avg-tool-result=${result.avgToolResultKB}KB keep-recent=${result.keepRecent}`,
  )
  lines.push('')
  const headers = [
    'turns',
    'baseline (tokens)',
    'compressed (tokens)',
    'tokens saved',
    '% saved',
    'clipped',
  ]
  const data = result.rows.map(r => [
    String(r.turns),
    r.baselineTokens.toLocaleString('en-US'),
    r.compressedTokens.toLocaleString('en-US'),
    r.tokensSaved.toLocaleString('en-US'),
    `${r.tokensPctSaved.toFixed(1)}%`,
    String(r.clippedCount),
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
  turns: readonly number[]
  avgToolResultKB: number
  keepRecent: number
  model: string
  asJson: boolean
} {
  let turns: number[] = [10, 30, 60]
  let avgToolResultKB = 4
  let keepRecent = 2
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--turns=')) {
      turns = arg
        .slice('--turns='.length)
        .split(',')
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0)
    } else if (arg.startsWith('--kb=')) avgToolResultKB = Number(arg.slice('--kb='.length))
    else if (arg.startsWith('--keep-recent='))
      keepRecent = Number(arg.slice('--keep-recent='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { turns, avgToolResultKB, keepRecent, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureMicrocompactSavings(opts)
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
