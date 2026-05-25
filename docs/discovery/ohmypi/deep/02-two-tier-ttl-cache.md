# 02 — Two-tier TTL cache (deep dive)

Discovery follow-up to `docs/discovery/ohmypi/02-two-tier-ttl-cache.md`.
Research only — no production code changes proposed for this pass.

## Resumo executivo

`oh-my-pi` ships a generalizable stale-while-revalidate pattern that today is
specialized for the `github` tool (issue/PR/PR-diff views). Each cache entry
has two TTLs: a **soft** TTL (returns the row outright, no work) and a
**hard** TTL (drops the row, forces a fresh fetch). In the soft/hard window
the row is served immediately as `stale` and a background `queueMicrotask`
revalidation rewrites it from the live source. Storage is **SQLite on disk**
(`bun:sqlite`, WAL, 0o600), namespaced by an auth-key hash so cache hits
never cross account/token boundaries.

Claudio already has *three* independent disk caches under `~/.claudio/`
(`model-cache/`, `image-cache/`, `latest-version.json`) plus an in-process
`LRUCache` for `WebFetchTool`. None of them implement the soft/hard tier;
they are all binary (fresh or expired). Adopting a generic `twoTierCache`
utility would consolidate that surface and unlock stale-while-revalidate for
the three highest-traffic call sites: `WebFetch`, `WebSearch`, and provider
model listings.

## Implementação omp

Single file. SQLite-backed; one process-wide connection opened lazily.

- Schema and DB lifecycle: `packages/coding-agent/src/tools/github-cache.ts:88` (`openDb`), table DDL at `:109`, WAL/synchronous pragmas at `:97-99`, file-mode hardening (`0o600` for db/`-wal`/`-shm`) at `:82`.
- Entry shape: `CachedView<T>` at `:33-43`. Primary key is the tuple `(auth_key, repo, kind, number, include_comments)` — see `:120`. Only `fetched_at` is stored; soft/hard TTLs are applied at read time, not persisted.
- Persistence path: `getGithubCacheDbPath()` from `@oh-my-pi/pi-utils` (consumed at `:93`). Lives in the user's XDG cache dir, *not* in the agent's config dir.
- TTL resolution: `resolveCacheTtl()` at `:412-421` reads `github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled` from `Settings`. Defaults: `softMs = 5 min`, `hardMs = 7 days` (`:57-58`).
- Two-tier lookup: `getOrFetchView()` at `:470-531`. The branch logic at `:493-525` is the canonical reference:
  - `age > hardMs` → delete row eagerly (`:495-499`) and fall through to fresh fetch.
  - `age <= softMs` → return `status: "fresh"` directly (`:500-507`).
  - otherwise → return cached `status: "stale"` AND `scheduleBackgroundRefresh()` (`:508-524`).
- Background refresh: `scheduleBackgroundRefresh()` at `:445-468`. Uses `queueMicrotask`, never awaits, errors are logged at `debug` level and dropped — the stale row stays in place on failure (no invalidation). The next caller will see it as stale again and re-schedule.
- Eviction: two layers.
  - Per-lookup throttled sweep `sweepIfDue()` at `:156-163` (`SWEEP_INTERVAL_MS = 60_000`) deletes every row older than the *configured* hard TTL (`evictExpired`, `:139-146`). Caps on-disk exposure window at `hardMs + 60s`.
  - No max size / row count. Eviction is purely time-based.
- Auth-key namespacing: `resolveGithubCacheAuthKey()` at `:187-208` hashes `GH_TOKEN`-family env vars and `~/.config/gh/hosts.yml` contents (never stored raw). Bypassed entirely when caller passes `null` (`:475-478`).
- Failure modes: every helper swallows DB errors and logs at `debug`, then degrades to "no cache" — a corrupt DB never blocks a `gh` call (see banner comment at `:6-15`).
- Call sites: `gh.ts:2520`, `gh.ts:2547`, `gh.ts:2841` (issue view, PR view, PR diff). All three pass the same `fetchFresh` shape, so the wrapper is genuinely reusable inside omp.

