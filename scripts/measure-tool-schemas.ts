/**
 * Read-only baseline measurement for the tool-schema bundle.
 *
 * For every tool returned by `getAllBaseTools()` this script computes:
 *   - `description` byte length (UTF-8) — Anthropic-shape only (descriptions
 *     don't survive translation 1:1 across engines)
 *   - full serialized schema byte length per engine (`anthropic`, `openai`,
 *     `codex`)
 *   - rough token estimate via the shared `roughTokenCountEstimation`
 *
 * Output: a sorted plaintext table per engine (default — when `--engine=all`)
 * or a single engine table.
 *
 * Flags:
 *   --engine=anthropic|openai|codex|all    (default: all)
 *   --git-mode=on|off                      (default: on)
 *   --json                                 keep legacy JSON output (anthropic only)
 *
 * Used as the baseline gate for the schema-slim work tracked in
 * `~/.claude/plans/enchanted-popping-oasis.md`. No side effects, no network.
 */

import { getAllBaseTools } from '../src/tools.js'
import { toolToAPISchema } from '../src/utils/api.js'
import { roughTokenCountEstimation } from '../src/services/tokenEstimation.js'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import type { Tool } from '../src/Tool.js'
import { enableConfigs } from '../src/utils/config.js'
import { convertTools } from '../src/services/api/openaiShim.js'
import { convertToolsToResponsesTools } from '../src/services/api/codexShim.js'
import { clearToolSchemaCache } from '../src/utils/toolSchemaCache.js'

type Engine = 'anthropic' | 'openai' | 'codex'
const ALL_ENGINES: readonly Engine[] = ['anthropic', 'openai', 'codex'] as const

type Row = {
  name: string
  engine: Engine
  descriptionBytes: number
  schemaBytes: number
  tokens: number
  error?: string
}

type EngineSchema = {
  description: string
  serialized: string
}

async function buildAnthropicSchema(
  tool: Tool,
  allTools: readonly Tool[],
): Promise<EngineSchema> {
  const schema = await toolToAPISchema(tool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [...allTools],
    agents: [],
    allowedAgentTypes: [],
  })

  const description =
    'description' in schema && typeof schema.description === 'string'
      ? schema.description
      : ''
  return { description, serialized: JSON.stringify(schema) }
}

async function buildEngineSchema(
  engine: Engine,
  tool: Tool,
  allTools: readonly Tool[],
): Promise<EngineSchema> {
  // Anthropic shape is the canonical input; OpenAI/Codex shims re-shape it.
  const anthropic = await buildAnthropicSchema(tool, allTools)

  if (engine === 'anthropic') return anthropic

  const anthropicParsed = JSON.parse(anthropic.serialized) as {
    name?: string
    description?: string
    input_schema?: Record<string, unknown>
  }
  const shimInput = [
    {
      name: anthropicParsed.name ?? tool.name,
      description: anthropicParsed.description ?? '',
      input_schema: anthropicParsed.input_schema,
    },
  ]

  if (engine === 'openai') {
    // convertTools filters out ToolSearchTool; preserve a 0-byte row so the
    // table still has a deterministic shape across engines.
    const converted = convertTools(shimInput)
    if (converted.length === 0) {
      return { description: anthropic.description, serialized: '' }
    }
    return {
      description: anthropic.description,
      serialized: JSON.stringify(converted[0]),
    }
  }

  // engine === 'codex'
  const converted = convertToolsToResponsesTools(shimInput)
  if (converted.length === 0) {
    return { description: anthropic.description, serialized: '' }
  }
  return {
    description: anthropic.description,
    serialized: JSON.stringify(converted[0]),
  }
}

async function measureTool(
  engine: Engine,
  tool: Tool,
  allTools: readonly Tool[],
): Promise<Row> {
  try {
    const { description, serialized } = await buildEngineSchema(engine, tool, allTools)
    return {
      name: tool.name,
      engine,
      descriptionBytes: Buffer.byteLength(description, 'utf8'),
      schemaBytes: Buffer.byteLength(serialized, 'utf8'),
      tokens: serialized ? roughTokenCountEstimation(serialized) : 0,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      name: tool.name,
      engine,
      descriptionBytes: 0,
      schemaBytes: 0,
      tokens: 0,
      error: message,
    }
  }
}

