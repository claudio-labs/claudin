/**
 * Measure the per-spawn token cost of `AgentTool`-launched sub-agents.
 *
 * When the main agent calls `AgentTool` with `subagent_type=Explore` (or
 * any other built-in/user-defined agent), we spin up a child query loop
 * that gets its OWN:
 *
 *   - custom system prompt (set per-agent via `getSystemPrompt()` or the
 *     `system_prompt` frontmatter on disk-defined agents)
 *   - filtered tool bundle (the agent's `disallowedTools` removes some, the
 *     allowedTools whitelist keeps only what's listed)
 *   - independent conversation history (so prior turns don't transfer)
 *
 * That's a non-trivial bootstrap. None of the existing benches measure it.
 * In a typical session where the main agent dispatches 3 parallel
 * sub-agents, you pay ~3× the bootstrap cost in addition to the main
 * loop's ongoing cost.
 *
 * This bench walks every built-in agent, measures its bootstrap, and
 * reports a sortable table:
 *
 *   - agentType
 *   - system prompt bytes / tokens (the part that's unique to this agent)
 *   - tool bundle bytes / tokens AFTER `disallowedTools` filtering
 *   - total spawn cost (tokens) — what you pay on the first turn of the
 *     spawned agent's loop
 *
 * Flags:
 *   --model=<name>       tokenizer ratio (default claude-sonnet-4-5)
 *   --engine=anthropic|openai|codex  schema shape (default anthropic)
 *   --json               machine-readable
 *
 * Read-only. No real sub-agents are launched.
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
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { toolToAPISchema } from '../src/services/api/api.js'
import { getAllBaseTools } from '../src/tools.js'
import { getBuiltInAgents } from '../src/tools/AgentTool/builtInAgents.js'
import { resolveAgentTools } from '../src/tools/AgentTool/agentToolUtils.js'
import { convertTools } from '../src/services/api/openaiShim.js'
import { convertToolsToResponsesTools } from '../src/services/api/codexShim.js'
import { clearToolSchemaCache } from '../src/services/tools/toolSchemaCache.js'
import type { Tool } from '../src/Tool.js'

type Engine = 'anthropic' | 'openai' | 'codex'

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

async function buildToolBundleBytes(
  tools: readonly Tool[],
  engine: Engine,
): Promise<number> {
  const anthropicSchemas: { name: string; description: string; input_schema: Record<string, unknown> }[] = []
  for (const tool of tools) {
    try {
      const schema = await toolToAPISchema(tool, {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: [...tools],
        agents: [],
        allowedAgentTypes: [],
      })
      const parsed = JSON.parse(JSON.stringify(schema)) as {
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
      }
      anthropicSchemas.push({
        name: parsed.name ?? tool.name,
        description: parsed.description ?? '',
        input_schema: parsed.input_schema ?? {},
      })
    } catch {
      // Skip rather than fail — matches measure-tool-schemas.ts which
      // records an error row instead of aborting the whole table.
    }
  }

  if (engine === 'anthropic') {
    return bytes(JSON.stringify(anthropicSchemas))
  }
  if (engine === 'openai') {
    return bytes(JSON.stringify(convertTools(anthropicSchemas)))
  }
  return bytes(JSON.stringify(convertToolsToResponsesTools(anthropicSchemas)))
}

/**
 * Minimal stub of the slice of ToolUseContext that built-in agent
 * `getSystemPrompt()` callbacks read. Only `claudeCodeGuideAgent` uses it;
 * everything else ignores its argument. We provide empty arrays so the
 * generated prompt has stable, comparable bytes across runs.
 */
function buildSyntheticToolUseContext(): {
  options: {
    commands: readonly { type: string; name: string; description: string }[]
    agentDefinitions: { activeAgents: readonly { source: string }[] }
    mcpClients: readonly unknown[]
  }
} {
  return {
    options: {
      commands: [],
      agentDefinitions: { activeAgents: [] },
      mcpClients: [],
    },
  }
}

export type SubagentRow = {
  agentType: string
  source: string
  /** Bytes of the agent's custom system prompt */
  systemPromptBytes: number
  /** Bytes of the filtered tool bundle */
  toolBundleBytes: number
  /** Bytes of the agent's `whenToUse` description (the cost it adds to
   *  AgentTool's parent schema enum entry). */
  whenToUseBytes: number
  totalBytes: number
  totalTokens: number
  filteredToolCount: number
}

