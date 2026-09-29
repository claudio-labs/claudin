---
name: subagent-unit-ab-2026-09-29
description: Real-unit A/B (sessions/indexingScan, 5 arms × 3 reps, Opus 5.5 parent at xhigh) — effort cap `high` on sub-agents −24% vs base with disjoint ranges, thinking −48%, quality equal; relief trigger 250k +7% and over-clips ~3× (tool output tokenizes at ~1.7 chars/token on Opus 5.x, the client assumes 3.5)
type: project
---

Run 2026-09-29 on branch `perf/cache-levers-2026-09-28`, harness
`scripts/bench/ab/subagent-unit-ab.ts` (re-runs the recorded `sessions/indexingScan`
characterization unit of session 501d7261 from its pristine sandbox, through the
wire proxy). Rep 1 from run `/tmp/subagent-unit-ab/2026-09-29T00-39-30-184Z`, reps
2–3 from `…T01-35-59-749Z` (the first process died with the host session mid-rep 2;
`--first-rep/--prior` resume it). ≈$196 for the 15 graded runs.

Gates were fixed before the run: quality every rep, cost median below base AND
placebo with ranges disjoint from base, mechanism evidence.

| arm | ok | total median [range] | sub calls | max ctx | thinking |
|---|---|---|---|---|---|
| claude (Claude Code 2.1.283) | 3/3 | $12.39 [12.25–13.98] | 93 | 269k | 66k |
| base | 3/3 | $12.65 [11.95–15.36] | 67 | 331k | 84k |
| placebo | 3/3 | $15.33 [13.33–15.36] | 81 | 320k | 78k |
| relief `CLAUDIN_SUBAGENT_RELIEF_TRIGGER=250000` | 3/3 | $13.56 [13.38–18.43] | 101 | 246k | 98k |
| effort `CLAUDIN_SUBAGENT_EFFORT_CAP=high` | 3/3 | **$9.58 [7.79–10.68]** | 67 | 253k | **44k** |

- **effort passed all three gates**: −24% vs base, −37% vs placebo, range disjoint
  from all six base+placebo runs; sub-agent requests carried `high`, thinking −48%;
  deliverable depth equal (tests median 55 vs 51/66, 40 probes, specs 295–361 lines);
  wall 14–18 min vs 23–27. Also −23% vs Claude Code's own sub-agent.
- **relief lost** (+7%, overlap, more calls and more thinking). Its clip over-shoots:
  rep 2 asked to free ~57k at 247k and fell to 60k — 64 results, 334k chars for 187k
  tokens = **1.70 chars/token**, while `MODEL_TOKENIZER_CONFIGS` assumes 3.5 for every
  Claude model (`src/shared/tokenEstimation.ts:301`). The agent then re-read what it
  lost. The same ~3× shows on main-thread relief (6d8e403b: "~112k" logged, 734k→405k).
- Base-vs-placebo spread is 21–28% per rep: never read an n=1 here.

Shipped as a one-level step-down below a raised parent, not a fixed cap
(`CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN`, [[subagent-effort-cap-high-default]]); from xhigh
it is the same `high` measured here. The relief over-clip was fixed on the same branch
(real units + the thinking a clip drops): the replayed decision takes 8 clips, not 68.

Links: [[token-census-2026-09-28]] (why), [[feedback-gates-need-a-placebo-arm]].
