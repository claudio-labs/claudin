/**
 * Long-tail sweep of "list-shaped" attachments.
 *
 * `measure-attachments-budget.ts` covers every attachment kind at two
 * profile sizes (typical / heavy). For attachments that scale with the
 * project — number of files, number of agents, number of MCP servers,
 * number of memory entries — typical/heavy isn't enough: in real
 * monorepos those lists can run 50-200 entries deep and drive a real
 * per-turn cost.
 *
 * This bench sweeps `fileCount` ∈ {1, 10, 50, 200} for the three delta-style
 * attachments that scale linearly with project size:
 *
 *   - `agent_listing_delta`
 *   - `deferred_tools_delta`
 *   - `mcp_instructions_delta`
 *
 * Output: per-attachment row with bytes/tokens at each fileCount step,
 * plus the slope (bytes per +1 entry) so you can extrapolate to your
 * project size.
 *
 * Read-only. Same renderer path as production
 * (`normalizeAttachmentForAPI`). No filesystem reads beyond `enableConfigs`.
 *
 * Flags:
 *   --counts=1,10,50,200    sweep points (default 1,10,50,200)
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
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/utils/config.js'
import type { Attachment } from '../src/utils/attachments.js'
import { normalizeAttachmentForAPI } from '../src/utils/messages.js'

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

function userMessageContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      if ((block as { type?: string }).type === 'text') {
        parts.push((block as { text?: string }).text ?? '')
        continue
      }
    }
    parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

function renderAttachment(att: Attachment): string {
  const messages = normalizeAttachmentForAPI(att)
  return messages
    .map(m => userMessageContentToString(m.message.content))
    .join('\n')
}

type Kind =
  | 'agent_listing_delta'
  | 'deferred_tools_delta'
  | 'mcp_instructions_delta'

/**
 * Per-entry body-size knobs. The MCP delta is fixture-driven:
 * production server-instruction sizes vary widely (some <100 B, some
 * Notion/Solana ones ~3-5 KB), so the slope is meaningless without
 * sweeping. We expose `bodyBytes` so callers can probe multiple sizes.
 */
function build(kind: Kind, n: number, bodyBytes: number): Attachment {
  switch (kind) {
    case 'agent_listing_delta':
      return {
        type: 'agent_listing_delta',
        isInitial: true,
        showConcurrencyNote: true,
        addedTypes: Array.from({ length: n }, (_, i) => `agent-${i}`),
        addedLines: Array.from(
          { length: n },
          (_, i) => `- agent-${i}: ${LOREM.slice(0, Math.min(bodyBytes, 80))}`,
        ),
        removedTypes: [],
      }
    case 'deferred_tools_delta':
      return {
        type: 'deferred_tools_delta',
        addedNames: Array.from({ length: n }, (_, i) => `Tool${i}`),
        addedLines: Array.from(
          { length: n },
          (_, i) => `- Tool${i}: ${LOREM.slice(0, Math.min(bodyBytes, 60))}`,
        ),
        removedNames: [],
      }
    case 'mcp_instructions_delta':
      return {
        type: 'mcp_instructions_delta',
        addedNames: Array.from({ length: n }, (_, i) => `srv-${i}`),
        addedBlocks: Array.from(
          { length: n },
          (_, i) => `## srv-${i}\n${bodyOfSize(bodyBytes)}`,
        ),
        removedNames: [],
      }
  }
}

const KINDS: Kind[] = [
  'agent_listing_delta',
  'deferred_tools_delta',
  'mcp_instructions_delta',
]

export type LongtailRow = {
  kind: Kind
  count: number
  bodyBytes: number
  bytes: number
  tokens: number
}

export type LongtailResult = {
  model: string
  bytesPerToken: number
  rows: LongtailRow[]
  /** For each (kind, bodyBytes): slope per +1 entry. Sweeping bodyBytes
   *  surfaces that the slope is overwhelmingly fixture-driven for the
   *  body-bearing deltas (memory, MCP). */
  slopesPerEntry: {
    kind: Kind
    bodyBytes: number
    bytesPerEntry: number
    tokensPerEntry: number
  }[]
}

const DEFAULT_BODY_BYTES = [100, 800, 3000] as const

export async function measureLongtailAttachments(options: {
  counts?: readonly number[]
  bodyBytes?: readonly number[]
  model?: string
} = {}): Promise<LongtailResult> {
  const counts = options.counts ?? [1, 10, 50, 200]
  const bodySizes = options.bodyBytes ?? DEFAULT_BODY_BYTES
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const rows: LongtailRow[] = []
  const slopes: LongtailResult['slopesPerEntry'] = []

  for (const kind of KINDS) {
    for (const bodyBytes of bodySizes) {
      let smallest: { count: number; bytes: number; tokens: number } | null = null
      let largest: { count: number; bytes: number; tokens: number } | null = null

      for (const count of counts) {
        const wire = renderAttachment(build(kind, count, bodyBytes))
        const b = bytes(wire)
        const t = roughTokenCountEstimation(wire, ratio)
        rows.push({ kind, count, bodyBytes, bytes: b, tokens: t })
        if (smallest === null || count < smallest.count) {
          smallest = { count, bytes: b, tokens: t }
        }
        if (largest === null || count > largest.count) {
          largest = { count, bytes: b, tokens: t }
        }
      }

      if (smallest && largest && largest.count !== smallest.count) {
        slopes.push({
          kind,
          bodyBytes,
          bytesPerEntry: Math.round(
            (largest.bytes - smallest.bytes) / (largest.count - smallest.count),
          ),
          tokensPerEntry: Math.round(
            (largest.tokens - smallest.tokens) / (largest.count - smallest.count),
          ),
        })
      }
    }
  }

  return { model, bytesPerToken: ratio, rows, slopesPerEntry: slopes }
}

function formatTable(result: LongtailResult): string {
  const lines: string[] = []
  lines.push(
    `# Long-tail attachments — model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push('')
  const kinds = Array.from(new Set(result.rows.map(r => r.kind))) as Kind[]
  for (const kind of kinds) {
    lines.push(`## ${kind}`)
    const headers = ['count', 'body B', 'bytes', 'tokens']
    const data = result.rows
      .filter(r => r.kind === kind)
      .sort((a, b) => a.bodyBytes - b.bodyBytes || a.count - b.count)
      .map(r => [
        String(r.count),
        r.bodyBytes.toLocaleString('en-US'),
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
  }
  lines.push('# Slope per +1 entry (B per added entry, at given body size)')
  for (const s of result.slopesPerEntry) {
    lines.push(
      `  ${s.kind} @ ${s.bodyBytes} B body: ${s.bytesPerEntry.toLocaleString('en-US')} B / ${s.tokensPerEntry.toLocaleString('en-US')} tokens`,
    )
  }
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  counts: readonly number[]
  bodyBytes: readonly number[]
  model: string
  asJson: boolean
} {
  let counts: number[] = [1, 10, 50, 200]
  let bodyBytes: number[] = [...DEFAULT_BODY_BYTES]
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--counts=')) {
      counts = arg
        .slice('--counts='.length)
        .split(',')
        .map(Number)
        .filter(n => Number.isFinite(n) && n >= 0)
    } else if (arg.startsWith('--body-bytes=')) {
      bodyBytes = arg
        .slice('--body-bytes='.length)
        .split(',')
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0)
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { counts, bodyBytes, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureLongtailAttachments(opts)
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
