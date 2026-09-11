# Native Prompt Caching — xAI/Grok vs Codex vs OpenAI

**Status:** Partly shipped (2026-09-11). The §4 gap is closed on the routing
axis — Claudin now sends `x-grok-conv-id` on the xAI lane — but the *effect*
is still **unmeasured**: no xAI account was available, so the change rests on
xAI's documentation, not on a cache hit anyone has seen. §6 is what remains.
**Scope:** `src/providers/shims/openaiShim/messagesClient.ts`,
`src/providers/shims/codexShim.ts`, `src/agent/cache/cacheProfile.ts`,
`src/providers/cache/cacheMetrics.ts`

## Question

Do xAI/Grok and the Codex CLI lane use "the OpenAI prompt-caching pattern",
or does each have its own native mechanism? The short answer is that all
three are implicit prefix caches — none has Anthropic-style `cache_control`
breakpoints — but they differ in **invalidation granularity**, **where the
routing key travels**, and **what TTL control exists**. Those three
differences are exactly the ones a single OpenAI-shaped client gets wrong.

## 1. Side-by-side

| | Anthropic | OpenAI (`api.openai.com`) | xAI / Grok | Codex (chatgpt.com backend) |
|---|---|---|---|---|
| Mechanism | Explicit `cache_control` breakpoints | Automatic prefix | Automatic prefix | Automatic prefix |
| Invalidation unit | Marker position | 128-token increments | **Whole message** | 128-token increments |
| Minimum prefix | n/a (explicit) | 1,024 tokens | **Undocumented** | 1,024 tokens |
| Routing key | — | `prompt_cache_key` (body) | **`x-grok-conv-id` (HTTP header)** on Chat Completions; `prompt_cache_key` (body) only on their Responses endpoint | `prompt_cache_key` (body) |
| TTL control | 5m / 1h `ttl` | `prompt_cache_retention` (`in_memory` \| `24h`); newest models move to `prompt_cache_options.ttl = "30m"` | **None. No TTL published at all** | None sent (inherits account default) |
| Cached-read price | 0.1× | 0.1× | 0.15×–0.25×, per model | subscription |
| Cache-write price | 1.25× (5m) / 2× (1h) | no surcharge on older models; **1.25× on GPT-5.6+** | none documented | n/a |
| Usage field | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | same names as OpenAI | `input_tokens_details.cached_tokens` |

## 2. xAI / Grok

Caching is automatic and needs no markers. The mechanics that differ from
OpenAI:

- **Message-granular matching.** xAI checks "how many messages at the
  beginning match a previous request exactly". It is not a token-block
  prefix match. Appending to the tail of the last user message is roughly
  free on OpenAI (128-token increments) and **discards that whole message**
  on xAI. Any per-turn rewrite of an old message — which is precisely what
  our stable-stub system does — invalidates from that message onward.
- **The routing key is a header, not a body field.** On Chat Completions
  the key is `x-grok-conv-id`; on their Responses endpoint it is
  `prompt_cache_key` in the body; on gRPC it is conv-id metadata. xAI's own
  wording is "Always set…", but a re-read on 2026-09-11 shows the header is
  **optional, not required**: caching is automatic on prefix match and the
  header only makes the routing *sticky*, since "cache entries are stored
  per-server". The "constantly-zero `cached_tokens`" line in the 2026-08-20
  notes overstated it — the docs' actual wording is FAQ guidance to "verify
  your conversation ID and message ordering" when hits stay at zero. The
  practical conclusion is unchanged (send it), but the expected effect is a
  hit-*rate* improvement, not caching on/off.
- **No TTL, no retention parameter, and no guarantee.** xAI states entries
  can be evicted at any time under memory pressure or server restart, and
  that requests may land on a different server. Treat the lifetime as short
  and best-effort.
- **Usage fields are OpenAI-shaped** (`usage.prompt_tokens_details.cached_tokens`
  on Chat Completions, `usage.input_tokens_details.cached_tokens` on
  Responses). No xAI-specific field and no cache-write counter is
  documented.
