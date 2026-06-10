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

## Pointers to the mechanisms

- `services/compact/stableStubState.ts` — stable stubs (`clippedIds`),
  age prune (`pruneOldToolResults`), RSS byte-guard
  (`pruneToolResultsByBytes`), display stub, **`getClipFrontierIndex`**.
- `services/api/claude/paramBuilders.ts` — `addCacheBreakpoints`: defer-2048
  walk + frontier cap (`min(defer, frontier)`), head-pin fallback,
  skipCacheWrite fork handling.
- `services/api/claude/cacheControl.ts` — ephemeral 5m/1h TTL selection.
- `services/api/claude/streaming.ts` — wiring order:
  `ensureToolResultPairing → applyStableStubs → history redactions →
  frontier → addCacheBreakpoints`; also sends `context_management` when the
  beta header is on.
- `services/compact/microCompact.ts` — explicit clip set; size trigger is
  profile-gated (0.5 aggressive / 0.85 retain), time-based trigger clips
  when the server cache already expired (mutation is free then).
- `utils/messages/normalize.ts` — `stripOldThinkingBlocks` /
  `stripOldNarrationBlocks`: position-based keep windows (count-based
  windows pinned the frontier with sporadic thinking).
- Shims (`openaiShim/messagesClient.ts`, `codexShim.ts`) — no marker;
  longest-unchanged-prefix providers benefit from byte-stability alone.
- `tools/FileReadTool/serverClearingDetection.ts` — Read's dedup
  (`file_unchanged` stub) stands down once a `clear_tool_uses` edit has been
  applied: the stub points at an earlier tool_result the server may have
  wiped, and the API reports only counts, never which ones. The evidence
  (`context_management.applied_edits`) arrives on the `message_delta` stream
  event and is written back to the turn's last assistant message by
  `applyMessageDeltaToLastMessage` (`services/api/claude/streaming.ts`).

## Bench

`scripts/profile/cache-ab-bench.ts` — A/B against Claude Code
(`--sequential --revisits=8` is the fidelity workload; usage parsed from the
session transcript because claudin's stream-json emits assistant events
before final usage lands).
