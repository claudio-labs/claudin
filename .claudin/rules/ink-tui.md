---
paths:
  - "src/terminal/ink/**"
  - "src/components/**"
  - "src/screens/**"
  - "src/native-ts/**"
  - "src/terminal/hooks/useTextInput.ts"
---
# Ink / TUI Renderer — Claudin Development Rules

Claudin ships a **forked Ink** (`src/terminal/ink/`): a grid-based renderer that measures
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
  via `src/terminal/ink/terminal.ts::getInlineImageProtocol` (`InlineImageProtocol =
  'kitty' | null`); everything else falls back to the `[Image #N]` label.
- Kitty fits because it uses the **Unicode Placeholder** variant: `stringWidth.ts`
  is patched so each `U+10EEEE` cluster counts as exactly 1 cell → strict
  1-grid-cell : 1-terminal-cell mapping; placeholder rows are real
  `\n`-terminated strings (grid-native).
- iTerm2 OSC 1337 and sixel are **0-width** to `stringWidth` (stripped as ANSI)
  but the terminal advances N rows on paint → Ink reserves 0–1 rows and paints
  following content on top → corruption. Adding them is NOT a small change: it
  needs a new leaf node analogous to `src/terminal/ink/components/RawAnsi.tsx` that
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

- **(a) Damage-bounds miss (`src/terminal/ink/screen.ts` `diffEach`, model width == terminal
  width).** Row shrinks or a subtree unmounts with no new content reflowing into
  its rectangle → stale glyphs to the right / orphan rows above the status bar.
  Fix: in the same-width path, scan the full screen —
  `diffSameWidth(prev, next, 0, maxWidth, 0, maxHeight, cb)`. `findNextDiff` skips
  equal cells with integer compares, so full-screen scan stays sub-millisecond.
  Regressions live in `src/terminal/ink/screen.test.ts` (shrinking-row + orphan-row).
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

- `src/terminal/ink/components/ScrollBox.tsx` relies on viewport culling that engages only
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
  `src/terminal/ink/ink.tsx` — roots run in ConcurrentMode (legacy mode compiled out). A
  `useSyncExternalStore` notify + a `setState` in the same task produce **1 render
  / 1 commit**, flushed async — normal auto-batching, NOT two sync commits.
- When reasoning about commit/paint atomicity, assume ConcurrentMode +
  same-task auto-batching + Ink's throttled stdout paint as a second net. Don't
  cite `LegacyRoot` as a sync guarantee; the false premise in
  `render-to-screen.ts`'s comment is unfixed — re-probe before relying on it.

## 6. Some committed `.tsx` are React-Compiler output, not JSX

- At least `src/agent/ui/TokenWarning.tsx` is checked in **already
  React-Compiler-transformed**: `import { c as _c } from 'react-compiler-runtime'`,
  `const $ = _c(13)` fixed-slot cache, `$[i]` bookkeeping,
  `Symbol.for("react.memo_cache_sentinel")` guards — this is the real source, not
  a build artifact. Likely true of other `src/components/*.tsx`.
- When hand-editing one, **do not change the `_c(N)` slot count or the `$[index]`
  bookkeeping** or memoization breaks. Prefer edits that ride existing structures:
  add a field to an existing destructure, or change a string/expression inside an
  already-memoized branch. If a change genuinely needs new memoized state, edit
  the pre-compiler source if one exists, or rebuild — never hand-write new `_c`
  slots. (If you must add one memoized value by hand, the safe pattern is: bump
  `_c(N)` by the slot count you add, use the new trailing indices, and gate with
  `if ($[k] !== dep) { v = compute(); $[k] = dep; $[k+1] = v } else { v = $[k+1] }`
  — PR #18 added `stripOutputMarkers` memoization to `BashToolResultMessage.tsx`
  this way, `_c(34)`→`_c(36)`.)

## 7. `useTextInput`'s local mirror only re-syncs on a PROP change

- `src/terminal/hooks/useTextInput.ts` keeps a **local text/cursor mirror**
  (`renderState`/`liveValueRef`/`liveOffsetRef`) so consecutive keystrokes advance
  immediately even before the controlled parent's `value` commits. It re-syncs FROM
  the parent **only when the `value` or `externalOffset` prop actually changes** —
  the `useLayoutEffect` gated by `lastSeenPropsRef` (~L125-138). `setValue` fires
  `onChange` only when the text differs and `onOffsetChange` only when the offset
  differs.
