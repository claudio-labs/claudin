/**
 * Client SDK cache — avoids rebuilding Anthropic/Bedrock/Vertex/Foundry
 * client objects on every API call when the provider hasn't changed.
 *
 * Cache key is derived from the resolved provider transport, API key, base
 * URL, model override, the requested `maxRetries`, and the identity of any
 * `fetchOverride`. All of these change the constructed client, so they must
 * all discriminate the cache — otherwise one caller's client (e.g. a token
 * counter with SDK retries enabled, or a request with no `fetchOverride`)
 * could be handed back to a caller that needs different behavior.
 *
 * The store is keyed by that composite string so that interleaved call sites
 * (streaming on the primary model vs. token counting on the small/fast model)
 * don't evict each other.
 *
 * Single-flight dedup: if two concurrent calls request the same key, only one
 * `getAnthropicClient()` construction runs — the other awaits the same Promise.
 *
 * Invalidation is generation-based: an in-flight fill started before an
 * `invalidateClientCache()` (e.g. an OAuth refresh inside `withRetry`) will not
 * repopulate the cache with the now-stale client.
 */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { onGlobalConfigChange } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

interface CachedEntry {
  client: Anthropic
  createdAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes — covers short-lived OAuth tokens

const cache = new Map<string, CachedEntry>()

// Single-flight: in-flight construction promises, keyed the same way as `cache`.
const pendingFills = new Map<string, Promise<Anthropic>>()

// Bumped on every invalidation. A fill captures the generation it started in
// and only writes to `cache` if the generation is still current when it
// resolves — otherwise it would resurrect a stale client.
let generation = 0

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

type ClientParams = {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}

// `fetchOverride` is a function and can't be serialized into the key, so assign
// each distinct function a stable id and key by that. A WeakMap lets the ids be
// GC'd alongside the functions.
const fetchIds = new WeakMap<object, number>()
let nextFetchId = 1

function fetchIdentity(fetchOverride: ClientOptions['fetch'] | undefined): string {
  if (!fetchOverride) return 'none'
  let id = fetchIds.get(fetchOverride as object)
  if (id === undefined) {
    id = nextFetchId++
    fetchIds.set(fetchOverride as object, id)
  }
  return `fetch#${id}`
}

function buildCacheKey(params: ClientParams): string {
  const provider = tryGetActiveProvider()
  return [
    provider?.transport ?? 'none',
    // An explicit `apiKey` (e.g. `verifyApiKey` validating a candidate key that
    // differs from the active provider's) is the discriminator and takes
    // precedence over the provider's stored key.
    params.apiKey ?? provider?.apiKey ?? 'none',
    provider?.baseUrl ?? 'default',
    params.model ?? 'default',
    `r${params.maxRetries}`,
    fetchIdentity(params.fetchOverride),
  ].join('|')
}

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/** Called when provider changes or credentials are refreshed. */
export function invalidateClientCache(): void {
  generation++
  cache.clear()
  pendingFills.clear()
  logForDebugging('[clientCache] invalidated')
}

// Auto-invalidate on provider/config change
onGlobalConfigChange(() => {
  invalidateClientCache()
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Memoized version of `getAnthropicClient()`.
 *
 * Returns a cached client when the composite key matches and the entry is
 * within TTL. On cache miss, delegates to `getAnthropicClient()` and caches
 * the result. Concurrent calls for the same key share a single in-flight
 * promise (single-flight dedup), including on cold start.
 */
export async function getCachedAnthropicClient(
  getAnthropicClient: (params: ClientParams) => Promise<Anthropic>,
  params: ClientParams,
): Promise<Anthropic> {
  const key = buildCacheKey(params)
  const now = Date.now()

  // Cache hit — return immediately
  const hit = cache.get(key)
  if (hit) {
    if (now - hit.createdAt < CACHE_TTL_MS) {
      logForDebugging('[clientCache] hit')
      return hit.client
    }
    // Expired — drop it and fall through to a fresh construction.
    cache.delete(key)
  }

  // Single-flight: if another call is already filling this key, piggyback.
  const inflight = pendingFills.get(key)
  if (inflight) {
    logForDebugging('[clientCache] awaiting in-flight fill')
    return inflight
  }

  // Cache miss — delegate to the real factory.
  logForDebugging('[clientCache] miss — constructing new client')
  const fillGeneration = generation
  const fillPromise = getAnthropicClient(params)
    .then(client => {
      // Only populate if no invalidation happened during construction;
      // otherwise we'd resurrect a client built with stale credentials.
      if (generation === fillGeneration) {
        cache.set(key, { client, createdAt: Date.now() })
      }
      return client
    })
    .finally(() => {
      // Only clear our own pending entry — an invalidation may have already
      // replaced it with a newer fill that must not be removed.
      if (pendingFills.get(key) === fillPromise) {
        pendingFills.delete(key)
      }
    })
  pendingFills.set(key, fillPromise)

  return fillPromise
}
