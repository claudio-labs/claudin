---
name: AskUserQuestion nav-bar ghost = ambiguous-width drift on vacated rows
description: "S →" orphan on AskUserQuestion nav bar is terminal/model width disagreement on ←→☒☐, NOT the diffEach-bounds bug; only ghosts on rows that get VACATED (nav bar shifts r27↔r28)
type: project
---

The "S →" / "Slbmit" ghost above the AskUserQuestion nav bar is **width drift**, a DIFFERENT mechanism than the `screen.ts diffEach` damage-bounds bugs fixed 2026-06-03/06-07 (see ink-diff-damage-xbounds.md). Those fixes assume model width == terminal width; this case breaks that assumption.

**Root cause (confirmed 2026-06-17 by headless terminal-sim replay of real probe frames):** Claudin's `stringWidth` (src/ink/stringWidth.ts:254, `ambiguousIsNarrow:true`) measures East-Asian-Ambiguous glyphs `←`(U+2190) `→`(U+2192) `☒`(U+2612) `☐`(U+2610) as width **1**. Repro terminal (Ghostty 1.3.1 + JetBrainsMono Nerd Font) renders them width **2**. The cell-grid columns and the physical terminal columns diverge.

**Why it only ghosts on vacate:** A freshly-drawn nav-bar row looks fine (every glyph is painted, just shifted right). But the fullscreen REPL is a fixed-height (45-row) screen and the nav bar oscillates between rows (r27↔r28) as you navigate questions — different question heights shift the block. When the nav bar moves OFF a row, `render()` clears that row by writing spaces at the **model's** (narrower) columns; the glyphs that drifted further right (e.g. "Submit"'s tail, the trailing `→`) sit beyond the model's extent and are never overwritten → orphan.

**Proof:** width-1 replay of probe-19's r28-vacate clears perfectly; flipping the simulator to render ambiguous=wide reproduces `|  ☒ … ns … Te a … bm t  →|` — the exact scattered+trailing-→ pattern.

**FIXED 2026-06-17 via option 2 (confirmed working in the user's Ghostty).** In `LogUpdate.render()`'s diff loop (`src/ink/log-update.ts`), when `removed && added && isEmptyCellAt(next,x,y) && isRowEmptyFrom(next,x,y)` (prev had a glyph, next is empty from x to EOL), emit ONE `eraseToEndOfLine()` (CSI K) for that row instead of per-cell spaces — wipes the physical tail regardless of width drift. New helper `isRowEmptyFrom` in `screen.ts`; `erasedToEolRow` guards one-erase-per-row. Regression test in `log-update.test.ts` replays the real probe-19 frames through a VT that renders ambiguous glyphs WIDE and asserts the vacated row is empty (red without the fix). 61/61 ink tests pass. Committed to main 2026-06-17 as a6c0dd23 (`fix(ink): clear vacated rows with end-of-line erase to kill width-drift ghosts`).

Rejected alternatives: (1) CPR-detect terminal ambiguous width at startup + feed `stringWidth` — correct/general but touches startup + makes the module-scope width const dynamic (hot path ~100k calls/frame). (3) Swap ambiguous glyphs in QuestionNavigationBar.tsx — lowest risk but incomplete (other vacated rows still drift).

**Probe method (reusable):** temp `logForDebugging` at top of `LogUpdate.render()` dumping `prev`/`next` per-row when a marker string is present; run `claudindev --debug`, read `~/.claudin/debug/latest`. Then headless-replay the captured frames through `LogUpdate.render()` + a minimal VT sim (serialize Diff via termio/csi `cursorMove`/`cursorTo`/`eraseLines`).
