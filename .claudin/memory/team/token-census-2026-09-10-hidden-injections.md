---
name: token-census-2026-09-10-hidden-injections
description: Census of 2026-09-09..10 sessions ($278, 1,882 calls) — the transcript census is blind to rule/CLAUDE.md attachments (~19% of all context), fresh Code agents carry 43% orientation, fork-at-300k and 5m-TTL-vs-nested-Agent findings, keep-alive economics
type: project
---

Census of Tue 2026-09-09 → Wed 2026-09-10 (`session-census.ts --since=2026-09-09`):
1,882 calls (830 main / 1,052 sidechain), $278 — reads 46%, writes 25%, output 17%,
uncached input 12%. Context p50 142k / p90 343k; sidechain cost $130 (47%), of
which one 33-fresh-agent audit fan-out (5987df7b) was $59.74 and seven forks at
~300k parent context (121c385f) were $35.44.

**The transcript census under-attributes ~19% of context.** `claude_md_delta` and
`nested_memory` (AGENTS.md + always-on rules + both MEMORY.md indexes; the
path-scoped `.claudin/rules/*.md`) are attachments and are NOT persisted in the
`.jsonl` — only `deferred_tools_delta` is. Persisted message bytes for a 357k
session were ~150k tokens. Found them by the residual method: per call,
`Δctx − (new tool_result tokens + previous output + thinking)`; jumps >2.5k are
injections, jumps >100k are prefix rewrites. Measured: fresh Code agent gets
~23k tokens at its first tool call (orientation) + ~15k on the first `src/**`
Read (search-strategy 31.6k chars + code-design + typescript-patterns) + 5–8k
per extra rule touched — 43% of everything a fresh agent reads (≈$28/2 days);
main sessions carry 16% (≈$18). `omitClaudeMd` exists but only Plan and the
WebResearchers set it (`runAgent.ts`, `pipeline.ts`).

Other findings: (1) fresh `agent:*` sub-agents are 5m TTL; when they spawn nested
Agents that take >5 min, their own prefix expires and rewrites (6×, 346k tok,
≈$2.2) — the write TTL cannot know the next response will block. (2) Keep-alive
pings every 4.5 min at the 5m tier would have cost $3.33 vs the $14.64 1h premium
actually paid (23 gaps of 5–60 min); untested, and subscription quota may count
the pings. (3) 57 full Reads >8k chars = 25% of Read chars, mostly `/tmp/*.diff`,
`.txt` and memory `.md` — the auto-outline pivot is line-based and skips them.
(4) 229 Bash `cd <other-repo> && git show …` calls (415k chars) because the Git
tool has no `-C`/cwd and the redirect ignores `cd &&`. (5) ExitPlanMode echoes
~40% of the plan back in its result (67k chars / 10 calls). (6) Exact duplicate
tool inputs are negligible (12 Reads) — the tool-result cache works; the
"re-reads" are different ranges of the same file.

**Why:** a grep/usage census that trusts the transcript reports rules as "free"
and blames Read for context growth; the injections are the second-largest
component after the fixed prefix and the only one that scales with fan-out.

**How to apply:** for any context attribution, run the residual method (or add it
to `session-census.ts`) before ranking levers. Reproduce: the scripts were
throwaway (`/tmp/deep-census.ts`, `/tmp/hidden-all.ts`) — the method is above.
Related: [[weekly-token-census-2026-09-08]], [[fork-vs-fresh-ab-2026-09-09]].
