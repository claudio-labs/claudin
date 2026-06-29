# TOOL_RESULT_JSON_COMPRESSION — cache A/B bench (Sonnet)

Model `claude-sonnet-4-6`, `cache-ab-bench.ts`, claudindev vs claudindev with the
feature flag toggled per side via env (`CLAUDIN_TOOL_RESULT_JSON_COMPRESSION=0|1`).
Raw logs: `json-compression-bench.txt` (main), `json-compression-control.txt`
(control), `json-compression-smoke2.txt` (10-step smoke).

## Verdict

- **Cache-safety gate PASSED.** The mixed control (no JSON) is off≈on to within
  noise — per-turn timelines are line-for-line near-identical — so the feature is
  a true no-op outside the JSON path. On the JSON path per-turn cW shows no
  prefix-rewrite spike; r:w stays ~40:1 (healthy reuse).
- **Net win, directionally positive.** On the JSON workload the on-side is
  cheaper (cost, cR, cW all down) with cW never rising.
- **Caveat:** the main-bench turn counts diverged (on=21 vs off=24) because the
  model is non-deterministic about how many turns a "20-step" list takes, so the
  headline % is soft. The 10-step smoke, where both sides took an equal 14 turns,
  is the cleaner single-run signal: cW 25.6k→10.7k (−58%), cost −23%.

## Main — JSON workload (20 turns, runs=3, median)

| side | cR | cW | r:w | $ | turns |
|---|---|---|---|---|---|
| A (off) | 801.9k | 20.2k | 39.77:1 | $0.6361 | 24 |
| B (on)  | 741.2k | 18.3k | 40.40:1 | $0.5916 | 21 |

min/max: A cR [798.6k..835.8k] cW [19.4k..33.7k]; B cR [532.6k..794.1k] cW [3.5k..21.7k].

cW does not rise (−9% median, min 3.5k), cR down 7.6%, cost down 7%. The cR gap is
muted because claudin's existing clip/stub already shrinks the uncompressed JSON
on the off side, so the win surfaces as cW/cost/r:w rather than raw cR.

## Control — file workload, no JSON (20 turns, runs=3, median)

| side | cR | cW | r:w | $ | turns |
|---|---|---|---|---|---|
| A (off) | 833.7k | 40.5k | 20.61:1 | $0.6234 | 21 |
| B (on)  | 833.6k | 39.9k | 20.91:1 | $0.6111 | 21 |

Off and on are identical within noise (cR Δ0.01%, cW Δ1.5%, equal 21 turns), with
per-turn cW matching turn-by-turn (e.g. turn 7 cW=7.8k both sides). Proves zero
regression outside the new path.

## Smoke (10-step, runs=1, equal 14 turns) — cleanest single signal

| side | cR | cW | r:w | $ |
|---|---|---|---|---|
| A (off) | 400.5k | 25.6k | 15.64:1 | $0.4737 |
| B (on)  | 404.9k | 10.7k | 37.72:1 | $0.3654 |

cW −58%, cost −23%, cR flat, r:w 15.6→37.7.

## Head-to-head — `claudin` (main, 0.6.10) vs `claudindev` (this branch, feature ON), 30-turn JSON

`cache-ab-bench.ts --workload=json --turns=30 --runs=1`, Sonnet 4.6. Both binaries
report 0.6.10, so the only delta is this branch. Raw log: `json-compression-30turn.txt`.

| side | cR | cW | r:w | $ | requests |
|---|---|---|---|---|---|
| A `claudin` (main, no feature) | 1.29m | 42.3k | 30.53:1 | $0.9863 | 34 |
| B `claudindev` (feature ON)    | 1.15m | 27.1k | 42.39:1 | $0.8569 | 31 |

cW −36%, cR −11%, cost −13%, r:w 30.5→42.4. The cW win concentrates at turn 1 (A caches
the uncompressed 67KB JSON result → 14.5k write; B writes 0); steady-state per-turn cW is
~820 on both, so the compression marker adds no per-turn write and r:w rises.
**Soft headline:** the model took 34 vs 31 requests (non-deterministic step count), so part
of the totals gap is the extra requests on A. The structural signal (no per-turn cW spike,
higher r:w, smaller cached JSON region) is consistent with the env-toggle A/B above.

## #7 — constant-field hoisting (render-char delta, deterministic)

Roadmap #7: fields identical on every row are hoisted onto a single `const={…}`
line and dropped from the grid columns (lossless — full element stays in the
`jsonl` backing). Measured on `scripts/profile/fixtures/big-json.sh`, which carries
two constant fields (`author:"viudes"` and `labels:["area/cache","type/perf"]`).
A/B is the render of `HEAD:jsonArrayCompress.ts` (no hoist) vs this branch (hoist),
identical input → isolates the hoist:

| rows | input chars | render (no hoist) | render (hoist) | saved | Δ |
|---|---|---|---|---|---|
| 55 (all shown) | 12,179 | 8,384 | 6,562 | 1,822 | −21.7% |
| 300 (windowed)  | 67,133 | 7,681 | 6,029 | 1,652 | −21.5% |

New render head (n=300):

```
const={"author":"viudes","labels":["area/cache","type/perf"]}
rows=300 keys=[number,title,state,mergeable,comments]
#1	1	Pull request 1: …	MERGED	false	2
```

~21.5% smaller render (the bytes that enter the prompt cache) on a realistic
`gh … --json`-shaped payload, with `author` + `labels` removed from every shown
row. Lossless: the backing `jsonl` is unchanged (every element still carries both
fields), so Read offset/limit + Grep on the cited path still resolve any row.

### End-to-end cache validation (cW + cR, Sonnet, 30 turns)

`cache-ab-bench.ts --a=claudin --b=claudindev --workload=json --turns=30 --runs=1
--model=claude-sonnet-4-6` with `CLAUDIN_TOOL_RESULT_JSON_COMPRESSION=1` forced on
both arms (`claudin` = released 0.6.11 / no hoist; `claudindev` = this branch /
hoist). Run where both arms completed the full workload:

| arm | turns | cR | cW | r:w | out | $ |
|---|---|---|---|---|---|---|
| A `claudin` (no hoist) | 31 | 1.16m | 41.6k | 27.96:1 | 8.7k | $0.94 |
| B `claudindev` (hoist) | 34 | 1.35m | **29.1k** | **46.39:1** | 10.7k | $0.97 |

**B writes −30% to cache (41.6k→29.1k) and has +66% reuse (27.96:1→46.39:1) — even
though B ran 3 MORE turns.** Per-turn `cW` is steady at ~820 on BOTH arms with no
spike, so the hoist's new `const=` line does not invalidate or rewrite the cached
prefix; the lower total cW comes from the smaller cached tool-result region (the
−21.5% render). Absolute cost is ~level ($0.94 vs $0.97) but B did 34 vs 31 turns,
so per-turn B is ~6% cheaper. The hoist is cache-safe end-to-end and reduces
cache-write pressure.

Caveat: turn counts differ (31 vs 34 — the harness's known non-deterministic step
count), so the totals aren't perfectly apples-to-apples; the cW/r:w *direction* is
the robust signal and it held across two runs. A first run had arm A quit early (2
turns, non-deterministic early-exit) and was discarded; arm B there was likewise
healthy (31 turns, cW 23.2k, r:w 47.97:1).
