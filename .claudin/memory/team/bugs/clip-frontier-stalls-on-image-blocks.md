---
name: clip-frontier-stalls-on-image-blocks
description: FIXED 2026-10-15 on branch fix/cache-image-frontier — image blocks held the cache marker back (clipped screenshot never stubbed; media past the 100 cap all "mutable"), billing the tail uncached on every request ($243/wk, 81744358 $221 of $271); also clip state now survives resume; the "mutated at 14" breaks stay unexplained
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

**Fix (fix/cache-image-frontier, 2026-10-15):**
- One predicate, `isStubbableResult`, now decides for the stubber, the frontier,
  the relief candidates and the idle-gap clip.
- The media strip runs before the stubs and is announced as `media cap (N
  oldest dropped)`. It is not batched, by the user's choice: each new image past
  the cap rewrites from the oldest image on, as Claude Code does.
- The `[Cache:]` line names `uncached tail Nk (marker held at …)` and the kind
  of a mutation (`full→stub`, `stub→full`, `media removed`).
- `lookback-miss-census.ts` has an uncached-tail section.
- A `clip-state` transcript entry restores the clipped set on resume.
- Guards: `imageFrontier.invariant.test.ts`, a required test:floor suite, and
  `scripts/migrations/probes/imageFrontier20261015.json`.
- Live check (Sonnet 5.5, 110 PNGs read 10 per request, then NOTES.md): the
  release sent 12.8k and 35.2k uncached on the two requests after the cap; the
  branch sent 2 on every request. One announced strip rewrite of 15.4k, and no
  strict-mode violations.

**Still open:** the `messages mutated at 14` breaks in 81744358 (0.46M tokens).
A forensic pass found that index 14 is a 640-char text Read (`.env.example`),
not an image. It flips full↔stub at turn starts without an announcement. The
path is unproven: a lost clip set on a process restart is the likeliest cause,
and the clip-state fix covers that. The next occurrence will say `full→stub` or
`stub→full` on the line. [[cache-break-census-2026-10-15]]
