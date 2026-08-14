/**
 * Simulate a multi-turn session and report how token cost *grows* over time.
 *
 * Every other bench in this directory is per-turn. Real sessions accumulate:
 * the conversation history grows, the cached prefix is re-billed on every
 * cache break, env_info changes (date rollover, cwd change), and delta
 * attachments inject new bytes when memory/agents/MCP/skills change.
 *
 * This bench takes the per-turn building blocks (system prompt, tool
 * schemas, env_info, an average tool_use→tool_result pair, and a small
 * stream of delta attachments) and projects them across N turns to show:
 *
 *   - cumulative input tokens billed (assuming an Anthropic-style 5-min
 *     cache hit ratio for the static prefix)
 *   - the turn at which microCompact would kick in (default: when
 *     accumulated tool_results cross the production threshold)
 *   - the post-microcompact "savings runway" — how long the savings keep
 *     us under the budget before another break is needed
 *
 * Output: per-N-turn row with billed-tokens, plus a summary of when the
 * curve crosses common budget breakpoints (50k, 100k, 200k tokens).
 *
 * Flags:
 *   --turns=1,10,30,50,100   sweep points (default 1,10,30,50,100)
 *   --tool-result-kb=4       avg bytes per tool_result KiB (default 4)
 *   --break-every=20         force a cache break every N turns (default 20)
 *   --model=<name>           tokenizer ratio (default claude-sonnet-4-5)
 *   --json                   machine-readable
 *
 * Read-only. No real API calls.
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
import { measureToolSchemas } from './measure-tool-schemas.ts'
import { computeSimpleEnvInfo, getSystemPrompt } from '../src/constants/prompts.js'
import { loadMemoryPrompt } from '../src/memdir/memdir.js'
import { getAllBaseTools } from '../src/tools.js'
import { getEffectiveContextWindowSize } from '../src/services/compact/autoCompact.js'
import { buildClipStub } from '../src/services/compact/stableStubState.js'

/** 5-minute cache hit ratio used for billing math (Anthropic public pricing). */
const CACHE_5M_DISCOUNT = 0.1

/**
 * Mirror `microCompact.ts:188` — the production microcompact threshold is
 * `0.5 × effective context window` in tokens, not a fixed byte size. An
 * earlier version of this bench hard-coded 50 KB which fired far too
 * early on long-context models. Sourced live so model swaps update it.
 */
const MICROCOMPACT_FRACTION = 0.5

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

export type DriftRow = {
  turns: number
  /** Tokens of static prefix (cached across turns) */
  prefixTokens: number
  /** Tokens of conversation history accumulated so far (tool_use + tool_result pairs) */
  historyTokens: number
  /** Tokens of delta attachments injected this turn */
  deltaTokens: number
  /** Total billed tokens up to and including this turn (with cache discount applied) */
  billedTotal: number
  /** Number of cache breaks that have occurred up to this turn */
  cacheBreaks: number
}

export type DriftResult = {
  model: string
  bytesPerToken: number
  toolResultKB: number
  breakEvery: number
  rows: DriftRow[]
  /** Turns at which billed-cumulative crosses common budget thresholds */
  budgetCrossings: { threshold: number; turnsToReach: number | null }[]
}

