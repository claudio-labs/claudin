---
name: ScrollBox only clips inside an alt-screen fullscreen root
description: ScrollBox renders all child rows in inline/main-screen-rewrite mode — overlays must window manually on rendered rows
type: project
---

`src/ink/components/ScrollBox.tsx` relies on the renderer's viewport culling, which only engages inside a real alt-screen fullscreen Ink root (its own doc says "works best inside a fullscreen constrained-height root"). In inline mode AND main-screen-rewrite mode, it renders EVERY child row at full height — `height={N}` does not clip.

**Why:** `isFullscreenEnvEnabled()` returns true on Ghostty via `shouldUseMainScreenRewrite()`, but that path keeps the overlay in the scrolling transcript (no alt-screen). The `/diff` reviewer gated its split + ScrollBox on `isFullscreenEnvEnabled()` and a tall diff grew the whole dialog instead of scrolling — the top "rose" off-screen (reported 2026-06-18). The file list never had this because it does manual windowing (slice to N rows + "↑/↓ N more" markers).

**How to apply:** for a bounded, scrollable body that works in ALL render modes, window manually on FINAL rendered rows, not React subtrees. `new ColorDiff(hunk, firstLine, filePath, fileContent).render(theme, width, dim)` (src/components/StructuredDiff/colorDiff.ts → native-ts/color-diff) returns the exact `string[]` of wrapped ANSI rows that `StructuredDiff` feeds to `<RawAnsi lines=… width=… />`. Concatenate per segment, `slice(offset, offset+height)`, render via RawAnsi, and own the scroll offset in state (↑/↓/PgUp/PgDn, clamped to `rows.length - height`). DiffPane.renderDiffRows is the working example. Keeps syntax highlighting/word-diff; never overflows.
