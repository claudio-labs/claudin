---
name: feat/cache-head-anchor branch state (Plan B)
description: 2026-06-08 — feat/cache-head-anchor adds default-on messages[0] cache_control anchor; controlled A/B is directional only (r:w 1.06→3.39), head-to-head vs claude blocked by cache-ab-bench harness bugs
type: project
---

`feat/cache-head-anchor` (not merged) extends the defer-cache-marker work in `src/services/api/claude/paramBuilders.ts:addCacheBreakpoints` with a SECOND `cache_control` marker pinned to `messages[0]`. Default ON; kill-switch `CLAUDIN_DISABLE_CACHE_HEAD_ANCHOR=1` (deprecated alias `CLAUDIN_ANCHOR_CACHE_HEAD=0`). Skipped when `skipCacheWrite=true` (preserves fork-subagent fire-and-forget invariant) and when `messages.length <= 1`. Coalesces with the trailing marker when walk-back pins to index 0. Two commits on the branch: `8f91a7fb` (bench expansion to 30 mixed-size files) and `56cf0893` (head-anchor default-on + 5 new tests + stableStub.benchmark expectation 1→2 markers).

This is a DIFFERENT head anchor than the `Math.max(i, 0)` fallback called out in `defer-cache-marker-shipped.md` — the latter is the trailing marker's safety net when walk-back exhausts; this one is an additional permanent prefix anchor that coexists with it. Both load-bearing, do not conflate.

**Why:** Single-marker policy (after the deferred trailing-pair short-circuit) places the marker at `length-1` every turn. The window between the previous turn's marker and the new one — prev `assistant(tool_use)` + new `user(tool_result)` + new `assistant(tool_use)`, ~9k tok on mixed Read workloads — is re-billed as `cache_creation` every turn because no marker parks further back to lock the prior tail as `cache_read`. A second marker at `messages[0]` extends the cached prefix beyond the system+tools block to cover the first user turn permanently. Anthropic API supports up to 4 markers; the prior `addCacheBreakpoints` comment about Mycro KV eviction forcing single-marker is upstream first-party folklore — Claude Code itself uses multi-marker empirically.

**How to apply:**
- Status as of 2026-06-08: NOT merged to main; evidence is **directional only**. One controlled A/B on the 30-file mixed bench (head-anchor OFF→ON, same harness, same cwd) showed `cR=821.6k→1.28m`, `cW=778k→377k`, r:w 1.06→3.39, cost $1.43→$0.71. Variance between identical reruns of the same binary is huge (r:w spread 0.73 → 3.39 → 2.57 → 3.68), so single-run A/Bs are noise; N≥3 with median needed before authoritative claim.
- Still ~1.8× behind Claude Code's empirical r:w 6.21 on the same workload — ~10k/turn of orphan window remains in steady state. A "Plan C" is the obvious follow-up (target: the residual gap), but defer until the bench is trustworthy.
- Head-to-head vs `claude` binary is BLOCKED by `scripts/profile/cache-ab-bench.ts` bugs (see `cache-ab-bench-unreliable.md`) — do not cite head-to-head numbers from that script until it's fixed.
- The bench's `extractTimeline` output prints cumulative totals replicated across every turn, not per-turn deltas — the per-turn tables in the script's output are misleading. The TOTALS row is real; per-turn rows are not.
