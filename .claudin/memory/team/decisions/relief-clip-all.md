---
name: relief-clip-all
description: Since 2026-10-15 a window-lane relief event clips every clearable result outside the last two turns, not one band — the rewrite starts at the oldest clip anyway; −22% SEPARATED on context-relief-ab, killswitch CLAUDIN_RELIEF_CLIP_ALL=0
type: project
scope: src/agent/compact/reliefPolicy.ts
impact: functional
---

**Decision:** When the window lane of the relief policy fires, the event
selects every clearable candidate outside the protected last two turns
(`decision.selectAll`, `microCompact.ts` asks `Infinity`). It no longer stops
after one band. The trigger, the band (still the starvation floor) and the rss
lane's low-water target are unchanged. `CLAUDIN_RELIEF_CLIP_ALL=0` restores
one band.

**Why:** clips go oldest first, so the prompt cache is rewritten from the first
clipped block, which is right after the system prompt in practice. A
one-band event paid for the whole history to free one band: 50.7k rewritten for
24k freed on the 140k bench, and 560–690k for 133–159k on real 1M threads
([[cache-break-census-2026-10-15]]). Extra stubs in the same event shrink the
rewrite instead of adding to it.

**Evidence (pre-registered gate, all five met):**
- context-relief-ab, Sonnet 5.5, `--window=140000`, N=5, parallel arms, one
  price table:
  - cost $1.258 → $0.987, −22% SEPARATED; the placebo moved +1% (overlap);
  - clipped ids 7 → 12 in every run, 10/10 edits;
  - rewrite 51.0k → 20.7k, end context 64.7k → 34.4k;
  - edit-turn lookups 8 → 11 (overlap).
- The lane-off arm (autocompact only, Claude Code's shape) cost $1.194, and
  Claude Code 2.1.301 itself $1.150. Both separated from clip-all.
- `relief-ceiling-sim.ts --clip-all` over the real 1M main threads since 09-17:
  net $65.47 → $96.24. That is an upper bound, about 0.5% of main-thread
  spend; 1M sessions rarely reach the trigger.
  - Correction 2026-10-24: those dollars do not reproduce. The sim priced Opus
    5.5 at Opus 5's rates until then; re-run with the fixed prices it gives
    clip-all net $13.08 against band-only $5.59 (1,333 threads). The direction
    holds; do not cite the old figures.

**What changes for a teammate:** long sessions over the trigger drop to about
half their context after a clip, and re-fetch a little more. The design doc
(`docs/tech/cache/context-relief-policy.md`) has the section and a correction
of its "tuning the band buys almost nothing": the rewrite size `R` is not fixed.
The guards are the break-probe specs `reliefSelection.json` and
`reliefClipAll.json`.

**Amended 2026-10-19:** "the last two turns" protects RESULTS only. A call's
INPUT (patchText, content, new_string) stays whole while its result is among
the 10 newest tool results (`KEEP_RECENT_INPUT_RESULTS`, `clipFrontier.ts`),
after a clip left the model copying a `[clipped: …]` placeholder into a new
Patch (#312).
The simulator puts the cost at under 1.3% of net savings
([[tool-cache-permission-census-2026-10-19]]).
