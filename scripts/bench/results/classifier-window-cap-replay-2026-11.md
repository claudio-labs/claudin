# Classifier window budget: which cap, replay — 2026-11-16, branch fix/census-2026-11-16

The 2026-11-14..16 census was the first field data for the window budget and the lag marker
(on by default since 2026-11-12, v1.2.2). Per classifier call, sessions on v1.2.2 against
sessions before it:

| | Calls | $ per call | Cache read per call | Cache write per call |
|---|---|---|---|---|
| before (2 sessions) | 568 | 0.054 | 59k | 5.1k |
| v1.2.2 (4 sessions) | 456 | 0.044 | 127k | 2.3k |

Writes fell by half, as designed; reads more than doubled, and the saving was 18% where the
11-11 replay had promised 32%. In the longest session (315 calls) a call read 147k tokens
and cost $0.050. Reads are now about 60% of what the classifier costs.

So this replay asks one question: is 800k chars the right cap? One run per cap,
`bun scripts/bench/tokens/classifier-cache-replay.ts --since=<date> --window-tokens=<n>`
(the budget is 0.8 chars per token of window, so 1,000,000 / 500,000 / 375,000 / 312,500
give 800k / 400k / 300k / 250k chars; the chunk is a quarter of the budget). Same caveats
as `classifier-window-lag-replay-2026-11.md`: real serializer and lag marker, identity tool
stub, chars / 4, no system prompt — read the ratios, not the dollars. The corpus is live, so
the `stable` row moves by a few cents between runs.

## Since 2026-11-04 (13 days, 3,360 calls)

| Arm | Written | Read | Opus 5.5 | Fable 5.2 | Front moved | Idle > 1h |
|---|---|---|---|---|---|---|
| old | 27.89M | 60.67M | $235.22 | $458.31 | 25.31M in 513 | 0.28M in 8 |
| stable | 9.48M | 76.04M | $91.08 | $166.96 | 5.87M in 131 | 0.59M in 15 |
| stable+lag | 8.51M | 77.02M | $83.51 | $151.62 | 5.87M in 131 | 0.59M in 15 |
| window+lag, 800k (today) | 4.37M | 148.82M | $64.70 | $99.63 | 0 | 1.86M in 21 |
| window+lag, 400k | 5.10M | 125.41M | $65.86 | $106.64 | 1.31M in 17 | 1.33M in 20 |
| window+lag, 300k | 5.45M | 104.51M | $64.51 | $108.13 | 2.08M in 36 | 1.00M in 18 |
| window+lag, 250k | 5.57M | 89.54M | $62.49 | $107.06 | 2.43M in 51 | 0.84M in 18 |

Cost against `stable` at Opus 5.5 prices: × 0.71, 0.72, 0.71, 0.69. The lever gate passes at
every cap.

## Since 2026-11-14 (3 days, 446 calls)

| Arm | Written | Read | Opus 5.5 | Fable 5.2 | Front moved |
|---|---|---|---|---|---|
| old | 4.89M | 11.91M | $41.48 | $80.59 | 4.38M in 89 |
| stable | 1.52M | 14.44M | $15.06 | $27.24 | 0.88M in 20 |
| stable+lag | 1.31M | 14.65M | $13.39 | $23.85 | 0.88M in 20 |
| window+lag, 800k (today) | 0.71M | 34.56M | $12.63 | $18.35 | 0 |
| window+lag, 400k | 0.80M | 25.57M | $11.48 | $17.84 | 0.24M in 3 |
| window+lag, 300k | 0.84M | 20.94M | $10.90 | $17.61 | 0.34M in 6 |
| window+lag, 250k | 0.84M | 17.72M | $10.29 | $17.05 | 0.38M in 8 |

Cost against `stable` at Opus 5.5 prices: × 0.84, 0.76, 0.72, 0.68. At 800k the replay's own
gate 3 (cost ≤ 0.8 × stable) FAILS on this window; it passes at the three smaller caps.

## Reading

- A smaller cap trades reads for writes: at 250k the classifier reads 40-50% fewer tokens
  and the cut moves again (51 moves in 13 days, where 800k has none).
- At Opus 5.5 prices (a write costs 40 reads) 250k is the cheapest on both windows, by 3%
  over 13 days and by 19% over the 3 days that two long sessions dominate.
- At Fable 5.2 prices (a write costs 80 reads) 800k is the cheapest over 13 days, by 7%,
  and the dearest over the 3 days, by 7%.
- No cap wins on both windows at both prices, and over the longer window the caps are
  within about 5% of each other at Opus 5.5 prices. The 800k default was not a mistake; it is
  also not clearly the best.

## Decision

The default stays 800k. `CLAUDIN_CLASSIFIER_WINDOW_CHARS` (200k-800k) is in so that a live
A/B can run caps as arms. That A/B is not this branch's: `classifier-cache-ab.ts` cannot
exercise an 800k reference today (its corpus is 571k chars and its gate 3 needs the
reference arm to truncate), and it has no check that a risky command is still blocked under
a shorter history, which is the one thing a replay cannot see.