## Estado atual em Claudio

Caches exist; the soft/hard tier does not. Inventory:

### In-process (no persistence)

- `src/tools/WebFetchTool/utils.ts:64` — `URL_CACHE = new LRUCache<string, CacheEntry>` with `ttl = 15 min` (`:61`), `maxSize = 50 MB` (`:62`), entry shape at `:49-57` (bytes/code/content/contentType/persistedPath). Single TTL, hard eviction. Hit path at `:415-426`, write path at `:522-534`.
- `src/tools/WebFetchTool/utils.ts:73` — `DOMAIN_CHECK_CACHE` (hostname → `true`) with `ttl = 5 min`, `max = 128`. Caches only "allowed"; failures re-checked.
- `src/tools/WebSearchTool/WebSearchTool.ts` — **no result cache**. Each query hits the search provider every time. Only growthbook feature flags are cached upstream (`getFeatureValue_CACHED_MAY_BE_STALE`, `:9, :706`).
- `src/services/api/providerConfig.ts:592` — `getAdditionalModelOptionsCacheScope()` returns a scope key used by *other* caches; preset metadata itself is computed per call. No persisted provider-metadata cache.

### Persisted under `~/.claudio/`

Verified present on this host:

- `~/.claudio/model-cache/` — `src/utils/model/modelCache.ts`. Per-provider JSON file. `CACHE_TTL_HOURS = 24`, version stamped. Binary: valid or invalid, no stale-serve.
- `~/.claudio/latest-version.json` — `src/utils/latestVersionCache.ts`. Synchronous read at banner time (`readLatestVersion`, `:36-46`); written by `writeLatestVersion`. No TTL on disk — caller (`startupUpdateCheck.ts`) gates by `checkedAt`.
- `~/.claudio/image-cache/`, `~/.claudio/paste-cache/`, `~/.claudio/file-history/` — caches but content-addressed (not TTL-bound).
- `~/.claudio/v8cache/` — V8 bytecode, invalidated by build, not in scope.

### Gap

No utility today gives a caller "serve immediately, refresh in background". Every cache miss is synchronous; every expiry is hard.

## Proposta: utility genérica `twoTierCache<K, V>`

Strawman API (research artifact — not implemented):

```ts
// src/utils/cache/twoTierCache.ts (proposed location)

export interface TwoTierOptions<V> {
  softTtlMs: number
  hardTtlMs: number
  // Optional persistence layer. In-memory only when omitted.
  store?: TwoTierStore<V>
  // Optional namespacing — e.g. provider id, auth-key hash. Mixed into the
  // storage key. Null disables the cache entirely for this lookup (omp parity).
  scope?: string | null
  // Called when background refresh throws. Default: logError at debug.
  onRefreshError?: (err: unknown, key: string) => void
}

export interface TwoTierEntry<V> {
  value: V
  fetchedAt: number
}

export interface TwoTierStore<V> {
  get(key: string): TwoTierEntry<V> | null | Promise<TwoTierEntry<V> | null>
  set(key: string, entry: TwoTierEntry<V>): void | Promise<void>
  delete(key: string): void | Promise<void>
  // Optional sweep — called from twoTierCache on a throttled interval if defined.
  evictOlderThan?(cutoffMs: number): void | Promise<void>
}

export type CacheStatus = 'fresh' | 'stale' | 'miss' | 'disabled'

export interface TwoTierResult<V> {
  value: V
  status: CacheStatus
  fetchedAt: number
}

export async function twoTierCache<K, V>(
  key: K,
  fetcher: () => Promise<V>,
  opts: TwoTierOptions<V>,
): Promise<TwoTierResult<V>>
```

Two reference implementations of `TwoTierStore` would live alongside:

