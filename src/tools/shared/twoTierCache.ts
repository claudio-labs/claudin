import { LRUCache } from 'lru-cache'
import { logError } from 'src/utils/log.js'

// Two-tier TTL cache with in-flight coalescing, observability counters,
// and stale-while-revalidate. Extracted from WebFetchTool to be shared
// with WebSearchTool. See the T5.10 design plan.
//
// Semantics:
//   - fresh (age < soft): served from cache as hit
//   - stale (soft <= age < hard): served from cache; a single background
//     refresh is scheduled (deduplicated via in-flight map)
//   - miss (age >= hard or no entry): blocking fetch
//
// If softTtlMs === hardTtlMs the stale window has width zero and the
// cache effectively runs in "no-stale" mode (no background refresh
// fires; soft expiry behaves identically to hard expiry). WebSearch
// uses this mode — search results are too volatile to serve stale.

export type CacheDecision = 'fresh' | 'stale' | 'miss'

// Pure helper, exported so the boundary is unit-testable without
// touching LRU internals or real timers.
export function decideCacheAction(
  entry: { fetchedAt: number } | undefined,
  now: number,
  softTtlMs: number,
  hardTtlMs: number,
): CacheDecision {
  if (!entry) return 'miss'
  const age = now - entry.fetchedAt
  if (age < softTtlMs) return 'fresh'
  if (age < hardTtlMs) return 'stale'
  return 'miss'
}

export type TwoTierStats = {
  hits: number
  stale: number
  misses: number
  coalesced: number
  refreshSuccess: number
  refreshFailure: number
}

export type TwoTierCacheOptions<V> = {
  // Name used in error logs and the refresh-timeout AbortError message.
  name: string
  softTtlMs: number
  // Set === softTtlMs for no-stale mode (search engines, anything where
  // serving slightly old data is worse than re-fetching).
  hardTtlMs: number
  // Either max (count) or maxSize (bytes) — mirrors lru-cache.
  max?: number
  maxSize?: number
  sizeOf?: (value: V) => number
  // Background refreshes that hang would pin a key in `inFlight` forever,
  // blocking every future caller for that key (foreground misses coalesce
  // onto the same dead promise). Default: 30s — well above realistic
  // network latency, below any human-perceptible UI freeze. Set to 0 to
  // disable (legacy behavior, not recommended).
  refreshTimeoutMs?: number
  // Cooldown after a background refresh failure: subsequent stale callers
  // for the same key serve from cache without re-dispatching the refresh
  // until the cooldown elapses. Prevents a failing upstream (e.g. 401,
  // 500) from amplifying one user retry into N network calls. Default
  // 30s. Set to 0 to disable. WebSearch (no-stale mode) is unaffected
  // since its stale branch is unreachable.
  refreshFailureCooldownMs?: number
  // Default: logError(err). Override for tests.
  onRefreshError?: (err: unknown) => void
  // Default: Date.now. Injectable for deterministic tests of TTL logic.
  clock?: () => number
}

export type TwoTierCache<K extends string, V> = {
  // The fetcher is invoked at most once per (key, in-flight window).
  // foregroundSignal aborts the underlying fetch only when this is the
  // first/coalescing-owner caller — see "Abort semantics" below.
  getOrFetch(
    key: K,
    fetcher: (signal: AbortSignal) => Promise<V>,
    foregroundSignal?: AbortSignal,
  ): Promise<V>
  getStats(): Readonly<TwoTierStats>
  clear(): void
}

type Slot<V> = { fetchedAt: number; value: V }

// Abort semantics: the first caller to land on a cold key supplies the
// AbortController that the underlying fetch uses; subsequent coalesced
// callers share that promise. If the first caller cancels (Ctrl+C), the
// fetch aborts and every coalesced caller observes the same AbortError.
// This matches the previous WebFetch behavior and is a known trade-off —
// rare in practice and not worth the complexity of refcounted signals.
//
// Background refreshes get their own short-lived AbortController so a
// foreground cancel cannot kill them and an in-progress refresh cannot
// be cancelled by an unrelated user action. They are bounded by
// refreshTimeoutMs to prevent hangs from pinning the key.

