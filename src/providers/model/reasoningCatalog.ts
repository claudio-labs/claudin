/**
 * Which reasoning-effort levels a given (endpoint, model) pair accepts, and
 * which field carries them on the wire.
 *
 * Claudin used to answer the first question with an allowlist of model-name
 * fragments in `modelSupportsEffort`, and the second one nowhere at all: the
 * only `reasoning_effort` write in the OpenAI shim sat inside the DeepSeek
 * host branch. The picker and the request body therefore disagreed — a
 * gateway model could show "Xhigh effort" while the body carried no effort
 * field of any kind. This module is the single answer both of them read.
 *
 * The LEVELS come from models.dev's per-model `reasoning_options`, vendored by
 * `scripts/codegen/reasoning-catalog.ts` (see reasoningCatalogData.ts). That
 * data is per-model precise in a way no name pattern can be: `glm-5.3-flash`
 * accepts `low|high|max` and not `medium`, while `glm-5.1` on the same gateway
 * accepts nothing at all. The WIRE SHAPE is the small table below, because no
 * catalog publishes it.
 *
 * A model absent from the catalog gets NO effort control — not a guess. The
 * manual escape hatches stay available for anything the snapshot has not
 * caught up with: a `?reasoning=high` suffix on the model name, or
 * `extras.reasoningEffort` on the profile, both of which reach
 * `request.reasoning.effort` directly.
 *
 * Killswitch: `CLAUDIN_DISABLE_REASONING_EFFORT_WIRE=1` makes every lookup
 * report "no capability", which restores the pre-catalog behavior — no effort
 * on the wire for OpenAI-compatible providers, and no effort in the picker.
 */
import {
  CATALOG_MODEL_EFFORTS,
  CATALOG_PROVIDER_ENDPOINTS,
} from 'src/providers/model/reasoningCatalogData.js'
import { getRefreshedCatalog } from 'src/providers/model/reasoningCatalogRefresh.js'
import type {
  CatalogEffortValue,
  CatalogEndpoint,
} from 'src/providers/model/reasoningCatalogTrim.js'
import { activeTransportUsesOpenAiShim } from 'src/providers/model/providers.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  supportsCodexReasoningEffort,
  type ReasoningEffort,
} from 'src/providers/presets/providerConfig.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

export type { CatalogEffortValue }

type ModelEfforts = Readonly<Record<string, readonly CatalogEffortValue[]>>

/**
 * The vendored snapshot, unless the opt-in refresh has a cached copy. The
 * substitution is per PROVIDER, not per model: a provider the refresh knows
 * about replaces the snapshot's row for it wholesale, so a model dropped
 * upstream disappears here too instead of lingering as a merge artifact.
 */
function endpointTable(): readonly CatalogEndpoint[] {
  return getRefreshedCatalog()?.endpoints ?? CATALOG_PROVIDER_ENDPOINTS
}

function effortsFor(providerId: string): ModelEfforts | undefined {
  const refreshed = getRefreshedCatalog()?.efforts[providerId]
  return refreshed ?? CATALOG_MODEL_EFFORTS[providerId]
}

/**
 * Hosts whose catalog entry carries no `api` URL, because models.dev reaches
 * them through a first-party SDK rather than an OpenAI-compatible base. Each
 * predicate mirrors one that already exists elsewhere in the tree
 * (`isOfficialOpenAIUrl`, the Azure hostname test in the shim,
 * `hasGeminiApiHost`) — kept here as a table so the catalog id is the only
 * thing a new endpoint has to supply.
 */
const HOST_PROVIDER_IDS: ReadonlyArray<{
  id: string
  matches: (hostname: string) => boolean
}> = [
  {
    id: 'openai',
    matches: h => h === 'api.openai.com' || h.endsWith('.api.openai.com'),
  },
  {
    id: 'azure',
    matches: h =>
      h.endsWith('.openai.azure.com') ||
      h.endsWith('.cognitiveservices.azure.com') ||
      h.endsWith('.services.ai.azure.com'),
  },
  { id: 'google', matches: h => h === 'generativelanguage.googleapis.com' },
  { id: 'google-vertex', matches: h => VERTEX_HOST_RE.test(h) },
  { id: 'groq', matches: h => h === 'api.groq.com' },
  { id: 'togetherai', matches: h => h === 'api.together.xyz' },
  { id: 'mistral', matches: h => h === 'api.mistral.ai' },
  { id: 'cloudflare-ai-gateway', matches: h => h === 'gateway.ai.cloudflare.com' },
]

