/**
 * Measure the per-turn token cost of MCP integration.
 *
 * Three measurable surfaces, none of which are tracked anywhere else:
 *
 *   1. **Tool schemas** — every MCP tool gets registered via the same
 *      `toolToAPISchema` path as built-ins. `measure-tool-schemas.ts` only
 *      walks `getAllBaseTools()` and ignores MCP tools entirely, so the
 *      per-server schema cost is invisible. We synthesize realistic tool
 *      schemas, run them through the same engine shims, and report bytes.
 *   2. **Server instructions** — `getMcpInstructionsSection` injects a
 *      static block per connected server with `instructions` set. Concat
 *      grows linearly with #servers.
 *   3. **mcp_instructions_delta attachment** — initial-turn announcement
 *      is large; subsequent turns are usually empty (delta gating).
 *
 * Output: per-server breakdown + grand total. JSON via --json.
 *
 * Flags:
 *   --servers=N         number of synthetic servers (default 3)
 *   --tools-per-server=N (default 8)
 *   --instructions-bytes=N  per-server instructions size in bytes (default 1500)
 *   --model=<name>      tokenizer ratio (default claude-sonnet-4-5)
 *   --engine=anthropic|openai|codex  schema shape (default anthropic)
 *   --json              machine-readable
 *
 * Read-only. No real MCP servers are contacted.
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

import { convertToolsToResponsesTools } from '../src/services/api/codexShim.js'
import { convertTools } from '../src/services/api/openaiShim.js'
import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/utils/config.js'

type Engine = 'anthropic' | 'openai' | 'codex'

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

export type MCPServerFixture = {
  name: string
  toolCount: number
  /** length of the synthetic `instructions` block, in bytes */
  instructionsBytes: number
}

export type ServerRow = {
  server: string
  toolSchemasBytes: number
  instructionsBytes: number
  totalBytes: number
  totalTokens: number
}