- **Pricing is a per-model ratio, not a flat rate:** grok-4.6 $2.00/M input
  vs $0.50/M cached (75% off); grok-4.5 $2.00 vs $0.30 (85%); grok-4.3 and
  grok-4.20 $1.25 vs $0.20 (84%). The ratio is preserved across the
  <200k / ≥200k context-length pricing tiers. No cache-write surcharge.

## 3. Codex CLI

The Codex client's design is the interesting part, because it deliberately
**refuses** the Responses API's server-side state. From `codex-rs/core/src/client.rs`:

- `store: false` — always.
- **No `previous_response_id`** on the standard streaming path (it appears
  only in the WebSocket incremental path).
- `include: ["reasoning.encrypted_content"]` — how reasoning traces survive
  round-trips without server storage.
- `prompt_cache_key` = the session id, set unconditionally.
- **`prompt_cache_retention` is never sent**, so it inherits the account
  default.

The consequence: Codex resends the entire conversation history as an exact
prefix every turn, and prefix caching is not an optimization layered on top
of `previous_response_id` — it is the **replacement** for it, and it is what
keeps sampling cost linear instead of quadratic. That is why Codex only ever
*appends*: changing tools mid-conversation, switching models, or altering
sandbox/approval/cwd settings all break the prefix, and Codex handles config
changes by appending a new message rather than rewriting an old one.

The request body is identical on the ChatGPT-backend lane and the API-key
lane; the only divergence is a routing-hint header when the auth is the
Codex backend.

This independently confirms our 2026-07-21 removal of
`prompt_cache_retention` from `codexShim` — the official client does not
send it either.

## 4. What Claudin does today

| | xAI / Grok | Codex OAuth |
|---|---|---|
| Transport | `openai_compat` (Chat Completions shim). `isXaiOAuthBaseUrl` only swaps the bearer for the OAuth token — the transport stays `openai_compat` (`src/providers/presets/providerConfig.ts:17`) | `codex_responses` (`src/providers/shims/codexShim.ts`) |
| `prompt_cache_key` | **Not sent** — gated on `isOfficialOpenAIUrl` (host must be `api.openai.com`), `src/providers/shims/openaiShim/messagesClient.ts:99,375` (Copilot `/responses` fallback at `:843`) | Sent, `getSessionId()`, gated on `isCodexBaseUrl` — `src/providers/shims/codexShim.ts:516` |
| `x-grok-conv-id` | **Sent since 2026-09-11** — `getSessionId()`, gated on the exact host `api.x.ai` via `isXaiOAuthBaseUrl`, in the shared header object of `_doOpenAIRequest`. Killswitch `CLAUDIN_DISABLE_XAI_CONV_ID=1`. Deliberately NOT mirrored into the body: `prompt_cache_key` is documented for xAI's Responses endpoint only, and Chat Completions' tolerance of unknown body fields is undocumented | n/a |
| `prompt_cache_retention` | Not sent (same gate) | Deliberately never sent; the backend 400s with `Unsupported parameter` (test at `src/providers/shims/codexShim.test.ts:1138`) |
| Cache profile | `AGGRESSIVE_PROFILE` — the "caching behavior unknown" default for generic OpenAI-compatible backends (`src/agent/cache/cacheProfile.ts:151`) | `RETAIN_PROFILE`, explicit branch (`cacheProfile.ts:162`) |
| Usage parsed back | `prompt_tokens_details.cached_tokens` via `convertChunkUsage` (`src/providers/shims/openaiShim/streamParser.ts:54`); classified `'openai'` by the `mapProviderToCacheAware` fallthrough (`src/providers/cache/cacheMetrics.ts:279`), so an empty field reads as honest zeros, not N/A | `input_tokens_details.cached_tokens` via `makeUsage` (`codexShim.ts:87`); provider tag `'codex'` (`cacheMetrics.ts:263`) |
| Normalization | Both go through `buildAnthropicUsageFromRawUsage`: `cache_read_input_tokens` = cached_tokens, `input_tokens` rewritten fresh-only, `cache_creation_input_tokens` pinned to 0 at the shim boundary (`cacheMetrics.ts:296,356`) | idem |
| Pricing rows | Grok carries `promptCacheReadTokens` ≈ 25% of input (grok-4: 3 → 0.75) — `src/providers/usage/modelCost.ts:174` | subscription-billed |

