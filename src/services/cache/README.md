# src/services/cache — cache policy layer

Map of Claudin's prompt-cache system. This folder holds **policy** (what to
keep, clip, freeze, and when, per provider). Mechanisms it orchestrates live
where their subsystems live — pointers below.

Design doc + measured numbers: `docs/tech/cache/clip-frontier-breakpoint.md`.

## Layout

```
services/cache/
  cacheProfile.ts        provider → CacheProfile resolver (CLAUDIN_CACHE_PROFILE)
  anthropic/             Anthropic-server / Claude-model–only features
    apiMicrocompact.ts   context_management beta (clear_tool_uses / clear_thinking)
    (future: cache_edits/cache_reference plumbing, retain-profile
     context-management defaults)
```

The transport-level Anthropic-only code (marker placement, TTLs, renderer)
stays under `services/api/claude/` — that folder is already per-provider.
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
`services/compact/requestDeterminism.invariant.test.ts`):

- **Stub bytes are first-write-wins** (`perKeyStubText` in
  `stableStubState.ts`): the first stub emitted for a tool_use_id records
  its exact bytes and every later rewriter replays them, so views holding
  different content for the same id (budget preview vs full original)
  cannot flip the wire bytes.
- **History deletions are amortized and announced**: the REPL's display
  array seeds the next request, so `evictOldStubbedMessages` /
  `evictToMaxSize` fire in batches (`EVICT_MIN_BATCH` = 24 evictable
  messages; `EVICT_TRIGGER_AT` = 300 → cut back to 200), call
  `notifyCacheDeletion`, and a free full sweep runs pre-query when the
  idle gap says the server cache already expired.
- **The tool pool never churns bytes gratuitously**: MCP updates replace
  in place and keep schemas across transient failures
  (`resolveUpdatedTools`), LSP `defer_loading` latches per session, and
  deferred tools are announced via persisted delta attachments
  (`tengu_glacier_2xr` on in the open build) instead of an ephemeral
  `messages[0]` prepend — with a legacy-format latch for sessions resumed
  on a warm pre-flip cache (`maybeLatchLegacyDeferredAnnouncement`).

## Pointers to the mechanisms

- `services/compact/stableStubState.ts` — stable stubs (`clippedIds`),
  first-write-wins stub byte registry (`perKeyStubText`), age prune
  (`pruneOldToolResults`), RSS byte-guard (`pruneToolResultsByBytes`),
  amortized display eviction (`evictOldStubbedMessages` /
  `evictToMaxSize` + `EVICT_MIN_BATCH` / `EVICT_TRIGGER_AT`), display
  stub, **`getClipFrontierIndex`**.
- `services/api/claude/paramBuilders.ts` — `addCacheBreakpoints`: defer-2048
  walk + frontier cap (`min(defer, frontier)`), head-pin fallback,
  skipCacheWrite fork handling, optional trailing marker on the last
  message (`CLAUDIN_TRAIL_CACHE_MARKER=1`, experimental — caches the
  defer/frontier tail window instead of re-sending it as 1× input;
  mutually exclusive with `CLAUDIN_ANCHOR_CACHE_HEAD`).
- `services/api/claude/cacheControl.ts` — ephemeral 5m/1h TTL selection.
- `services/api/claude/streaming.ts` — wiring order:
  `ensureToolResultPairing → applyStableStubs → history redactions →
  frontier → addCacheBreakpoints`; also sends `context_management` when the
  beta header is on.
- `services/compact/microCompact.ts` — explicit clip set; size trigger is
  profile-gated (0.5 aggressive / 0.85 retain); the time-based trigger
  fires when the server cache already expired and PERSISTS through the
  same clipped set (`addClippedIds`) — the post-idle "cleaned" prefix
  keeps its hits on later turns, and pre-existing size-trigger ids
  survive (no `resetClippedIds` on the time path).
- `services/mcp/useManageMCPConnections.ts` — `resolveUpdatedTools`:
  positional tool-pool replacement; schemas survive `failed` transitions
  ('disabled' still removes).
- `utils/toolSearch.ts` — `isDeferredToolsDeltaActive` +
  `maybeLatchLegacyDeferredAnnouncement`: deferred-tools announcement
  format (delta attachments vs legacy prepend), settled per session
  before tool schemas are built.
- `utils/messages/normalize.ts` — `stripOldThinkingBlocks` /
  `stripOldNarrationBlocks`: position-based keep windows (count-based
  windows pinned the frontier with sporadic thinking).
- Shims (`openaiShim/messagesClient.ts`, `codexShim.ts`) — no marker;
  longest-unchanged-prefix providers benefit from byte-stability alone.
  On top of that, official-OpenAI URLs (`isOfficialOpenAIUrl`) send
  `prompt_cache_key: getSessionId()` + `prompt_cache_retention: '24h'`
  (cache routing + extended TTL; gated by URL so third-party/local
  backends that may reject unknown params never see them). The Codex
  backend (`isCodexBaseUrl`) sends only `prompt_cache_key` — it rejects
  `prompt_cache_retention` with a `400 Unsupported parameter`.
- `tools/FileReadTool/serverClearingDetection.ts` — Read's dedup
  (`file_unchanged` stub) stands down once a `clear_tool_uses` edit has been
  applied: the stub points at an earlier tool_result the server may have
  wiped, and the API reports only counts, never which ones. The evidence
  (`context_management.applied_edits`) arrives on the `message_delta` stream
  event and is written back to the turn's last assistant message by
  `applyMessageDeltaToLastMessage` (`services/api/claude/streaming.ts`).

## Bench

`scripts/profile/cache-lockstep-bench.ts` — one user turn per file via
`--input-format stream-json` (identical pacing by construction); the
reliable harness for main-vs-branch comparisons. `cache-ab-bench.ts`
remains for exploratory runs only — its extractTimeline rows are
cumulative and run-to-run variance is high, so don't cite its numbers.