export type MCPOverheadResult = {
  engine: Engine
  model: string
  bytesPerToken: number
  servers: ServerRow[]
  /** Bytes of the joined "# MCP Server Instructions" block injected into the system prompt */
  systemPromptInstructionsBytes: number
  systemPromptInstructionsTokens: number
  /** Bytes of the "mcp_instructions_delta" attachment on the first turn (full re-announce) */
  initialDeltaAttachmentBytes: number
  initialDeltaAttachmentTokens: number
  totalBytes: number
  totalTokens: number
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Build a synthetic MCP tool schema in the Anthropic input shape. Mirrors
 * what `client.ts:1807` emits when it normalizes MCP tool definitions
 * coming back from `tools/list`.
 */
function syntheticAnthropicSchema(server: string, idx: number): {
  name: string
  description: string
  input_schema: Record<string, unknown>
} {
  return {
    name: `mcp__${server}__tool_${idx}`,
    description:
      `Tool ${idx} provided by MCP server "${server}". ` +
      `${LOREM} Used to perform some operation requiring ${idx + 1} args. ` +
      `Returns a structured payload describing the result.`,
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Identifier of the target resource' },
        options: {
          type: 'object',
          description: 'Optional flags affecting behavior',
          properties: {
            recursive: { type: 'boolean', description: 'recurse into children' },
            limit: { type: 'integer', description: 'maximum results to return' },
            filter: { type: 'string', description: 'optional substring filter' },
          },
        },
        metadata: {
          type: 'array',
          description: 'Auxiliary metadata key/value pairs',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
      required: ['target'],
    },
  }
}

function shimSchema(
  engine: Engine,
  schemas: ReturnType<typeof syntheticAnthropicSchema>[],
): string {
  if (engine === 'anthropic') {
    return JSON.stringify(schemas)
  }
  if (engine === 'openai') {
    return JSON.stringify(convertTools(schemas))
  }
  return JSON.stringify(convertToolsToResponsesTools(schemas))
}

/**
 * Mirror `getMcpInstructions()` in `src/constants/prompts.ts`. Inlined here
 * so we don't depend on `MCPServerConnection` having a real `Client`
 * field — the production helper only reads `name` and `instructions`.
 */
function renderMcpInstructionsBlock(
  fixtures: readonly { name: string; instructions: string }[],
): string {
  const blocks = fixtures
    .filter(f => f.instructions.length > 0)
    .map(f => `## ${f.name}\n${f.instructions}`)
    .join('\n\n')
  if (blocks.length === 0) return ''
  return `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${blocks}`
}

/**
 * Mirror the wire shape of `mcp_instructions_delta` on first announcement
 * (see `src/utils/messages.ts` rendering). The attachment carries
 * `addedNames` + `addedBlocks`; on initial turn `addedBlocks` is the same
 * content as the system-prompt block, but it lives in the conversation
 * tail instead of the cacheable system prompt.
 */
function renderInitialMcpDelta(
  fixtures: readonly { name: string; instructions: string }[],
): string {
  const blocks = fixtures
    .filter(f => f.instructions.length > 0)
    .map(f => `## ${f.name}\n${f.instructions}`)
  if (blocks.length === 0) return ''
  return `<system-reminder>\nThe following MCP servers added instructions:\n\n${blocks.join('\n\n')}\n</system-reminder>`
}

export async function measureMcpOverhead(options: {
  servers?: number
  toolsPerServer?: number
  instructionsBytes?: number
  model?: string
  engine?: Engine
} = {}): Promise<MCPOverheadResult> {
  const serverCount = options.servers ?? 3
  const toolsPerServer = options.toolsPerServer ?? 8
  const instructionsBytes = options.instructionsBytes ?? 1500
  const model = options.model ?? 'claude-sonnet-4-5'
  const engine: Engine = options.engine ?? 'anthropic'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  const fixtures: MCPServerFixture[] = Array.from(
    { length: serverCount },
    (_, i) => ({
      name: `srv-${i}`,
      toolCount: toolsPerServer,
      instructionsBytes,
    }),
  )

  const serverRows: ServerRow[] = []
  const instructionsList: { name: string; instructions: string }[] = []

  for (const f of fixtures) {
    const schemas = Array.from({ length: f.toolCount }, (_, i) =>
      syntheticAnthropicSchema(f.name, i),
    )
    const schemaWire = shimSchema(engine, schemas)
    const schemaBytes = bytes(schemaWire)

    const instructions = bodyOfSize(f.instructionsBytes)
    instructionsList.push({ name: f.name, instructions })

    const instrBytes = bytes(instructions)
    const totalBytes = schemaBytes + instrBytes
    serverRows.push({
      server: f.name,
      toolSchemasBytes: schemaBytes,
      instructionsBytes: instrBytes,
      totalBytes,
      totalTokens: Math.round(totalBytes / ratio),
    })
  }

  const sysBlock = renderMcpInstructionsBlock(instructionsList)
  const deltaBlock = renderInitialMcpDelta(instructionsList)

  const sysBytes = bytes(sysBlock)
  const deltaBytes = bytes(deltaBlock)

  const schemasTotal = serverRows.reduce((acc, r) => acc + r.toolSchemasBytes, 0)
  const totalBytes = schemasTotal + sysBytes + deltaBytes
  const totalTokens =
    serverRows.reduce((acc, r) => acc + Math.round(r.toolSchemasBytes / ratio), 0) +
    roughTokenCountEstimation(sysBlock, ratio) +
    roughTokenCountEstimation(deltaBlock, ratio)

  return {
    engine,
    model,
    bytesPerToken: ratio,
    servers: serverRows,
    systemPromptInstructionsBytes: sysBytes,
    systemPromptInstructionsTokens: roughTokenCountEstimation(sysBlock, ratio),
    initialDeltaAttachmentBytes: deltaBytes,
    initialDeltaAttachmentTokens: roughTokenCountEstimation(deltaBlock, ratio),
    totalBytes,
    totalTokens,
  }
}

function formatTable(result: MCPOverheadResult): string {
  const lines: string[] = []
  lines.push(
    `# MCP overhead — engine=${result.engine} model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push('')
  const headers = ['server', 'schemas (bytes)', 'instr (bytes)', 'total (bytes)', 'tokens']
  const data = result.servers.map(r => [
    r.server,
    r.toolSchemasBytes.toLocaleString('en-US'),
    r.instructionsBytes.toLocaleString('en-US'),
    r.totalBytes.toLocaleString('en-US'),
    r.totalTokens.toLocaleString('en-US'),
  ])
  data.push([
    'system-prompt block',
    '—',
    result.systemPromptInstructionsBytes.toLocaleString('en-US'),
    result.systemPromptInstructionsBytes.toLocaleString('en-US'),
    result.systemPromptInstructionsTokens.toLocaleString('en-US'),
  ])
  data.push([
    'initial delta attachment',
    '—',
    result.initialDeltaAttachmentBytes.toLocaleString('en-US'),
    result.initialDeltaAttachmentBytes.toLocaleString('en-US'),
    result.initialDeltaAttachmentTokens.toLocaleString('en-US'),
  ])
  data.push([
    'TOTAL',
    '',
    '',
    result.totalBytes.toLocaleString('en-US'),
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
  servers: number
  toolsPerServer: number
  instructionsBytes: number
  model: string
  engine: Engine
  asJson: boolean
} {
  let servers = 3
  let toolsPerServer = 8
  let instructionsBytes = 1500
  let model = 'claude-sonnet-4-5'
  let engine: Engine = 'anthropic'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--servers=')) servers = Number(arg.slice('--servers='.length))
    else if (arg.startsWith('--tools-per-server='))
      toolsPerServer = Number(arg.slice('--tools-per-server='.length))
    else if (arg.startsWith('--instructions-bytes='))
      instructionsBytes = Number(arg.slice('--instructions-bytes='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
    else if (arg.startsWith('--engine=')) {
      const v = arg.slice('--engine='.length)
      if (v === 'anthropic' || v === 'openai' || v === 'codex') engine = v
      else throw new Error(`unknown engine: ${v}`)
    }
  }
  return { servers, toolsPerServer, instructionsBytes, model, engine, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureMcpOverhead(opts)
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
