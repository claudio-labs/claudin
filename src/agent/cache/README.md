# src/agent/cache — cache policy layer

Map of Claudin's prompt-cache system. This folder holds **policy** (what to
keep, clip, freeze, and when, per provider). Mechanisms it orchestrates live
where their subsystems live — pointers below.

Design doc + measured numbers: `docs/tech/cache/clip-frontier-breakpoint.md`.
Context relief (the one client-side policy, its cost model, and the four
mechanisms it replaced): `docs/tech/cache/context-relief-policy.md`.

## Layout

```
src/agent/cache/
  cacheProfile.ts        provider → CacheProfile resolver (CLAUDIN_CACHE_PROFILE)
  anthropic/             Anthropic-server / Claude-model–only features
    apiMicrocompact.ts   context_management beta (clear_tool_uses / clear_thinking)
    (future: cache_edits/cache_reference plumbing, retain-profile
     context-management defaults)
```

The transport-level Anthropic-only code (marker placement, TTLs, renderer)
stays under `src/providers/shims/claude/` — that folder is already per-provider.
Anything that only works against api.anthropic.com or only with Claude
models and is *cache policy* goes in `anthropic/` here; future provider
specifics (e.g. DeepSeek TTL tuning, Gemini implicit-cache quirks) get
sibling folders.

## The system at a glance

Two invariants drive everything:

1. **Clip-frontier** (default ON; `CLAUDIN_CLIP_FRONTIER=0` disables): the message-level
   `cache_control` marker never advances past the last byte-stable index —
   mutation only ever happens in the uncached tail, so clipping cannot break
   the cached prefix per turn.
2. **Cache profile** (`CLAUDIN_CACHE_PROFILE=aggressive|retain|auto`, unset → auto): how
   eagerly to clip at all. `retain` (Anthropic-style 12.5:1 write/read
   spread) keeps tool_results full and lets the cheap cached reads pay;
   `aggressive` (low-spread providers) clips per turn.

Three byte-stability rules back them (added by the 2026-06 cache-break
audit; integrated regression:
`src/agent/compact/requestDeterminism.invariant.test.ts`):

- **Stub bytes are first-write-wins** (`perKeyStubText` in
  `stableStubState.ts`): the first stub emitted for a tool_use_id records
  its exact bytes and every later rewriter replays them, so views holding
  different content for the same id (budget preview vs full original)
  cannot flip the wire bytes.
- **Nothing is ever deleted from the API view**: the REPL's display array
  seeds the next request, so every context-relief action is a stable-stub
  clip decided in ONE place (`src/agent/compact/reliefPolicy.ts` via
  `microcompactMessages`, pre-request) on REAL usage, announced through
  `notifyCacheDeletion` + `recordPrefixRewrite`. The display cap is a render
  window in `REPL.tsx` (`MAX_DISPLAY_MESSAGES`), not a history bound. The
  message evictions and the post-turn byte-guard that used to rewrite the
  prefix from four uncoordinated places are gone.
- **The tool pool never churns bytes gratuitously**: MCP updates replace
  in place and keep schemas across transient failures
  (`resolveUpdatedTools`), LSP `defer_loading` latches per session, and
  deferred tools are announced via persisted delta attachments
  (`tengu_glacier_2xr` on in the open build) instead of an ephemeral
  `messages[0]` prepend — with a legacy-format latch for sessions resumed
  on a warm pre-flip cache (`maybeLatchLegacyDeferredAnnouncement`).
- **Every deferred tool is in the `tools` array from the first request**,
  flagged `defer_loading: true` (the documented tool-search contract). The
  API keeps deferred definitions out of the cached prefix and expands a
  discovered one at its `tool_reference`, so a ToolSearch discovery does not
  change the array. The previous "send only discovered deferred tools"
  filter mutated the array on every discovery and was measured to rewrite
  the whole conversation (+93 prefix tokens, 50–134k tokens re-billed per
  discovery in real sessions); it survives behind
  `CLAUDIN_DEFERRED_TOOLS_DISCOVERED_ONLY=1` for pathological MCP pools.
  Probe: `scripts/bench/ab/tool-search-cache-probe.ts`.

## Pointers to the mechanisms

- `src/agent/compact/reliefPolicy.ts` — the pure decision: `decideRelief`
  (window lane: usage > `min(fraction × window, autocompact − margin)`,
  target a band below; rss lane: retained full results > the profile's high
  water) and `selectReliefIds` (oldest-first until the request is covered).
  `CLAUDIN_DISABLE_RELIEF_POLICY=1` turns off the window lane only.
- `src/agent/compact/stableStubState.ts` — stable stubs (`clippedIds`),
  first-write-wins stub byte registry (`perKeyStubText`), age prune
  (`pruneOldToolResults`, aggressive only), the relief candidate walk
  (`collectClearableCandidates`: cutoff window, pins, errors, images,
  `MIN_STUB_TOKENS`, already-clipped ids), display stub,
  **`getClipFrontierIndex`**.
