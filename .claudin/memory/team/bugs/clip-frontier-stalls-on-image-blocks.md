---
name: clip-frontier-stalls-on-image-blocks
description: FIXED 2026-10-15 on branch fix/cache-image-frontier — media blocks held the cache marker back (clipped screenshot never stubbed; media past the 100 cap all "mutable"), billing the tail uncached on every request ($243/wk, 81744358 $221 of $271); clip state now survives every resume path; the "mutated at 14" breaks are NOT a lost clip set and stay open
type: project
paths:
  - "src/agent/compact/stableStubState/clipFrontier.ts"
  - "src/agent/compact/stableStubState/clipStubText.ts"
  - "src/agent/compact/microCompact.ts"
  - "src/providers/shims/claude/renderMessages.ts"
---

**Symptom:** `input_tokens` jumped from ~2 to tens or hundreds of thousands and
`cache_read` froze for the rest of the session. There was no break line, only
`hit 17%`. The rule that guards this now lives in `.claudin/rules/cache.md`
§5 ("A block the frontier calls mutable must be one a rewriter WILL change"),
and the design-doc history is in `docs/tech/cache/clip-frontier-breakpoint.md`.

**Two causes:**
- **Clipped screenshot.** The idle-gap clip put a screenshot's id in the clipped
  set. `stubOneBlock` never stubs an image. The frontier still waited for the
  stub: 72c401aa sat 2h at a frozen read, and 9a7b84f4 did the same.
- **Media cap.** Past 100 media items, every media block counted as mutable.
  81744358 (playwright, Sonnet 5.5) sent ~470k uncached on each of 230 calls
  after its 101st image.

**Fix (fix/cache-image-frontier, 2026-10-15), with a second round after three reviews:**
- **One predicate.** `isStubbableResult` now decides for the stubber, the
  frontier, the relief candidates and the idle-gap clip. It refuses images and
  documents alike. The idle-gap clip also skips pinned results.
- **Media strip.**
  - It runs before the stubs and is announced as `media cap (N oldest dropped)`,
    folded once per turn.
  - It is not batched, by the user's choice: each new image past the cap
    rewrites from the oldest image on, as Claude Code does. On 81744358 that
    costs ~$100, against ~$26 for batches of 10.
  - A compaction's render does not reset the count.
- **The `[Cache:]` line.**
  - It names `uncached tail Nk (marker held at …)` once per turn per thread,
    read from the marker actually placed (`heldMarker`).
  - It gives the kind of a mutation: `full→stub`, `stub→full`, `media removed`,
    or `<type> block added/removed`.
- **Census.** `lookback-miss-census.ts` has an uncached-tail section.
- **`clip-state`.** The transcript entry is written on every clip and every
  reset (rewind) in the REPL, `-p` and the SDK. The metadata re-append stamps it
  for branches and forks. All four resume paths restore it.
- **Guards.**
  - `imageFrontier.invariant.test.ts`, a required test:floor suite.
  - `scripts/migrations/probes/imageFrontier20261015.json`.
  - A source scan that pairs every `restoreCostStateForResume` with
    `restoreClippedState`.
- **Live check** (Sonnet 5.5, 110 PNGs read 10 per request, then NOTES.md): the
  release sent 12.8k and 35.2k uncached on the two requests after the cap; the
  branch sent 2 on every request. One announced strip rewrite of 15.4k, and no
  strict-mode violations.

**Still open: the `messages mutated at 14` breaks in 81744358 (0.46M).**
- **It is NOT a lost clip set**, which the first draft of this file claimed. A
  replay through v1.1.44 showed that every restart came after an idle gap over
  60 min, so the idle-gap clip re-clipped everything at turn 1. Message 14's
  tool results were already stubs then.
- **What really disappears** is a `nested_memory` rule
  (`.claudin/rules/search-strategy.md`, 187 tokens) folded into message 14. It
  happens on the first request of the SECOND turn after a resume, and once
  without any restart (10-12 22:49).
- **Suspected mechanism:** the text-into-tool_result merge in
  `normalize.ts:1106-1122`. It has not been reproduced.
- The line now names it (`text block removed`). To reproduce it, run
  `CLAUDIN_CACHE_BREAK_DUMP=1` on a resume followed by two turns.
  [[cache-break-census-2026-10-15]]
