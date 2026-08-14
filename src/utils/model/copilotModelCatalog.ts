/**
 * Dynamic GitHub Copilot model catalog.
 *
 * Fetches `GET {baseUrl}/models` for the active Copilot account and caches
 * the result so synchronous consumers (model picker, display names, context
 * windows, native-Anthropic routing) can use the account's real model list —
 * including entitlements (`model_picker_enabled`, `policy`) and
 * `supported_endpoints` — instead of the hardcoded snapshot in
 * `copilotModels.ts`. The snapshot remains the fallback whenever the fetch
 * fails or hasn't completed yet, so nothing regresses offline.
 */

import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { COPILOT_HEADERS } from 'src/services/api/openaiShim/constants.js'
import { getGithubEndpointType } from 'src/services/api/providerConfig.js'
import { onGlobalConfigChange } from 'src/services/config/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  COPILOT_MODELS,
  getAllCopilotModels,
  type CopilotModel,
} from './copilotModels.js'

const CATALOG_TIMEOUT_MS = 5000

export type CopilotCatalogEntry = {
  model: CopilotModel
  /** From the API's `supported_endpoints`; null when the field is absent. */
  supportedEndpoints: string[] | null
  /** `model_picker_enabled` — dated snapshots and internal routes are false. */
  pickerEnabled: boolean
}

type CopilotApiModel = {
  id?: string | null
  name?: string | null
  model_picker_enabled?: boolean | null
  supported_endpoints?: unknown
  policy?: { state?: string | null } | null
  capabilities?: {
    family?: string | null
    type?: string | null
    limits?: {
      max_context_window_tokens?: number | null
      max_output_tokens?: number | null
      max_prompt_tokens?: number | null
      vision?: object | null
    } | null
    supports?: {
      tool_calls?: boolean | null
      vision?: boolean | null
      adaptive_thinking?: boolean | null
      reasoning_effort?: unknown
      max_thinking_budget?: number | null
    } | null
  } | null
}

let cachedCatalog: CopilotCatalogEntry[] | null = null
// Base URL the cached catalog was fetched from — a github.com ↔ enterprise
// switch must not answer from the previous account's entitlements.
let cachedCatalogBaseUrl: string | null = null
let fetchPromise: Promise<void> | null = null
// Endpoint the in-flight fetch targets, so an endpoint switch mid-flight can
// be detected and a refetch chained.
let fetchBaseUrl: string | null = null
let configListenerInstalled = false

/** Copilot endpoint of the active profile, or null when Copilot isn't active. */
function resolveActiveCopilotBaseUrl(): string | null {
  const provider = tryGetActiveProvider()
  if (provider?.transport !== 'github_copilot') return null
  return (provider.baseUrl || 'https://api.githubcopilot.com').replace(
    /\/+$/,
    '',
  )
}

/**
 * The cache is only consultable when it was fetched from the endpoint the
 * active profile points at — this makes stale data unreachable both for
 * non-Copilot providers and across Copilot profile/account switches.
 */
function isCatalogUsableForActiveProvider(): boolean {
  if (!cachedCatalog) return false
  const baseUrl = resolveActiveCopilotBaseUrl()
  return baseUrl !== null && cachedCatalogBaseUrl === baseUrl
}

// Mid-session /provider switches don't pass through startup or the sign-in
// flow — refresh the catalog when the active Copilot endpoint changes.
// Same invalidation pattern as activeProvider.ts.
function ensureConfigListenerInstalled(): void {
  if (configListenerInstalled) return
  configListenerInstalled = true
  onGlobalConfigChange(() => {
    const baseUrl = resolveActiveCopilotBaseUrl()
    if (baseUrl && cachedCatalogBaseUrl !== baseUrl) {
      prefetchCopilotModelCatalog()
    }
  })
}

/**
 * Reduce any model spelling to the bare Copilot model id:
 * "github:copilot:claude-sonnet-4.6" → "claude-sonnet-4.6",
 * "openai/gpt-4.1" → "gpt-4.1", query params stripped.
 */
export function normalizeBareCopilotModelId(model: string): string {
  const noQuery = model.split('?', 1)[0] ?? model
  const lastColon = noQuery.lastIndexOf(':')
  const segment = (lastColon === -1 ? noQuery : noQuery.slice(lastColon + 1)).trim()
  const slashIndex = segment.indexOf('/')
  return slashIndex === -1 ? segment : segment.slice(slashIndex + 1)
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is string => typeof v === 'string')
}

