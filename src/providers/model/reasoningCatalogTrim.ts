/**
 * Turns a raw models.dev `api.json` into the small shape Claudin keeps.
 *
 * Shared by two callers that must agree byte-for-byte on what "the catalog"
 * means: `scripts/codegen/reasoning-catalog.ts`, which vendors the result as
 * reasoningCatalogData.ts, and `reasoningCatalogRefresh.ts`, which writes the
 * same shape to the opt-in on-disk cache. A second implementation would drift,
 * and the drift would only show as a provider quietly losing its levels.
 *
 * Pure: no fs, no network, no env. Both shells do their own IO.
 */
import { z } from 'zod/v4'

/**
 * models.dev provider ids Claudin can reach through a `/provider` preset.
 * Keep in sync with getProviderPresetDefaults() in
 * src/providers/presets/providerProfiles.ts.
 *
 * DeepSeek and Moonshot are here for their ENDPOINTS only — a profile may
 * point at either, and the endpoint table is what tells the lookup to hand
 * them to the shim's own hand-written branches instead of the generic lane.
 */
const CATALOG_PROVIDER_IDS = [
  'alibaba',
  'alibaba-cn',
  'alibaba-coding-plan',
  'alibaba-coding-plan-cn',
  'azure',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'google',
  'google-vertex',
  'groq',
  'minimax',
  'minimax-coding-plan',
  'mistral',
  'moonshotai',
  'nvidia',
  'opencode',
  'opencode-go',
  'openai',
  'openrouter',
  'togetherai',
  'zai',
  'zai-coding-plan',
  'zhipuai',
  'zhipuai-coding-plan',
] as const

/** The enum models.dev validates `values` against. */
export const CATALOG_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'default',
] as const

export type CatalogEffortValue = (typeof CATALOG_EFFORT_VALUES)[number]

const ReasoningOption = z.union([
  z.object({ type: z.literal('toggle') }),
  z.object({
    type: z.literal('effort'),
    // A `null` entry means "send no effort field" — upstream carries it inside
    // the same list. Claudin spells that `adaptive`, not a level, so nulls are
    // dropped rather than mapped onto one.
    values: z.array(z.enum(CATALOG_EFFORT_VALUES).nullable()),
  }),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
])

const Model = z.object({
  reasoning_options: z.array(ReasoningOption).optional(),
})

const Provider = z.object({
  api: z.string().optional(),
  models: z.record(z.string(), Model).default({}),
})

// Only the providers we ship are validated against the schema above. The full
// catalog carries 200+ of them and any one can introduce a shape we do not
// model yet; failing over a provider Claudin cannot even reach would be a
// self-inflicted outage.
const RawCatalog = z.record(z.string(), z.unknown())

/**
 * A provider's own API base, split for matching. A `null` segment is an
 * upstream placeholder (an account id) and matches any single segment.
 */
export type CatalogEndpoint = {
  id: string
  host: string
  segments: ReadonlyArray<string | null>
}

export type TrimmedCatalog = {
  endpoints: CatalogEndpoint[]
  /** provider id → model id → accepted effort levels. */
  efforts: Record<string, Record<string, CatalogEffortValue[]>>
  /** Endpoints dropped because more than one provider claimed them. */
  ambiguous: string[]
}

/**
 * `${CLOUDFLARE_ACCOUNT_ID}` and friends are placeholders, not path text.
 * `new URL()` percent-encodes the braces, so decode before testing.
 */
const PLACEHOLDER_RE = /^\$\{[^}]*\}$/

function toEndpoint(id: string, api: string): CatalogEndpoint | undefined {
  let url: URL
  try {
    url = new URL(api)
  } catch {
    return undefined
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => {
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        /* a lone % — keep the raw segment */
      }
      return PLACEHOLDER_RE.test(decoded) ? null : decoded.toLowerCase()
    })
  return { id, host: url.hostname.toLowerCase(), segments }
}

function endpointKey(endpoint: CatalogEndpoint): string {
  return `${endpoint.host}/${endpoint.segments.join('/')}`
}

export function trimModelsDevCatalog(
  raw: unknown,
  providerIds: readonly string[] = CATALOG_PROVIDER_IDS,
): TrimmedCatalog {
  const catalog = RawCatalog.parse(raw)
  const endpoints: CatalogEndpoint[] = []
  const efforts: Record<string, Record<string, CatalogEffortValue[]>> = {}

  for (const id of [...providerIds].sort()) {
    const rawProvider = catalog[id]
    if (rawProvider === undefined) {
      throw new Error(
        `models.dev has no provider "${id}" — renamed or removed upstream; fix CATALOG_PROVIDER_IDS`,
      )
    }
    const provider = Provider.parse(rawProvider)
    if (provider.api) {
      const endpoint = toEndpoint(id, provider.api)
      if (endpoint) endpoints.push(endpoint)
    }

    const models: Record<string, CatalogEffortValue[]> = {}
    for (const [modelId, model] of Object.entries(provider.models)) {
      const effort = model.reasoning_options?.find(option => option.type === 'effort')
      if (!effort) continue
      const values = effort.values.filter(
        (value): value is CatalogEffortValue => value !== null,
      )
      if (values.length === 0) continue
      models[modelId] = values
    }
    if (Object.keys(models).length > 0) {
      efforts[id] = models
    }
  }

  // Two providers claiming the same base (minimax and minimax-coding-plan both
  // publish `api.minimax.io/anthropic/v1`) cannot be told apart from a URL, and
  // picking whichever sorted first would silently attribute one plan's models
  // to the other. Drop both — an unresolvable endpoint means "no row", which is
  // the fail-closed answer.
  const counts = new Map<string, number>()
  for (const endpoint of endpoints) {
    counts.set(endpointKey(endpoint), (counts.get(endpointKey(endpoint)) ?? 0) + 1)
  }
  const ambiguous = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort()

  // Longest path first, so /api/coding/paas/v4 wins over /api/paas/v4 on the
  // same host regardless of the order the catalog happens to list them in.
  const resolved = endpoints
    .filter(endpoint => counts.get(endpointKey(endpoint)) === 1)
    .sort(
      (a, b) =>
        b.segments.length - a.segments.length ||
        a.host.localeCompare(b.host) ||
        a.id.localeCompare(b.id),
    )

  return { endpoints: resolved, efforts, ambiguous }
}
