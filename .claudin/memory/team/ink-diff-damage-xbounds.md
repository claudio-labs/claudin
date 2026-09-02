---
name: Ink diff damage bounds miss vacated cells (X and Y)
description: src/ink/screen.ts diffEach damage bounds only cover written cells, so rows or columns vacated at constant terminal size leak stale glyphs — same-width path now scans full screen
type: project
---

In the forked Ink engine (`src/ink/screen.ts`), damage bounds are computed from cells WRITTEN to the `next` frame, so they miss cells that `prev` had but `next` leaves empty. Two flavors of leak observed:

1. **Row shrinks at constant terminal width** (vanishing `(@owner)`/spinner suffix, re-truncated subject, wide tool-output row replaced by a shorter task row) — stale glyphs sit to the right of the damage region. Fixed 2026-06-03 by widening X to `0..maxWidth`.
2. **Subtree unmounts with no new content reflowing into its rectangle** (e.g. the AskUserQuestion permission dialog closes — "S" from "Submit" and trailing "→" stayed painted above the status bar). The vacated rows fall entirely outside `next.damage`'s Y-range. Fixed 2026-06-07 by widening Y to `0..maxHeight` in the same call.

**Why:** `diffEach` only widened the scan for height shrink (`prevHeight > nextHeight`) or full terminal-width shrink (`prevWidth > nextWidth`), never for individual rows/cells vacated at constant terminal size.

**How to apply:** In the same-width path (`src/ink/screen.ts` ~line 1212), call `diffSameWidth(prev, next, 0, maxWidth, 0, maxHeight, cb)`. `findNextDiff` skips equal cells with integer compares (~16k 8-byte compares for a typical 200×80 grid), so full-screen scan stays sub-millisecond. Two regressions live in `src/ink/screen.test.ts` (shrinking-row + orphan-row, both fail without the fix). Validated under `claudindev`.
