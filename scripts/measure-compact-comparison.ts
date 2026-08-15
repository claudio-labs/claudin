/**
 * Compare token economics: full `/compact` vs `microCompact` vs no-op.
 *
 * `measure-microcompact-savings.ts` already covers the stable-stub path
 * (`applyStableStubs`) — that's the *automatic* compactor that fires when
 * accumulated tool_results cross a threshold. The user-triggered `/compact`
 * is different: it replaces the entire history with a generated summary
 * and a follow-up "continue" user message. Its economics:
 *
 *   - One-shot cost: a model call to *generate* the summary, billed at
 *     full rates (input = full history, output = summary).
 *   - Recurring savings: every subsequent turn pays only for the summary
 *     instead of the full history.
 *
 * MicroCompact has no upfront cost (it's deterministic), but its savings
 * are smaller because it preserves the message structure — it just clips
 * fat tool_result bodies to stable stubs.
 *
 * This bench builds a synthetic N-turn session, then for each compaction
 * strategy reports:
 *
 *   - history tokens before
 *   - history tokens after
 *   - upfront cost (compact only)
 *   - break-even turn (when accumulated savings overtake the upfront cost)
 *
 * Read-only. No model calls. The "summary" is approximated as a fixed
 * fraction of the original history bytes — a known calibration constant
 * derived from production /compact outputs (see SUMMARY_RATIO).
 *
 * Flags:
 *   --turns=30,60,120        sweep points (default 30,60,120)
 *   --kb=4                   avg tool_result KiB (default 4)
 *   --keep-recent=2          microCompact keep-recent (default 2)
 *   --model=<name>           tokenizer ratio (default claude-sonnet-4-5)
 *   --json                   machine-readable
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
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} from '../src/agent/compact/stableStubState.js'
import { getCompactPrompt } from '../src/agent/compact/prompt.js'
import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/shared/tokenEstimation.js'
import { enableConfigs } from '../src/platform/config/config.js'

/**
 * Calibration: there is NO upper bound enforced by `getCompactPrompt()` —
 * the summary length is purely model-discretion. The "8-12% of original
 * history" rule of thumb has no code anchor in this repo. We default to
 * 10% but sweep across 5/10/15/20% so users can see how sensitive the
 * conclusion is to the assumption.
 */
const DEFAULT_SUMMARY_RATIOS = [0.05, 0.1, 0.15, 0.2] as const