- `src/providers/shims/claude/paramBuilders.ts` — `addCacheBreakpoints`: defer-2048
  walk + frontier cap (`min(defer, frontier)`), head-pin fallback,
  skipCacheWrite fork handling, optional trailing marker on the last
  message (`CLAUDIN_TRAIL_CACHE_MARKER=1`, experimental — caches the
  defer/frontier tail window instead of re-sending it as 1× input;
  mutually exclusive with `CLAUDIN_ANCHOR_CACHE_HEAD`).
- `src/providers/shims/claude/cacheControl.ts` — ephemeral 5m/1h TTL selection.
- `src/providers/shims/claude/streaming.ts` — wiring order:
  `ensureToolResultPairing → applyStableStubs → history redactions →
  frontier → addCacheBreakpoints`; also sends `context_management` when the
  beta header is on (NOT under `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=1` — the
  retain profile's server-side clear is inert there; see the relief doc).
  `clear_tool_inputs` is derived from the pool via `clearableResult: true`
  on each Tool (`clearableToolNamesFromPool`), not a hand-kept constant.
- `src/agent/compact/microCompact.ts` — the shell around the policy:
  measures `tokenCountWithEstimation` over the stubbed view (so a request
  between a clip and its response does not clip again), applies the
  decision to the clipped set, gated on a `querySource` so `/context`,
  `/compact` and `analyzeContext` never mutate it. The time-based trigger
  runs first, fires when the server cache already expired, and PERSISTS
  through the same clipped set (`addClippedIds`) — the post-idle "cleaned"
  prefix keeps its hits on later turns, and pre-existing relief ids survive
  (no `resetClippedIds` on the time path).
- `src/mcp/useManageMCPConnections.ts` — `resolveUpdatedTools`:
  positional tool-pool replacement; schemas survive `failed` transitions
  ('disabled' still removes).
- `src/agent/tools/toolSearch.ts` — `isDeferredToolsDeltaActive` +
  `maybeLatchLegacyDeferredAnnouncement`: deferred-tools announcement
  format (delta attachments vs legacy prepend), settled per session
  before tool schemas are built.
- `src/agent/messages/normalize.ts` — `stripOldThinkingBlocks` /
  `stripOldNarrationBlocks`: position-based keep windows (count-based
  windows pinned the frontier with sporadic thinking).
- Shims (`src/providers/shims/openaiShim/messagesClient.ts`,
  `src/providers/shims/codexShim.ts`) — no marker;
  longest-unchanged-prefix providers benefit from byte-stability alone.
  On top of that, official-OpenAI URLs (`isOfficialOpenAIUrl`) send
  `prompt_cache_key: getSessionId()` + `prompt_cache_retention: '24h'`
  (cache routing + extended TTL; gated by URL so third-party/local
  backends that may reject unknown params never see them). The Codex
  backend (`isCodexBaseUrl`) sends only `prompt_cache_key` — it rejects
  `prompt_cache_retention` with a `400 Unsupported parameter`.
- `src/tools/FileReadTool/serverClearingDetection.ts` — Read's dedup
  (`file_unchanged` stub) stands down once a `clear_tool_uses` edit has been
  applied: the stub points at an earlier tool_result the server may have
  wiped, and the API reports only counts, never which ones. The evidence
  (`context_management.applied_edits`) arrives on the `message_delta` stream
  event and is written back to the turn's last assistant message by
  `applyMessageDeltaToLastMessage` (`src/providers/shims/claude/streaming.ts`).
- `src/providers/cache/promptCacheBreakDetection.ts` — the break detector.
  Deferred tools contribute `{name, defer_loading}` to the tool hash (a
  deferred tool entering the array IS a prefix change); server edits from
  `applied_edits` label the break `server clear_tool_uses (…, expected)`;
  client mechanisms name themselves via `notifyCacheDeletion(source, agent,
  reason)` → `[PROMPT CACHE] expected drop: relief clip (12 tool results, ~45k
  tokens, window lane)`.
  `buildCacheBreakReason` is the pure labeler (tested).
- `src/providers/cache/cacheStatsTracker.ts` — per-turn/session cache
  metrics for the `[Cache: …]` line and `/cache-stats`, now including server
  clears (`recordServerClear`) and the client prefix rewrites announced this
  turn (`recordPrefixRewrite`, shown as `prefix rewritten: …` — the relief
  clip is decided pre-request, so the rewrite lands on the turn it names).

## Bench

`scripts/bench/ab/cache-lockstep-bench.ts` — one user turn per file via
`--input-format stream-json` (identical pacing by construction); the
reliable harness for main-vs-branch comparisons. `cache-ab-bench.ts`
remains for exploratory runs only — its extractTimeline rows are
cumulative and run-to-run variance is high, so don't cite its numbers.