/**
 * Providers whose effort already has a hand-written branch in the OpenAI shim
 * with its OWN dialect — DeepSeek pairs `reasoning_effort` with a `thinking`
 * toggle, Kimi Code sends `thinking.effort` instead. They stay out of the
 * generic lane so nothing is written twice; their branches, and the tests that
 * pin them, are untouched.
 */
const SHIM_OWNED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'deepseek',
  'moonshotai',
])

/** OpenRouter documents `reasoning_effort` as an alias, but `reasoning.effort` is canonical. */
const NESTED_REASONING_PROVIDER_IDS: ReadonlySet<string> = new Set(['openrouter'])

export type ReasoningEffortWire = 'reasoning_effort' | 'reasoning.effort'

/**
 * Vertex is regional — `us-central1-aiplatform.googleapis.com` — with a bare
 * `aiplatform.googleapis.com` for the global endpoint. Anchored at both ends on
 * purpose: `endsWith('aiplatform.googleapis.com')`, and even
 * `endsWith('-aiplatform.googleapis.com')`, accept an arbitrary host in front
 * (CodeQL js/incomplete-url-substring-sanitization). Every other host test in
 * the table above carries a leading dot, which is the same boundary by other
 * means.
 */
const VERTEX_HOST_RE = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/

function isDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_DISABLE_REASONING_EFFORT_WIRE)
}

function matchesSegments(
  actual: readonly string[],
  expected: ReadonlyArray<string | null>,
): boolean {
  if (actual.length < expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]
    if (want === null) continue
    if (actual[i] !== want) return false
  }
  return true
}

/**
 * The models.dev provider id an endpoint belongs to, or undefined when no row
 * claims it. Endpoints are pre-sorted longest-path-first by the codegen, so
 * `api.z.ai/api/coding/paas/v4` resolves to the coding plan rather than to the
 * general `api.z.ai/api/paas/v4` row that also matches its host.
 */
export function resolveCatalogProviderId(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  const hostname = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean).map(s => s.toLowerCase())

  for (const endpoint of endpointTable()) {
    if (endpoint.host === hostname && matchesSegments(segments, endpoint.segments)) {
      return endpoint.id
    }
  }
  for (const entry of HOST_PROVIDER_IDS) {
    if (entry.matches(hostname)) return entry.id
  }
  return undefined
}

/** Model ids may carry the `?reasoning=…` descriptor suffix; the catalog keys do not. */
function baseModelId(model: string): string {
  const trimmed = model.trim()
  const queryIndex = trimmed.indexOf('?')
  return queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex).trim()
}

/**
 * Case-insensitive fallback index, keyed on the model record itself so the
 * vendored table and a refreshed one never share an entry. Discovery echoes
 * whatever casing the provider's `/models` returned, and catalog ids are
 * case-sensitive (`MiniMax-M2.5`, `Qwen/Qwen3.5-9B`, `@cf/qwen/…`).
 */
const lowercaseIndexes = new WeakMap<
  ModelEfforts,
  ReadonlyMap<string, readonly CatalogEffortValue[]>
>()

function lowercaseIndexFor(
  models: ModelEfforts,
): ReadonlyMap<string, readonly CatalogEffortValue[]> {
  const cached = lowercaseIndexes.get(models)
  if (cached) return cached
  const index = new Map<string, readonly CatalogEffortValue[]>()
  for (const [id, values] of Object.entries(models)) {
    index.set(id.toLowerCase(), values)
  }
  lowercaseIndexes.set(models, index)
  return index
}

/**
 * The effort levels this model accepts on this endpoint, or undefined when the
 * catalog declares none — which covers three different upstream states that
 * all mean the same thing here: the model is absent, it declares an empty
 * `reasoning_options`, or its only option is a `toggle`/`budget_tokens` that
 * this round does not implement.
 */
export function lookupReasoningEffortValues(
  baseUrl: string | undefined,
  model: string,
): readonly CatalogEffortValue[] | undefined {
  if (isDisabled()) return undefined
  const providerId = resolveCatalogProviderId(baseUrl)
  if (!providerId || SHIM_OWNED_PROVIDER_IDS.has(providerId)) return undefined

  const models = effortsFor(providerId)
  if (!models) return undefined

  const id = baseModelId(model)
  return models[id] ?? lowercaseIndexFor(models).get(id.toLowerCase())
}

