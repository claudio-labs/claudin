# Classifier window budget + lag marker, live — 2026-11-11, branch perf/census-2026-11-11

**Status: both reps run, all six gates pass in each.** The levers are still opt-in: the
default flips on the user's yes, not on this file.

The two reps ran as two one-rep runs, so the account's quota could be read between them
(rep 1 took the Max plan's 5-hour window from 28% to 53%; rep 2 ran after it reset).
Rep 1's run directory was under `/tmp` and went with a host reboot before rep 2, so the
two are reported from each run's own report instead of `--report=<run 1>,<run 2>`, and
the gates that are written on means are worked out below from the two tables.

`claude-sonnet-5-5` for the main loop and the classifier, three headless
`--permission-mode auto --debug` sessions side by side, each in a throwaway git repo.
Rep 1 ran on the build of 95828731 and rep 2 on the build of e2530101. Between the two
the lag marker's key was made cheaper (a long block counts by its length and both ends,
see the replay's notes); the candidate wrote and read the same number of tokens in both
reps, to the token, so the change moved no breakpoint. The driver, its workload and its
gates are `scripts/bench/ab/classifier-cache-ab.ts`; the gates were committed before
the first run.

```
bun scripts/bench/ab/classifier-cache-ab.ts --reps=1 --budget-usd=45   # rep 1, 2026-11-11
bun scripts/bench/ab/classifier-cache-ab.ts --reps=1 --budget-usd=23   # rep 2, 2026-11-12
```

| Arm | What it is |
|---|---|
| `base` | both levers unset: the fixed 200k-char budget, cut in 25k chunks, one breakpoint on the action |
| `placebo` | base plus a variable nothing reads |
| `candidate` | `CLAUDIN_CLASSIFIER_WINDOW_BUDGET=1` and `CLAUDIN_CLASSIFIER_LAG_MARKER=1` |

**Workload:** 54 turns. Each is a user message with the next 5,500 chars of
`docs/tech/**/*.md` and one Bash call the classifier judges. Every sixth turn first asks
for 24 Reads of small files, one call each, which the mode accepts without the
classifier: 24 transcript blocks between two judged calls, past the API's 20-block
lookback. Every arm runs with `CLAUDIN_READ_MULTI=0` so those Reads are not one batch.

## Rep 1

| Session | auto_mode calls | cache write | cache read | classifier $ | rest of the session $ | rejects | p50 ms | truncated calls | lag block / wide calls |
|---|---|---|---|---|---|---|---|---|---|
| base r1 | 59 | 1,003,977 | 2,932,216 | $4.78 | $3.38 | 0 | 3,345 | 22 of 54 | 0 / 8 |
| placebo r1 | 65 | 1,006,773 | 3,240,879 | $4.89 | $3.40 | 0 | 3,573 | 22 of 54 | 0 / 8 |
| candidate r1 | 54 | 147,909 | 4,179,817 | $1.57 | $3.40 | 0 | 2,887 | 0 of 54 | 9 / 9 |

## Rep 2

| Session | auto_mode calls | cache write | cache read | classifier $ | rest of the session $ | rejects | p50 ms | truncated calls | lag block / wide calls |
|---|---|---|---|---|---|---|---|---|---|
| base r2 | 59 | 1,003,977 | 3,011,744 | $4.79 | $3.39 | 0 | 2,990 | 22 of 54 | 0 / 8 |
| placebo r2 | 56 | 1,006,773 | 2,666,612 | $4.75 | $3.40 | 0 | 3,407 | 22 of 54 | 0 / 8 |
| candidate r2 | 54 | 147,909 | 4,179,817 | $1.57 | $3.42 | 0 | 2,970 | 0 of 54 | 9 / 9 |

The candidate's `lag=` column reads `none/1, 1/3, 3/5, 5/7, 7/9, 9/35, 35/37, …, 297/323`:
on all 53 calls after the first, the marked block is the one the previous call's prompt
ended on, the nine calls that follow 24 Reads included. Base's block count drops five
times after call 32 (183 → 176, 208 → 178, …), which is the cut moving.

## Gates

| Gate | Rep 1 | Rep 2 | Both |
|---|---|---|---|
| 1. cache writes: candidate ≤ 0.6 × base in every rep, placebo within ±10% (means) | × 0.15 | × 0.15 | placebo × 1.00 |
| 2. classifier spend: candidate ≤ 0.8 × base (means) | $4.78 → $1.57 | $4.79 → $1.57 | × 0.33 |
| 3. a lag block on ≥ 80% of the calls past the lookback; no truncated call where base has them | 9 of 9; 22 and 0 | 9 of 9; 22 and 0 | 18 of 18 |
| 4. rejected tool calls: candidate ≤ base + 2, summed | 0 and 0 | 0 and 0 | 0 and 0 |
| 5. classifier latency p50: candidate ≤ 1.25 × base | 3,345 → 2,887 ms (× 0.86) | 2,990 → 2,970 ms (× 0.99) | × 0.92 on the mean of the two |
| 6. everything but the classifier within ±5% (means) | $3.38 → $3.40 | $3.39 → $3.42 | × 1.01 |

Each session judged its 54 Bash calls and rejected none. The whole session fell from
$8.16 to $4.97 in rep 1 and from $8.18 to $4.99 in rep 2 (−39% both). The candidate read
about 40% more cached tokens than base, which is the price of the whole transcript and
is inside the $1.57. What the classifier wrote is the same in both reps to the token, in
every arm: the workload decides it.

**The classifier calls beyond one per decision are second-stage calls.** In rep 2 the
transcripts record 49 of base's 54 decisions and 52 of placebo's as "Allowed by fast
classifier"; the other 5 and 2 went on to the thinking stage, which allowed them all, and
5 + 54 and 2 + 54 are the 59 and 56 calls of the table. The candidate's 54 were all
allowed by the fast stage, in both reps. Six of rep 2's seven escalations were on calls
whose transcript had been cut (base's decisions 33, 37, 43, 47 and 50, placebo's 46) and
one was not (placebo's decision 5), so a cut transcript seems to make the fast stage
less sure; 7 escalations in one rep is a small sample, and rep 1's positions went with
its run directory (its counts were 5, 11 and 0). Their cost is inside the classifier
spend the gates compare.

## Fable 5.2, the XML path

One 8-turn candidate session on `claude-fable-5-2`, to see the fourth breakpoint accepted
where the classifier takes its two-stage XML path:

```
bun scripts/bench/ab/classifier-cache-ab.ts --only=candidate --reps=1 --turns=8 --wide-every=4 --model=claude-fable-5-2 --no-warmup
```

8 classifier calls, no error, no reject, a lag block on 7 of them (the first call has no
earlier one) and on both calls that followed 24 Reads; 23,151 tokens written and 114,525
read, against 21,439 and 116,237 for the same 8 turns on Sonnet 5.5. $1.43.

## What this run is and is not

The workload meets both mechanisms on purpose: it passes the base budget at turn 33
and has nine gaps past the lookback. How often real sessions meet them is the replay's
answer (`classifier-window-lag-replay-2026-11.md`: −32% of the classifier's cost at Opus
5.5 prices over 11-04..11), not this one's. What the live run adds is that the API
behaves as the replay models it: four breakpoints are accepted, a lag block is found on
every wide call, the cut does not move under the window budget, and the decisions, the
latency and the main thread are where they were.

Spend: $21.41 for rep 1, $21.33 for rep 2 and $0.43 for an 8-turn plumbing probe, $43.17
of the $45 agreed for the A/B; $1.43 for the Fable check.
