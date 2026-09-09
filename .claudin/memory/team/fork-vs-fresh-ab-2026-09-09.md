---
name: fork-vs-fresh-ab-2026-09-09
description: Fork vs fresh Code agent A/B (Sonnet 5, N=3, 2026-09-09) — fresh −44% total at equal answers; parallel forks probe PASS (9/9 hits, no duplicate writes); count_tokens rate-limit stalls big Reads for minutes
type: project
---

Two benches landed 2026-09-09 in `scripts/bench/ab/` (shared parsing in `forkBench.ts`, unit-tested):

**`fork-vs-fresh-ab.ts`** — same task text delegated to a fork (no `subagent_type`) vs `subagent_type: "Code"`, parent at ~203k context, child does 27 calls (`wc -l` + `grep -c` per file, 8 files, plus a secret). Sonnet 5, N=3, 6/6 correct:
- FORK total $2.232 (range 2.225–2.233), child $1.271 of which **read $1.119** (5.6M read tokens = 203k × 27 calls)
- FRESH total $1.255 (range 1.248–1.303), child $0.296, read $0.143 (0.7M read tokens, 22k prefix)
- **FRESH cheaper by 44% on total, 4.3× on the child; ranges disjoint.** Same call count, same answers — the fork's history bought nothing for a task that fit in a brief.
- At Fable 5.1 (read $0.25/M) the ratio is similar; at Opus 5 (read $0.50/M) worse for the fork.

**`parallel-forks-probe.ts`** — 3 forks launched in ONE assistant message vs one at a time, N=3: **PASS**. 9/9 children hit the parent's prefix (first-call read = 1.00 of the spawn context), first-call cache writes 0 (the directive tail sits under the 2048-token deferred marker), parent's first call after the return reads 1.00 of the spawn context. Parallel was slightly cheaper than serial (median $1.49 vs $1.58 — fewer parent turns). Concurrency does not break the cache.

**Why:** the 2026-09-04..09 census showed forks re-read the inherited prefix on every call (84% of child read tokens, 36% of child spend) while hitting the cache 18/18 on the first call — so the cost is policy (fork by default, inherit everything, long children), not a miss. This A/B is the first time fork vs fresh-with-brief was measured on the same task; the earlier −32% "fork wins" number was fork vs Claude Code, not fork vs a named agent.

**Promoted on branch `feat/prefer-fresh-subagent` (2026-09-09):** the Agent tool's "When to fork" section became "Fork or fresh agent" (`src/tools/AgentTool/prompt.ts`), `getAgentToolSection()` and the multi-hop delegation lane in `prompts.ts` now default to a fresh `Code` agent with a brief and reserve the fork for a child that needs the conversation itself; examples show both lanes; `.claudin/rules/search-strategy.md` item 4 matches. The fork MECHANISM (fork-by-default when `subagent_type` is omitted) is unchanged — only the guidance moved. Sanity probe after the build: a brief-able delegation on Sonnet 5 picked `subagent_type: "Code"` (N=1).

**How to apply:** the old system-prompt line "Forks are cheap because they share your prompt cache" was true for one call. For a delegated task that fits in a written brief (implementation with a scoped spec, a file-level lookup), a named agent is the cheaper default; fork when the child needs the *history*. Do not re-run the clip experiment (`CLAUDIN_FORK_CLIP_HISTORY`) — any edit inside the inherited prefix rewrites everything after it.

**Harness trap found on the way:** a Read whose rough estimate exceeds 1/4 of the Read cap calls `/v1/messages/count_tokens` (`FileReadTool/guards.ts::validateContentTokens`), which is rate-limited separately and retried once honouring a long retry-after — on Sonnet 5 each ~20k-token fixture Read stalled **2.5–4.5 min** (debug log: `[API REQUEST] /v1/messages/count_tokens` then nothing for 161s). Benches set `CLAUDIN_FILE_READ_MAX_OUTPUT_TOKENS=100000` (`BENCH_ENV`) to stay on the estimate. Real sessions reading big files hit the same stall; unfixed. `subagent-cost-bench.ts` is obsolete (its regime switch predates fork/background decoupling).