There is **no xAI/Grok-specific cache test, doc, or code path anywhere in
the repo**. The 2026-06-10 provider-cache research in
[`clip-frontier-breakpoint.md`](clip-frontier-breakpoint.md) covered OpenAI,
Codex and Copilot and has no xAI entry.

## 5. The gap

Grok is **priced for cache reads** but sat on the aggressive clip profile and
sent no cache routing hint of any kind: the `prompt_cache_key` gate
(`host === api.openai.com`) excluded it by construction. Nothing in the repo
has ever measured whether Grok gets a cache hit — that is still true.

Two independent problems, and **only the first is addressed**; the second may
dominate:

1. ~~**No conv-id header** → requests are not sticky-routed.~~ Closed on the
   code axis 2026-09-11 (see §4), unverified on the effect axis.
2. **Aggressive clipping + message-granular invalidation.** Even with the
   header, `pruneOldToolResults` rewrites old `tool_result` messages every
   tool iteration. On OpenAI that costs the suffix after the rewritten
   128-token block; on xAI it discards **every message from the rewritten
   one onward**. The clip-frontier work solved the analogous problem for
   Anthropic by coupling the marker to the frontier; xAI has no marker to
   couple, so the only lever is not mutating the prefix.

## 6. Open questions

- **Measure. Nothing here has been measured.** `/cache-probe` carries the
  instrumentation as of 2026-09-11 — a `--conv-id` flag that sends the header,
  and OAuth-session support so an xAI web login authenticates the same way a
  real request does. Three runs answer it, on a profile pointed at a Grok
  model, reading `prompt_tokens_details.cached_tokens` off call 2:

  | invocation | what it isolates |
  |---|---|
  | `/cache-probe --no-key` | baseline: implicit caching with no hint at all |
  | `/cache-probe --no-key --conv-id` | header only — the shipped configuration |
  | `/cache-probe --conv-id` | header + body `prompt_cache_key`, which also answers whether xAI's Chat Completions rejects unknown body fields |

  Until that runs, both "Grok never hits cache" and "the header fixed it" are
  hypotheses.
- If the header helps, decide whether Grok moves off `AGGRESSIVE_PROFILE`.
  The answer depends on (2) above, not on the header.
- Sub-agents share one conv id. `getSessionId()` is process-global, so every
  parallel sub-agent pins to the same xAI server carrying a different large
  prefix. That is the documented intent of the header (one server per
  conversation), but concurrent distinct prefixes may evict one another.
  Unmeasurable without access; noted rather than designed around.
- Where does the xAI minimum prefix length sit? Undocumented; measurable
  with the same probe by bisecting prompt size.
- **OpenAI lane follow-up (confirmed 2026-09-11, deliberately not acted on).**
  The 2026-06-10 notes say OpenAI has "no write surcharge"; current docs bill
  cache writes at **1.25× input on GPT-5.6+**. And OpenAI's API reference marks
  `prompt_cache_retention` **deprecated** in favour of
  `prompt_cache_options.ttl` (GPT-5.6+, whose only accepted value `30m` is also
  the default), while their prompt-caching guide still frames the two as
  model-specific rather than deprecated. Whether sending
  `prompt_cache_retention: '24h'` to a 5.6+ model **errors or is silently
  ignored is not documented** — so our official-OpenAI lane
  (`messagesClient.ts:377,845`) may be carrying a dead parameter or a latent
  400. This was left out of the xAI change on purpose: it touches a different
  provider and needs its own probe against `api.openai.com`.
- Unverified secondary reporting claims `prompt_cache_retention` now
  *defaults* to `24h` for non-ZDR orgs (May 2026). Not confirmed in
  OpenAI's own docs. Do not act on it.

## Sources

- xAI: [prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching),
  [how it works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works),
  [maximizing cache hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits),
  [usage & pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing),
  [best practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices),
  [models & pricing](https://docs.x.ai/docs/models)
- OpenAI: [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching),
  [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [`openai/codex` — codex-rs/core/src/client.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
- In-repo: [`clip-frontier-breakpoint.md`](clip-frontier-breakpoint.md),
  [`src/agent/cache/README.md`](../../../src/agent/cache/README.md)
