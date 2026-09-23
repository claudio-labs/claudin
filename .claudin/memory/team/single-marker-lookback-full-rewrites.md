---
name: single-marker-lookback-full-rewrites
description: FIXED 2026-09-13 (lagging marker) — the single deferred cache marker caused full-history rewrites when it jumped ≥20 positions past the last write (Anthropic lookback window); 38.6% of 30 days of cache writes; detector said "likely server-side"
type: project
---

**2026-09-23: the cause is gone from the default path.** The message marker
now sits on the last message (`CLAUDIN_DEFER_CACHE_MARKER` defaults to 0, see
[[defer-cache-marker-shipped]]), so it advances every request and cannot jump
20 positions at once; the miss below needs `CLAUDIN_DEFER_CACHE_MARKER=2048`
(the probe pins it). The lag marker stays — free, and it covers the opt-in.

**Fixed on branch `fix/cache-lag-marker` (2026-09-13):** a second, lagging
marker on the previous request's marker message
(`src/providers/shims/claude/lagCacheMarker.ts`, `CLAUDIN_DISABLE_LAG_CACHE_MARKER=1`
off). Probe 3/3 both arms on Sonnet 5; design in
`docs/tech/cache/lookback-lag-marker.md`. The 30-day census
(`scripts/bench/tokens/lookback-miss-census.ts --since=30`) put the class at
414 events / 35.9M of 92.9M cache-write tokens across 213 sessions — re-run it
after a week to confirm the `marker-jump` column drops to zero.

Session ab1e69e8 (2026-09-13, opus-5 1M window, 879 calls, 720k ctx) paid 7 full
message-history rewrites (192k → 685k tokens each, 3.06M of 3.80M total cache-write
tokens = 81%), every one with `cache_read` falling to exactly 27,532 (the
system+tools breakpoint) and the `[Cache:]` line saying "likely server-side
(prompt unchanged)". No compaction ran (0 boundaries), so PR #182 is unrelated.

**Why:** `addCacheBreakpoints` (`src/providers/shims/claude/paramBuilders.ts`)
places exactly ONE message marker, deferred to the earliest index whose suffix
≥ 2048 est. tokens. During runs of tiny tool calls the marker crawls and the
uncached tail grows to 3–6k real tokens over 15–30 messages; the next big block
(image prompt, Read + rule injection, apply_patch) makes the marker jump to the
end. Anthropic's docs (prompt-caching, "lookback window") now state: the server
checks at most 20 positions behind a breakpoint, and "if a growing conversation
pushes your breakpoint 20 or more blocks past the last cache write, the lookback
window misses it. Add a second breakpoint closer to that position." Signature in
the transcript: `input_tokens` collapses (6194→2) on the same call `cache_read`
collapses to the system breakpoint. 5 of 7 fit; the 03:36 one (entries 6
positions back, and the same bytes re-counted 131k smaller) is a genuine
server-side miss, unexplained. Aborted prompts (user re-sent) still write cache
and leave no usage in the transcript — hidden rewrites are possible.

**How to apply:** fix is a second, LAGGING marker at the previous request's
marker index (free — already cached; system emits ≤2, so main+lag fits the
4-breakpoint cap; mutually exclusive with `CLAUDIN_TRAIL_CACHE_MARKER` /
`CLAUDIN_ANCHOR_CACHE_HEAD`), or cap the per-request marker advance below 20
positions. Teach `buildCacheBreakReason` the jump so it stops saying
"server-side" for this. Related: the clip-frontier invariant in
`.claudin/rules/cache.md`, and [[context-relief-unified-policy-ab]].
