# Classifier window budget + lag marker, replay — 2026-11-11, branch perf/census-2026-11-11

`bun scripts/bench/tokens/classifier-cache-replay.ts --since=2026-11-04`, over every
recorded classifier decision of the week (claudin + ferrous-dns, main threads and
sub-agents, 1,646 calls). The replay runs the real serializer and the real
`placeLagMarker`; tools are an identity stub, tokens are chars / 4, and the system
prompt and the CLAUDE.md block are left out. It under-reports the live spend by about
2× (the app's cost-state had the classifier at $84.69 for these sessions), so read the
ratios between arms, not the dollars.

| Arm | What it is |
|---|---|
| `old` | `CLAUDIN_CLASSIFIER_STABLE_CUT=0`: the newest-first fill |
| `stable` | today: 200k-char budget, cut at 25k chunks |
| `stable+lag` | today plus `CLAUDIN_CLASSIFIER_LAG_MARKER=1` |
| `window` | `CLAUDIN_CLASSIFIER_WINDOW_BUDGET=1` sized for a 1M-token window (800k chars, 200k chunks) |
| `window+lag` | both: the candidate |

## Result

| Arm | Written | Read | Opus 5.5 | Fable 5.2 | Lookback misses | Front moved | Idle > 1h |
|---|---|---|---|---|---|---|---|
| old | 11.63M | 26.61M | $98.37 | $191.41 | 0.49M in 26 | 10.31M in 209 | 0.14M in 4 |
| stable | 4.33M | 32.98M | $41.24 | $75.88 | 0.58M in 28 | 2.67M in 59 | 0.27M in 7 |
| stable+lag | 3.98M | 33.33M | $38.49 | $70.31 | 0 | 2.67M in 59 | 0.27M in 7 |
| window | 3.44M | 57.41M | $39.00 | $66.53 | 1.74M in 42 | 0 | 0.78M in 10 |
| window+lag | 2.03M | 58.82M | $27.99 | $44.21 | 0 | 0 | 0.78M in 10 |

- Under today's budget 62% of what the classifier writes is the cut moving: 59 moves,
  about 45k tokens each. A lookback miss is 13%.
- Either lever alone is worth 5–7%. With the transcript whole, every lookback miss
  rewrites all of it (1.74M), so the window budget needs the lag marker; with the lag
  marker alone the moves stay.
- Together: writes −53%, reads +78%, cost × 0.68 at Opus 5.5 prices and × 0.58 at
  Fable 5.2's, where a write costs 80 reads instead of 40.
- What is left is 10 expiries after an idle hour (0.78M) and the appends themselves.

## Gate (pre-registered in the script header)

| # | Gate | Verdict |
|---|---|---|
| 1 | writes ≤ 0.6 × stable in threads past the base budget (≥ 30 decisions) | PASS — 7 threads, 700 calls: 5.2k → 2.0k per call (× 0.40) |
| 2 | sized for a 200k-token window, the blocks are stable's | PASS — 0 of 1,646 calls differ |
| 3 | cost ≤ 0.8 × stable at Opus 5.5 prices | PASS — × 0.68 (Fable 5.2: × 0.58) |
| 4 | past the 800k cap, no more written per call than stable | PASS — synthetic 1.6M thread: 15.0k → 9.7k per call |
| 5 | serialize and mark the largest decision under 10 ms | PASS — 579k chars kept: median 3.5 ms of 9 runs |

The stable cut's own four gates still pass (−67% against `old`, 0 of 893 calls differ
under 150k, min kept 155.5k, serialize 3.3 ms).

Two things changed between the plan and these verdicts, both because a gate said so:

- **Gate 4 set the chunk.** The plan had the chunk at an eighth of the budget. At an
  eighth the synthetic thread wrote 15.0k → 19.4k per call, more than today, and the gate
  failed; at a quarter it writes 9.7k. The chunk is a quarter past the base budget and
  25k up to it.
- **Gate 5 was first measured as the slowest single call of the whole replay**, and read
  8.7 ms on the first run, then 12.0 to 13.5 ms on later runs of the same build as the
  corpus grew by the session doing the work, and 4.9 to 13.5 ms across four runs after
  the fix below: one GC pause in 1,700 timings decides it. It now times the decision
  with the longest kept transcript nine times and takes the median, which is what the
  gate's wording asks. The lag marker's key was also made cheaper: a block longer than
  128 chars counts by its length and its two ends, 8.6 → 2.4 ms under Bun for an
  840k-char transcript (2.1 → 0.9 ms under node). The old key's median was not measured;
  from those numbers it would have been about 8 ms.

The table above is the first run (1,646 calls). At the end of the day the same command
saw 1,715 calls and gave $43.73 → $30.46 (× 0.70), every gate passing.

## What the replay cannot say

- What the classifier decides with more history in view. The live A/B counts rejects.
- Latency: a prompt of up to 200k cached tokens instead of 50k. The live A/B measures it.
- The 2× between the replay and the app's own count is not explained, so a lever that
  holds here still has to hold on the wire.
