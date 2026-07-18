---
paths:
  - "src/ink/**"
  - "src/components/**"
  - "src/screens/**"
  - "src/native-ts/**"
---
# Ink / TUI Renderer — Claudin Development Rules

Claudin ships a **forked Ink** (`src/ink/`): a grid-based renderer that measures
every node's height from `\n`-line count and paints each row at an absolute
`(x,y)` via `setCellAt`. These constraints follow from that design — verify
file:line against current code before relying on an anchor.

## 1. Grid model: height = newline count, paint = absolute (x,y)

- `measure-text.ts` increments height per `\n` line; `output.ts` does
  `text.split('\n')`, one element per grid row; `render-node-to-output.ts` writes
  at absolute `y`. A node that advances the physical cursor by more rows than its
  measured `\n` count corrupts everything painted after it.

## 2. Inline images are Kitty-only by design — do not "just add" iTerm2/sixel

- `INLINE_IMAGES` renders only for the **Kitty family** (kitty, Ghostty, WezTerm)
  via `src/ink/terminal.ts::getInlineImageProtocol` (`InlineImageProtocol =
  'kitty' | null`); everything else falls back to the `[Image #N]` label.
- Kitty fits because it uses the **Unicode Placeholder** variant: `stringWidth.ts`
  is patched so each `U+10EEEE` cluster counts as exactly 1 cell → strict
  1-grid-cell : 1-terminal-cell mapping; placeholder rows are real
  `\n`-terminated strings (grid-native).
- iTerm2 OSC 1337 and sixel are **0-width** to `stringWidth` (stripped as ANSI)
  but the terminal advances N rows on paint → Ink reserves 0–1 rows and paints
  following content on top → corruption. Adding them is NOT a small change: it
  needs a new leaf node analogous to `src/ink/components/RawAnsi.tsx` that
  declares a fixed `rawHeight` AND reconciles the terminal's real cursor advance
  with that height (explicit newline/cursor-down padding). RawAnsi alone doesn't
  solve it — its height contract is still `lines.length`. (User decided to leave
  iTerm2/sixel out, 2026-07-14.)
- Kitty rendering works in the Bun-compiled binary since the sharp-vendoring fix
  (PR #11): `InlineImage.tsx` decodes/resizes via `getImageProcessor()` (sharp),
  which previously failed with no `node_modules` and fell back to the label.
- Render-lifecycle note: on-screen messages do NOT use Ink's real `<Static>`.
  `shouldRenderStatically` → `isStatic` is only a `React.memo` bail-out; every
  message stays a live fiber (wrapped in `OffscreenFreeze`), which is why async
  `setLines` (after sharp finishes) paints fine.

## 3. Vacated cells leak stale glyphs — two distinct mechanisms

Damage bounds are computed from cells **written** to the `next` frame, so cells
`prev` had but `next` leaves empty can leak. There are TWO different causes; fix
the right one.

- **(a) Damage-bounds miss (`src/ink/screen.ts` `diffEach`, model width == terminal
  width).** Row shrinks or a subtree unmounts with no new content reflowing into
  its rectangle → stale glyphs to the right / orphan rows above the status bar.
  Fix: in the same-width path, scan the full screen —
  `diffSameWidth(prev, next, 0, maxWidth, 0, maxHeight, cb)`. `findNextDiff` skips
  equal cells with integer compares, so full-screen scan stays sub-millisecond.
  Regressions live in `src/ink/screen.test.ts` (shrinking-row + orphan-row).
- **(b) Ambiguous-width drift (`stringWidth` model width ≠ terminal width).** With
  `ambiguousIsNarrow: true`, East-Asian-Ambiguous glyphs (`←→☒☐`) measure width 1
  but some terminals (Ghostty + Nerd Font) render them width 2. When a row is
  **vacated**, `render()` clears it at the model's narrower columns and the
  drifted tail is never overwritten → orphan (the classic "S → / Submit" ghost on
  the AskUserQuestion nav bar). Fix (shipped a6c0dd23): in `LogUpdate.render()`'s
  diff loop, when `removed && added && isEmptyCellAt(next,x,y) &&
  isRowEmptyFrom(next,x,y)`, emit ONE `eraseToEndOfLine()` (CSI K) for the row
  instead of per-cell spaces. Do NOT make the module-scope width const dynamic
  (hot path ~100k calls/frame). Probe method: `logForDebugging` at the top of
  `LogUpdate.render()` dumping per-row `prev`/`next`, then headless-replay the
  captured frames through a minimal VT sim that renders ambiguous glyphs WIDE.

## 4. ScrollBox only clips inside a real alt-screen fullscreen root

- `src/ink/components/ScrollBox.tsx` relies on viewport culling that engages only
  inside an alt-screen fullscreen root. In inline mode AND main-screen-rewrite
  mode (Ghostty via `shouldUseMainScreenRewrite()`) it renders EVERY child row —
  `height={N}` does not clip. A tall body grows the whole dialog instead of
  scrolling.
- For a bounded scrollable body that works in ALL render modes, window manually on
  **final rendered rows**, not React subtrees: get the exact `string[]` from
  `new ColorDiff(...).render(theme, width, dim)`, `slice(offset, offset+height)`,
  render via `<RawAnsi lines=… width=… />`, and own the scroll offset in state
  (↑/↓/PgUp/PgDn clamped to `rows.length - height`). `DiffPane.renderDiffRows` is
  the working example; keeps highlighting/word-diff, never overflows.

## 5. LegacyRoot is vestigial — assume ConcurrentMode + auto-batching

- react-reconciler 0.33 (React 19) ignores the `LegacyRoot` tag Ink passes at
  `src/ink/ink.tsx` — roots run in ConcurrentMode (legacy mode compiled out). A
  `useSyncExternalStore` notify + a `setState` in the same task produce **1 render
  / 1 commit**, flushed async — normal auto-batching, NOT two sync commits.
- When reasoning about commit/paint atomicity, assume ConcurrentMode +
  same-task auto-batching + Ink's throttled stdout paint as a second net. Don't
  cite `LegacyRoot` as a sync guarantee; the false premise in
  `render-to-screen.ts`'s comment is unfixed — re-probe before relying on it.

## 6. Some committed `.tsx` are React-Compiler output, not JSX

- At least `src/components/TokenWarning.tsx` is checked in **already
  React-Compiler-transformed**: `import { c as _c } from 'react-compiler-runtime'`,
  `const $ = _c(13)` fixed-slot cache, `$[i]` bookkeeping,
  `Symbol.for("react.memo_cache_sentinel")` guards — this is the real source, not
  a build artifact. Likely true of other `src/components/*.tsx`.
- When hand-editing one, **do not change the `_c(N)` slot count or the `$[index]`
  bookkeeping** or memoization breaks. Prefer edits that ride existing structures:
  add a field to an existing destructure, or change a string/expression inside an
  already-memoized branch. If a change genuinely needs new memoized state, edit
  the pre-compiler source if one exists, or rebuild — never hand-write new `_c`
  slots.
