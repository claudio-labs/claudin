---
name: inline-fullreset-per-message
description: FIXED — the inline TUI used to CSI 2J the screen on EVERY message and repaint from the banner whenever the frame fit the viewport; keeps the measurements and the two invariants the fix rests on
type: project
---

**Fixed on branch `fix/tui-bottom-anchor-repaint` (2026-09-09).** Kept for the
numbers, and for the two invariants a future change here must not break.

Measured 2026-09-09 in tmux 100x18, `TERM_PROGRAM=ghostty CLAUDIN_NO_FLICKER=0`,
36 messages, probes in `log-update.ts`. Two facts, one root, both survive PR #160
(which only fixed *where* the repaint starts, not *how often* it fires).

**1. One full-screen reset per message.** 35 `fullResetSequence_CAUSES_FLICKER`
calls, all `reason='offscreen'` — the `prevHadScrollback && isShrinking` branch
(`log-update.ts:203`). The existing `Full reset (shrink while overflowing)` log
gives the magnitude: the shrink was **2 rows 31× and 3 rows 4×**, against frames
86–120 rows tall. That is the spinner/status row disappearing when a turn ends.
So a 2-row shrink at the *bottom* of the frame costs a `CSI 2J` erase of the whole
visible screen plus a repaint of all `viewport.height - 1` rows, once per turn,
in every long non-fullscreen session. `rewriteMainScreen` (Ghostty) fired 206×
between them and is not the problem.

**2. The repaint starts at the banner whenever the frame is not taller than the
viewport.** `startY = max(0, screen.height - (viewport.height - 1))`, so
`screen.height <= viewport.height` gives `startY <= 1` — row 0/1 of the frame is
`<StartupBanner/>` (`REPL.tsx:2970`, `LogoHeader` right after it). Captured live:
`screenH=120 viewportH=120 startY=1` after resizing the pane, and the pane top
then read `▐█████▌ Anthropic · Opus 4.8 …` with the whole transcript re-flowed
under it. Also seen at `screenH=15 viewportH=18 startY=0`. Visually this is
"the logo gets pinned to the top and the input jumps upward, bottom rows blank" —
reachable in a *long* session too, since the reset uses the NEXT frame's height
(after compaction, after a collapse, or in a tall window).

Why it reads as a scroll bug on Ghostty: every one of those writes snaps the
terminal viewport back to the bottom, so scrolling up to read is impossible the
moment anything outputs — the exact reason `isFullscreenEnvEnabled()` force-enables
alt-screen for Ghostty (`fullscreen.ts:144-149`). Users who pick
`/config` → renderer = default (`flickerFreeMode: false`, which this reporter has)
opt back into it.

**How it was fixed, and the two invariants that hold it up.**

- `repaintTailInPlace` erases exactly as many rows as it repaints, so the net
  vertical movement is ZERO and the cursor ends back on the last viewport row.
  That is what lets it use `eraseLines` where the old code could not — the old
  code cleared only the k *vacated* rows and left the cursor k rows high, which
  is the desync the reset existed to avoid. Do not "simplify" it back into a
  reset, and do not make it erase a different count than it paints.
- `anchorRows` bottom-anchors **every** repaint path: the block ends on the
  second-to-last viewport row, cursor on the last. When the frame overflows,
  padRows is 0 and the output is byte-identical to the pre-fix code — that is
  what keeps the two PR #160 guards green without touching them.
- The banner additionally **unmounts itself** once it scrolls out of the
  viewport (`shouldLatchStartupBanner`), because while it is frame row 0 no
  anchoring can stop a repaint from resurrecting it. `/clear` remounts it via
  `key={conversationId}`.

Verified live, same bench: resets **35 → 0** over 36 messages, 37 in-place
repaints in their place. The shape that used to pin the banner
(`prevH=124 nextH=13 viewport=120`) now logs
`[REPAINT] in-place … FRAME FITS VIEWPORT` and paints the frame at rows
106-120 with the banner where it belongs.

**Still open:** the *model* half of #165 — whatever shrinks
`displayedMessages`/`renderableMessages` to the tail. The renderer no longer
destroys the rows above, but they are still gone from the frame, so `ctrl+L`,
a resize, `/export` and transcript mode can still lose them. The
`FRAME FITS VIEWPORT` flag on the in-place line is the signal to watch.

See [[clip-pin-cache-ab-2026-07-25]] for the bench traps around this area.
