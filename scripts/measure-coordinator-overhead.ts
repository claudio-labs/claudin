/**
 * Measure the per-turn token overhead of `COORDINATOR_MODE`.
 *
 * When the coordinator feature is on (env `CLAUDE_CODE_COORDINATOR_MODE=1`),
 * the main agent loop runs in "coordinator" shape:
 *
 *   - A *replacement* system prompt (`getCoordinatorSystemPrompt()`) — not
 *     the regular Claudin system prompt. Smaller in some sections, larger
 *     in others.
 *   - Extra coordinator-only tools: `TeamCreate`, `TeamDelete`,
 *     `SendMessage`, `SyntheticOutput`. Each carries its own schema bytes.
 *   - A user-context injection (`getCoordinatorUserContext`) listing what
 *     workers can do.
 *   - Each spawned worker is a sub-agent with the async-allowed tool set
 *     (10-15 tools), plus message-protocol overhead (TeamCreate envelope,
 *     SendMessage frames).
 *
 * None of this is reflected in `measure-token-budget.ts` (which only
 * measures the *regular* system prompt) or `measure-subagent-spawn-cost.ts`
 * (which measures built-in agents, not coordinator workers).
 *
 * This bench reports:
 *
 *   - Coordinator system prompt bytes/tokens
 *   - User-context injection bytes/tokens (incl. MCP server names)
 *   - Per-worker spawn cost (worker tool set after filtering)
 *   - Dispatch overhead (TeamCreate + SendMessage envelopes for one
 *     worker turn)
 *   - Projected cost for "coordinator + N workers"
 *
 * Read-only. Forces `CLAUDE_CODE_COORDINATOR_MODE=1` for the duration of
 * the measurement and restores afterward.
 *
 * Flags:
 *   --workers=2,5,10        worker counts to project (default 2,5,10)
 *   --mcp-servers=3         simulated MCP server count for context (default 3)
 *   --model=<name>          tokenizer ratio (default claude-sonnet-4-5)
 *   --json                  machine-readable
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
} from '../src/shared/tokenEstimation.js'
import { enableConfigs } from '../src/platform/config/config.js'
import { getCoordinatorSystemPrompt } from '../src/agent/coordinator/coordinatorMode.js'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../src/constants/tools.js'
import { AGENT_TOOL_NAME } from '../src/tools/AgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../src/tools/SendMessageTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../src/tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../src/tools/TeamDeleteTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../src/tools/SyntheticOutputTool/SyntheticOutputTool.js'

const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

/**
 * Replicates `getCoordinatorUserContext` body without going through the
 * `feature('COORDINATOR_MODE')` gate. The real helper short-circuits to
 * `{}` at test time because `feature()` is a build-time stub that returns
 * false when the bundle isn't built with the flag — that would make this
 * bench measure nothing. We mirror the production string so the byte
 * counts are real.
 */
function renderCoordinatorUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
): string {
  const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
    .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
    .sort()
    .join(', ')

  let content = `Workers spawned via the ${AGENT_TOOL_NAME} tool have access to these tools: ${workerTools}`
  if (mcpClients.length > 0) {
    content += `\n\nWorkers also have access to MCP tools from connected MCP servers: ${mcpClients
      .map(c => c.name)
      .join(', ')}`
  }
  return content
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

const COORD_FLAG = 'CLAUDE_CODE_COORDINATOR_MODE'

export type CoordinatorRow = {
  section:
    | 'system_prompt'
    | 'user_context'
    | 'worker_tools_listing'
    | 'dispatch_envelope'
  bytes: number
  tokens: number
}

export type CoordinatorResult = {
  model: string
  bytesPerToken: number
  rows: CoordinatorRow[]
  asyncAllowedToolCount: number
  /** Cost projection for N workers (system + ctx + N × dispatch envelope) */
  projection: { workers: number; tokens: number }[]
}

/**
 * Synthetic dispatch envelope: TeamCreate input + initial SendMessage to
 * the worker + a typical synthetic-output frame coming back. We mirror the
 * shape of these tool calls without invoking the real tools (which require
 * agent infrastructure).
 */
function renderDispatchEnvelope(workerType: string, taskDescription: string): string {
  return JSON.stringify({
    teamCreate: {
      type: 'tool_use',
      name: 'TeamCreate',
      input: { agentType: workerType, prompt: taskDescription },
    },
    sendMessage: {
      type: 'tool_use',
      name: 'SendMessage',
      input: { workerId: 'worker-001', content: taskDescription },
    },
    syntheticOutput: {
      type: 'tool_result',
      tool_use_id: 'toolu_synth_001',
      content: 'Worker progress: investigating...',
    },
  })
}

function renderWorkerToolsListing(): string {
  // In coordinator mode the user-context lists worker-allowed tools by
  // name. The list size scales with ASYNC_AGENT_ALLOWED_TOOLS.
  return Array.from(ASYNC_AGENT_ALLOWED_TOOLS).sort().join(', ')
}

export async function measureCoordinatorOverhead(options: {
  workers?: readonly number[]
  mcpServers?: number
  model?: string
} = {}): Promise<CoordinatorResult> {
  const workers = options.workers ?? [2, 5, 10]
  const mcpServers = options.mcpServers ?? 3
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  // Force coordinator mode on for the duration of measurement.
  const previousFlag = process.env[COORD_FLAG]
  process.env[COORD_FLAG] = '1'

  try {
    const ratio = getBytesPerTokenForModel(model)

    const sysPrompt = getCoordinatorSystemPrompt()
    const sysBytes = bytes(sysPrompt)

    const fakeMcpClients = Array.from({ length: mcpServers }, (_, i) => ({
      name: `mcp-server-${i}`,
    }))
    const ctxText = renderCoordinatorUserContext(fakeMcpClients)
    const ctxBytes = bytes(ctxText)

    const workerTools = renderWorkerToolsListing()
    const workerToolsBytes = bytes(workerTools)

    const dispatch = renderDispatchEnvelope(
      'Code',
      'Investigate the cache invalidation issue in src/services/api/.',
    )
    const dispatchBytes = bytes(dispatch)

    const rows: CoordinatorRow[] = [
      {
        section: 'system_prompt',
        bytes: sysBytes,
        tokens: roughTokenCountEstimation(sysPrompt, ratio),
      },
      {
        section: 'user_context',
        bytes: ctxBytes,
        tokens: roughTokenCountEstimation(ctxText, ratio),
      },
      {
        section: 'worker_tools_listing',
        bytes: workerToolsBytes,
        tokens: roughTokenCountEstimation(workerTools, ratio),
      },
      {
        section: 'dispatch_envelope',
        bytes: dispatchBytes,
        tokens: roughTokenCountEstimation(dispatch, ratio),
      },
    ]

    // Projection: sysPrompt + ctx is paid ONCE per session (cached).
    // Dispatch envelope is paid PER worker spawn.
    const sysTokens = rows[0]!.tokens
    const ctxTokens = rows[1]!.tokens
    const dispatchTokens = rows[3]!.tokens
    const projection = workers.map(n => ({
      workers: n,
      tokens: sysTokens + ctxTokens + n * dispatchTokens,
    }))

    return {
      model,
      bytesPerToken: ratio,
      rows,
      asyncAllowedToolCount: ASYNC_AGENT_ALLOWED_TOOLS.size,
      projection,
    }
  } finally {
    if (previousFlag === undefined) delete process.env[COORD_FLAG]
    else process.env[COORD_FLAG] = previousFlag
  }
}

function formatTable(result: CoordinatorResult): string {
  const lines: string[] = []
  lines.push(
    `# Coordinator overhead — model=${result.model} (bytes/token=${result.bytesPerToken}) async-allowed-tools=${result.asyncAllowedToolCount}`,
  )
  lines.push('')
  const headers = ['section', 'bytes', 'tokens']
  const data = result.rows.map(r => [
    r.section,
    r.bytes.toLocaleString('en-US'),
    r.tokens.toLocaleString('en-US'),
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
  lines.push('# Projection: coordinator + N workers')
  for (const p of result.projection) {
    lines.push(
      `  ${p.workers} workers → ${p.tokens.toLocaleString('en-US')} tokens (sys + ctx + N × dispatch)`,
    )
  }
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  workers: readonly number[]
  mcpServers: number
  model: string
  asJson: boolean
} {
  let workers: number[] = [2, 5, 10]
  let mcpServers = 3
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--workers=')) {
      workers = arg
        .slice('--workers='.length)
        .split(',')
        .map(Number)
        .filter(n => Number.isFinite(n) && n >= 0)
    } else if (arg.startsWith('--mcp-servers='))
      mcpServers = Number(arg.slice('--mcp-servers='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { workers, mcpServers, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureCoordinatorOverhead(opts)
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
