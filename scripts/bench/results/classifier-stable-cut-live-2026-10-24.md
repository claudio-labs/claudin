# Classifier stable cut, live — 2026-10-24, branch perf/census-2026-10-24

This run used one build of the branch at 9295e960 and `claude-sonnet-5-5` for both the
main loop and the classifier. Four auto-mode sessions ran in parallel: 2 arms × 2 reps.
Each was a headless `--input-format stream-json --permission-mode auto --debug`
session in a throwaway git repo.

| Arm | What it is |
|---|---|
| `old` | `CLAUDIN_CLASSIFIER_STABLE_CUT=0`: the newest-first fill, with the budget minus the action |
| `stable` | the branch default: cut at 25k-char chunks counted from the first entry, with the whole budget |

**Workload:** 46 turns. Each turn is one user message followed by one Bash call that
the classifier has to decide (`python3 -c "print(N * 7)"`).
- The message holds the next 5,500 chars of the repo's own `docs/tech/**/*.md` prose.
- Every message carries a session tag, so sessions running at once cannot share
  prompt-cache entries. A 2-turn probe without the tag showed one arm reading the
  other's writes.
- The classifier transcript passes the 200k-char budget around turn 34. Calls past it
  were counted from the debug log's `truncated=true`.

## Pre-registered gate

Written before the full run.

1. `sourceUsage.auto_mode` cache writes: stable ≤ 0.6 × old, in every rep.
2. As first written, decisions had to be identical turn by turn. It was amended before
   the full run. The 2-turn probe sent byte-identical requests in both arms, still under
   the budget, and still got a refusal in one arm and an allow in the other, so
   per-turn identity only measures model noise. The amended gate: rejects in `stable`
   ≤ rejects in `old` + 2, summed over the reps.
3. Mechanism: every session has classifier calls with `truncated=true`.

## Results

| Session | auto_mode calls | cache write | cache read | classifier $ | main thread $ | past the budget | rejects |
|---|---|---|---|---|---|---|---|
| old r1 | 53 | 1,132,124 | 1,976,043 | $5.12 | $2.00 | 12 | 7 |
| old r2 | 53 | 1,131,682 | 2,153,215 | $5.14 | $2.01 | 12 | 7 |
| stable r1 | 53 | 340,548 | 2,824,826 | $2.11 | $2.00 | 12 | 7 |
| stable r2 | 51 | 341,080 | 2,710,422 | $2.08 | $1.99 | 12 | 5 |

- **Gate 1 passes:** writes stable/old = 0.30 in both reps (−70%). Classifier spend fell
  from $5.13 to $2.10 per session (−59%). The whole session fell from ~$7.13 to ~$4.10
  (−42%).
- **Gate 2 passes:** 12 rejects against 14.
- **Gate 3 passes:** 12 classifier calls past the budget in every session.
- The main thread cost the same in both arms ($2.00), as it should.

## A finding unrelated to the arms

Every reject in all four sessions was the same: "Auto mode classifier declined to
assess this transcript", a refusal from the model, not a block. They came 5-7 times per
session, about 14% of calls, at turns that differed between reps. In `-p` a refusal
falls back to manual approval, which is a denial; interactively it would prompt. So on
this workload (long prose in the user turns, Sonnet 5.5 as the classifier), the
classifier declines often. Both arms show it the same way.

The driver was a scratchpad script for this session and is not committed. The
workload above is enough to rebuild it.
