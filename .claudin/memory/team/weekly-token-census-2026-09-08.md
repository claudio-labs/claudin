---
name: weekly-token-census-2026-09-08
description: Token/cost census of 2026-09-04..09-08 sessions (1,044 calls, ~$170), what was fixed from it on branch feat/token-census-fixes, and the Sonnet 5 probe results that decided each promotion
type: project
---

Census of the 8 main sessions + 12 fork transcripts from Fri 2026-09-04 to Tue
2026-09-08 (Fable 5.1 + Opus 5, real `modelCost.ts` tiers): 1,044 calls, ~$170.
Split: cache reads 45%, cache writes 25%, uncached input 15%, output 15%
(thinking = 47% of output tokens). Context per call p50 206k / p90 333k / max
469k — 64% of calls ran above 150k, which is what makes reads the top line.
Reproduce with `bun scripts/bench/tokens/session-census.ts --since=2026-09-04`.

Findings and what happened to each (PR from `feat/token-census-fixes`, 2026-09-09):
- Two full-prefix rewrites (182k + 250k, ≈$8.7) in session 90cd64ea with
  `cache_read` falling to exactly 25,853 and NOTHING between the calls; the
  `[Cache: 27.5m read • hit 96%]` line hid it and the detector hashed only
  system+tools. Root cause still unknown. FIXED the observability: messages are
  hashed per request, the break reason reaches the persisted `[Cache:]` line
  (verified live: `cache break: tools changed (+2/-0 tools …) — read 31.5k→0,
  rewrote 31.6k`). Next rewrite will be attributed without `--debug`.
- 76 deduped poll turns (`sleep`/`tmux capture-pane`) ≈ $12. SHIPPED the
  `WaitFor` tool (on). The Bash sleep→WaitFor redirect is gated OFF
  (`CLAUDIN_ENABLE_WAITFOR_REDIRECT`): Sonnet 5 used WaitFor unprompted 12/12,
  so the A/B never exercised the refusal; Opus 5 re-run hit the usage limit.
- Malware reminder on every Read (375×/week). SHIPPED: opus-5/fable-5-1 exempt,
  once-per-agent default (probe: 3 reads → 1 reminder, answer unchanged).
- Forks: 156k avg inherited context. Clip experiment LOST: Sonnet 5 N=3,
  parent 204k, child 11 calls → total $1.46 → $1.62 (+11%, ranges disjoint).
  A 1h write is 20–80× a read; the clip pays only for very long forks.
  `CLAUDIN_FORK_CLIP_HISTORY` stays off as bench instrumentation.
- 1h TTL premium $16.4 vs $11.7 exposure under 5m (8 gaps of 5–28 min) — not
  worth flipping.

**Why:** a grep census over `~/.claudin/projects/<proj>/*.jsonl` overcounts —
forks mirror the parent transcript; dedupe by `message.id` and `tool_use.id`
(the first pass said 134 poll turns and a 7× refusal; deduped: 76 and 1×).
Also found along the way: the clipped-id registry (`stableStubState.ts`) is
keyed per TEAMMATE, not per agent — a fork child's own relief clips land in
the session-wide set and clip the parent's view too (pre-existing, unfixed).

**How to apply:** headless `-p` emits no `[Cache:]` system record — probe the
debug log + `cache-break-*.diff` instead and treat the REPL line as the live
gate. Probes live in `scripts/bench/ab/` (`headlessProbe.ts` harness,
`cache-break-attribution-probe.ts`, `waitfor-adoption-ab.ts`,
`read-reminder-probe.ts`, `fork-clip-ab.ts`); fresh scratch cwd per arm or the
server cache serves the other arm's prefix.
