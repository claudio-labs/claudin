---
name: subagent-effort-cap-high-default
description: Sub-agents run one effort level below a parent raised above its model's default since 2026-09-29 (max→xhigh, xhigh→high, Opus 5.5 high→medium; at/below default unchanged) — xhigh→high measured −24% on a real unit, disjoint; `CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN=0` restores inheritance
type: project
scope: src/tools/AgentTool/subagentThinking.ts, src/tools/AgentTool/runAgent.ts
impact: functional
---

**Decision:** a non-fork sub-agent runs ONE effort level below its parent when the
parent's named level is above the default of the parent's model
(`getDefaultEffortForModel`): max → xhigh, xhigh → high, and on Opus 5.5 (default
medium) high → medium. A parent at or below the default — the unpinned case — is
inherited as is, so the step never lands below the default. Forks keep the parent's effort
(cache prefix), an agent definition with its own `effort` keeps it, `CLAUDIN_EFFORT_LEVEL`
still pins every request. `CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN=0` restores plain inheritance.
Taken by the user on 2026-09-29, branch `perf/cache-levers-2026-09-28` (PR #266).
The first cut was a fixed `high` cap; the user changed it the same day to the one-step
rule, so a `max` parent keeps its sub-agents at `xhigh` instead of `high`.

**Why:** a sub-agent's thinking is billed as output and then re-read by every later call —
output tokens are ~46% of a fresh Code agent's final context. The real-unit A/B
([[subagent-unit-ab-2026-09-29]]) with the parent at xhigh and the sub-agent at high:
$9.58 [7.79–10.68] vs base $12.65 [11.95–15.36] and placebo $15.33 [13.33–15.36], thinking
−48%, 3/3 deliverables of equal depth, 35% faster, and below Claude Code's own sub-agent
($12.39). Only the xhigh→high step was measured; max→xhigh and high→medium are the same
rule, unmeasured.

**What changes for a teammate:** with a project pinned above the model default, delegated
work thinks one level less than the main thread. With no pin nothing changes (Opus 5.5
defaults to `medium`, [[opus-5-5-default-effort-medium]]). One task type was measured (a
characterization unit); a regression on deep-reasoning delegations would show here first.

**Rejected:** `CLAUDIN_SUBAGENT_RELIEF_TRIGGER=250000`, measured in the same run (+7%,
overlapping ranges) — it stays an off-by-default experiment.

**Evidence:** `scripts/bench/ab/subagent-unit-ab.ts`; runs
`/tmp/subagent-unit-ab/2026-09-29T00-39-30-184Z` (rep 1) and `…T01-35-59-749Z` (reps 2–3);
pinned by `subagentThinking.test.ts` and `scripts/migrations/probes/subagentEffortStepDown.json`.
