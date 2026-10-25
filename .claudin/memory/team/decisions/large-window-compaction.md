---
name: large-window-compaction
description: Compacting a 1M main thread at half its window — NOT PROMOTED 2026-10-24, inconclusive at the bench's regime; the replay said +28% of main reads (upper bound), the Sonnet 5.5 A/B at a 140k window gave −6% SEPARATED against a pre-registered −15% gate; clipping earlier loses money at Opus 5.5 prices
type: project
scope: src/agent/compact/autoCompact.ts, src/agent/compact/reliefPolicy.ts
impact: rejected
---

**Decision:** nothing changed. A 1M main thread still clips at 735k and
compacts on starvation or at 967k.

**Why:** the 10-23..24 census found the main thread's cache reads were $92 of
$147, with context p50 360k and no main thread reaching the 735k trigger. The
user chose to attack it in the same branch, reopening their 10-09 rejection of
"a fixed lower ceiling" ([[relief-starved-compacts-keepalive-default]]). The
candidate missed its gate, and the gate's bench cannot test the 1M claim, so
the honest reading is inconclusive, not refuted.

**What changes for a teammate:** do not reopen this with a lower clip trigger —
at Opus 5.5 prices a 1h write costs 40 reads and earlier clips lose money.
Compaction is the lever left, and `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE` alone is not
its arm: it also lowers the clip trigger, so the clip fires first and nothing
compacts. Pair it with `CLAUDIN_DISABLE_RELIEF_POLICY=1`. Any clip or
compaction figure from `relief-ceiling-sim.ts` before 10-24 used a write of 20
reads and no thinking drop; recompute it before citing it.

**Rejected:**
- Clipping earlier (calibrated replay: clip at 600k +6%, 500k +1%, 400k −6%,
  300k −14% of main reads — small at best, negative below 400k).
- `compact50clip` (`CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE=50` alone): +3% in the A/B,
  it never compacted.
- `compact50` as a default: −6% SEPARATED against the −15% gate.

**Evidence:**
- Replay, `relief-ceiling-sim.ts --main --compact-at --regrowth=1.55
  --post-compact=60000`: +26% at 588k, +28% at 490k, +42% at 392k — an upper
  bound on 8 threads, sensitive to the regrowth factor (+39% at 1.0), with no
  term for the working context a compaction loses.
- A/B, `scripts/bench/results/context-relief-ab-compact50-2026-10-24.md`: Sonnet
  5.5, window 140k, N=5, with a placebo. `compact50` (compaction at 50%, no clip
  lane) −6% SEPARATED, lookups 8 vs 13, edits 10/10, one compaction per rep.
  The bench compacts at call ~27 of ~37 at ~60k context, against p50 360k in
  the census, so the one-off summary weighs far more than on a 1M thread.
- The deciding run, if reopened: Opus 5.5, a 300k window at 50%,
  `--per-phase=20+` (two or more compactions per rep), N=5 paired, measuring
  re-reads after the compaction. Estimated ~$60.
- Measured on the way (`composition.ts`, 9 main threads over 300k): thinking is
  ~34% of the context, clearable results 28%, rules loaded on demand 10%; a
  clip-all on the 5.5 models frees 49-65% in one go (the server's thinking
  drop); after a clip, growth per call runs 1.55× faster.
