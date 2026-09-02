---
name: Defer-cache-marker (prompt-cache placement) shipped 2026-06-07
description: addCacheBreakpoints now walks back N tokens before placing the single cache marker; default 2048; head-anchor fallback is load-bearing (not a bug)
type: project
---

`src/services/api/claude/paramBuilders.ts` `addCacheBreakpoints` no longer pins the single `cache_control` marker at `messages[length-1]` every turn. It now walks backward summing `roughTokenCountEstimationForMessage` and places the marker at the earliest index whose suffix sums to ≥ `DEFAULT_DEFER_CACHE_MARKER_TOKENS` (= 2048). Override at runtime via `CLAUDIN_DEFER_CACHE_MARKER=<N>` (0 = baseline).

**Why:** Anthropic's prompt cache silently discards writes when the trailing block between the previous marker and the new one is too small (empirically ~1024 tokens). With a marker pinned at every turn's last message, tool-loop turns (small tool_use + tool_result, ~300-800 tok) all fall below that floor — server bills `cache_creation` but stores nothing reusable, and the next turn finds only the system+tools checkpoint (~13k) to read. Bench `scripts/profile/cache-ab-bench.ts` over 13 small tool turns:
- baseline: r:w = 0.97:1, ~$0.50
- default 2048: r:w = 10.48:1, $0.34 (~32% cheaper, ~10.8× more cache reuse)
- For context, in a head-to-head at the same time Claude Code itself measured r:w = 0.09:1 / $0.69 on this bench — but it likely uses 1h TTL (premium write, longer lived) and we may underperform on very long sessions with pauses; revisit with a long-session bench before claiming overall parity.

**How to apply:**
- DO NOT "simplify" the `Math.max(i, 0)` fallback when the loop exhausts. Pinning to `messages[0]` as a head anchor on short/early conversations is INTENTIONAL and load-bearing — an earlier draft fell back to `baseMarkerIndex` (length-1) on reviewer advice and regressed the bench to r:w = 0.78. The long comment block in `paramBuilders.ts` documents this; respect it.
- `skipCacheWrite` bypasses the defer logic entirely (preserved).
- Behavioral tests live at `src/services/api/claude/__tests__/addCacheBreakpoints.test.ts`; threshold is memoized so tests must call `_resetDeferCacheMarkerForTesting()` after flipping the env.
- For new perf experiments in this area: prototype as `CLAUDIN_*` env toggle, A/B with `scripts/profile/cache-ab-bench.ts`, then promote to default only after a measured win — `Math.max(i, 0)` is a case study in how a reviewer's "elegant" simplification can quietly regress when the empirical signal isn't checked.