- `createMemoryStore<V>(maxSize?)` — wraps `lru-cache` (already a Claudio dep, see `WebFetchTool/utils.ts:2`). Drop-in for callers that don't want disk.
- `createJsonStore<V>(dirname, { schemaVersion })` — one JSON file per key under `~/.claudio/cache/<dirname>/`. Matches the `model-cache/` shape that already exists (`modelCache.ts:21 CACHE_DIR_NAME`). Avoids adding `bun:sqlite` as a hard runtime dep; SQLite would be a future `createSqliteStore` if a high-cardinality call site demands it.

Behavior parity with omp's `getOrFetchView`:
1. `scope === null` or both TTLs zero → bypass, return `disabled` + live fetch.
2. Throttled sweep via `store.evictOlderThan(hardTtlMs)` no more than once per 60s per scope.
3. On hit within soft → `fresh`, no work.
4. On hit between soft and hard → `stale`, schedule `queueMicrotask(refresh)`, return cached.
5. On hit past hard → delete row, fall through to live fetch.
6. Refresh failures are logged and the stale row is preserved (omp `:459-466`).

Race protection (not in omp today): a per-key in-flight `Map<string, Promise<V>>`
so concurrent callers in the soft/hard window only spawn one background refresh.

## Sites de adoção (priorizados)

1. **`WebFetchTool` URL cache** (`src/tools/WebFetchTool/utils.ts:64`). Highest ROI.
   - Today: 15-minute hard TTL. After 15 min the next fetch blocks on the
     network even if the page didn't change.
   - Two-tier: `softTtlMs = 5 min`, `hardTtlMs = 60 min`. Re-asks of the
     same URL within an hour return immediately and refresh in background.
   - Memory store is enough (already LRUCache-backed); just swap the lookup.

2. **`WebSearchTool` query cache** (currently absent — `WebSearchTool.ts`).
   - Today: every search hits the provider. LLMs frequently re-issue the
     same query within one research session.
   - Two-tier: normalize `(query, allowed_domains, blocked_domains)` into
     a key; `softTtlMs = 10 min`, `hardTtlMs = 24 h`. Memory store with
     small `maxSize` (e.g. 64 entries) to bound RAM.
   - Doc the trade-off in `README_SEARCH_PROVIDERS.md`: results may be
     up to `hardTtlMs` stale; recommend providers that handle freshness
     server-side (Firecrawl) keep their own ETag layer untouched.

3. **`modelCache.ts`** (`src/utils/model/modelCache.ts`).
   - Today: 24h hard TTL, binary. After 24h startup blocks on the model
     list endpoint.
   - Two-tier: `softTtlMs = 24 h`, `hardTtlMs = 7 d`. Startup never waits
     on the network for a provider the user has used recently; the
     background refresh updates the list before next launch.
   - `createJsonStore` reuses the existing per-provider JSON layout.

4. **(Lower priority) `latestVersionCache`** (`src/utils/latestVersionCache.ts`).
   - Today: synchronous read at banner time; the caller decides freshness.
   - Two-tier would let the banner always render instantly from disk
     while a background fetch updates the file. Already close to that
     shape; mainly a refactor to share the utility.

Provider preset metadata (`providerConfig.ts`) is *not* recommended as a
first adoption site: presets are static at build time and recomputing them
is cheap. Cross-invalidation on `/provider` changes would add complexity
with little benefit. The `getAdditionalModelOptionsCacheScope()` key
(`providerConfig.ts:592`) is still useful as a `scope` value for **other**
caches (e.g. `WebFetch` keyed per-provider) — that's where it should be
wired, not as a cached value itself.

## Riscos

- **Race no refresh.** Two concurrent stale reads schedule two refreshes.
  omp accepts this (`:453 queueMicrotask` is fire-and-forget). Claudio
  should add an in-flight `Map` keyed by storage-key to coalesce. Without
  it, a flapping search query inside a tight loop could amplify upstream
  load 10×.