- **Trap:** if the parent's `onChange` *discards* a keystroke (e.g.
  `PromptInput.tsx` consuming the leading `!`/mode char as a mode toggle and
  `return`ing WITHOUT `trackAndSetInput`), the `value` prop stays unchanged. If the
  cursor op for that keystroke also doesn't move the offset, **neither prop changes,
  the mirror never re-syncs, and the discarded char lingers** in the buffer. This is
  exactly what the old mode-entry `cursor.insert('!').left()` did: `.left()` pinned
  the offset at 0, so `onOffsetChange` never fired; the `!` stayed and every
  following char inserted in front of it, pushing it to the tail
  (`git status!` → `unknown option 'branch!'`). Removing `.left()` (PR #18) let the
  offset advance 0→1, firing the re-sync that clears the consumed char.
- **Rule:** when a keystroke is meant to be consumed/discarded at the parent, make
  sure **some prop the mirror watches actually changes** (value or offset) so it
  re-syncs — do not pin the offset. Verify a mode-char change end-to-end
  (`setValue` → parent `onChange`/`onOffsetChange` → prop change → `useLayoutEffect`
  re-sync), not just the local cursor math.

## 8. A dialog cannot claim PgUp/PgDn — `scroll:page*` is always consumed

- `resolver.ts:45` only resolves a binding whose **context is active**, so
  `pageup`/`pagedown` (bound in the `Scroll` context, `defaultBindings.ts:209`)
  only dispatch while `ScrollKeybindingHandler` is mounted — and its
  `scroll:pageUp`/`scroll:pageDown` handlers (`ScrollKeybindingHandler.tsx:448-463`)
  **always consume**. Its `scroll:lineUp/lineDown` (`:474`) deliberately returns
  `false` when the ScrollBox content fits, which is the ONLY reason a wheel event
  reaches a child list (e.g. Settings Config's paginated slice). Page keys have no
  such bail, and the REPL handler mounts before any modal, so a
  `context: 'Settings'` handler for `scroll:page*` is dead code — it registers,
  typechecks, builds, and never fires.
- Don't "fix" it by adding the fits→`false` bail to the page handlers: with a long
  transcript the REPL scrollbox does NOT fit, so the key would scroll the
  transcript behind the modal instead of acting on the dialog — behavior that
  changes with session length. Handle the key in the dialog's own `onKeyDown`
  instead (that path dispatches independently of keybinding consumption, see the
  j/k carve-out in `Settings/Config.tsx`), with keys nothing else claims —
  `[`/`]` is the in-repo precedent (`diff:previousSource/nextSource`).
- Verify keyboard wiring in a real terminal, not by reading the registration:
  `tmux new-session -d -s probe -x 110 -y 44 -c /tmp/scratch "node dist/cli.mjs"`,
  then one `send-keys` per key with ~0.5s between (several keys in one call get
  coalesced/dropped) and `capture-pane -p`. `Usage.tsx:741-742` still registers
  `scroll:page*` the dead way.

## 9. Since chalk 6, a numeric `FORCE_COLOR` pins the level instead of raising it

- chalk 6.0.0 (bumped 2026-07-27, #42) made `envForceColor` return **early with
  the exact level** for a numeric value, so terminal detection no longer runs.
  Measured: `FORCE_COLOR=1 COLORTERM=truecolor` → level **3** on chalk 5.6.2,
  level **1** on 6.0.0. `FORCE_COLOR=true` (and empty) still only enables color
  and lets detection pick the level, so that is the value to suggest when someone
  wants "force color, keep truecolor".
- **How to apply:** a report of a washed-out / 16-color TUI that only reproduces
  in one shell or in CI is most likely `FORCE_COLOR=1` in the environment, not a
  theme or renderer bug. Check `chalk.level` before touching `colorize.ts`.
  Our own writes are unaffected — `RunTestsTool/run.ts` passes `FORCE_COLOR=0` to
  the child and the profile scripts pass `3`, both of which mean the same thing in
  either version.
- Don't re-raise the level in `src/terminal/ink/colorize.ts` to restore the old behavior:
  the level-2→3 (vscode) and >2→2 (tmux) fixups there correct a *detection* miss,
  whereas a numeric `FORCE_COLOR` is an explicit user request that chalk now
  honors literally. Overriding it would make the env var unable to select 16-color
  output at all.

## 10. One logical line = one `<Text>`; siblings in a row Box become columns

- A `<Box flexDirection="row">` lays each `<Text>` child out as its own flex
  item with its own width, and wrapping happens **inside** that item. Splitting a
  status line into sibling `<Text>`s to escape a parent style therefore does not
  produce one flowing line — it produces columns that wrap independently. Splitting
  the collapsed-group badge in `CollapsedReadSearchContent.tsx` to keep its `+42 −7`
  out of a `dimColor` wrapper rendered as
  `… read 3  +42 − (ctrl+o to` / `files                    expand)` — the tail of
  each column continuing on the next row.
- The escape was unnecessary: `dimColor` on a parent `<Text>` **composes with** a
  child's `color` instead of replacing it. This fork does not wrap ANSI strings —
  `squash-text-nodes.ts:24-26` merges a style *object* per segment
  (`{...inheritedStyles, ...node.textStyles}`), so a child's `color` wins on the
  `color` key while the parent's `dim` survives untouched. Nesting
  `<Text color="diffAddedWord">` inside a dim parent reads as dim green, which is
  what a finished row should look like anyway. Keep the line in one `<Text>` and
  let the nesting do the styling.
- **A `<Box>` with no `flexDirection` is a row** (`Box.tsx:103`), so this bites
  without a `flexDirection="row"` anywhere in sight. The same file hit it twice:
  once on the badge, and once on the per-file `⎿` rows, where an inner
  `<Box flexGrow={1}>` held the path in one `<Text>` and `+28 −4` in another.
- Only a width that forces a wrap can tell the two shapes apart, and a test at the
  default 80 columns often cannot: the split `⎿` row rendered **identically** at 80
  and 34 columns, and only started eating the path at 26 (`M /repo/one.t  +28 −4`).
  Sweep two or three widths — `renderToString(node, columns)`
  (`src/terminal/render/staticRender.tsx`) takes one.
- This is invisible to a code review and to a unit test that only asserts
  `toContain`, because the words are all still present — just interleaved across
  rows. Assert **contiguity and order** of the fragments over the
  whitespace-flattened output (`expectInOrder` in
  `CollapsedReadSearchContent.test.tsx`): a bare `toContain('+28')` passes on the
  mangled render, `'M /repo/one.ts'` does not.
