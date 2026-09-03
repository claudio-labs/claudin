---
name: context-relief-unified-policy-ab
description: PR #156 (2026-09-03) replaced four context-relief mechanisms with reliefPolicy.ts; the A/B numbers vs v1.1.24, and the bench trap where "re-reads" split 8 vs 15 on equal information loss because one arm relocates with Grep and the other with Read(outline)
type: project
---

PR #156 `perf(cache): unify context relief into one usage-driven policy` (branch
`perf/unified-context-relief`, 2026-09-03) replaced the estimate-driven size
clip, the RSS byte-guard, `evictOldStubbedMessages` and the display-cap
eviction with one pre-request decision (`decideRelief`, window + rss lanes)
whose only action is the byte-stable stub clip. Nothing drops a message from
the API view anymore; `REPL.tsx` slices the last 200 for rendering only.

A/B (`scripts/bench/ab/context-relief-ab.ts`, Sonnet 5, 30 turns = 10 Grep →
10 full Reads → 10 Edits in those files, `--window=140000`, 3 reps, betas off
on both): uncached input 185k → 81k, cost $2.00 → $1.49 (ranges separated),
peak context 105k → 87k, prefix breaks equal (2), edit-phase lookups equal
(16 vs 16). The whole gap is the old estimate trigger firing ~20k late.

State as of 2026-09-03 evening: PR open, CI pending, merge BLOCKED on the
repo's required review. The adversarial break-and-restore audit of the new
tests ([[feedback-audit-empirical-test-verification]]) was NOT run — the user
interrupted the launch to reshape the bench, and it was recommended again
before merge. A −1,100-line cache diff without that pass is the open risk.

A recurring question from the user: "does 60k mean everything is cut to
60k?" No — `reliefBandTokens` (60k, clamped to 30% of the trigger) is how far
BELOW the trigger the clip descends once usage crosses it (~730k on native
1M at fraction 0.75); below the trigger nothing is touched. Lead with that
when the policy comes up.

**Why:** The bench's first `re-reads` column (Read calls on already-read
paths) said 8 vs 15 — a regression that was not there. Both arms had clipped
the reads and both relocated every edit anchor; v1.1.24 did it with `Grep`,
the policy build with `Read(view: outline)`. A single-tool count measures
tool choice, not information loss.

**How to apply:** For any "did the model lose context" metric, count every
lookup tool inside the phase (the bench's `edit-turn lookups`), not one tool.
On a native 1M window 30 turns never reach a trigger — pass `--window` or the
two arms are indistinguishable. Full measurements and the cost model:
`docs/tech/cache/context-relief-policy.md`. Related: [[clip-pin-cache-ab-2026-07-25]],
[[token-bench-measurement-traps]].
