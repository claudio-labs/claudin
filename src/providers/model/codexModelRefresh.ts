/**
 * The ChatGPT account's own model list on the Codex backend.
 *
 * `GET /backend-api/codex/models?client_version=…` answers what this account
 * and plan may use, the way the Codex CLI asks for it (its models_cache.json):
 * on 2026-11-24 a free plan got gpt-6-luna, gpt-5.6-terra and gpt-5.6-luna,
 * while the paid plans also get the gpt-6.x models. The list is fetched at
 * startup, after a Codex login and when the active profile changes, and handed
 * to setCodexAccountModels (codexModelCatalog.ts). The catalog's snapshot
 * answers until then, and whenever the fetch fails.
 *
 * Killswitch: CLAUDIN_CODEX_MODELS_FETCH=0 never asks; the snapshot answers.
 */
import { z } from 'zod/v4'

import { onGlobalConfigChange } from 'src/platform/config/config.js'
import {
  setCodexAccountModels,
  type CodexModelEntry,
} from 'src/providers/model/codexModelCatalog.js'
import {
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
} from 'src/providers/oauth/codexCredentials.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  resolveRuntimeCodexCredentials,
  type ReasoningEffort,
} from 'src/providers/presets/providerConfig.js'
import { activeSessionOnCodexBackend } from 'src/providers/shims/codex/backend.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

/**
 * The client version the list is asked for. The backend leaves out a model
 * whose `minimal_client_version` is newer (gpt-6.2-* needs 0.166.0), and
 * answers 400 without one. Raise it with the Codex wire captures.
 */
export const CODEX_MODELS_CLIENT_VERSION = '0.172.0'

const FETCH_TIMEOUT_MS = 5000

const ACCOUNT_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max'])

// Only what is read; the backend sends some forty more fields per model.
const CodexModelsResponseSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      description: z.string().nullish(),
      visibility: z.string().nullish(),
      priority: z.number().nullish(),
      default_reasoning_level: z.string().nullish(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() })).nullish(),
      context_window: z.number().int().positive().nullish(),
    }),
  ),
})

type CodexApiModel = z.infer<typeof CodexModelsResponseSchema>['models'][number]

export type CodexModelsDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** The bearer and the ChatGPT account id the request goes out with. */
  credentials: () => Promise<{ apiKey: string; accountId?: string }>
}

function isAccountEffort(value: string | null | undefined): value is ReasoningEffort {
  return typeof value === 'string' && ACCOUNT_EFFORTS.has(value)
}

/**
 * What the picker lists: the models the account shows (`visibility: list`),
 * in its priority order. A model without a window is left out, since the
 * window is what the account record is for. `ultra` is left out of the levels
 * (see CodexAccountLimits).
 */
export function toCodexAccountModels(models: readonly CodexApiModel[]): CodexModelEntry[] {
  return models
    .filter(model => model.visibility === 'list' && model.context_window)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(model => {
      const defaultEffort = isAccountEffort(model.default_reasoning_level)
        ? model.default_reasoning_level
        : undefined
      return {
        id: model.slug,
        label: model.slug,
        description: model.description?.trim() || model.slug,
        account: {
          contextWindow: model.context_window as number,
          effortLevels: (model.supported_reasoning_levels ?? [])
            .map(level => level.effort)
            .filter(isAccountEffort),
          ...(defaultEffort && { defaultEffort }),
        },
      }
    })
}

async function activeCodexCredentials(): Promise<{ apiKey: string; accountId?: string }> {
  const refreshResult = await refreshCodexAccessTokenIfNeeded().catch(async error => {
    logForDebugging(
      `[codex] access token refresh failed before the models fetch: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return { refreshed: false, credentials: await readCodexCredentialsAsync() }
  })
  return resolveRuntimeCodexCredentials({ storedCredentials: refreshResult.credentials })
}

const DEFAULT_DEPS: CodexModelsDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  credentials: activeCodexCredentials,
}

/** The active Codex profile's list, or null when it is not on the backend or the backend did not answer one. */
export async function fetchCodexAccountModels(
  deps: CodexModelsDeps = DEFAULT_DEPS,
): Promise<CodexModelEntry[] | null> {
  const provider = tryGetActiveProvider()
  if (!provider || !activeSessionOnCodexBackend()) return null
  try {
    const credentials = await deps.credentials()
    if (!credentials.apiKey || !credentials.accountId) return null
    const url = new URL('/backend-api/codex/models', provider.baseUrl)
    url.searchParams.set('client_version', CODEX_MODELS_CLIENT_VERSION)
    const response = await deps.fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
        'chatgpt-account-id': credentials.accountId,
        originator: 'claudin',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      logForDebugging(`[codex] models list answered ${response.status}; the snapshot stays`)
      return null
    }
    const parsed = CodexModelsResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      logForDebugging('[codex] models list did not parse; the snapshot stays')
      return null
    }
    const entries = toCodexAccountModels(parsed.data.models)
    return entries.length > 0 ? entries : null
  } catch (error) {
    logForDebugging(
      `[codex] models list fetch failed; the snapshot stays: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function isFetchEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_CODEX_MODELS_FETCH)
}

/** Which account list is wanted now: the active Codex profile's, or none. */
function activeKey(): string | null {
  if (!isFetchEnabled() || !activeSessionOnCodexBackend()) return null
  const provider = tryGetActiveProvider()
  return provider ? `${provider.profileId ?? provider.name}|${provider.baseUrl}` : null
}

// The key the list in the catalog belongs to, and the last one asked for: a
// failed fetch is not retried on every config save, only on the next change.
let committedKey: string | null = null
let requestedKey: string | null = null
let fetchPromise: Promise<void> | null = null
let fetchKey: string | null = null
let listenerInstalled = false

function ensureListenerInstalled(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  onGlobalConfigChange(() => {
    if (activeKey() !== requestedKey) void prefetchCodexAccountModels()
  })
}

/**
 * Fetch the active Codex profile's list into the catalog. A profile switch
 * drops the previous list first; `force` asks again for the same profile, as
 * after a login, where the account may have changed.
 */
export function prefetchCodexAccountModels(options: { force?: boolean } = {}): Promise<void> {
  // Resolve the profile before listening, so the active-provider cache's own
  // config listener is installed first and has been invalidated by the time
  // this one reads it.
  const key = activeKey()
  ensureListenerInstalled()
  if (key !== committedKey || options.force) {
    setCodexAccountModels(null)
    committedKey = null
  }
  requestedKey = key
  if (!key || committedKey === key) return Promise.resolve()
  if (fetchPromise) {
    if (fetchKey === key && !options.force) return fetchPromise
    // The fetch in flight is for another profile (its result is dropped at
    // commit time below), or it predates a login. Ask again once it settles.
    return fetchPromise.finally(() => prefetchCodexAccountModels(options))
  }
  fetchKey = key
  fetchPromise = fetchCodexAccountModels()
    .then(entries => {
      if (entries && activeKey() === key) {
        setCodexAccountModels(entries)
        committedKey = key
      }
    })
    .finally(() => {
      fetchPromise = null
      fetchKey = null
    })
  return fetchPromise
}

/** Test-only: forget what was fetched, and which profile it was for. */
export function _resetCodexAccountModelsForTesting(): void {
  setCodexAccountModels(null)
  committedKey = null
  requestedKey = null
  fetchPromise = null
  fetchKey = null
}
