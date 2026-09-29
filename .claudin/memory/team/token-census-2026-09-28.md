---
name: token-census-2026-09-28
description: Token/cost census of 2026-09-26..28 ($1,823, 8,739 calls) — one clean-room-rewrite fan-out (501d7261, 54 Code sub-agents) was 77%; output tokens incl. thinking stay resident (fit k≈1.0); sub-agents never relieved below 750k; 5m-TTL expiries behind WaitFor/fg Bash $65; Bash filter and Read re-reads are NOT the lever
type: project
---

Census of Sat 2026-09-26 → Mon 09-28 (all projects; claudin 96%). $1,823 =
reads $1,139 (62%) + writes $345 + output $339. Session 501d7261 (the
clean-base rewrite: 54 fresh Code sub-agents, one per characterize/implement
unit) = $1,395 — sub-agents $1,223, 88-206 calls each, max ctx p50 418k /
max 710k, zero compactions (1M window, trigger ≈750k, never reached).

Levers, 3-day $ (upper bounds):
1. **Context ceiling** — cache reads above 200k: main $190 + sub $263;
   above 300k: $116 + $126. Same open item as [[weekly-token-census-2026-09-20]] #1,
   now dominated by sub-agents.
2. **Thinking is resident** — regressing ctx growth over 89 threads gives
   `G ≈ R/2.0 + 1.01·O` (R = tool-result chars, O = output tokens), so every
   output token, thinking included, is re-read by every later call. Est.
   residency of output $504 (thinking ≈$366, sub $207) on top of $339 emitted.
   claudin's project effort is pinned `xhigh` and sub-agents inherit it
   (`subagentThinking.ts`, since 09-25). Batch-clearing thinking has the
   keep-window pathology documented in `apiMicrocompact.ts`.
3. **5m-TTL expiries** — 27 in sub-agents after >5-min gaps, $65.50 of
   rewrite premium vs ≈$14.7 for 4.5-min keep-alives: 18 after `WaitFor`
   (38 sub-agent calls had `timeout_s` >300, max 600), 9 after foreground
   Bash with 5-10 min timeouts. Moving those agents to 1h would cost more
   (+$143 on 501d7261's $238 of writes).
4. **Unexplained floor drops** — 17 drops with <5-min gaps ($32): sub-agent
   history fell to the system+tools floor (12,672) mid tool-loop, nothing
   between the calls in the transcript. Needs a wire/`[Cache:]` capture.
5. **Not levers:** Bash = 14% of result chars, residency ≈$75 total; 80% of
   calls unfiltered but avg 840 chars and mostly self-piped; the 127 results
   >3k are deliberate data (`bun -e` scans, `sed -n`, `cat` of task output).
   Read re-reads: overlap+contained+after-edit ≈250 items / 1.25M chars
   (≈6% of Read chars, residency ≈$30); dedup stub fired once because
   re-reads are different ranges.

**Why:** the cost is a regime (long sub-agents at xhigh on a 1M window), not
tool shapes — the same finding as 09-20, sharper.

**How to apply:** rank by Σ max(0, ctx−T) and by output residency before
touching filters. Method traps: split batch Read results on `==> path <==`
headers (files cut by "Not shown — over the …k tokens" and batch
auto-outline → `view:'full'` pairs otherwise count as identical re-reads);
`cut-refetch-census.ts` needs `bun --preload ./src/stubs/test-preload.ts`;
write census stdout to a file — the Bash filter line-capped a report table.