export type MeasureOptions = {
  engines?: readonly Engine[]
  /**
   * When 'off', flips CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS on for the duration
   * of measurement so `shouldIncludeGitInstructions()` returns false. Restored
   * after measurement to leave the process env untouched.
   */
  gitMode?: 'on' | 'off'
}

export type MeasureResult = {
  rows: Row[]
  totalsByEngine: Map<Engine, { schemaBytes: number; tokens: number }>
}

export async function measureToolSchemas(
  options: MeasureOptions = {},
): Promise<MeasureResult> {
  const engines = options.engines ?? ALL_ENGINES
  const gitMode = options.gitMode ?? 'on'

  // Several tools (Bash, Read, ...) read GlobalConfig inside their `prompt()`
  // path. Without `enableConfigs()` the read throws "Config accessed before
  // allowed.", which collapses to an `<error: ...>` row. Call it once so we
  // measure the real wire payload.
  try {
    enableConfigs()
  } catch (err) {
    // Already enabled or non-fatal — measurement still proceeds. Logged so a
    // real init failure (corrupt settings, race) doesn't silently distort
    // bytes. Never thrown — this script is one-shot dev tooling.
    console.error(
      `[measure-tool-schemas] enableConfigs() non-fatal: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // `toolToAPISchema` caches the result of `tool.prompt()` by tool name. That
  // cache is desirable in production (avoids re-running prompts each turn) but
  // poisons measurement: the second call with a different `gitMode` would hit
  // the cache and report identical bytes. Clear before every run so each
  // measurement reflects the current env / gitMode.
  clearToolSchemaCache()

  // Some tool prompts read `process.env.NODE_ENV` and short-circuit in tests
  // (e.g. attachments.ts skips skill_listing). When this script is invoked
  // from a test runner, that distorts the wire-size baseline. Pin NODE_ENV to
  // a non-test value during measurement and restore after — never observable
  // outside this function.
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'

  // `getAllBaseTools()` filters by `isTodoV2Enabled()` — lazy, reads env on
  // every call. Force Task v2 on so the bundle matches typical interactive
  // REPL output. Restored in finally so the test runner doesn't leak the
  // override into adjacent suites.
  const TASKS_KEY = 'CLAUDE_CODE_ENABLE_TASKS'
  const previousTasks = process.env[TASKS_KEY]
  process.env[TASKS_KEY] = '1'

  // Toggle `shouldIncludeGitInstructions()` via env. The helper checks
  // `process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` first; setting it to
  // '1' is enough to short-circuit the BashTool git block.
  const ENV_KEY = 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'
  const previousEnv = process.env[ENV_KEY]
  if (gitMode === 'off') {
    process.env[ENV_KEY] = '1'
  }

  try {
    const tools = getAllBaseTools()
    const rows: Row[] = []
    for (const engine of engines) {
      for (const tool of tools) {
        rows.push(await measureTool(engine, tool, tools))
      }
    }
    rows.sort((a, b) => {
      if (a.engine !== b.engine) {
        return engines.indexOf(a.engine) - engines.indexOf(b.engine)
      }
      return b.schemaBytes - a.schemaBytes
    })

    const totalsByEngine = new Map<
      Engine,
      { schemaBytes: number; tokens: number }
    >()
    for (const engine of engines) {
      totalsByEngine.set(engine, { schemaBytes: 0, tokens: 0 })
    }
    for (const row of rows) {
      const totals = totalsByEngine.get(row.engine)
      if (totals) {
        totals.schemaBytes += row.schemaBytes
        totals.tokens += row.tokens
      }
    }

    return { rows, totalsByEngine }
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
    if (previousTasks === undefined) {
      delete process.env[TASKS_KEY]
    } else {
      process.env[TASKS_KEY] = previousTasks
    }
    if (gitMode === 'off') {
      if (previousEnv === undefined) {
        delete process.env[ENV_KEY]
      } else {
        process.env[ENV_KEY] = previousEnv
      }
    }
  }
}

function formatRowsForEngine(rows: Row[], headers: string[]): string {
  const data = rows.map(r =>
    r.error
      ? [r.name, '<error: ' + r.error + '>', '', '']
      : [
          r.name,
          r.descriptionBytes.toLocaleString('en-US'),
          r.schemaBytes.toLocaleString('en-US'),
          r.tokens.toLocaleString('en-US'),
        ],
  )
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const pad = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join(' | ')
  const separator = widths.map(w => '-'.repeat(w)).join('-+-')
  return [pad(headers), separator, ...data.map(pad)].join('\n')
}

function formatReport(result: MeasureResult): string {
  const headers = ['name', 'desc bytes', 'schema bytes', '~tokens']
  const sections: string[] = []
  for (const [engine, totals] of result.totalsByEngine) {
    const engineRows = result.rows.filter(r => r.engine === engine)
    sections.push(`# engine: ${engine}`)
    sections.push(formatRowsForEngine(engineRows, headers))
    sections.push('')
    sections.push(
      `Tools measured: ${engineRows.length}\n` +
        `Total schema bytes: ${totals.schemaBytes.toLocaleString('en-US')}\n` +
        `Total ~tokens: ${totals.tokens.toLocaleString('en-US')}`,
    )
    const errored = engineRows.filter(r => r.error)
    if (errored.length > 0) {
      sections.push(`Tools with errors: ${errored.length}`)
    }
    sections.push('')
  }

  // Combined summary footer for quick cross-engine diffing.
  if (result.totalsByEngine.size > 1) {
    sections.push('# combined totals')
    const summaryHeaders = ['engine', 'total bytes', 'total ~tokens']
    const summaryRows: string[][] = []
    for (const [engine, totals] of result.totalsByEngine) {
      summaryRows.push([
        engine,
        totals.schemaBytes.toLocaleString('en-US'),
        totals.tokens.toLocaleString('en-US'),
      ])
    }
    const widths = summaryHeaders.map((h, i) =>
      Math.max(h.length, ...summaryRows.map(row => row[i]!.length)),
    )
    const pad = (cells: string[]) =>
      cells
        .map((cell, i) =>
          i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!),
        )
        .join(' | ')
    const sep = widths.map(w => '-'.repeat(w)).join('-+-')
    sections.push(
      [pad(summaryHeaders), sep, ...summaryRows.map(pad)].join('\n'),
    )
  }

  return sections.join('\n')
}

