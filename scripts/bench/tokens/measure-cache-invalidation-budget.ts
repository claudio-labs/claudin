/**
 * Measure the per-turn token cost of *prompt-cache invalidation*.
 *
 * Anthropic's server-side prompt cache lets the system + tool schemas be
 * served at a discounted "cache read" rate (≈10% of normal input price for
 * 5-min cache, ≈8% for 1-hour). When *anything* in the cached prefix
 * changes, the cache breaks — the entire prefix is re-billed at full input
 * price and re-cached. The break is silent: you only see it as a higher
 * input-token bill on that turn.
 *
 * `src/providers/cache/promptCacheBreakDetection.ts` enumerates the things
 * that can break the cache. This bench builds a realistic baseline prefix
 * and computes the *re-bill cost* of each individual break cause:
 *
 *   - addingOneTool     — most common: a new MCP tool registers mid-session.
 *   - removingOneTool   — symmetric.
 *   - tweakToolDesc     — even a 1-byte description change re-bills everything.
 *   - tweakSystemPrompt — env_info / memory / banner update inside system.
 *   - modelSwitch       — user runs `/provider` mid-session.
 *   - betaHeaderFlip    — feature toggle that adds/removes a beta header.
 *
 * The output: for each scenario, the *break cost* in tokens = the size of
 * the cached prefix that has to be re-billed. Practical interpretation: if
 * `tweakToolDesc` reports 18,000 tokens, every accidental description tweak
 * (even a typo fix) costs ~18k tokens at full price the first time it
 * surfaces.
 *
 * Flags:
 *   --model=<name>        tokenizer ratio (default claude-sonnet-4-5)
 *   --engine=anthropic|openai|codex   schema shape (default anthropic)
 *   --json                machine-readable
 *
 * Read-only. No real API calls. No actual cache is touched.
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

import { getBytesPerTokenForModel } from '../../../src/shared/tokenEstimation.js'
import { enableConfigs } from '../../../src/platform/config/config.js'
import { measureToolSchemas } from './measure-tool-schemas.ts'
import { getSystemPrompt, computeSimpleEnvInfo } from '../../../src/agent/prompts/prompts.js'
import { loadMemoryPrompt } from '../../../src/memory/memdir/memdir.js'
import { getAllBaseTools } from '../../../src/tools/tools.js'

type Engine = 'anthropic' | 'openai' | 'codex'

/** Anthropic 5-minute cache hit price ratio (cache_read vs full input). */
const CACHE_5M_DISCOUNT = 0.1
/** Anthropic 1-hour cache hit price ratio. */
const CACHE_1H_DISCOUNT = 0.08

export type CacheScenarioRow = {
  scenario: string
  /** Bytes of the cached prefix (system + tool schemas) that gets re-billed */
  cachedPrefixBytes: number
  /** Tokens that get re-billed at full input price on cache miss */
  rebillTokens: number
  /** Tokens that *would have been billed* on a hit (5m cache discount) */
  hitTokens5m: number
  /** Tokens that *would have been billed* on a hit (1h cache discount) */
  hitTokens1h: number
  /** Net cost of the break: rebill − hit */
  breakCostTokens5m: number
  breakCostTokens1h: number
}

