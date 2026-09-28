# Spec: `vcs/structuredDiff`

## Purpose

The terminal components that draw a patch, and the switch that says whether
syntax highlighting is available at all.

- **`StructuredDiff`** draws one hunk of a patch: every line with its number, a
  `+`, `-` or blank marker, and the code, with the words that changed picked
  out. By default the syntax renderer in `src/native-ts/color-diff` draws the
  rows. When highlighting is off, a plain fallback of this unit draws them.
- **`StructuredDiffList`** draws the hunks of one file's patch, with a `...` row
  between two consecutive hunks.
- **`colorDiff.ts`** is the switch. Callers ask it for the renderer's classes and
  for the name of a theme's syntax palette, and get `null` when the user turned
  highlighting off through `CLAUDIN_SYNTAX_HIGHLIGHT`.

Users meet it in the results of the Edit and Write tools and in rejected
edits, in the Edit, sed-edit, Write and NotebookEdit permission dialogs, in the
Rename tool's result, and in the theme picker's preview. `/diff`'s pane,
highlighted code blocks and the explorer's editor use only the switch.

A hunk is the `diff` package's `StructuredPatchHunk`:
`{ oldStart, oldLines, newStart, newLines, lines: string[] }`. Each line starts
with `+`, `-`, a space, or `\` (the `\ No newline at end of file` note). The
callers build hunks with that package's `structuredPatch`, mostly through
`src/vcs/git/diff.ts`.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `StructuredDiff` | a React component, memoized, taking `{ patch: StructuredPatchHunk; dim: boolean; filePath: string; firstLine: string \| null; fileContent?: string; width: number; skipHighlighting?: boolean }` | `src/permissions/ui/FileWritePermissionRequest/FileWriteToolDiff.tsx`, `src/permissions/ui/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx`, `src/platform/ThemePicker.tsx`, `StructuredDiffList` |
| `StructuredDiffList` | `(props: { hunks: StructuredPatchHunk[]; dim: boolean; width: number; filePath: string; firstLine: string \| null; fileContent?: string }) => React.ReactNode` | `src/tools/FileEditTool/ui/FileEditToolDiff.tsx`, `FileEditToolUpdatedMessage.tsx`, `FileEditToolUseRejectedMessage.tsx` (with `dim`), `src/tools/RenameTool/UI.tsx` |
| `StructuredDiffFallback` (in `Fallback.tsx`) | a React component taking `{ patch: StructuredPatchHunk; dim: boolean; width: number }` | `StructuredDiff` only. The rewrite may stop exporting it. |
| `transformLinesToObjects`, `processAdjacentLines`, `calculateWordDiffs`, `numberDiffLines`, `LineObject` (in `Fallback.tsx`) | helper exports | nothing: see Out of scope |
| `ColorModuleUnavailableReason` | the type `'env'` | `colorDiff.ts` itself |
| `getColorModuleUnavailableReason` | `() => ColorModuleUnavailableReason \| null` | `src/platform/ThemePicker.tsx` |
| `expectColorDiff` | `() => typeof ColorDiff \| null` | `src/vcs/diff/ui/DiffPane.tsx`, `StructuredDiff` |
| `expectColorFile` | `() => typeof ColorFile \| null` | `src/terminal/highlighted-code/HighlightedCode.tsx` |
| `expectEditorHighlighter` | `() => typeof EditorHighlighter \| null` | `src/terminal/explorer/ExplorerDialog.tsx` |
| `getSyntaxTheme` | `(themeName: string) => SyntaxTheme \| null` | `src/platform/ThemePicker.tsx` |

`ColorDiff`, `ColorFile`, `EditorHighlighter` and `SyntaxTheme` are the
renderer's exports (`src/native-ts/color-diff/index.ts`). The callers use them
as follows, and that is the renderer's contract, not this unit's:
- `new ColorDiff(hunk, firstLine, filePath, fileContent | null).render(themeName, width, dim)` returns the rows, one string with ANSI codes per terminal row, or `null`.
- `new ColorFile(code, filePath).render(themeName, width, dim)` returns the numbered rows of a whole file.
- `new EditorHighlighter(filePath, firstLine, themeName)` offers `renderLineWindow(line, fromCol, width, cursorCol?)` and `displayColOf(line, col)`.
- `SyntaxTheme` is `{ theme: string; source: string | null }`.

`src/platform/ThemePicker.test.tsx` mocks `StructuredDiff.js` and
`colorDiff.js` by path, with `StructuredDiff`, `getColorModuleUnavailableReason`
and `getSyntaxTheme`. The rewrite keeps those paths and names.

The theme keys the fallback draws with belong to the design system
(`src/terminal/theme/`): `diffAdded`, `diffRemoved`, `diffAddedDimmed`,
`diffRemovedDimmed`, `diffAddedWord`, `diffRemovedWord` and `text`. The tests
read their values with `getTheme(name)`.

## Observable behaviour

### 1. The switch (`colorDiff.ts`)

- `getColorModuleUnavailableReason()` returns `'env'` when `CLAUDIN_SYNTAX_HIGHLIGHT` holds `0`, `false`, `no` or `off`, compared without regard to case and after trimming whitespace. Otherwise it returns `null`: unset, empty, or any other value (`1`, `true`, `on`, `Monokai Extended`, `offline`, `00`).
- The variable is read on every call, so a change takes effect at the next call.
- While the reason is `null`:
  - `expectColorDiff()`, `expectColorFile()` and `expectEditorHighlighter()` return the renderer's own classes, the very objects `src/native-ts/color-diff` exports;
  - `getSyntaxTheme(name)` returns what the renderer's `getSyntaxTheme(name)` returns, for every theme name. Today that is `{ theme: 'Monokai Extended', source: null }` for `dark` and `{ theme: 'GitHub', source: null }` for `light`, which the theme picker shows after "Syntax theme:".
- While the reason is `'env'`, all four return `null`.

### 2. Which path `StructuredDiff` takes

It draws the plain fallback when any of these holds, and the syntax renderer's
rows otherwise:
- the `skipHighlighting` prop is true. It defaults to false, and no caller sets it today;
- the `syntaxHighlightingDisabled` setting is true in the app state (`useSettings()`). The theme picker's ctrl+t toggles it while diffs are on screen;
- the switch reports a reason (section 1), read when the diff renders;
- the renderer returns `null` for the hunk. The current renderer never does, so this is not pinned.

### 3. The highlighted path

- **What is painted.** Exactly the rows the renderer returns, one terminal row per string, cell for cell: characters, colours and dimming. The renderer is constructed with the hunk, `firstLine`, `filePath` and `fileContent` (or `null` when the prop is absent). It is rendered with the name of the theme in effect (`useTheme()`), the effective width, and `dim`.
- **The effective width** is `width` rounded down, or 1 when that is less than 1.
- **What that looks like today.** This is the renderer's behaviour, pinned here only through the equality:
  - a row is a space, the line number right-aligned to the digit count of the hunk's largest line number, a space, the marker, then the code;
  - a removed line shows its number in the old file, and added and context lines show theirs in the new file. A hunk with `oldStart` 10 and `newStart` 12 numbers its first context line 12 and its first removed line 11;
  - a line longer than the width wraps at any character. Continuation rows leave the number blank and repeat the marker;
  - added and removed rows are padded to the width in their background colour;
  - the changed words of a removed line and the added line it pairs with get a stronger background, unless `dim`;
  - `dim` dims every cell;
  - the language comes from the file's name or extension, or else from its first line: a shebang naming python, node, bash or sh, ruby or perl, or a first line starting `<?php` or `<?xml`.
- **`fileContent`** changes nothing in the picture today, because the renderer ignores it. The callers pass it, so the rewrite keeps accepting it and handing it on.

### 4. The fallback: rows and numbers

- One row per hunk line, in the hunk's order, plus continuation rows for lines that wrap (section 7).
- A row is the line number, right-aligned in a column one wider than the digit count of the largest number drawn in the hunk, then a space, the marker (`+` added, `-` removed, blank otherwise), then the code: the hunk line without its first character. At width 80, a hunk starting at line 7 reads `  7  alpha`, `  8 -bravo one`, ` 10 +delta tres`, ` 11  echo`. A hunk reaching line 101 reads `  98  ninety-eight` and ` 101  one hundred one`.
- A line that starts with neither `+` nor `-` is drawn as context. That includes the `\ No newline at end of file` note (see Findings).
- **Numbering in the old module.** Numbers count up from `oldStart` over the context and added lines. A run of removed lines is numbered from the same point as the added lines that follow it, which reuse those numbers. This matches section 3's numbering only when the hunk starts at the same line on both sides and no unbalanced change comes before a removal in the same hunk. The suite pins only such hunks. See Findings.
- Every row is filled with spaces to the full width, so an added or removed row is a solid bar of its colour.

### 5. The fallback: words that changed

- **Pairing.** A run of consecutive removed lines followed directly by a run of consecutive added lines pairs up in order: the first removed line with the first added one, the second with the second, and so on. The lines left over in the longer run are unpaired, and so is every other line. A context line between the two runs means no pairing.
- **Comparing a pair.** The two lines are compared with the `diff` package's `diffWordsWithSpace`, case-sensitive. Words and runs of whitespace are tokens, so a double space that became single is a change, and so is a change of case.
- **The 40% rule.** The changed share is the length of every removed token plus every added token, divided by the length of the two lines together, in UTF-16 code units. Above 0.4, both lines are drawn whole, like unpaired lines. At 0.4 or below, they are drawn word by word. `let ab = oldval` against `let ab = newval` is exactly 0.4, so it is drawn word by word. `let a = oldval` against `let a = newval` is 0.43, so it is drawn whole.
- **Word by word.** The removed row shows the unchanged tokens and the removed ones, and the added row shows the unchanged tokens and the added ones, each in order. The changed tokens get the word colour (section 6).
- A dimmed diff is never drawn word by word.

### 6. The fallback: colours

Pinned at truecolor, against the theme in effect:
- A removed row is `diffRemoved` and an added row is `diffAdded`, across the whole row: number, marker, code and padding. With `dim`, they are `diffRemovedDimmed` and `diffAddedDimmed`.
- Context rows have no background.
- Changed tokens are `diffRemovedWord` and `diffAddedWord`.
- The code on added and removed rows is in the theme's `text` colour.
- With `dim`, every character is dimmed (the design system's `dimColor`).
- Not pinned, being style only: the number and marker of a context row are dimmed.
- A theme change while the diff is on screen repaints it in the new theme's colours.

### 7. The fallback: long lines and the width

- The width is rounded down, and anything below 1 counts as 1. The code always gets at least one column, so at width 1 every character sits on a row of its own (` 1 -a`, `   -b`, `   -c`).
- **The gutter** is the number column plus the space plus the marker.
- **A row drawn whole** wraps its code at spaces into the width minus the gutter minus one. A word longer than that is broken.
- **A row drawn word by word** wraps into the width minus the gutter. A row can end early where a changed token meets an unchanged one.
- **Continuation rows** leave the number blank and repeat the marker.
- **Wide characters** count as the columns they take.
- **What the suite pins,** at 40, 28 and 20 columns:
  - no row is wider than the width;
  - the text keeps its order and loses nothing;
  - no word is cut;
  - a row drawn whole ends only where the next word would not fit in the width minus the gutter minus one;
  - a changed word keeps its colour on whichever row it lands;
  - continuation rows look as described.

### 8. Live updates

While a diff is on screen, it repaints when:
- a prop changes: a new hunk object, `dim`, `width`, `filePath` or `firstLine`;
- the `syntaxHighlightingDisabled` setting changes. It switches paths, both ways;
- the theme changes, as with the theme picker's preview.

Drawing one hunk object again with other parameters never shows the picture of
an earlier set. The suite checks seven such draws in a row, varying the theme,
width, dim, file path and first line.

### 9. The list

- Each hunk is drawn by `StructuredDiff`, in order, with the list's `dim`, `width`, `filePath`, `firstLine` and `fileContent`. The list never sets `skipHighlighting`, so the setting and the switch decide the path of every hunk.
- Between two consecutive hunks there is one row reading `...`, dim, at the left edge of the list, and fenced off from selection (section 10). There is none before the first hunk or after the last.
- Each hunk sizes its own number column. A hunk around line 1 has a one-digit column, and one around line 22 has a two-digit column.
- No hunks paints nothing.
- It returns the hunks and separators as siblings, not in a container, so the caller must stack them. Every caller puts the list in a column box, and `RenameTool/UI.tsx` explains why.

### 10. Selection in fullscreen (not pinned)

In fullscreen mode, dragging over a diff selects and copies only code. The
gutter is fenced off from selection (`NoSelect`):
- **The highlighted path.** Fullscreen is on when `isFullscreenEnvEnabled()` (`src/terminal/render/fullscreen.ts`) says so. The fence covers the renderer's gutter: the digit count of the larger of the hunk's last old line (`oldStart + oldLines - 1`) and last new line (`newStart + newLines - 1`), at least 1, plus 3. It applies only when that gutter is narrower than the effective width; otherwise nothing is fenced. The picture is the same either way, and the suite pins that at widths 60, 24, 12, 5, 4 and 3.
- **The fallback** fences its number and marker in both modes, since the fence only acts in fullscreen.
- **The list** fences its `...` rows.

This is not pinned because the fake terminal cannot drive selection: the
renderer enables it on the alt screen, and it finds its instance through
`process.stdout`.

### 11. Remounting stays cheap (not pinned)

The transcript remounts every message when ctrl+o switches views. A diff that
is remounted for a hunk object it already drew, with the same theme, width,
dim, file path, first line and fullscreen fence, must not run the syntax
renderer again. What is kept for that must not outlive the hunk object, and
resizing the terminal while a diff is visible must not make it grow without
bound. A consequence callers can see: hunks are treated as immutable, and a
hunk object changed in place after it was drawn may keep its old picture.
Callers never do that.

## Edge cases and errors

| Case | What the user sees | Pinned |
|---|---|---|
| A list with no hunks | nothing | yes |
| A width below 1, or a fractional width | 1, or the width rounded down, on both paths | yes |
| Fullscreen with a width no wider than the gutter | the same picture, with nothing fenced | the picture: yes |
| A line longer than the width | wrapped at any character on the highlighted path, at spaces in the fallback | yes |
| Wide characters | measured by the columns they take | the fallback: yes |
| A hunk that starts at different lines on the two sides | the highlighted path: old numbers on removed lines, new ones elsewhere. The fallback counts from `oldStart`, so its numbers differ | the highlighted path: yes. The fallback: no (Findings) |
| A `\ No newline at end of file` line | on both paths, a numbered context row reading ` No newline at end of file`, and every line after it numbered one too high | no (Findings) |
| A line ending in a carriage return (CRLF files) | the highlighted path does not show it. The fallback adds an empty row after the line | no (Findings) |
| A tab inside a line | on both paths it counts as no column while the row is laid out, and the terminal renderer then widens it to its 8-column stops, so the row runs past the width. In a word-by-word fallback row, the marker also drops to a row of its own | no (Findings) |
| Two hunks with the same `newStart` in one list | React warns about a duplicate key. One file's patch never has two | no |
| The renderer returns `null` | the fallback | no: unreachable today |
| A hunk object changed in place after it was drawn | its old picture may stay | no |
| `CLAUDIN_SYNTAX_HIGHLIGHT` changed while a diff is on screen | it takes effect when that diff next renders | no |
| A `width` wider than the terminal | not handled here. Callers pass the terminal width or less | no |

## Security requirements

The code in a hunk is untrusted. It comes from files on disk and from edits
the model proposes, and the diff is what a user reads before approving a
Write, Edit or NotebookEdit. So the diff must show the code, and the code must
not be able to act on the terminal or disguise itself.

**Holds today, and pinned on both paths.** A control sequence inside a line never
reaches the terminal as any of these:
- a clipboard write (OSC 52);
- a cursor move or a screen clear;
- a bell or a backspace.

The words on either side of it are still shown, in order. The terminal renderer
(`src/terminal/ink`) is what drops them. This unit hands it the code as it is,
so the rewrite must keep the code on a path that goes through that renderer.

**Does not hold today (Findings, not pinned).** Styling sequences (SGR) and
hyperlinks (OSC 8) inside a line are honoured, on both paths:
- An added line holding `ESC[8m` (conceal), or a foreground set to its background, hides part of itself. A permission dialog can show `x = 1` for a line that also carries a command.
- The same sequences can fake the colours of an unchanged row.
- An OSC 8 hyperlink shows harmless text that opens any URL when clicked.

**The requirement for the rewrite.** Code never styles or links itself:
- strip escape sequences, and every C0 control character except the tab, from each hunk line before it is drawn, on both paths;
- on the highlighted path, do it before the hunk reaches the renderer, since the renderer adds its own sequences.

Dropping them is what the terminal renderer already does with every other
sequence. Only a file that holds raw escape bytes looks different afterwards,
and it then shows its text without the styling those bytes asked for.

## Tests that pin it

- **`src/vcs/diff/structured/structuredDiff.characterization.test.tsx`:** 40 tests. They cover `StructuredDiff` (both paths, fullscreen, live updates, control sequences), the fallback (rows, numbers, colours, changed words, long lines) and `StructuredDiffList`.
- **`src/vcs/diff/structured/colorDiff.characterization.test.ts`:** 9 tests of the switch.
- **Together:** 49 tests that run in about 16 s and passed three runs in a row.
- **Coverage of the old module:**
  - `Fallback.tsx`: 100% of functions and 98.16% of lines;
  - `StructuredDiff.tsx`: 100% and 96.95%;
  - `StructuredDiffList.tsx` and `colorDiff.ts`: 100% and 100%.

  The uncovered lines are the compiler output's cache hits, plus one guard that no input reaches.
- **How the suite observes the diff.** The rewrite has to keep working under this harness:
  - It mounts the component in a real Ink root (`createRoot` from `src/terminal/ink.js`, on `src/terminal/__testutils__/fakeTerminal.ts`), inside `AppStateProvider` and a `ThemeProvider` with an explicit theme. The app state is `getDefaultAppState()` with the test's settings.
  - The terminal is 20 columns wider than the diff, so a row that overflowed would show.
  - It replays the last painted frame into cells: the character, foreground, background and dim flag of each one. Trailing blanks with no background are dropped.
  - It compares the highlighted path, cell for cell, with what the renderer's `ColorDiff` returns for the same inputs, replayed the same way.
  - It compares the fallback's colours with the diff keys of `getTheme(name)`. For the whole suite, chalk is forced to truecolor (level 3) and `COLORTERM` is `truecolor`.
  - `CLAUDIN_NO_FLICKER` is `0` (fullscreen off) unless a test sets `1`, and `CLAUDIN_SYNTAX_HIGHLIGHT` is unset unless a test sets it. `CLAUDIN_CONFIG_DIR` and the project directory point at a fresh temp directory for each test.
  - It changes settings through the app state store (`useSetAppState`), the theme through the preview (`usePreviewTheme`), and props through a second `render` on the same root.
- **`scripts/migrations/probes/rewrite-vcs-structuredDiff.json`:** 40 probes over the four files. Every one of them turns the suites red on the old code.
- **Other tests.**
  - `src/native-ts/color-diff/index.test.ts` pins the renderer itself.
  - `src/platform/ThemePicker.test.tsx` mocks `StructuredDiff.js` and `colorDiff.js` (see Public contract).
  - No other test renders these components.

**Not pinned, and why:**
- **The selection fence in fullscreen** (section 10). The fake terminal cannot drive selection.
- **The cost of a remount** (section 11). It cannot be observed.
- **The renderer returning `null`.** It cannot happen today.
- **The old output that is wrong** (Findings):
  - the fallback's numbers where they disagree with section 3;
  - the `\ No newline` note, carriage returns and tabs;
  - the early break at a segment boundary;
  - styling and links carried by the code.
- **Style only.** The dimmed gutter of context rows, the dim `...`, and any colour on the highlighted path beyond its equality with the renderer.

## Out of scope

- **The helper exports of `Fallback.tsx`:** `transformLinesToObjects`, `processAdjacentLines`, `calculateWordDiffs`, `numberDiffLines` and the `LineObject` type. Nothing imports them, and `knip-baseline.json` lists all five as unused exports. The rewrite drops them, together with their `knip-baseline.json` entries.
- Everything else is kept.

## Findings

Each one is described, not fixed. The decision column says what the rewrite
does. None of the fixes can break a caller, stored data, a setting or a
workflow: they change only how a diff looks on screen.

| Finding | Decision |
|---|---|
| **The code can style or link itself (security).** SGR sequences and OSC 8 hyperlinks in a hunk line are honoured on both paths. So file content can hide part of a line, paint it in the background colour, fake the colours of other rows, or show harmless text that links anywhere, in the diffs of permission dialogs and tool results. The terminal renderer drops every other sequence, and a test pins that. | Fix, as pure hardening: strip escape sequences and C0 control characters (the tab aside) from the code before drawing, on both paths. Source code never holds raw escape bytes, so legitimate diffs do not change. `HighlightedCode` (through `ColorFile`) and `/diff`'s pane (through `ColorDiff`) hand file text to the same renderer and are likely exposed too; they are other units and were not checked here. Record it in the team bug memory. |
| **The fallback numbers lines differently from the highlighted path.** It happens when a hunk starts at different lines on the two sides, or when a removal follows an unbalanced change in the same hunk. The fallback counts from `oldStart`: a hunk with `oldStart` 10 and `newStart` 12 reads 10, 11, 12, 11, 12, 13, 14, where the highlighted path reads 12, 11, 12, 13, 14, 15, 16. Turning highlighting off changes the numbers the user sees. | Fix: number like the highlighted path, with removed lines by the old file and the rest by the new file. Pin it at an offset hunk in the new module's tests. |
| **`\ No newline at end of file` is drawn as a numbered context line** on both paths, and every line after it is numbered one too high: `+three` shows as line 3 instead of 2. | Fix: the note takes no number and does not advance the numbering. Draw it as a dim row without a number, under the line it qualifies. On the highlighted path, keep it out of what the renderer gets and add the note row beside the renderer's rows. |
| **A carriage return at the end of a line** (a CRLF file) adds an empty continuation row after every line in the fallback. The highlighted path shows nothing for it. | Fix: drop a trailing carriage return before drawing. |
| **A tab inside a line** counts as no column on both paths while the row is laid out. The terminal renderer then widens it to its 8-column stops, so the row runs past the width, by 13 columns in a 30-column trial. In the fallback's word-by-word rows, the marker also drops to a row of its own. The permission dialogs go through `getPatchForDisplay`, which turns leading tabs into two spaces each. Hunks built by `getPatchFromContents` (ApplyPatch, staged writes, Rename, part of the Edit tool) keep raw tabs. | Fix: expand every tab to spaces before measuring, the same way on both paths, counted from the start of the code rather than from the terminal's left edge. |
| **Rows drawn whole wrap one column short** of the width minus the gutter, while rows drawn word by word use the full width minus the gutter. | Fix: one content width for every row, the width minus the gutter. The suite pins only bounds that both satisfy. |
| **Word-by-word rows can break early** where a changed token meets an unchanged one, and leave room on the row unused. | Fix: wrap word-by-word rows like whole rows, at spaces and as full as they go, with each token keeping its colour. |
| **The list returns siblings,** so each caller has to stack them in a column box. `RenameTool/UI.tsx` found out by drawing two hunks side by side. | Fix: the list stacks its own hunks. Callers already in a column box see no change. |
| **The list keys hunks by `newStart`,** so two hunks with the same start would share a React key. One file's patch never has two. | Fix: keys unique within the list. |
| **The fullscreen guard is invisible.** When the gutter is as wide as the diff, the old module does not fence it. Without the guard, the code column is zero columns wide and paints the same picture, so the probe that removed the guard turned nothing red. The guard only decides whether the fence covers the whole row at that one width. | Keep the rule in section 10. It is not pinned, and its probe was replaced. |
| **`fileContent` has no effect** on the picture, because the renderer ignores it. | Keep for parity: accept it and hand it on. Every caller passes it, and a later renderer may use it. |
| **`skipHighlighting` has no caller.** The theme picker only declares it in a local props type. | Keep for parity: it is part of the props, and the suite pins it. |

## Target design

- **Keep the four module paths.** The callers, the module mocks in `ThemePicker.test.tsx` and the probe spec name them.
- **Hand-written components,** with no React-Compiler output and no cache slots. `StructuredDiff` stays memoized on its props.
- **`colorDiff.ts`** stays a thin switch: one function that says whether highlighting is available and, if not, why; the four accessors built on it; explicit return types.
- **`StructuredDiff`:**
  - a pure decision for the path. The `skipHighlighting` prop, the setting and the switch go in; "highlighted" or "fallback" comes out;
  - a sanitizer that every hunk goes through before either path. It strips control sequences, drops a trailing carriage return, and expands tabs (Findings);
  - the highlighted path hands the sanitized hunk to the renderer and paints its rows as they are. That is one raw-ANSI leaf (`RawAnsi` in `src/terminal/ink.js`), or in fullscreen two: a gutter column fenced with `NoSelect`, and the code column (section 10);
  - a memo of the renderer's rows per hunk object, keyed by everything that changes them: theme, effective width, dim, file path, first line and fence. It is weakly held and bounded in size (section 11).
- **The fallback** splits into a pure model and a thin view (`.claudin/rules/code-design.md`, S and I):
  - the model turns a hunk and a width into rows. Each row carries its number (or none), its marker, and its code as segments tagged unchanged, added word or removed word. The model does the numbering (Findings), the pairing, the 40% rule with `diffWordsWithSpace`, and the wrapping: at spaces, by display width, with one content width;
  - the view draws each row as a row box: the gutter fenced with `NoSelect`, then the code as one `<Text>` with nested spans for the word colours. The rows arrive already wrapped, so the two siblings never wrap on their own (`.claudin/rules/ink-tui.md` §10). The fill to the full width stays.
- **The list** is a column box of the hunks, with unique keys and the `...` separators between them.
- **Types.** Explicit throughout, with no `any`. Regexes live at module level.
- **Tests.**
  - The characterization suites, unchanged.
  - Unit tests for the fallback model: numbering at an offset hunk, the note, carriage returns, tabs, one content width, and full word-by-word rows.
  - A test that a hunk line holding SGR and OSC 8 sequences paints as plain text, on both paths.