function mapApiModel(raw: CopilotApiModel): CopilotCatalogEntry | null {
  const id = raw.id?.trim()
  if (!id) return null
  // Only chat-capable entries — the endpoint also lists embeddings models.
  const capType = raw.capabilities?.type?.trim().toLowerCase()
  if (capType && capType !== 'chat') return null
  if (raw.policy?.state === 'disabled') return null

  const limits = raw.capabilities?.limits ?? {}
  const supports = raw.capabilities?.supports ?? {}
  const vision = supports.vision === true || Boolean(limits.vision)
  const reasoning =
    supports.adaptive_thinking === true ||
    Array.isArray(supports.reasoning_effort) ||
    typeof supports.max_thinking_budget === 'number'

  const model: CopilotModel = {
    id,
    name: raw.name?.trim() || id,
    family: raw.capabilities?.family?.trim() || id,
    attachment: vision,
    reasoning,
    tool_call: supports.tool_calls === true,
    temperature: true,
    knowledge: '',
    release_date: '',
    last_updated: '',
    modalities: {
      input: vision ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: {
      context: limits.max_context_window_tokens ?? 128_000,
      ...(typeof limits.max_prompt_tokens === 'number'
        ? { input: limits.max_prompt_tokens }
        : {}),
      output: limits.max_output_tokens ?? 16_384,
    },
  }

  return {
    model,
    supportedEndpoints: toStringArray(raw.supported_endpoints),
    pickerEnabled: raw.model_picker_enabled !== false,
  }
}

export async function fetchCopilotModelCatalog(): Promise<
  CopilotCatalogEntry[] | null
> {
  const provider = tryGetActiveProvider()
  if (provider?.transport !== 'github_copilot') return null
  if (getGithubEndpointType(provider.baseUrl) !== 'copilot') return null
  const token = provider.extras?.githubToken ?? provider.apiKey
  if (!token) return null

  const baseUrl = (provider.baseUrl || 'https://api.githubcopilot.com').replace(
    /\/+$/,
    '',
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = (await response.json()) as { data?: CopilotApiModel[] }
    if (!Array.isArray(data?.data)) return null

    const seen = new Set<string>()
    const entries: CopilotCatalogEntry[] = []
    for (const raw of data.data) {
      const entry = mapApiModel(raw)
      if (!entry || seen.has(entry.model.id)) continue
      seen.add(entry.model.id)
      entries.push(entry)
    }
    return entries.length > 0 ? entries : null
  } catch {
    logForDebugging('[CopilotCatalog] /models fetch failed — using hardcoded registry')
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Prefetch and cache the catalog. Call at startup / after Copilot sign-in. */
export function prefetchCopilotModelCatalog(): void {
  ensureConfigListenerInstalled()
  const baseUrl = resolveActiveCopilotBaseUrl()
  if (!baseUrl) return
  if (cachedCatalog && cachedCatalogBaseUrl !== baseUrl) {
    // Endpoint/account switched — the name-heuristic fallbacks are better
    // than answering from the previous account's catalog while we refetch.
    cachedCatalog = null
    cachedCatalogBaseUrl = null
  }
  if (fetchPromise) {
    if (fetchBaseUrl === baseUrl) return
    // The in-flight fetch targets the previous endpoint; its result is
    // discarded by the commit-time check below — refetch once it settles.
    fetchPromise.finally(() => prefetchCopilotModelCatalog())
    return
  }
  fetchBaseUrl = baseUrl
  fetchPromise = fetchCopilotModelCatalog()
    .then(entries => {
      // Commit only if the active endpoint still matches what was fetched —
      // a sign-in or profile switch mid-flight must not poison the cache.
      if (entries && resolveActiveCopilotBaseUrl() === baseUrl) {
        cachedCatalog = entries
        cachedCatalogBaseUrl = baseUrl
      }
    })
    .finally(() => {
      fetchPromise = null
      fetchBaseUrl = null
    })
}


/**
 * Models for the /model picker: the account's live picker-enabled list when
 * fetched, else the hardcoded snapshot.
 */
export function getEffectiveCopilotModels(): CopilotModel[] {
  if (isCatalogUsableForActiveProvider()) {
    const live = cachedCatalog?.filter(e => e.pickerEnabled).map(e => e.model)
    if (live && live.length > 0) return live
  }
  return getAllCopilotModels()
}

function findCatalogEntry(model: string): CopilotCatalogEntry | undefined {
  // The catalog only describes one Copilot endpoint: when another provider —
  // or another Copilot profile/account — is active, generic lookups (context
  // windows, display names) must not resolve from a stale snapshot.
  if (!isCatalogUsableForActiveProvider()) return undefined
  const bare = normalizeBareCopilotModelId(model)
  return cachedCatalog!.find(e => e.model.id === bare)
}

/** Catalog-first display-name lookup (falls back to the hardcoded registry). */
export function getCopilotDisplayName(model: string): string | undefined {
  const bare = normalizeBareCopilotModelId(model)
  return findCatalogEntry(bare)?.model.name ?? COPILOT_MODELS[bare]?.name
}

/**
 * Whether the account's catalog says this model speaks Anthropic's
 * `/v1/messages`. Returns null when unknown (no catalog yet, model missing,
 * or `supported_endpoints` absent) — callers should fall back to heuristics.
 */
export function copilotModelSupportsAnthropicMessages(
  model: string,
): boolean | null {
  const entry = findCatalogEntry(model)
  if (!entry || entry.supportedEndpoints === null) return null
  return entry.supportedEndpoints.some(e => e.includes('/v1/messages'))
}

/** Context window from the live catalog; undefined when not fetched/known. */
export function getCatalogCopilotContextWindow(model: string): number | undefined {
  return findCatalogEntry(model)?.model.limit.context
}

/** Max output tokens from the live catalog; undefined when not fetched/known. */
export function getCatalogCopilotMaxOutputTokens(
  model: string,
): number | undefined {
  return findCatalogEntry(model)?.model.limit.output
}

/** Test-only: seed or clear the cached catalog (tagged to the active endpoint). */
export function _setCopilotCatalogForTesting(
  entries: CopilotCatalogEntry[] | null,
): void {
  cachedCatalog = entries
  cachedCatalogBaseUrl = entries ? resolveActiveCopilotBaseUrl() : null
}