export function createTwoTierCache<K extends string, V extends object>(
  opts: TwoTierCacheOptions<V>,
): TwoTierCache<K, V> {
  const {
    name,
    softTtlMs,
    hardTtlMs,
    max,
    maxSize,
    sizeOf,
    refreshTimeoutMs = 30_000,
    refreshFailureCooldownMs = 30_000,
    clock = Date.now,
    onRefreshError = (err: unknown) => logError(err),
  } = opts

  if (softTtlMs > hardTtlMs) {
    throw new Error(
      `[${name}] twoTierCache: softTtlMs (${softTtlMs}) must be <= hardTtlMs (${hardTtlMs})`,
    )
  }

  // Single source of truth for expiry: LRU's ttl drives hard eviction,
  // so soft/hard can't drift apart silently. lru-cache's option types are
  // a tagged union (max XOR maxSize), so we branch at construction.
  const lru =
    typeof maxSize === 'number'
      ? new LRUCache<K, Slot<V>>({
          ttl: hardTtlMs,
          maxSize,
          sizeCalculation: sizeOf
            ? (slot: Slot<V>) => Math.max(1, sizeOf(slot.value))
            : undefined,
        })
      : new LRUCache<K, Slot<V>>({
          ttl: hardTtlMs,
          max: max ?? 64,
        })

  const inFlight = new Map<K, Promise<V>>()
  // Last failed-refresh timestamp per key. Wiped on clear() and on the
  // first successful refresh for the key.
  const lastRefreshFailureAt = new Map<K, number>()

  const stats: TwoTierStats = {
    hits: 0,
    stale: 0,
    misses: 0,
    coalesced: 0,
    refreshSuccess: 0,
    refreshFailure: 0,
  }

  // Generation counter bumped on every clear(). In-flight fetches capture
  // the current generation at dispatch time; on completion they compare
  // against the live counter and bail out of any side effects (storing
  // into the LRU, incrementing stats) if a clear() ran while they were
  // pending. Without this guard a long-running refresh can "resurrect"
  // a cleared cache and dirty the counters — observable after /clear is
  // invoked mid-request.
  let generation = 0

  function store(key: K, value: V): void {
    lru.set(key, { fetchedAt: clock(), value })
  }

  function performFetch(
    key: K,
    fetcher: (signal: AbortSignal) => Promise<V>,
    foregroundSignal: AbortSignal | undefined,
    isBackground: boolean,
  ): Promise<V> {
    const existing = inFlight.get(key)
    if (existing) {
      stats.coalesced++
      return existing
    }

    const myGen = generation
    const controller = new AbortController()

    // Listener bookkeeping: addEventListener without {once:true} so that a
    // successful fetch can explicitly removeEventListener in `finally`.
    // {once:true} would auto-remove only on abort fire — on success the
    // listener stays attached to the foreground signal indefinitely
    // (leak via signal → listener → controller cycle).
    let foregroundListener: (() => void) | undefined
    if (foregroundSignal && !isBackground) {
      if (foregroundSignal.aborted) {
        controller.abort(foregroundSignal.reason)
      } else {
        foregroundListener = () => controller.abort(foregroundSignal.reason)
        foregroundSignal.addEventListener('abort', foregroundListener)
      }
    }

    // Background-refresh timeout: a fetcher that never resolves would
    // otherwise pin `key` in inFlight forever and block every future
    // caller for that key.
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (isBackground && refreshTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        controller.abort(
          new Error(
            `[${name}] background refresh timed out after ${refreshTimeoutMs}ms`,
          ),
        )
      }, refreshTimeoutMs)
    }

    const promise = fetcher(controller.signal)
      .then(value => {
        // generation gate: if clear() ran during this fetch, drop the
        // result on the floor — do not resurrect the cache, do not
        // touch stats. The caller still observes the value (we return it
        // to satisfy their await), but the cache state stays clean.
        if (myGen !== generation) return value
        if (isBackground) stats.refreshSuccess++
        lastRefreshFailureAt.delete(key)
        store(key, value)
        return value
      })
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        if (foregroundListener && foregroundSignal) {
          foregroundSignal.removeEventListener('abort', foregroundListener)
        }
        // Only delete if we still own the slot under the current
        // generation — otherwise clear() already wiped inFlight and a
        // newer dispatch may have populated the same key.
        if (myGen === generation) inFlight.delete(key)
      })

    inFlight.set(key, promise)
    return promise
  }

  function getOrFetch(
    key: K,
    fetcher: (signal: AbortSignal) => Promise<V>,
    foregroundSignal?: AbortSignal,
  ): Promise<V> {
    const slot = lru.get(key)
    const decision = decideCacheAction(slot, clock(), softTtlMs, hardTtlMs)

    if (decision === 'fresh' && slot) {
      stats.hits++
      return Promise.resolve(slot.value)
    }

    if (decision === 'stale' && slot) {
      stats.stale++
      // Skip dispatch if a refresh (or coalesced foreground miss) is
      // already in flight for this key. Without this guard the second
      // stale caller would re-enter performFetch, see the in-flight,
      // and bump `coalesced` — double-counting a single network call
      // (one as `stale`, again as `coalesced`).
      //
      // Also skip if the previous refresh for this key failed within the
      // cooldown window. Otherwise N stale callers during an upstream
      // outage amplify into N network calls — same anti-pattern the
      // coalesce guard prevents, just on the time axis. The slot's data
      // is still served (caller sees stale-but-valid).
      const lastFailure = lastRefreshFailureAt.get(key)
      const inCooldown =
        lastFailure !== undefined &&
        refreshFailureCooldownMs > 0 &&
        clock() - lastFailure < refreshFailureCooldownMs
      if (!inFlight.has(key) && !inCooldown) {
        const myGen = generation
        void performFetch(key, fetcher, undefined, true).catch(err => {
          if (myGen !== generation) return // discard post-clear
          stats.refreshFailure++
          lastRefreshFailureAt.set(key, clock())
          onRefreshError(err)
        })
      }
      return Promise.resolve(slot.value)
    }

    // Miss path. If another miss is already in-flight for the same key,
    // count this caller as `coalesced` instead of `misses` — keeps the
    // counters mutually exclusive (one logical fetch = one miss, the
    // riders are coalesced). performFetch handles the bookkeeping for
    // the cold-dispatch case.
    if (inFlight.has(key)) {
      stats.coalesced++
      return inFlight.get(key) as Promise<V>
    }
    stats.misses++
    return performFetch(key, fetcher, foregroundSignal, false)
  }

  function getStats(): Readonly<TwoTierStats> {
    return { ...stats }
  }

  function clear(): void {
    generation++
    lru.clear()
    inFlight.clear()
    lastRefreshFailureAt.clear()
    stats.hits = 0
    stats.stale = 0
    stats.misses = 0
    stats.coalesced = 0
    stats.refreshSuccess = 0
    stats.refreshFailure = 0
  }

  return { getOrFetch, getStats, clear }
}
