---
name: dev-tools-deferred-advice-ab-2026-09-24
description: A/B of deferring Build/RunTests/Typecheck/WaitFor + advisory Bash redirects (N=3, Opus 5.5 medium) — no cost regression, prefix −3.3k tokens, but deferred RunTests/Typecheck went unused (0/9) and the test lanes never fire on piped runs
type: project
paths:
  - "src/tools/BashTool/redirectLanes.ts"
  - "src/tools/ToolSearchTool/prompt.ts"
---

Run `/tmp/session-cache-ab/20260924-143858` (`scripts/bench/ab/session-cache-ab.ts
--reps=3 --effort=medium`), branch `feat/dev-tools-deferred-advice` @ 84f6707d.
Four simultaneous arms of the same binary: `claudindev` (deferred + advice),
`refuse` (`CLAUDIN_BASH_REDIRECT=refuse`), `eager` (`CLAUDIN_EAGER_DEV_TOOLS=1`),
`placebo` (a no-op env). 12/12 sessions passed 18/18 hidden checks; ~$14 spent.

| median [min–max] | claudindev | refuse | eager | placebo |
|---|---|---|---|---|
| session cost | $1.07 [1.02–1.26] | $1.18 [1.18–1.25] | $1.22 [0.95–1.32] | $1.24 [1.07–1.27] |
| turns | 21 [20–23] | 24 [24–30] | 20 [20–25] | 21 [19–24] |
| first-turn context | 17.3k | 17.3k | 20.6k | 17.3k |

- **Noise band is ±16%**: placebo is byte-identical to claudindev and cost +16%.
  Neither cost delta (eager +14%, refuse +10%) is a finding; the pre-registered
  gates passed as "no regression", not as a saving.
- **Deferral is −3.3k prefix tokens per request** (deterministic), worth ~3% of
  a session at Opus 5.5 cache prices — below what N=3 can resolve.
- **Deferred, the model never loaded the tools**: 0 ToolSearch calls and 0
  RunTests/Typecheck calls in 9 deferred sessions, against 5 RunTests + 2
  Typecheck calls in the 3 eager ones. It ran `bun test 2>&1 | tail -30` in Bash.
- **The RunTests/Typecheck lanes never fired in any arm**: every Bash test run
  carried a `| tail`/`| grep` or was compound (`cd … && bun test …`, `for …`),
  the shapes both modes skip on purpose. This fixture does not measure advice
  vs refusal for tests at all.
- Refusal costs turns: refuse +3 turns (separated ranges). The Read lane fired
  3× as advice and 2× as refusal; no repeat read-only Bash followed either.
- Most harness refusals in every arm were Patch read-gate refusals after files
  were read with `for f in …; do cat $f; done` — unrelated to this branch.

**How to apply:** if RunTests/Typecheck adoption matters, the levers are the
piped/compound exclusion in advise mode (a note blocks nothing, unlike the
refusal the exclusion was written for) or keeping RunTests eager — measure
either against this run with `--replay`.
