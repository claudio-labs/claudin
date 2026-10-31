---
name: large-window-compaction
description: Compacting a 1M main thread early — NOT PROMOTED 2026-10-24 (inconclusive) and again 2026-10-31 (refuted on the mechanism); on Opus 5.5 at the real 1M window it cut cost 33% but the model looked up 9× more during the edits; clipping earlier loses money at Opus 5.5 prices
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

**Reopened 2026-10-31, refuted on what it loses ([[census-10-30-compaction-meta-ttl]]).**
The run below was redesigned against the real setting: the default 1M window, where the base
neither clips nor compacts (sessions of 10-25..30: context p90 624k, under the 735k clip), and a
candidate compacting at a fixed ~147k (`CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE=15` +
`CLAUDIN_DISABLE_RELIEF_POLICY=1`). `context-relief-ab.ts` got `--dirs/--large/--effort`, a
re-read count that skips the script's own repeats, compaction counts and `--gate=`.
- **Sonnet 5.5 calibration** (1 rep, 24 files, ~284k): cost −52%, but edit-turn lookups 2.7×
  and re-reads 2.2× the base. The base clipped at 415k through the RSS lane (250k retained), so
  24 files is too many.
- **Opus 5.5** (1 rep, 18 files ~232k, effort medium, with a placebo): $5.10 against $7.64
  (−33%), 2 compactions, edits 18/18 in every arm, but lookups 28 vs 3 and 14 re-reads after the
  first compaction against 0 in the base. Both gates (≤2×, ≤1.5×) fail by far, so the run
  stopped at one rep, as agreed before it started. The placebo clipped (21 ids, peak 410k, +27%
  cost): 18 files still sits at the RSS lane's edge; a rerun should use 16 (~200k).
- **Reading:** the summary keeps the task, not the file bodies, and the model reads them again
  edit by edit. The post-compact restore brings back at most 5 recent files at 5k tokens each
  (`postCompactAttachments.ts`), and the fixture edits 18 files of 30-70 KB. If this is reopened,
  the candidate is a wider restore of the files still to be edited, not a lower trigger.

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
- The deciding run proposed here (Opus, a 300k window at 50%) was replaced on
  10-31 by the real-setting run above: at 300k the base clips at 210k, a relief
  the 1M default never reaches. `--per-phase=20+` was never valid; it parsed as
  NaN and ran zero turns.
- Measured on the way (`composition.ts`, 9 main threads over 300k): thinking is
  ~34% of the context, clearable results 28%, rules loaded on demand 10%; a
  clip-all on the 5.5 models frees 49-65% in one go (the server's thinking
  drop); after a clip, growth per call runs 1.55× faster.
