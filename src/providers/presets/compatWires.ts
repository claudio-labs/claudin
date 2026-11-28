/**
 * Which wire a request of an OpenAI-compatible profile goes out on.
 *
 * Every such profile speaks Chat Completions unless a row here names its host
 * and model: `responses` sends it to the host's Responses API (B), `anthropic`
 * to the vendor's Anthropic Messages endpoint (C). The profile keeps its own
 * base URL either way — usage, limits and family addenda read it — and the
 * row says where the other wire lives.
 *
 * A row is `verified` when a recording of that host proves the wire
 * (src/providers/__fixtures__/cassettes/). An unverified row stays off unless
 * its kind's env asks for every row:
 *   CLAUDIN_OPENAI_RESPONSES       0 = no Responses rows, all = unverified too
 *   CLAUDIN_VENDOR_ANTHROPIC_WIRE  0 = no Anthropic rows, all = unverified too
 * A pair the endpoint rejected on its first request falls back to chat for
 * the process (wireFallback.ts).
 */
import { isWireRejected, type FallbackWire } from 'src/providers/presets/wireFallback.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export type CompatWireKind = FallbackWire

export type CompatWireRow = {
  /** Names the row in debug lines and tests. */
  id: string
  wire: CompatWireKind
  /** The profile base URL's hostname, exact (a string) or matched (a RegExp). */
  host: string | RegExp
  /** A path prefix the base URL must carry too (Azure's `/openai/v1`). */
  path?: string
  /** Models the row applies to, tested against the lowercased model id. */
  models: RegExp
  verified: boolean
  /** The vendor's Anthropic base URL, for an `anthropic` row. */
  anthropicBaseUrl?: string
}

export type CompatWire =
  | { wire: 'chat' }
  | { wire: 'responses'; row: CompatWireRow }
  | { wire: 'anthropic'; row: CompatWireRow; baseUrl: string }

const CHAT: CompatWire = { wire: 'chat' }
const TRAILING_SLASH_RE = /\/+$/

// GPT-5 and every later major, as providerConfig's GPT_REASONING_FAMILY_RE.
const GPT_5_PLUS_RE = /^gpt-(?:[5-9]|[1-9]\d+)(?:[.-]|$)/
const GROK_4_PLUS_RE = /^grok-(?:[4-9]|[1-9]\d+)(?:[.-]|$)/

export const COMPAT_WIRES: readonly CompatWireRow[] = [
  // Recorded: cassettes/openai-responses (reasoning replayed under store:false).
  { id: 'openai', wire: 'responses', host: 'api.openai.com', models: GPT_5_PLUS_RE, verified: true },
  // Recorded: cassettes/azure (the v1 API, `?api-version=v1`).
  {
    id: 'azure-openai',
    wire: 'responses',
    host: /^[a-z0-9-]+\.openai\.azure\.com$/,
    path: '/openai/v1',
    models: GPT_5_PLUS_RE,
    verified: true,
  },
  { id: 'xai', wire: 'responses', host: 'api.x.ai', models: GROK_4_PLUS_RE, verified: false },
]

const ENV_OF: Record<CompatWireKind, string> = {
  responses: 'CLAUDIN_OPENAI_RESPONSES',
  anthropic: 'CLAUDIN_VENDOR_ANTHROPIC_WIRE',
}

function rowAllowed(row: CompatWireRow): boolean {
  const value = process.env[ENV_OF[row.wire]]
  if (isEnvDefinedFalsy(value)) return false
  return row.verified || value?.trim().toLowerCase() === 'all'
}

function hostMatches(row: CompatWireRow, hostname: string): boolean {
  return typeof row.host === 'string' ? row.host === hostname : row.host.test(hostname)
}

export function resolveCompatWire(
  baseUrl: string | undefined,
  model: string,
  rows: readonly CompatWireRow[] = COMPAT_WIRES,
): CompatWire {
  if (!baseUrl) return CHAT
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return CHAT
  }
  const hostname = url.hostname.toLowerCase()
  const path = url.pathname.replace(TRAILING_SLASH_RE, '')
  const id = model.trim().toLowerCase()
  for (const row of rows) {
    if (!hostMatches(row, hostname)) continue
    if (row.path && !path.startsWith(row.path)) continue
    if (!row.models.test(id)) continue
    if (!rowAllowed(row)) continue
    if (isWireRejected(row.wire, baseUrl, model)) continue
    if (row.wire === 'anthropic' && row.anthropicBaseUrl) {
      return { wire: 'anthropic', row, baseUrl: row.anthropicBaseUrl }
    }
    if (row.wire === 'responses') return { wire: 'responses', row }
  }
  return CHAT
}