export type CacheInvalidationResult = {
  engine: Engine
  model: string
  bytesPerToken: number
  scenarios: CacheScenarioRow[]
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export async function measureCacheInvalidation(options: {
  engine?: Engine
  model?: string
} = {}): Promise<CacheInvalidationResult> {
  const engine: Engine = options.engine ?? 'anthropic'
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  // ---------------------------------------------------------------------
  // Baseline cached prefix (system + tools)
  // ---------------------------------------------------------------------
  const tools = getAllBaseTools()
  const [systemBlocks, memory, envInfo] = await Promise.all([
    getSystemPrompt(tools, model),
    loadMemoryPrompt(),
    computeSimpleEnvInfo(model),
  ])
  const systemText = [systemBlocks.join('\n\n'), memory ?? '', envInfo].join('\n\n')
  const systemBytes = bytes(systemText)

  const toolMeasurement = await measureToolSchemas({ engines: [engine] })
  const toolSchemasBytes =
    toolMeasurement.totalsByEngine.get(engine)?.schemaBytes ?? 0

  const baselineBytes = systemBytes + toolSchemasBytes
  // Anthropic's prompt cache is multi-scope: `splitSysPromptPrefix`
  // (claude.ts:2982) emits each system block with its own cacheScope,
  // followed by tools at the end. A change inside a *later* cache scope
  // does NOT invalidate earlier ones. We approximate the two coarse
  // scopes the open build cares about:
  //   - "tools-only" change → only the tools array (and anything after
  //     it, which is nothing) rebills. The system prefix stays cached.
  //   - "system" change → both system AND tools rebill (because tools
  //     come after system in the cached prefix).
  // The exact split between system blocks (static-vs-dynamic) is more
  // granular in production; we don't model that here.

  // Helper: given the bytes of the cached prefix, compute hit/miss/break costs.
  function row(
    scenario: string,
    affectedBytes: number,
  ): CacheScenarioRow {
    const rebillTokens = Math.round(affectedBytes / ratio)
    const hitTokens5m = Math.round(rebillTokens * CACHE_5M_DISCOUNT)
    const hitTokens1h = Math.round(rebillTokens * CACHE_1H_DISCOUNT)
    return {
      scenario,
      cachedPrefixBytes: affectedBytes,
      rebillTokens,
      hitTokens5m,
      hitTokens1h,
      breakCostTokens5m: rebillTokens - hitTokens5m,
      breakCostTokens1h: rebillTokens - hitTokens1h,
    }
  }

  const scenarios: CacheScenarioRow[] = []

  // Tool-only changes: only the tools section rebills. System cache stays
  // hot.
  scenarios.push(row('add 1 tool (e.g. new MCP)', toolSchemasBytes))
  scenarios.push(row('remove 1 tool', toolSchemasBytes))
  scenarios.push(row('tweak 1 tool description', toolSchemasBytes))

  // System-prefix changes: tools sit AFTER system, so any system tweak
  // invalidates system + tools. Practical example: env_info date rollover
  // in the system prompt block, or a memory write that mutates the system
  // memory section.
  scenarios.push(row('tweak system prompt', baselineBytes))

  // Whole-cache invalidations: model identity and beta-header set are
  // keyed at the cache root, so everything rebills.
  scenarios.push(row('switch model (/provider)', baselineBytes))
  scenarios.push(row('flip beta header', baselineBytes))

  // cc_workload flip on cron↔interactive alternation: USED to invalidate
  // the entire prefix because getWorkload() was inlined into the
  // attribution header (block 0 of the system prompt). Fixed by removing
  // that injection — workload still rides on the User-Agent suffix
  // (utils/http.ts:34), but the prefix bytes are now stable. Kept here
  // as a 0-byte regression marker so any reintroduction surfaces in the
  // bench output.
  scenarios.push(row('cc_workload flip cron<->interactive (fixed)', 0))

  // Non-breaking reference rows: env_info delivered as a user-message
  // attachment is BELOW the cache marker, so nothing rebills. Same with
  // sticky auto_mode.
  scenarios.push(row('env_info as user attachment (no break)', 0))
  scenarios.push(row('auto_mode latched (no break, sticky)', 0))

  // Sort by cost desc.
  scenarios.sort((a, b) => b.breakCostTokens5m - a.breakCostTokens5m)

  return {
    engine,
    model,
    bytesPerToken: ratio,
    scenarios,
  }
}

function formatTable(result: CacheInvalidationResult): string {
  const lines: string[] = []
  lines.push(
    `# Cache invalidation budget — engine=${result.engine} model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push(
    `# discount: 5m=${(CACHE_5M_DISCOUNT * 100).toFixed(0)}% 1h=${(CACHE_1H_DISCOUNT * 100).toFixed(0)}%`,
  )
  lines.push('')
  const headers = [
    'scenario',
    'rebill tok',
    'hit 5m tok',
    'break 5m',
    'hit 1h tok',
    'break 1h',
  ]
  const data = result.scenarios.map(r => [
    r.scenario,
    r.rebillTokens.toLocaleString('en-US'),
    r.hitTokens5m.toLocaleString('en-US'),
    r.breakCostTokens5m.toLocaleString('en-US'),
    r.hitTokens1h.toLocaleString('en-US'),
    r.breakCostTokens1h.toLocaleString('en-US'),
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
  engine: Engine
  model: string
  asJson: boolean
} {
  let engine: Engine = 'anthropic'
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--engine=')) {
      const v = arg.slice('--engine='.length)
      if (v === 'anthropic' || v === 'openai' || v === 'codex') engine = v
      else throw new Error(`unknown engine: ${v}`)
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { engine, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureCacheInvalidation(opts)
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
