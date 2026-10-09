---
name: weekly-token-census-2026-10-09
description: Census 2026-10-02..09 ($2,783, 13.3k calls, writes 39%) — #273 causes gone; sub-agent 5m-TTL expiries behind foreground sleep/break-probe waits $592; 4k relief clips rewrite ~800k prefixes ($142 + follow-on turn floors $68); 1M still never compacts (trigger 967k)
type: project
---

Census of 2026-10-02 → 10-09 (`session-census.ts --since=2026-10-02`, `lookback-miss-census.ts
--since=7 --verbose`, three read-only forensic agents). $2,783 = writes $1,091 (39%, vs ~13-19% in
September) + reads $1,373 + output $319. ed9c2e1c (clean-base rewrite, 202 sub-agents) = $2,128.

**No #273 cause recurred.** The other main-thread sessions (on `main`) had zero full rewrites. In
ed9c2e1c, the `[Cache:]` line carries the "server dropped N thinking blocks" label, so the
binary had #273. Its 38 main-thread rewrites (29.1M tokens, $291) break down as:
- 19 relief clips, 14.2M, $142: a **new client cause**. The window lane sits 200-320k short
  of its 625k target, and `RELIEF_MIN_EVENT_TOKENS = 4_000` (`reliefPolicy.ts:125`) clips as
  soon as 4k ages out, which rewrites ~800k. From 10-03 23:46Z on, 16 clips freed ~92k and cost $124.
- 9 floors on the first request of the next human turn, 6.8M, $68. Each followed a turn that had
  a rewrite, so in practice one clip costs two rewrites.
- 6 idle >1h (expected).
- 3 detector-named mutations, $22, not yet explained: two changed the Bash result the
  preceding clip had protected; one was messages.3 on resume.

**Sub-agents: 400 rewrites, 94.8M, $592.** All of them are 5m-TTL expiries. The waits were a
foreground `sleep 240-1795` or a sleep loop after backgrounding `break-probe.ts` (~72 runs).
None involved WaitFor, relief, or a client mutation. In 770cedde, 12 Code agents re-wrote
260-290k every ~10 min. Lever: cap a sub-agent's foreground waits under ~4.5 min (≈$410/wk)
or move it to 1h TTL once it starts a long wait (≈$474/wk). These are alternatives.

**Context:** the 1M autocompact trigger is 980k − 13k = 967k (`autoCompact.ts:124`). ed9c2e1c
peaked at 957k (avg 611k) with zero compactions, and "relief starved" never escalates.

**Measurement bugs:**
- `session-census` misses floor→floor rewrites (221 sub-agent events, $331).
- `lookback-miss-census` treats a `<synthetic>` record as the previous call and doesn't read
  `relief clip` entries.
- The detector applies the 5-min rule on 1h threads (`promptCacheBreakDetection.ts:911`) and
  measures the gap from the last response instead of from the request start.

**What landed (branch `fix/cache-census-2026-10-09`):** the fixes in
[[relief-starved-compacts-keepalive-default]]. The 3 "mutations" turned out to be
`extract_memories` fork clips, which landed in main's clipped set. Both census scripts were fixed
the same day.

**Why:** the rewrite share doubled in one week. Every dollar of it was relief clips or
waits that outlived the TTL, not prompt bytes.

**How to apply:** scale the relief minimum to the prefix size before touching anything else,
and keep sub-agent waits under the TTL. [[weekly-token-census-2026-09-20]]
[[turn-opening-full-prefix-rewrites]]
