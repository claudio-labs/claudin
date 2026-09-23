---
name: Defer-cache-marker — shipped 2026-06-07, default REVERSED to 0 on 2026-09-23
description: The message cache marker walked back 2048 tokens (2026-06-07) on an unreliable bench; the graded session bench showed it cost 4–17% more, so the default is 0 (last message, capped at the clip frontier) and 2048 is opt-in
type: project
scope: cache/defer-marker
impact: functional
---

**Decision (2026-09-23):** `DEFAULT_DEFER_CACHE_MARKER_TOKENS = 0` in
`src/providers/shims/claude/paramBuilders.ts` — the single message marker goes
on the last message, capped at the clip frontier, like Claude Code.
`CLAUDIN_DEFER_CACHE_MARKER=2048` restores the deferred walk; the walk, its
`Math.max(i, 0)` head anchor and the lag marker are unchanged code.

**Why:** the deferral assumed the API discards writes smaller than ~1024
tokens. The graded session bench (`scripts/bench/ab/session-cache-ab.ts`,
N=3 per arm) found the deferred tail billed as uncached input turn after turn
and then written anyway, while Claude Code's 555–774-token writes were read
back on the next turn:

| 0 vs 2048 | session cost | uncached input | cache write |
|---|---|---|---|
| Opus 5.5, 1h | $1.80 vs $1.88 (−4%, SEPARATED) | 46 vs 40.1k | overlap |
| Sonnet 5, 1h | $1.83 vs $2.17 (−15%, SEPARATED) | 96 vs 146k | +3% (overlap) |
| Opus 5.5, 5m (`CLAUDIN_MAIN_CACHE_TTL=5m`) | $1.40 vs $1.67 (−17%, overlap) | 42 vs 35.7k | +0% |

The 2026-06-07 evidence (r:w 0.97 → 10.48) came from `cache-ab-bench.ts`, later
found structurally unreliable ([[cache-ab-bench-unreliable]]: cumulative rows,
~5× run-to-run swing).

**What changes for a teammate:**
- A cache experiment is A/B'd with `session-cache-ab.ts --variant=<label>:<ENV>=<value>`, not `cache-ab-bench.ts`.
- `lookback-miss-probe.ts` pins `CLAUDIN_DEFER_CACHE_MARKER=2048` in both arms — the lookback miss only exists under deferral ([[single-marker-lookback-full-rewrites]]).
- With deferral opted in, the `Math.max(i, 0)` head anchor is still load-bearing: a fallback to length-1 regressed the old bench to r:w 0.78.

**Rejected:** a TTL-aware default (0 for 1h requests, 2048 for 5m) — the 5m gate showed 0 winning there too. **Not measured:** one-shot 1h forks without `skipCacheWrite` (memory extraction, auto-dream) now write their short tail at 2× instead of sending it as 1× input; interactive sessions with long pauses.

**Evidence:** runs `/tmp/session-cache-ab/20260923-043629` (Opus), `-053140` (Sonnet), `-054328` (5m); [[session-cache-ab-bench-2026-09-23]].