function parseArgs(argv: string[]): {
  engines: readonly Engine[]
  gitMode: 'on' | 'off'
  asJson: boolean
} {
  let engines: readonly Engine[] = ALL_ENGINES
  let gitMode: 'on' | 'off' = 'on'
  let asJson = false

  for (const arg of argv) {
    if (arg === '--json') {
      asJson = true
      continue
    }
    if (arg.startsWith('--engine=')) {
      const value = arg.slice('--engine='.length)
      if (value === 'all') {
        engines = ALL_ENGINES
      } else if (value === 'anthropic' || value === 'openai' || value === 'codex') {
        engines = [value]
      } else {
        throw new Error(
          `Unknown --engine value: ${value} (expected anthropic|openai|codex|all)`,
        )
      }
      continue
    }
    if (arg.startsWith('--git-mode=')) {
      const value = arg.slice('--git-mode='.length)
      if (value !== 'on' && value !== 'off') {
        throw new Error(`Unknown --git-mode value: ${value} (expected on|off)`)
      }
      gitMode = value
      continue
    }
  }

  return { engines, gitMode, asJson }
}

async function main(): Promise<void> {
  const { engines, gitMode, asJson } = parseArgs(process.argv.slice(2))

  const result = await measureToolSchemas({ engines, gitMode })

  if (asJson) {
    const totals: Record<string, { schemaBytes: number; tokens: number }> = {}
    for (const [engine, value] of result.totalsByEngine) {
      totals[engine] = value
    }
    process.stdout.write(
      JSON.stringify(
        {
          rows: result.rows,
          totals,
          gitMode,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  process.stdout.write(`# git-mode: ${gitMode}\n`)
  process.stdout.write(formatReport(result) + '\n')
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
