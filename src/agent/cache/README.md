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
  window (`src/agent/repl/displayWindow.ts`), not a history bound — and it is
  off by default now, each render path being bounded by its own layer (the
  virtual list's mounted-item cap, `computeSliceStart` inline). The message
  evictions and the post-turn byte-guard that used to rewrite the prefix from
  four uncoordinated places are gone.
- **The tool pool never churns bytes gratuitously**: MCP updates replace
  in place and keep schemas across transient failures
  (`resolveUpdatedTools`), LSP `defer_loading` latches per session, and
  deferred tools are announced via persisted delta attachments
  (on by default, `CLAUDIN_DEFERRED_TOOLS_DELTA=0` to turn off) instead of an ephemeral
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
- **The message marker is followed by a lagging one**
  (`src/providers/shims/claude/lagCacheMarker.ts`): a second message-level
  breakpoint on the message that carried the previous request's marker. The
  API only looks 20 positions behind a breakpoint for an existing entry; a
  marker that lingers through tiny tool turns and then jumps to the tail
  lands past that, the lookup resumes at the system breakpoint, and the
  whole history is re-billed (7 events / 3.06M tokens in one session,
  38.6% of all cache writes over 30 days of transcripts, under the deferred
  placement that was the default until 2026-09-23). The lag marker is where
  the lookup resumes instead; it costs nothing, and with the marker now on
  the last message it is usually redundant. Probe:
  `scripts/bench/ab/lookback-miss-probe.ts`; census:
  `scripts/bench/tokens/lookback-miss-census.ts`;
  design: `docs/tech/cache/lookback-lag-marker.md`.

## Pointers to the mechanisms

- `src/agent/compact/reliefPolicy.ts` — the pure decision: `decideRelief`
  (window lane: usage > `min(fraction × window, autocompact − margin)`,
  target a band below — the profile's 60k, growing to 15% of the trigger on
  windows past ~400k; rss lane: retained full results > the profile's high
  water) and `selectReliefIds` (oldest-first until the request is covered).
  An event whose selectable savings fall under `RELIEF_MIN_EVENT_TOKENS`
  (4k) adds no ids: `microCompact.ts` logs `[RELIEF] starved` and puts one
  `relief starved (~Nk short, window lane)` on the turn's `[Cache:]` line.
  On a 1M window the retain profile's floor — 2000-char result heads plus
  the tool_use INPUTS nothing used to clip — sat above the 690k target
  (session 88f03ef5, 2026-09-15: 149 clip events, 140 of them one result
  for ~0k, the 4 real ones each a 600-700k rewrite); the band, the floor and
  the input side below are the answer.
  `CLAUDIN_DISABLE_RELIEF_POLICY=1` turns off the window lane only.
- `src/agent/compact/stableStubState.ts` — stable stubs (`clippedIds`),
  first-write-wins stub byte registry (`perKeyStubText`), age prune
  (`pruneOldToolResults`, aggressive only), the relief candidate walk
  (`collectClearableCandidates`: cutoff window, pins, errors, images,
  `MIN_STUB_TOKENS`, already-clipped ids — and, given the pool's
  `clearableInputFields`, the tool_use INPUT side as candidates too), display
  stub, **`getClipFrontierIndex`**.
- `src/agent/compact/stableStubState/applyInputStubs.ts` — the client-side
  twin of `clear_tool_inputs`: a clipped call's declared input fields
  (`Tool.clearableInputFields` — Patch.patchText, Write.content,
  Edit.old_string/new_string, NotebookEdit.new_source, Agent.prompt) are
  rewritten to `[clipped: ~N tokens of <field> from <tool>]`, byte-stable
  under `${id}#${field}` in the same registry. WIRE-ONLY: the three shim
  request paths call it right after `applyStableStubs`; it is never
  substituted into QueryEngine's messages, so the TUI, the plan dossier and
  persistence keep the full call. An input-only id (Patch) never
  enters the result set — that set stubs whatever it is given.
- `src/providers/shims/claude/paramBuilders.ts` — `addCacheBreakpoints`: marker
  on the last message capped at the frontier (`min(last, frontier)`); the
  deferred walk and its head-pin fallback only under
  `CLAUDIN_DEFER_CACHE_MARKER=<N>`; skipCacheWrite fork handling.
- `src/providers/shims/claude/cacheControl.ts` — ephemeral 5m/1h TTL selection.
- `src/providers/shims/claude/streaming.ts` — wiring order:
  `ensureToolResultPairing → applyStableStubs → history redactions →
  frontier → addCacheBreakpoints`; also sends `context_management` when the
  beta header is on. On the real first-party endpoint that is the default
  since 2026-09-22 (`adoptedBetas.ts`), but the body is only
  `clear_thinking` with `keep: "all"`. The retain profile's server-side
  clear and the aggressive keep window are `serverEdits`, which stay inert
  unless `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=false` (see the relief doc).
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
  xAI/Grok (`isXaiOAuthBaseUrl`, exact host `api.x.ai`) takes neither: its
  routing key is the `x-grok-conv-id` **header**, `getSessionId()`, since
  2026-09-11 — `prompt_cache_key` is documented for xAI's Responses
  endpoint only and we ride Chat Completions. Killswitch
  `CLAUDIN_DISABLE_XAI_CONV_ID=1`. Whether it actually raises
  `cached_tokens` is **unmeasured** (no xAI account); xAI also invalidates
  per whole message, so the aggressive profile's per-iteration rewrite of an
  old `tool_result` may cost the prefix regardless —
  `docs/tech/cache/native-prompt-caching-by-provider.md` §6.
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
