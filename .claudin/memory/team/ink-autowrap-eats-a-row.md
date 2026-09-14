---
name: Auto-wrap eats a row — the side-panel divider checkerboard (2026-09-13)
description: A frame row that reaches the LAST column plus one cell of width drift makes the terminal wrap, swallow a row, and paint every later row of that frame one row low; fixed by turning DECAWM off around each paint
type: project
---

**Symptom.** With `/diff` open as a side panel, the vertical divider between the
chat and the panel renders as a dashed column — present on roughly half the rows
(user, pt-BR: *"quando o diff esta aberto fica quadriculada"*, 2026-09-13). They
attributed it to checklists being on screen; checklists are only a correlate,
because the todo block re-renders constantly and so keeps producing frames.

**This is a THIRD mechanism**, distinct from both of the ones
[[ink-ambiguous-width-vacate-ghost]] and [[ink-diff-damage-xbounds]] describe
(`.claudin/rules/ink-tui.md` §3 (a)/(a2)/(b)). Width drift is the trigger, but
the damage is not a stale glyph on the drifted row — it is **every later row of
the frame landing one row too low**.

## The chain

1. `ModalSlot.tsx` draws the panel as a Box with `borderStyle="single"` and only
   `borderLeft`, at column `leftCols = floor(columns/2)`
   (`src/terminal/sidePanelLayout.ts`). The divider is therefore ONE glyph per
   row — the most sensitive possible detector of a row-cursor desync.
2. A split row is emitted as one run that ends at the **last column**. Measured
   on a real 180-column session: `\r` `CSI 90 C` `CSI 1 B` `│` then exactly 89
   background spaces — `width - leftCols - 1`, i.e. right up to the margin.
3. If the terminal renders any glyph in that run wider than `stringWidth` says,
   the run overflows the margin and the terminal auto-wraps, **consuming a row**.
   `│` (U+2502) is itself East-Asian-Ambiguous, as are `─ ● …`; Nerd Font PUA
   icons are another candidate. Which one drifts does not matter.
4. `moveCursorTo` (`src/terminal/ink/log-update.ts`) steps rows **relatively** —
   `\r` plus cursor-down — so from the wrap onward every row of that frame is
   painted one row low. The border shows on alternating rows.

**Why the CSI K drift-robust path does not save it.** The 2026-06-17 fix
(§3(b)) only fires when `isRowEmptyFrom(next, x, y)`, and the panel's cells
carry `sidePanelBackground`, so they are **not empty**. Confirmed by
instrumenting the `diffEach` callback in a running session: `emptyNext=false`
across the whole tail. The panel legitimately paints ~89 cells per row; there is
no shorter run to emit.

## Fix (PR #195, `fix/tui-autowrap-row-desync`, 2026-09-13)

`writeDiffToTerminal` (`src/terminal/ink/terminal.ts`) wraps each frame's buffer
in DECAWM off/on — `DISABLE_AUTO_WRAP` / `ENABLE_AUTO_WRAP`, added beside the
other DEC modes in `src/terminal/ink/termio/dec.ts`. The overflow is then clamped
to the last column and the damage stays on its own row.

Safe because the renderer never wants an implicit wrap: it positions every cell
absolutely, wraps its own text (`wrap-text.ts`), advances rows with explicit
`\r`+LF in `renderFrameSlice`, and `writeCellWithStyleStr` already refuses to
write a wide char that would cross the viewport edge. Both sequences go in the
**same `stdout.write`**, inside the BSU/ESU pair, so the terminal is never left
with wrapping off — no exit-path change needed, and no killswitch was added.
Once this lands, `ink-tui.md` §3 should gain it as mechanism **(c)**.

## Verification recipe (reusable for any cursor-desync suspicion)

Cheaper and more faithful than the `logForDebugging` + `--debug` probe in
[[ink-ambiguous-width-vacate-ghost]], because it replays the REAL byte stream:

1. Capture the app's own output: run it under `script -qfc '<launcher>' /tmp/s.raw`
   inside a fixed-size tmux session (`tmux new-session -d -x 180 -y 45`). Drive
   it with `send-keys` (see [[tmux-mouse-click-verification]] for the caveats).
2. Replay `/tmp/s.raw` through a small VT sim that honours `?7l`/`?7h` and takes
   a configurable set of wide glyphs, then read the divider column per row.
3. tmux's own `capture-pane` renders ambiguous glyphs narrow, so it shows the
   MODEL and will look correct — useful as the "no regression" control, useless
   as a repro.

Result: before, column 90 read `.|.|.|.|…`; after, 39 solid rows — both with
only `│` wide and with every ambiguous glyph plus the PUA range wide. The stream
carried 127 balanced `?7l`/`?7h` pairs and ended wrap-on.

## The test trap that hides this bug

A synthetic frame whose panel fill is plain spaces with `styleId ===
stylePool.none` reads as **empty** to `isEmptyCellAt`, so the CSI K path fires,
the run never reaches the margin, and the regression test passes **with the fix
reverted**. The fill cells must intern a real background style
(`stylePool.intern([{type:'ansi', code:'\x1b[48;2;…m', endCode:'\x1b[49m'}])`)
to reproduce the production shape. The test in `log-update.test.ts` serializes
through the real `writeDiffToTerminal` rather than a hand-rolled copy, and was
confirmed red without the fix (`│ │ │ │ … ││`). 397 `src/terminal` tests pass,
typecheck 0 new.