export type SubagentSpawnResult = {
  engine: Engine
  model: string
  bytesPerToken: number
  rows: SubagentRow[]
  /** Sum of totalTokens across all built-in agents — useful for "if user
   *  spawns one of every type" budgeting. */
  totalTokens: number
}

export async function measureSubagentSpawnCost(options: {
  engine?: Engine
  model?: string
} = {}): Promise<SubagentSpawnResult> {
  const engine: Engine = options.engine ?? 'anthropic'
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  // Match measure-tool-schemas.ts: pin NODE_ENV and Tasks toggle so that
  // tool prompts emit production-shape bytes.
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const TASKS_KEY = 'CLAUDE_CODE_ENABLE_TASKS'
  const previousTasks = process.env[TASKS_KEY]
  process.env[TASKS_KEY] = '1'

  try {
    clearToolSchemaCache()

    const ratio = getBytesPerTokenForModel(model)
    const allTools = getAllBaseTools()
    const builtIns = getBuiltInAgents()

    const rows: SubagentRow[] = []

    const ctx = buildSyntheticToolUseContext()
    for (const agent of builtIns) {
      let sysPrompt = ''
      try {
        // Built-in agents have signature ({ toolUseContext }) => string. The
        // synthetic ctx has empty arrays so commands/agents/mcp blocks
        // collapse to "(none)" or omitted sections — that's fine for
        // measurement: we want the *baseline* prompt, not a personalized
        // one.
        const fn = agent.getSystemPrompt as unknown as (
          arg?: unknown,
        ) => string | Promise<string>
        const out = fn({ toolUseContext: ctx })
        sysPrompt = await Promise.resolve(out)
      } catch (err) {
        // Don't crash the bench on one agent — surface it as a 0-byte row
        // with the error tag in agentType.
        sysPrompt = ''
        console.error(
          `[measure-subagent-spawn-cost] agent ${agent.agentType} prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const sysBytes = bytes(sysPrompt)

      // Use the same filter the runtime uses (`resolveAgentTools`). It
      // honours BOTH `disallowedTools` AND the positive `tools:` whitelist;
      // a previous version of this bench only checked `disallowedTools`
      // and reported identical bundle bytes for every built-in agent.
      const resolved = resolveAgentTools(
        agent,
        allTools as readonly Tool[],
        /* isAsync */ false,
        /* isMainThread */ false,
      )
      const filtered = resolved.hasWildcard
        ? resolved.resolvedTools
        : resolved.resolvedTools

      // Each agent spawn rebuilds its tool bundle from scratch — they don't
      // share the parent's cached bundle because the wire schemas differ.
      const toolBytes = await buildToolBundleBytes(filtered, engine)

      const whenToUse = agent.whenToUse ?? ''
      const whenBytes = bytes(whenToUse)

      const totalBytes = sysBytes + toolBytes + whenBytes
      const totalTokens =
        roughTokenCountEstimation(sysPrompt, ratio) +
        Math.round(toolBytes / ratio) +
        roughTokenCountEstimation(whenToUse, ratio)

      rows.push({
        agentType: agent.agentType,
        source: agent.source,
        systemPromptBytes: sysBytes,
        toolBundleBytes: toolBytes,
        whenToUseBytes: whenBytes,
        totalBytes,
        totalTokens,
        filteredToolCount: filtered.length,
      })
    }

    rows.sort((a, b) => b.totalTokens - a.totalTokens)

    const totalTokens = rows.reduce((acc, r) => acc + r.totalTokens, 0)

    return {
      engine,
      model,
      bytesPerToken: ratio,
      rows,
      totalTokens,
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousTasks === undefined) delete process.env[TASKS_KEY]
    else process.env[TASKS_KEY] = previousTasks
  }
}

function formatTable(result: SubagentSpawnResult): string {
  const lines: string[] = []
  lines.push(
    `# Sub-agent spawn cost — engine=${result.engine} model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push('')
  const headers = [
    'agentType',
    'source',
    'sys (B)',
    'tools (B)',
    'whenToUse (B)',
    'tools',
    'tokens',
  ]
  const data = result.rows.map(r => [
    r.agentType,
    r.source,
    r.systemPromptBytes.toLocaleString('en-US'),
    r.toolBundleBytes.toLocaleString('en-US'),
    r.whenToUseBytes.toLocaleString('en-US'),
    String(r.filteredToolCount),
    r.totalTokens.toLocaleString('en-US'),
  ])
  data.push([
    'TOTAL',
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
  const result = await measureSubagentSpawnCost(opts)
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
