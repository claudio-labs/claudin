/**
 * Which wire a request of an OpenAI-compatible profile goes out on.
 *
 * Every such profile speaks Chat Completions unless a row here names its host
 * and model: `responses` sends it to the host's Responses API
 * (`openai_responses`, providerConfig.ts), `anthropic` to the vendor's
 * Anthropic Messages endpoint (shims/vendorAnthropic/). The profile keeps its own
 * base URL either way — usage, limits and family addenda read it — and the
 * row says where the other wire lives.
 *
 * A row is `verified` when a recording of that host proves the wire
 * (src/providers/__fixtures__/cassettes/) for the models it names; the same
 * host's other models sit in an unverified row. An unverified row stays off
 * unless its kind's env asks for every row:
 *   CLAUDIN_OPENAI_RESPONSES       0 = no Responses rows, all = unverified too
 *   CLAUDIN_VENDOR_ANTHROPIC_WIRE  0 = no Anthropic rows, all = unverified too
 * A pair the endpoint rejected on its first request falls back to chat for
 * the process (wireFallback.ts).
 */
import { isWireRejected } from 'src/providers/presets/wireFallback.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export type CompatWireKind = 'responses' | 'anthropic'

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
// The recorded models, then each family as a whole.
const MINIMAX_M3_RE = /^minimax-m3(?:[.-]|$)/
const KIMI_K3_RE = /^(?:kimi-)?k3(?:[.-]|$)/
const QWEN_3_7_OR_3_8_RE = /^qwen3\.[78](?:[.-]|$)/
const MINIMAX_RE = /^minimax-m\d/
const KIMI_RE = /^(?:kimi-)?k\d/
const QWEN_RE = /^qwen/

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

  // Recorded: cassettes/minimax-messages, anthropic-compatible-messages (M3).
  {
    id: 'minimax',
    wire: 'anthropic',
    host: 'api.minimax.io',
    models: MINIMAX_M3_RE,
    verified: true,
    anthropicBaseUrl: 'https://api.minimax.io/anthropic',
  },
  // Recorded: cassettes/moonshot-messages (kimi-k3, through a tool loop).
  {
    id: 'moonshot',
    wire: 'anthropic',
    host: 'api.moonshot.ai',
    models: KIMI_K3_RE,
    verified: true,
    anthropicBaseUrl: 'https://api.moonshot.ai/anthropic',
  },
  // Recorded: cassettes/alibaba-messages (qwen3.7-plus, qwen3.8-max, pay-as-you-go intl).
  {
    id: 'dashscope-intl',
    wire: 'anthropic',
    host: 'dashscope-intl.aliyuncs.com',
    models: QWEN_3_7_OR_3_8_RE,
    verified: true,
    anthropicBaseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
  },
  // The same hosts' other models, and the hosts from the vendors' docs: never recorded.
  { id: 'minimax-other', wire: 'anthropic', host: 'api.minimax.io', models: MINIMAX_RE, verified: false, anthropicBaseUrl: 'https://api.minimax.io/anthropic' },
  { id: 'moonshot-other', wire: 'anthropic', host: 'api.moonshot.ai', models: KIMI_RE, verified: false, anthropicBaseUrl: 'https://api.moonshot.ai/anthropic' },
  { id: 'dashscope-intl-other', wire: 'anthropic', host: 'dashscope-intl.aliyuncs.com', models: QWEN_RE, verified: false, anthropicBaseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic' },
  { id: 'minimax-cn', wire: 'anthropic', host: 'api.minimaxi.com', models: MINIMAX_RE, verified: false, anthropicBaseUrl: 'https://api.minimaxi.com/anthropic' },
  { id: 'moonshot-cn', wire: 'anthropic', host: 'api.moonshot.cn', models: KIMI_RE, verified: false, anthropicBaseUrl: 'https://api.moonshot.cn/anthropic' },
  { id: 'dashscope-cn', wire: 'anthropic', host: 'dashscope.aliyuncs.com', models: QWEN_RE, verified: false, anthropicBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
  {
    id: 'dashscope-coding-intl',
    wire: 'anthropic',
    host: 'coding-intl.dashscope.aliyuncs.com',
    models: QWEN_RE,
    verified: false,
    anthropicBaseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
  },
  {
    id: 'dashscope-coding-cn',
    wire: 'anthropic',
    host: 'coding.dashscope.aliyuncs.com',
    models: QWEN_RE,
    verified: false,
    anthropicBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
  },
  { id: 'zai', wire: 'anthropic', host: 'api.z.ai', models: /^glm-/, verified: false, anthropicBaseUrl: 'https://api.z.ai/api/anthropic' },
  { id: 'deepseek', wire: 'anthropic', host: 'api.deepseek.com', models: /^deepseek-/, verified: false, anthropicBaseUrl: 'https://api.deepseek.com/anthropic' },
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
