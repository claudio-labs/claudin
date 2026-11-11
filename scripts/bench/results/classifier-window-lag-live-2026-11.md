# Classifier window budget + lag marker, live — 2026-11-11, branch perf/census-2026-11-11

**Status: one rep of two.** All six gates pass on rep 1. The pre-registered run is two
reps, and gate 1 asks for the ratio in every rep, so nothing is decided until rep 2 has
run. It was held back for the account's quota: rep 1 took the Max plan's 5-hour window
from 28% to 53%.

Rep 1 ran before the lag marker's key was made cheaper (a long block now counts by its
length and both ends, see the replay's notes). The marker lands where it did: the
candidate's `lag=` column is a function of the workload, so rep 2's must read exactly as
rep 1's does (`lag=none/1, 1/3, 3/5, …`), and a difference there is a finding.

One build of the branch at 95828731, `claude-sonnet-5-5` for the main loop and the
classifier, three headless `--permission-mode auto --debug` sessions side by side, each
in a throwaway git repo. The driver, its workload and its gates are
`scripts/bench/ab/classifier-cache-ab.ts`; the gates were committed before the run.

```
bun scripts/bench/ab/classifier-cache-ab.ts --reps=1 --budget-usd=45
bun scripts/bench/ab/classifier-cache-ab.ts --report=/tmp/classifier-cache-ab/20261111-205754
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

| Gate | Rep 1 |
|---|---|
| 1. cache writes: candidate ≤ 0.6 × base in every rep, placebo within ±10% | × 0.15; placebo × 1.00 |
| 2. classifier spend: candidate ≤ 0.8 × base | $4.78 → $1.57 (× 0.33) |
| 3. a lag block on ≥ 80% of the calls past the lookback; no truncated call where base has them | 9 of 9; base 22 truncated, candidate 0 |
| 4. rejected tool calls: candidate ≤ base + 2 | 0 and 0 |
| 5. classifier latency p50: candidate ≤ 1.25 × base | 3,345 ms → 2,887 ms (× 0.86) |
| 6. everything but the classifier within ±5% | $3.38 → $3.40 |

Each session judged its 54 Bash calls and rejected none. The whole session fell from
$8.16 to $4.97 (−39%). The candidate read 43% more cached tokens than base, which is the
price of the whole transcript and is inside the $1.57. Base and placebo made 5 and 11
more classifier API calls than they had decisions and the candidate made none; the debug
log does not say whether those were second-stage calls or retries, so that difference is
not explained.

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

The workload meets both mechanisms on purpose: it passes the base budget near turn 36
and has nine gaps past the lookback. How often real sessions meet them is the replay's
answer (`classifier-window-lag-replay-2026-11.md`: −32% of the classifier's cost at Opus
5.5 prices over 11-04..11), not this one's. What the live run adds is that the API
behaves as the replay models it: four breakpoints are accepted, a lag block is found on
every wide call, the cut does not move under the window budget, and the decisions, the
latency and the main thread are where they were.

Spend so far: $21.41 for rep 1, $0.43 for an 8-turn plumbing probe, $1.43 for the Fable
check. Rep 2 is one more command, the first one above; `--report=<rep 1 dir>,<rep 2 dir>`
reads the two as one run.
