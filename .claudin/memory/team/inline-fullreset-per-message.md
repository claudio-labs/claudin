---
name: inline-fullreset-per-message
description: FIXED 2026-09-11 — PR #172's bottom anchor covered ONLY the branch where the previous frame OVERFLOWS the viewport, so a frame that FITS stranded the whole UI in the top rows; keeps the mechanism, the probe numbers and the A/B that closed it
type: project
---

**Fixed on `fix/tui-anchor-fits-viewport` (2026-09-11).** PR #172 (`1ea4e2c3`,
v1.1.28) had fixed only the *reset-path* half; GitHub #165 was closed COMPLETED
on 2026-09-10 by the PR link firing, not by a verification, and the other half
shipped. Reported by a user on 2026-09-11 (46x184, `flickerFreeMode: false`) and
reproduced by probe. Kept for the mechanism and the numbers — the trap here is
believing a closed issue.

**The fix**: the in-place tail repaint's entry condition is `cursorAtBottom`
instead of `prevHadScrollback`, so a shrinking frame that FITS the viewport takes
the same net-zero path as one that overflows. What `repaintTailInPlace` needs is
a cursor just past the previous block's last row; requiring the overflow on top
of that was the bug. `CLAUDIN_LEGACY_FULL_RESET` keeps the old, narrower
condition.

## The claim that was wrong

The previous version of this memory said *"`anchorRows` bottom-anchors **every**
repaint path"*. It does not. `anchorRows` has exactly **two** call sites
(`src/terminal/ink/log-update.ts:682` in `repaintTailInPlace`, `:723` in
`fullResetSequence_CAUSES_FLICKER`). The **incremental diff path never calls
it**, and that is the path a shrink takes whenever the previous frame fits the
viewport.

The guard that routes between them (`log-update.ts:231-232`):

```ts
prevHadScrollback = cursorAtBottom && prev.screen.height >= prev.viewport.height
```

A frame SHORTER than the viewport fails it and falls through to the incremental
shrink at `log-update.ts:323-344`, which emits `clear(linesToClear)` +
`cursorMove(y:-1)` — net **−linesToClear** rows. The block's top stays put and
the freed rows stay blank **below** it.

## Measured (probe against the real `LogUpdate`, viewport 46)

| prev height | next | net dy | outcome |
|---|---|---|---|
| 60 (overflows) | 15 | **0** | `repaintTailInPlace`, stays at bottom ✅ |
| 46 (== viewport) | 15 | **0** | `>=` catches it ✅ |
| **45 (fits)** | 15 | **−30** | stranded 30 rows above the bottom ❌ |

It never self-heals: `repaintTailInPlace` is net-zero and the incremental path is
purely relative, so only an absolute `clearTerminal` repositions — reached for
`'resize'` (`:196-201`) and `'clear'` (`:183-188`) and nothing else. Pre-#172 the
per-turn reset accidentally re-anchored every turn; removing it removed the
self-healing too.

## The model half — also fixed, by deleting the policy

`useOnQuery.ts` used to replace the array at a compact boundary — with
`[newMessage]` inline, with one compact-interval in fullscreen — and
`Messages.tsx:508` dropped everything before the last boundary again at render
time for non-fullscreen, non-verbose. Both are gone: the boundary is appended
like any other message and the timeline is never cut. Compaction is a CONTEXT
operation (`query.ts:587` swaps the model-facing array) and that is all it is.
The render cost stays bounded by `MAX_DISPLAY_MESSAGES = 200` (`REPL.tsx:304`,
applied `:2856`), which is a count, not a boundary.

Two things fell out of that. The `setConversationId(randomUUID())` on both
compaction paths is gone — no row's content changes under an append, and the
re-key was reprinting `<StartupBanner key={conversationId}>` in the middle of
the timeline. And the manual `/compact` path, which had ALWAYS appended
(`compact.ts` → `processSlashCommand.tsx:636-661` → the append in
`useOnQuery`), finally agrees with the automatic one.

**Why only long sessions.** Before the first compaction the frame permanently
overflows the viewport, so the renderer's bad branch was unreachable. After it
the transcript restarted short and lived in the "fits the viewport" band, where
any large shrink — the next compaction, or a tool output collapsing to
`… +N lines` — stranded the block at the top for good.

## Reproducing it

Build a prev/next `Frame` pair with a configurable `viewport.height` (the
`frameFromLines` helper in `log-update.test.ts` hardcodes 10), call
`log.render(prev, next, false, true, false)`, and sum the diff's vertical
movement: `clear(n)` is `-(n-1)`, `cursorMove` is `y`, `stdout` is its LF count.
Net 0 means bottom-anchored; negative is the stranding. Live equivalents:
`CLAUDIN_DEBUG_REPAINTS` (`ink.tsx:629-652`) prints `prevH/nextH/viewport`, and
from a stuck state a one-column width change snaps it back (reset `'resize'`).

**Now covered** by three tests in `log-update.test.ts` built on a `netRowDelta`
helper: the 45→15 stranding, the 8→5 shrink (rewritten — it used to assert
`clear count === 3`, the vacated rows, and passed on the broken behavior), and
the killswitch restoring the incremental path. Reverting the condition to
`prevHadScrollback` fails exactly the two new ones.

**Still uncovered**: a viewport height *increase*. `:196-201` only resets when
the viewport gets SHORTER or narrower, so dragging the window taller still
leaves the block anchored to the old bottom.

## Escapes, if a variant of this ever shows up again

`ctrl+L` (forces reset `'clear'`), a one-column resize, or `/config` →
flicker-free renderer — alt-screen reports `viewport.height = rows + 1` against a
screen exactly `rows` tall, so `padRows` is always 0 and the path cannot fire.

## The live A/B that closed it

tmux 184x46, same keystrokes on both binaries: grow the input past the viewport,
clear it, regrow to ~40 rows (under the viewport), clear again. Released v1.1.28
moved the footer from rows 44-45 to **rows 14-15** with 31 blank rows below; the
rebuilt binary kept it on 44-45. That sequence is the cheapest live repro — it
needs no model call.

## Still true from the original 2026-09-09 bench

tmux 100x18, `TERM_PROGRAM=ghostty CLAUDIN_NO_FLICKER=0`, 36 messages: full-screen
resets **35 → 0**, 37 in-place repaints in their place, every original reset a 2-
or 3-row shrink of an 86-120 row frame (the spinner/status row at end of turn).
The two invariants `repaintTailInPlace` rests on also still hold: it erases
exactly as many rows as it paints (do not "simplify" it back into a reset), and
the banner unmounts itself once it scrolls out (`shouldLatchStartupBanner`),
`/clear` remounting it via `key={conversationId}`.

**Follow-up:** the renderer half of this belongs in
[[coding-gotchas-go-in-rules-not-memory]] terms in `.claudin/rules/ink-tui.md` —
`/dream` cannot write outside the memory dir, so it was not moved there.
See [[clip-pin-cache-ab-2026-07-25]] for the bench traps in this area.
