---
name: large-window-compaction
description: Compacting a 1M main thread at half its window — NOT PROMOTED 2026-10-24; the replay said +28% of main reads (upper bound), the Sonnet 5.5 A/B gave −6% SEPARATED against a pre-registered −15% gate; clipping earlier loses money at Opus 5.5 prices
type: project
scope: src/agent/compact/autoCompact.ts, src/agent/compact/reliefPolicy.ts
impact: rejected
---

**Decision:** nothing changed. A 1M main thread still clips at 735k and
compacts on starvation or at 967k.

**Why it was asked:** the 10-23..24 census found the main thread's cache reads
were $92 of $147. Context p50 was 360k, and no main thread reached the 735k
trigger. The user chose to attack it in the same branch, and reopened their
10-09 rejection of "a fixed lower ceiling"
([[relief-starved-compacts-keepalive-default]]).

**What the evidence said:**
- **Clipping earlier does not pay at Opus 5.5 prices.** A 1h write costs 40
  reads, so the rewrite of a 300k context costs 40 calls of reading it. Later
  clips free little, because stub heads, inputs and rules stay. Calibrated
  replay: clip at 600k +6%, at 500k +1%, at 400k −6%, at 300k −14% of main reads.
  The pre-10-24 `relief-ceiling-sim.ts` said the opposite: it priced a write at
  20 reads and ignored the thinking drop.
- **Compacting earlier pays in the replay**:
  `relief-ceiling-sim.ts --main --compact-at --regrowth=1.55 --post-compact=60000`
  gives +26% at 588k, +28% at 490k and +42% at 392k. That is an upper bound, and
  no token count sees the working context a compaction loses.
- **A/B** (`scripts/bench/results/context-relief-ab-compact50-2026-10-24.md`):
  Sonnet 5.5, window 140k, N=5, with a placebo.
  - `compact50` (compaction at 50%, no clip lane) came in at −6% SEPARATED, short of
    the −15% gate. Lookups were 8 vs 13 and edits 10/10. One compaction landed in
    every rep, the mechanism engaged.
  - `compact50clip` (only `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE=50`) came in at +3%, and
    never compacted: the clip trigger is capped under the threshold.

**Measured on the way** (`composition.ts`, 9 main threads over 300k):
- thinking is ~34% of the context;
- clearable results are 28%;
- rules loaded on demand are 10%;
- a clip-all event on the 5.5 models frees 49-65% in one go, because of the
  server's thinking drop;
- after a clip, growth per call runs 1.55× faster.

**If this is reopened:** run the deciding A/B on Opus 5.5, with a longer workload
(`--per-phase=20+`) that compacts more than once and measures work after the
compaction. Do not use `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE` alone as the arm: it
also lowers the clip trigger, so the clip fires first.