export async function measureCumulativeDrift(options: {
  turns?: readonly number[]
  toolResultKB?: number
  breakEvery?: number
  model?: string
} = {}): Promise<DriftResult> {
  const sweepTurns = options.turns ?? [1, 10, 30, 50, 100]
  const toolResultKB = options.toolResultKB ?? 4
  const breakEvery = options.breakEvery ?? 20
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  // Build the static prefix once
  const tools = getAllBaseTools()
  const [systemBlocks, memory, envInfo] = await Promise.all([
    getSystemPrompt(tools, model),
    loadMemoryPrompt(),
    computeSimpleEnvInfo(model),
  ])
  const systemText = [systemBlocks.join('\n\n'), memory ?? '', envInfo].join('\n\n')
  const systemBytes = bytes(systemText)
  const toolSchemasBytes =
    (await measureToolSchemas({ engines: ['anthropic'] })).totalsByEngine.get(
      'anthropic',
    )?.schemaBytes ?? 0

  const prefixBytes = systemBytes + toolSchemasBytes
  const prefixTokens = Math.round(prefixBytes / ratio)

  // Per-turn primitives
  const toolPairBytes = toolResultKB * 1024 + 200 /* tool_use envelope */
  const toolPairTokens = Math.round(toolPairBytes / ratio)

  // Production microcompact threshold (live).
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const microcompactThresholdTokens = Math.round(
    MICROCOMPACT_FRACTION * effectiveWindow,
  )

  // Production stub size: real `buildClipStub` for a typical tool name and
  // a representative original-token count. Sample once — the format is
  // stable across calls.
  const stubBytesProduction = Buffer.byteLength(
    buildClipStub('Bash', toolPairTokens),
    'utf8',
  )

  // Delta attachments injected on the first turn (initial announcement) plus
  // a smaller drip on every subsequent turn (typical: nothing, occasionally
  // a git_status_delta / claude_md_delta).
  const initialDeltaBytes = 4500 // claude_md_delta + agents/skills listing
  const recurringDeltaBytes = 200 // small status nudge

  // Walk turn-by-turn so we can report cumulative billed tokens at each
  // sweep point. Maintain a separate "max turns" loop to avoid quadratic
  // re-walks.
  const maxTurns = Math.max(...sweepTurns, 1)
  let cumBilled = 0
  let cumHistoryTokens = 0
  let cacheBreaks = 0
  const perTurnSnapshot = new Map<number, DriftRow>()

  for (let t = 1; t <= maxTurns; t++) {
    const isFirstTurn = t === 1
    const isCacheBreakTurn = t > 1 && t % breakEvery === 1
    if (isCacheBreakTurn) cacheBreaks++

    // Prefix billing: full price on turn 1 and on cache breaks; discounted
    // otherwise.
    const prefixBilledThisTurn = isFirstTurn || isCacheBreakTurn
      ? prefixTokens
      : Math.round(prefixTokens * CACHE_5M_DISCOUNT)

    // Conversation history grows linearly until microcompact would clip
    // it. Production threshold (microCompact.ts:188): MICROCOMPACT_FRACTION
    // × effective context window in TOKENS, not a fixed byte size. Stub
    // size mirrors `buildClipStub` (`[clipped: ~N tokens from <Tool>]`,
    // ~40-50 bytes).
    cumHistoryTokens += toolPairTokens

    if (cumHistoryTokens > microcompactThresholdTokens) {
      const stubBytesPerTurn = stubBytesProduction
      const keepRecent = 2
      const stubbedTurns = Math.max(0, t - keepRecent)
      cumHistoryTokens =
        Math.round((stubBytesPerTurn * stubbedTurns) / ratio) +
        keepRecent * toolPairTokens
    }

    const deltaBytes = isFirstTurn ? initialDeltaBytes : recurringDeltaBytes
    const deltaTokens = roughTokenCountEstimation(bodyOfSize(deltaBytes), ratio)

    const billedThisTurn =
      prefixBilledThisTurn + toolPairTokens /* this turn's new pair */ + deltaTokens
    cumBilled += billedThisTurn

    if (sweepTurns.includes(t)) {
      perTurnSnapshot.set(t, {
        turns: t,
        prefixTokens,
        historyTokens: cumHistoryTokens,
        deltaTokens,
        billedTotal: cumBilled,
        cacheBreaks,
      })
    }
  }

  const rows: DriftRow[] = sweepTurns
    .map(t => perTurnSnapshot.get(t))
    .filter((r): r is DriftRow => r !== undefined)
    .sort((a, b) => a.turns - b.turns)

  // Budget crossings
  const thresholds = [50_000, 100_000, 200_000]
  const budgetCrossings = thresholds.map(threshold => {
    let turnsToReach: number | null = null
    let cum = 0
    for (let t = 1; t <= maxTurns; t++) {
      // Replay the inner loop briefly just for the threshold sweep — cheap.
      const isFirstTurn = t === 1
      const isCacheBreakTurn = t > 1 && t % breakEvery === 1
      const prefixBilledThisTurn = isFirstTurn || isCacheBreakTurn
        ? prefixTokens
        : Math.round(prefixTokens * CACHE_5M_DISCOUNT)
      const deltaTokens = isFirstTurn
        ? roughTokenCountEstimation(bodyOfSize(initialDeltaBytes), ratio)
        : roughTokenCountEstimation(bodyOfSize(recurringDeltaBytes), ratio)
      cum += prefixBilledThisTurn + toolPairTokens + deltaTokens
      if (cum >= threshold) {
        turnsToReach = t
        break
      }
    }
    return { threshold, turnsToReach }
  })

  return {
    model,
    bytesPerToken: ratio,
    toolResultKB,
    breakEvery,
    rows,
    budgetCrossings,
  }
}

function formatTable(result: DriftResult): string {
  const lines: string[] = []
  lines.push(
    `# Cumulative drift — model=${result.model} (bytes/token=${result.bytesPerToken}) tool-result=${result.toolResultKB}KB break-every=${result.breakEvery}`,
  )
  lines.push('')
  const headers = ['turns', 'prefix tok', 'history tok', 'delta tok', 'billed cum', 'breaks']
  const data = result.rows.map(r => [
    String(r.turns),
    r.prefixTokens.toLocaleString('en-US'),
    r.historyTokens.toLocaleString('en-US'),
    r.deltaTokens.toLocaleString('en-US'),
    r.billedTotal.toLocaleString('en-US'),
    String(r.cacheBreaks),
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
  lines.push('# Budget crossings (turns to reach)')
  for (const c of result.budgetCrossings) {
    lines.push(
      `  ${c.threshold.toLocaleString('en-US')} tokens → ${
        c.turnsToReach === null ? 'not reached' : `turn ${c.turnsToReach}`
      }`,
    )
  }
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  turns: readonly number[]
  toolResultKB: number
  breakEvery: number
  model: string
  asJson: boolean
} {
  let turns: number[] = [1, 10, 30, 50, 100]
  let toolResultKB = 4
  let breakEvery = 20
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
    } else if (arg.startsWith('--tool-result-kb='))
      toolResultKB = Number(arg.slice('--tool-result-kb='.length))
    else if (arg.startsWith('--break-every='))
      breakEvery = Number(arg.slice('--break-every='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { turns, toolResultKB, breakEvery, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureCumulativeDrift(opts)
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