type AnyMsg = {
  type?: string
  message?: { role?: string; content?: unknown }
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
    const id = `toolu_${i.toString().padStart(4, '0')}`
    const name = TOOL_NAMES[i % TOOL_NAMES.length]!
    toolUseIds.push(id)

    wrapped.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Calling ${name} (turn ${i})` },
          { type: 'tool_use', id, name, input: { path: `/tmp/file_${i}.txt` } },
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
            tool_use_id: id,
            content: `${blob}\n---turn ${i}---`,
          },
        ],
      },
    })
  }

  wrapped.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
  })

  return { wrapped, toolUseIds }
}

export type CompactComparisonRow = {
  turns: number
  summaryRatio: number
  baselineTokens: number
  microcompactTokens: number
  microcompactSavingsTokens: number
  fullCompactTokens: number
  fullCompactSavingsTokens: number
  /** Upfront cost of /compact: input billed for the summary call. */
  fullCompactUpfrontTokens: number
  /** Turns to break even on the upfront cost (savings/turn × N ≥ upfront) */
  breakEvenTurnsForCompact: number | null
}

export type CompactComparisonResult = {
  model: string
  bytesPerToken: number
  avgToolResultKB: number
  keepRecent: number
  summaryRatios: readonly number[]
  rows: CompactComparisonRow[]
}

function tokensOf(messages: AnyMsg[], ratio: number): number {
  return roughTokenCountEstimation(JSON.stringify(messages), ratio)
}

export async function measureCompactComparison(options: {
  turns?: readonly number[]
  avgToolResultKB?: number
  keepRecent?: number
  summaryRatios?: readonly number[]
  model?: string
} = {}): Promise<CompactComparisonResult> {
  const sweep = options.turns ?? [30, 60, 120]
  const avgToolResultKB = options.avgToolResultKB ?? 4
  const keepRecent = options.keepRecent ?? 2
  const summaryRatios = options.summaryRatios ?? DEFAULT_SUMMARY_RATIOS
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  const compactPromptOverheadTokens = roughTokenCountEstimation(
    getCompactPrompt(),
    ratio,
  )

  const rows: CompactComparisonRow[] = []

  for (const N of sweep) {
    const { wrapped, toolUseIds } = buildSyntheticSession({
      turns: N,
      avgToolResultKB,
    })
    const baselineTokens = tokensOf(wrapped, ratio)

    // microCompact path is independent of summaryRatio.
    _resetAllClippedIdsForTesting()
    const clipCount = Math.max(0, toolUseIds.length - keepRecent)
    if (clipCount > 0) addClippedIds(toolUseIds.slice(0, clipCount))
    const compressed = applyStableStubs(wrapped) as AnyMsg[]
    const microTokens = tokensOf(compressed, ratio)
    _resetAllClippedIdsForTesting()
    const microSavings = baselineTokens - microTokens

    for (const summaryRatio of summaryRatios) {
      const summaryTokens = Math.round(baselineTokens * summaryRatio)
      const fullCompactUpfront =
        baselineTokens +
        compactPromptOverheadTokens +
        summaryTokens
      const fullCompactTokens = summaryTokens
      const fullSavings = baselineTokens - fullCompactTokens
      const breakEvenTurnsForCompact =
        fullSavings > 0 ? Math.ceil(fullCompactUpfront / fullSavings) : null

      rows.push({
        turns: N,
        summaryRatio,
        baselineTokens,
        microcompactTokens: microTokens,
        microcompactSavingsTokens: microSavings,
        fullCompactTokens,
        fullCompactSavingsTokens: fullSavings,
        fullCompactUpfrontTokens: fullCompactUpfront,
        breakEvenTurnsForCompact,
      })
    }
  }

  return {
    model,
    bytesPerToken: ratio,
    avgToolResultKB,
    keepRecent,
    summaryRatios,
    rows,
  }
}

function formatTable(result: CompactComparisonResult): string {
  const lines: string[] = []
  lines.push(
    `# Compact comparison — model=${result.model} (bytes/token=${result.bytesPerToken}) avg-tool-result=${result.avgToolResultKB}KB keep-recent=${result.keepRecent}`,
  )
  lines.push(
    `# summaryRatio swept: ${result.summaryRatios.map(r => `${(r * 100).toFixed(0)}%`).join(', ')} (no code anchor — model-discretion)`,
  )
  lines.push('')
  const headers = [
    'turns',
    'sum%',
    'baseline',
    'micro',
    '/compact',
    '/compact saved',
    'upfront',
    'break-even',
  ]
  const data = result.rows.map(r => [
    String(r.turns),
    `${(r.summaryRatio * 100).toFixed(0)}%`,
    r.baselineTokens.toLocaleString('en-US'),
    r.microcompactTokens.toLocaleString('en-US'),
    r.fullCompactTokens.toLocaleString('en-US'),
    r.fullCompactSavingsTokens.toLocaleString('en-US'),
    r.fullCompactUpfrontTokens.toLocaleString('en-US'),
    r.breakEvenTurnsForCompact === null ? '—' : `${r.breakEvenTurnsForCompact}`,
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
  summaryRatios: readonly number[]
  model: string
  asJson: boolean
} {
  let turns: number[] = [30, 60, 120]
  let avgToolResultKB = 4
  let keepRecent = 2
  let summaryRatios: number[] = [...DEFAULT_SUMMARY_RATIOS]
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
    else if (arg.startsWith('--summary-ratios=')) {
      summaryRatios = arg
        .slice('--summary-ratios='.length)
        .split(',')
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0 && n < 1)
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { turns, avgToolResultKB, keepRecent, summaryRatios, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureCompactComparison(opts)
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
