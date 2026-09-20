---
name: context-relief-unified-policy-ab
description: PR #156 (2026-09-03, merged) replaced four context-relief mechanisms with reliefPolicy.ts; the A/B numbers vs v1.1.24, the "re-reads" bench trap, and the 2026-09-20 measurement showing the retain profile cannot relieve a 1M window (floor above band, one-result ~0k clips, big clips = full rewrites)
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

Merged: `src/agent/compact/reliefPolicy.ts` is on main (verified 2026-09-20).
Whether the adversarial break-and-restore audit of its tests
([[feedback-audit-empirical-test-verification]]) ever ran is not recorded.

**Measured on a 1M window, 2026-09-20 — the retain profile cannot relieve
it.** Trigger 0.75×window ≈ 750k, band 60k → target 690k. In session 88f03ef5
(1,216 calls, p50 687k, max 958k) the floor under the profile — 1,427 stub
heads of 2,000 chars (~236k) + tool_use INPUTS that are never clipped
(apply_patch/Write/ExitPlanMode bodies, ~218k, 40% of the transcript) +
system 27k — sat above the band, so `decideRelief` fired on every call and
`selectReliefIds` clipped one result for ~0k: 149 clip events, 140 of them
single-result. The four multi-result clips (93/168/156/16 results) were the
session's four full-prefix rewrites (2.53M of 3.80M cache-write tokens).
`applyStubs.ts` touches `tool_result` only; server-side `clear_tool_inputs`
is inert because `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS` defaults to true. The
band formula (B* ≈ 60k) was derived for 200k windows. Numbers and levers in
[[weekly-token-census-2026-09-20]].

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