- **Conteúdo sensível.** A persisted cache for `WebFetch`/`WebSearch`
  results stores raw third-party content under `~/.claudio/`. omp keys
  by an auth-key hash to prevent cross-account leakage; Claudio doesn't
  have an equivalent identity for arbitrary web URLs, so per-host
  scoping is the closest analogue. Recommendation for the first
  iteration: in-memory store only for WebFetch/WebSearch, disk store
  only for low-sensitivity caches (model lists, provider metadata).
  Re-evaluate after auditing what URLs the agent actually re-visits.
- **Storage growth.** omp caps exposure via the throttled sweep
  (`:156-163`). A JSON-per-key store on Claudio side has no such sweep
  unless `evictOlderThan` is implemented. Without it, a long-lived
  install accumulates dead `~/.claudio/cache/web-fetch/*.json` files.
  The utility must require `evictOlderThan` or document the leak.
- **Privacy/telemetry surface.** Anything written to `~/.claudio/cache/`
  must survive `bun run verify:privacy`. Cache file *contents* aren't
  scanned today, but adding paste/URL bodies on disk widens the user's
  exposure if a developer later does e.g. crash-report bundling.
  Whatever utility lands should be documented in `CLAUDE.md` so a future
  log-bundler skips the cache dir by default.
- **Schema drift.** omp drops the table on `user_version < 3`
  (`github-cache.ts:106-108`). Any `createJsonStore` equivalent needs
  a version field per entry and a clear "ignore + refetch" policy on
  mismatch — never throw, never partially upgrade.

## Métrica de sucesso

Two leading indicators, one trailing:

1. **Stale-hit ratio** (leading). Instrument `twoTierCache` to count
   `fresh` / `stale` / `miss` / `disabled` per scope. Goal after rollout
   to WebFetch + WebSearch + modelCache: stale-hit count ≥ 20% of total
   lookups across a typical session, demonstrating the soft-tier window
   is the right size. If stale ≈ 0%, the soft TTL is too long; if
   miss ≈ 100%, the hard TTL is too short.

2. **Background-refresh latency p95** (leading). Time from
   `queueMicrotask` schedule to `store.set` completion. p95 must stay
   under the *next* user turn (rough proxy: 30 s). Otherwise the "stale"
   row is just a delayed miss for the same user.

3. **Tool-call wall-clock for re-visits** (trailing). Bench:
   ```
   scripts/profile/cache-revisit-bench.ts (proposed)
   ```
   replay a 50-turn transcript with 30% URL re-visit rate, compare
   p50/p95 `WebFetchTool` execution time before and after. Target:
   ≥ 50% reduction on the re-visit subset; 0% regression on first-visit.

Out of scope for the metric, in scope for the rollout: a `/cache` slash
command (or `/provider doctor` extension) that prints per-scope counters
so users can see whether the cache is actually helping their workflow.

## Referências

- omp: `/home/viudes/projects/oh-my-pi/packages/coding-agent/src/tools/github-cache.ts`
- omp call sites: `/home/viudes/projects/oh-my-pi/packages/coding-agent/src/tools/gh.ts:2520, :2547, :2841`
- Claudio WebFetch cache: `/home/viudes/projects/claudio/src/tools/WebFetchTool/utils.ts:48-81, :415-534`
- Claudio WebSearch (no cache): `/home/viudes/projects/claudio/src/tools/WebSearchTool/WebSearchTool.ts`
- Claudio model cache: `/home/viudes/projects/claudio/src/utils/model/modelCache.ts`
- Claudio latest-version cache: `/home/viudes/projects/claudio/src/utils/latestVersionCache.ts`
- Claudio provider metadata: `/home/viudes/projects/claudio/src/services/api/providerConfig.ts:592`
- Config-dir helper: `/home/viudes/projects/claudio/src/utils/envUtils.ts` (`getClaudioConfigHomeDir`)