/**
 * The GPT-5 family's levels, for an endpoint the catalog does not list. Claudin
 * already claims elsewhere that a `gpt-5*` id takes an effort parameter
 * (`supportsCodexReasoningEffort`, which also covers the Codex aliases); this
 * is that claim's level list, so a self-hosted proxy in front of OpenAI keeps
 * working instead of silently losing the control it had.
 */
const OPENAI_FAMILY_LEVELS: readonly CatalogEffortValue[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

/**
 * THE resolver for a request that goes out through the OpenAI shim — the one
 * function the picker and the wire both call, which is what keeps them from
 * disagreeing. Precedence: the catalog, then the GPT-5 family fallback.
 *
 * Returns undefined when nothing offers a level Claudin can show. A row whose
 * only level is `none`/`minimal`/`default` counts as nothing: those mean "think
 * less or not at all", which this UI already spells `adaptive`, so offering
 * them as a level would be a second control for one behavior.
 */
export function resolveShimEffortValues(
  baseUrl: string | undefined,
  model: string,
): readonly CatalogEffortValue[] | undefined {
  if (isDisabled()) return undefined
  const providerId = resolveCatalogProviderId(baseUrl)
  // DeepSeek and Kimi Code own their dialect in the shim already.
  if (providerId && SHIM_OWNED_PROVIDER_IDS.has(providerId)) return undefined

  const values =
    lookupReasoningEffortValues(baseUrl, model) ??
    (supportsCodexReasoningEffort(model) ? OPENAI_FAMILY_LEVELS : undefined)

  if (!values || pickerEffortLevels(values).length === 0) return undefined
  return values
}

/**
 * {@link resolveShimEffortValues} against the profile the session is running
 * on, for the UI side — `modelSupportsEffort` and `getAvailableEffortLevels`
 * hold a model name and nothing else. Native-transport requests
 * (anthropic/bedrock/vertex/foundry, and Copilot running a Claude model) never
 * reach the shim, so they keep their own effort path and are excluded here.
 */
export function resolveActiveShimEffortValues(
  model: string,
): readonly CatalogEffortValue[] | undefined {
  if (!activeTransportUsesOpenAiShim(model)) return undefined
  return resolveShimEffortValues(tryGetActiveProvider()?.baseUrl, model)
}

/** Which field carries the effort for this endpoint. */
export function reasoningEffortWireFor(baseUrl: string | undefined): ReasoningEffortWire {
  const providerId = resolveCatalogProviderId(baseUrl)
  return providerId && NESTED_REASONING_PROVIDER_IDS.has(providerId)
    ? 'reasoning.effort'
    : 'reasoning_effort'
}

/**
 * Claudin's own ladder, used to pick a neighbour when the level the user holds
 * is not one this model accepts. `none`/`minimal`/`default` sit below `low`
 * because they mean progressively less thinking; they are never a *target*
 * (the picker filters them out — "send nothing" is spelled `adaptive` here),
 * only a landing spot for a downward clamp on a model that offers nothing else.
 */
const EFFORT_ORDER: readonly CatalogEffortValue[] = [
  'none',
  'minimal',
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function rank(value: string): number {
  const index = EFFORT_ORDER.indexOf(value as CatalogEffortValue)
  return index === -1 ? EFFORT_ORDER.indexOf('high') : index
}

/**
 * Snap an effort onto the levels a model actually accepts, preferring the
 * closest one at or below it and falling back to the closest above. Sending
 * `medium` to a `glm-5.3-flash` (which takes `low|high|max`) is a 400; this is
 * what makes a session effort carried over from another model survive the
 * switch.
 */
export function clampEffortToValues(
  effort: string,
  values: readonly CatalogEffortValue[],
): CatalogEffortValue | undefined {
  if (values.length === 0) return undefined
  if ((values as readonly string[]).includes(effort)) return effort as CatalogEffortValue
  const target = rank(effort)
  const sorted = [...values].sort((a, b) => rank(a) - rank(b))
  const below = sorted.filter(value => rank(value) <= target).pop()
  return below ?? sorted[0]
}

/**
 * The levels to offer in the picker: the catalog's list minus the ones Claudin
 * has no UI for. `none`, `minimal` and `default` are dropped because the
 * "don't pin an effort" choice is already `adaptive`, and a second spelling of
 * it in the level list would be two controls for one behavior.
 */
export function pickerEffortLevels(
  values: readonly CatalogEffortValue[],
): ReasoningEffort[] {
  const OFFERED: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  return OFFERED.filter(level => (values as readonly string[]).includes(level))
}
