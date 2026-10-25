# context-relief-ab — 2026-10-24, branch perf/census-2026-10-24

`scripts/bench/ab/context-relief-ab.ts --window=140000 --model=claude-sonnet-5-5 --reps=5 --parallel`.
There was one build of the branch at 0c87953f. The context window is capped at 140k, so the
effective window is 120k.

| Arm | What it is |
|---|---|
| `claudindev` | today's policy: clip-all at 0.75 × 120k ≈ 90k, autocompact at 107k |
| `placebo` | the same binary with `CLAUDIN_BENCH_PLACEBO=1`, which nothing reads |
| `compact50` | `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE=50,CLAUDIN_DISABLE_RELIEF_POLICY=1`: compaction at 60k, no clip lane |
| `compact50clip` | `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE=50`: the trigger is capped to ~48k, so it clips first and compacts at 60k |

The question was whether a 1M main thread should compact at half its window, ≈490k,
instead of clipping at 735k and compacting at 967k. On 1M the replay
`relief-ceiling-sim.ts --main --compact-at --regrowth=1.55` put it at +28% of
main-thread reads. That figure is an upper bound.

## Pre-registered gate, per candidate against `claudindev`

- Cost −15% or better, SEPARATED.
- 10/10 edits in every rep.
- Median edit-turn lookups ≤ 2× the baseline's.
- Mechanism engaged: at least one compaction in every rep of the candidate, none in the baseline.
- The placebo overlapping the baseline.

## Results (median [min–max])

| metric | claudindev | placebo | compact50 | compact50clip |
|---|---|---|---|---|
| cost, one price table | $1.009 [0.992–1.050] | $1.002 [0.990–1.039] (−1%, overlap) | **$0.944 [0.929–0.956] (−6%, SEPARATED)** | $1.038 [1.028–1.045] (+3%, overlap) |
| cache write | 111.2k | 110.9k | 90.1k (−19%) | 114.8k (+3%) |
| cache read | 2.55M | 2.54M | 2.42M (−5%) | 2.61M (+2%) |
| output | 5.5k | 5.3k | 9.0k (+63%: the summary) | 4.9k |
| break tokens | 20.6k | 20.5k | 4.0k | 22.8k |
| peak / end context | 88.4k / 34.8k | 88.3k / 34.8k | 59.7k / 51.9k | 51.9k / 44.7k |
| re-reads | 5 [2–6] | 3 [3–5] | 4 [2–4] | 9 [8–12] |
| edit-turn lookups | 13 [11–15] | 13 [12–14] | **8 [7–9]** | 17 [16–21] |
| edits landed | 10/10 ×5 | 10/10 ×5 | 10/10 ×5 | 10/10 ×5 |

## Mechanism

These events come from the per-call timeline, as calls where the context drops by more than 25%:

- `claudindev` and `placebo`: one clip at call 37 in every rep, from ~88k to ~33k.
- `compact50`: one compaction at call 27 in every rep, from ~59.7k to ~16.5k. It clipped nothing.
- `compact50clip`: one clip at call 24 in every rep, from ~51.9k to ~35.3k, with 6 ids. It never compacted.
  This is the arm the plan predicted: with the clip trigger capped below the threshold, the clip
  frees enough that compaction never comes.

## Verdict: neither candidate passes, and no default changes

- `compact50` fails on cost alone: −6%, short of −15%. Every other gate holds. The win
  is real and separated, and the model made fewer edit-turn lookups (8 vs 13). But one
  compaction late in a 30-turn session is all this workload exercises, and the gate was
  set to pay for the working context a compaction loses in a long, multi-task session.
  This bench cannot see that loss.
- `compact50clip` fails on cost (+3%) and on mechanism (no compaction), and it re-read more:
  9 vs 5 re-reads, 17 vs 13 lookups.
- Only Sonnet 5.5 was run, by the user's choice. Opus 5.5 is unconfirmed.
- The placebo stayed within noise (−1%, overlap), so the run is readable.
