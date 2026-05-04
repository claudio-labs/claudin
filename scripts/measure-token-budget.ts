/**
 * Aggregate token-budget measurement for the *bootstrap* of every conversation.
 *
 * Every turn carries a fixed cost before any user message is sent:
 *
 *   - tool schemas (per engine — Anthropic / OpenAI / Codex shapes differ)
 *   - the system prompt (varies per active model family because the
 *     bytes-per-token ratio drifts: Claude 3.5 vs GPT-4 4.0 vs Gemini 4.0)
 *   - the memory block (`MEMORY.md` index + scoped notes)
 *   - the env-info block (CWD, git status, OS, model marketing name)
 *
 * `measure-tool-schemas.ts` already measures the tool bundle; this script
 * rolls that up plus the prompt/memory/env sections so the *total* baseline
 * is visible. Use this to validate token-saving changes (slim a prompt
 * section, drop a tool, defer an attachment) end-to-end rather than only
 * staring at a tool table.
 *
 * Output: a per-model table breaking down each section's bytes + estimated
 * tokens, plus a total. JSON via --json for diffing.
 *
 * Flags:
 *   --models=claude,gpt-4,gemini,...     (default: claude,gpt-4,gemini,deepseek,mistral)
 *   --engine=anthropic|openai|codex      (default: anthropic — used for tool schemas)
 *   --json                               machine-readable output
 *
 * Read-only. No network. No side effects beyond enabling configs (matches
 * `measure-tool-schemas.ts`).
 */

import { getAllBaseTools } from '../src/tools.js'
import { getSystemPrompt, computeSimpleEnvInfo } from '../src/constants/prompts.js'
import { loadMemoryPrompt } from '../src/memdir/memdir.js'
import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/utils/config.js'
import { measureToolSchemas } from './measure-tool-schemas.ts'

// Polyfill MACRO globals normally injected by `scripts/build.ts` via `define`.
// `getSystemPrompt()` references `MACRO.ISSUES_EXPLAINER` and crashes
// otherwise. Idempotent — only assigns when undefined.
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

type Engine = 'anthropic' | 'openai' | 'codex'

export type SectionRow = {
  section: 'tool_schemas' | 'system_prompt' | 'memory' | 'env_info'
  bytes: number
  tokens: number
}

export type ModelBudget = {
  model: string
  bytesPerToken: number
  rows: SectionRow[]
  totalBytes: number
  totalTokens: number
}

export type BudgetResult = {
  engine: Engine
  perModel: ModelBudget[]
}

const DEFAULT_MODELS = [
  'claude-sonnet-4-5',
  'gpt-4o-2024-08-06',
  'gemini-2.5-flash',
  'deepseek-chat',
  'mistral-large-2411',
]

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function tokensFor(s: string, model: string): number {
  return roughTokenCountEstimation(s, getBytesPerTokenForModel(model))
}

export async function measureTokenBudget(options: {
  engine?: Engine
  models?: readonly string[]
} = {}): Promise<BudgetResult> {
  const engine: Engine = options.engine ?? 'anthropic'
  const models = options.models ?? DEFAULT_MODELS

  try {
    enableConfigs()
  } catch {
    // best-effort — measurement still proceeds.
  }

  // Tool schemas: measured ONCE per engine; bytes don't depend on the
  // active model (the wire payload is identical), but token counts do.
  const toolMeasurement = await measureToolSchemas({ engines: [engine] })
  const toolSchemaBytes =
    toolMeasurement.totalsByEngine.get(engine)?.schemaBytes ?? 0

  // Reconstruct a single concatenated tool-bundle string is not available;
  // we already have the byte total. Token count = bytes / ratio.
  const tools = getAllBaseTools()

  const perModel: ModelBudget[] = []
  for (const model of models) {
    const ratio = getBytesPerTokenForModel(model)

    const [systemPromptBlocks, memory, envInfo] = await Promise.all([
      getSystemPrompt(tools, model),
      loadMemoryPrompt(),
      computeSimpleEnvInfo(model),
    ])
    const systemPrompt = systemPromptBlocks.join('\n\n')
    const memoryStr = memory ?? ''

    const rows: SectionRow[] = [
      {
        section: 'tool_schemas',
        bytes: toolSchemaBytes,
        tokens: Math.round(toolSchemaBytes / ratio),
      },
      {
        section: 'system_prompt',
        bytes: bytes(systemPrompt),
        tokens: tokensFor(systemPrompt, model),
      },
      {
        section: 'memory',
        bytes: bytes(memoryStr),
        tokens: tokensFor(memoryStr, model),
      },
      {
        section: 'env_info',
        bytes: bytes(envInfo),
        tokens: tokensFor(envInfo, model),
      },
    ]

    const totalBytes = rows.reduce((acc, r) => acc + r.bytes, 0)
    const totalTokens = rows.reduce((acc, r) => acc + r.tokens, 0)

    perModel.push({
      model,
      bytesPerToken: ratio,
      rows,
      totalBytes,
      totalTokens,
    })
  }

  return { engine, perModel }
}

function formatTable(result: BudgetResult): string {
  const lines: string[] = []
  lines.push(`# Token budget (engine=${result.engine})`)
  lines.push('')
  for (const m of result.perModel) {
    lines.push(`## ${m.model}  (bytes/token=${m.bytesPerToken})`)
    const headers = ['section', 'bytes', 'tokens (est)']
    const data = m.rows.map(r => [
      r.section,
      r.bytes.toLocaleString('en-US'),
      r.tokens.toLocaleString('en-US'),
    ])
    data.push([
      'TOTAL',
      m.totalBytes.toLocaleString('en-US'),
      m.totalTokens.toLocaleString('en-US'),
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
  }
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  engine: Engine
  models: readonly string[]
  asJson: boolean
} {
  let engine: Engine = 'anthropic'
  let models = DEFAULT_MODELS
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--engine=')) {
      const v = arg.slice('--engine='.length)
      if (v === 'anthropic' || v === 'openai' || v === 'codex') engine = v
      else throw new Error(`unknown engine: ${v}`)
    } else if (arg.startsWith('--models=')) {
      models = arg.slice('--models='.length).split(',').filter(Boolean)
    }
  }
  return { engine, models, asJson }
}

async function main(): Promise<void> {
  const { engine, models, asJson } = parseArgs(process.argv.slice(2))
  const result = await measureTokenBudget({ engine, models })
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return
  }
  process.stdout.write(formatTable(result) + '\n')
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
