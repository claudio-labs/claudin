---
name: TUI dialogs that rewrite rows in place need ink.repaint() BEFORE the state change
description: ink's incremental diff interleaves old/new cells on in-place row updates; fix = instance.repaint()+invalidatePrevFrame() in the key handler before setState; verified via tmux rig
type: project
---

A dialog that rewrites rows in place on navigation (master/detail phase switch, selection move)
renders interleaved old/new characters ("test:tester" → "dctest:tvstwr"), stale fragments of the
previous frame under blank areas, and a drifting pane border. Established with a live tmux repro
(2026-07-07, /workflows Running detail):

- The frame BUFFER is correct — a terminal resize (which rewrites every cell from scratch) always
  displayed the frame perfectly. The corruption is in the incremental EMISSION: partial-row writes
  positioned by model coordinates drift around ambiguous-width glyphs (✔ U+2714), interleaving cells.
- `invalidatePrevFrame()` is NOT enough: it only disables the blit fast path; the cell-diff still
  skips "unchanged" cells and emits positioned partial writes. In a `useLayoutEffect` it is also a
  frame late (fires after the garbled frame is on screen, and nothing triggers a follow-up render).

**The fix** — in the useInput handler, BEFORE the setState that changes the layout:
```ts
instances.get(process.stdout)?.prepareFullRepaint()  // src/ink/instances.js
```
`prepareFullRepaint()` (added to ink.tsx next to invalidatePrevFrame) picks the mode-appropriate
reset: alt-screen → `resetFramesForAltScreen()` + `needsEraseBeforePaint`; main-screen →
`repaint()` + `prevFrameContaminated`. The very frame that renders the new layout then writes every
cell, like the clean resize path. Pitfalls proven in the rig:
- A bare `repaint()` in alt-screen/fullscreen leaves 0×0 frames → log-update's 'growing'
  renderFrameSlice path scrolls the alt screen (trailing CR+LF) → STALE FRAMES STACK on every
  keypress (doubled headers, list bleeding into detail). Fullscreen is easy to be in without
  knowing: /config flickerFreeMode, or Ghostty's main-screen-rewrite auto-path.
- Do NOT call `forceRedraw()` before setState (it immediately re-renders the OLD content, and the
  subsequent state render is incremental again).
- Fullscreen also indents dialogs ~2 cols each side: width math based on `columns` must leave ~4
  cols slack (DiffDialog's `-10` fudge is the precedent) or overflow-hidden clips the right edge,
  and full-width `<Divider>` needs `padding={4}` or it wraps.

**Verifying TUI renders yourself (the rig):** scratch cwd + fake data (e.g. workflow runs are plain
JSON in `<cwd>/.claudin/workflows/.runs/<12-hex>.json`, schema in src/tools/AgentWorkflow/types.ts),
`tmux new-session -d -x 200 -y 46 'cd /tmp/demo && CLAUDIN_CONFIG_DIR=/tmp/cfg ANTHROPIC_API_KEY=sk-fake bin/claudin'`,
drive with `tmux send-keys`, read with `tmux capture-pane -p`. First run shows migration + folder-trust
dialogs. ⚠️ **The migration dialog's FIRST option is "Migrate now" — a blind Enter imports the user's
REAL ~/.claude tokens into the scratch config and later keystrokes can reach the paid API** (happened
2026-07-07: a stray prompt cost $0.24; wiped the cfg dir immediately). Always answer it with
Down+Enter (Skip), capture-pane BEFORE answering any startup dialog, and never batch keystrokes
across a startup boundary — startup timing varies and keys race into the wrong surface.
`tmux resize-window` is the buffer-vs-emission probe.
**Keybinding gotcha:** don't bind dialog-dismiss via `useKeybinding('confirm:no', …, {context:
'Confirmation'})` — Confirmation maps the letter **n** to confirm:no, so any tab exposing an "n"
shortcut closes the whole dialog. Use context 'Settings' (escape-only) like the settings panel does.

Layout recipe that renders clean (mirrors /diff's DiffPane):
- Tall bordered pane (`height={rows-6}`, `overflow="hidden"`, `paddingX={1}`, title via `borderText`)
  filled with ONE `<RawAnsi lines width={inner}/>`: ANSI strings truncated (`truncateToWidth`) and
  padded with real spaces to exactly the inner width (track plain width via src/ink/stringWidth.js),
  plus `' '.repeat(inner)` blank lines to the interior height. RawAnsi paints the full rectangle
  (a blank-padding `<Text>` does NOT — trailing whitespace is trimmed). inner = outer − 4.
- Exact column control comes free (right-aligned duration columns, no flex drift).
- Colors in raw lines: `themeColorToAnsi(getTheme(useTheme()[0]).success)+s+'\x1b[39m'`, chalk.bold/dim.
- **Never use ✔ (U+2714) in column-exact layouts**: stringWidth's Node path routes U+2600–27BF
  through the emoji segmentation branch and emoji-regex matches bare U+2714 → model counts 2 cells,
  but most monospace terminals advance 1 → every row containing it bends the right border (and the
  drift can carry into following rows). Use ✓ (U+2713) — near-identical glyph, not emoji-matched,
  measures 1 everywhere. ✗ (U+2717), ▸, ⊘, · all measure 1 and are safe. Verify with exact column
  counting on `tmux capture-pane` output (python enumerate of border-char positions), not eyeballs —
  a 1-col kink is invisible in a wall of text.
