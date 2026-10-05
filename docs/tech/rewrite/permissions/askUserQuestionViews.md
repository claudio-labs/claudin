# Spec: `permissions/askUserQuestionViews`

## Purpose

These are the screens the AskUserQuestion dialog draws for one question while
the model waits for the user's answer. The dialog itself (`AskUserQuestionPermissionRequest`,
unit `permissions/askUserQuestion`) owns the answers, moves between questions
and sends the result back. These views only show the current question and
report what the user did through callbacks.

- **`QuestionView`** is the list: the options with their descriptions, then a free-text "Other" row, then a footer.
- **`PreviewQuestionView`** is the side-by-side screen used when a single-choice question has previews. The options are on the left, the focused option's preview on the right, and a notes line sits under the preview.
- **`PreviewBox`** is the bordered box the preview is drawn in.

The labels, descriptions and previews come from the model. Nothing these views
do grants a permission. The weight is in reporting exactly the answer the user
chose, and in not letting model text drive the terminal.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `QuestionView` | component; props below | `AskUserQuestionPermissionRequest.tsx` |
| `PreviewQuestionView` | component; the same props, minus `planFilePath`, `pastedContents`, `onSubmit`, `onImagePaste`, `onRemoveImage` | `QuestionView.tsx` |
| `PreviewBox` | component; `{ content: string; maxLines?: number; minHeight?: number; minWidth?: number; maxWidth?: number }` | `PreviewQuestionView.tsx` |

The prop types are not exported. `Question` and `QuestionOption` come from
`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`, and `QuestionState`
(`{ selectedValue?: string | string[]; textInputValue: string }`) from
`use-multiple-choice-state.ts`. The `QuestionView` props:

| Prop | Meaning |
|---|---|
| `question`, `questions`, `currentQuestionIndex` | the question shown, all of them, and its index |
| `answers: Record<string, string>` | answered questions, keyed by question text (drives the tab bar's boxes) |
| `questionStates: Record<string, QuestionState>` | what the parent recorded per question text |
| `hideSubmitTab?` (default false), `planFilePath?`, `minContentHeight?`, `minContentWidth?` | layout inputs |
| `pastedContents?`, `onImagePaste?`, `onRemoveImage?` | images pasted into the Other row, forwarded to the list widget |
| `onUpdateQuestionState(questionText, updates, isMultiSelect)` | record part of a question's state |
| `onAnswer(questionText, label \| labels, textInput?, shouldAdvance?)` | report an answer. **How many arguments are passed matters**: the parent treats a missing `shouldAdvance` as `true` |
| `onTextInputFocus(isInInput)` | a text field took or lost the focus |
| `onCancel()`, `onSubmit()`, `onTabPrev?()`, `onTabNext?()` | cancel the dialog, finish a multiple-choice question, switch questions |
| `onRespondToClaude()`, `onFinishPlanInterview()` | the footer's two lines |

Collaborators the rewrite keeps using, rather than restating them: the
`Select` and `SelectMulti` list widgets (`src/terminal/custom-select`),
`QuestionNavigationBar` and `PermissionRequestTitle`, `Divider`, `TextInput`,
`applyMarkdown` and `getCliHighlightPromise`, `getExternalEditor` with
`toIDEDisplayName`, and `editPromptInEditor`.

## Observable behaviour

`Q` below is the question text. "The parent hears" means the callbacks fire, in
the order given.

### 1. Which screen (`QuestionView`)

- **Side by side** when the question is single-choice and at least one option has a non-empty `preview`. Every prop is passed on.
- **The list** otherwise. A multiple-choice question ignores its previews, and an empty preview counts as none.

### 2. The list (`QuestionView`)

**Screen**, top to bottom:
- in plan mode with a `planFilePath`, a planning line (see Finding 1), then a divider;
- the tab bar (`QuestionNavigationBar`) and the question as the title;
- the options as `N. <label>`, each description on the next line, indented five columns;
- the Other row: an input whose placeholder is `Type something.` for single choice and `Type something` for multiple choice. Recorded Other text fills it;
- for multiple choice, `[ ]` / `[✔]` boxes and a button under the options: `Next`, or `Submit` on the last question;
- a divider, then `<n+1>. Chat about this`, and in plan mode `<n+2>. Skip interview and plan immediately`, where `n` counts the options plus the Other row;
- the hint: `Enter to select · ↑/↓ to navigate · Esc to cancel` for one question, with `Tab/Arrow keys to navigate` in place of `↑/↓ to navigate` when there are several. While the Other row has the focus it gains `· <key> to edit in <editor display name>` before `· Esc to cancel` (Finding 3).

A recorded `selectedValue` is ticked (`List ✔`). A recorded `__other__` choice
ticks the Other row and shows its text.

**Single choice, answers** (`INPUT` text is what was typed into Other):

| Keys | The parent hears |
|---|---|
| Enter on an option, or its digit | `onUpdateQuestionState(Q, { selectedValue: label }, false)`, then `onAnswer(Q, label, undefined)` (three arguments) |
| ↑/↓, ctrl+p/ctrl+n | nothing (focus moves) |
| typing in Other | `onUpdateQuestionState(Q, { textInputValue: <whole text> }, false)` on each key |
| Enter on Other with text | `onUpdateQuestionState(Q, { selectedValue: '__other__' }, false)`, `onAnswer(Q, '__other__', INPUT)` |
| Enter on an empty Other | `onCancel()` (Finding 6) |
| Esc | `onCancel()` |

`onTextInputFocus(true)` fires when the Other row takes the focus, and
`onTextInputFocus(false)` when another row does, the first one included.

**Multiple choice, answers**:

| Keys | The parent hears |
|---|---|
| Enter or a digit on an option | `onUpdateQuestionState(Q, { selectedValue: [...values] }, true)`, `onAnswer(Q, labels, undefined, false)` (four arguments) |
| Enter on the button | `onSubmit()` |
| Esc | `onCancel()` |

`values` is the new set of selected values in toggle order, starting from the
recorded one. `labels` is the same set without `__other__`, plus the Other text
recorded so far when Other is selected. When the selection changes after
typing, the full text is in the answer (Finding 5 is about the reports while typing).

**The footer.** Down past the last row (the Other row, or the button for
multiple choice) moves the focus to `Chat about this`. The pointer `❯` marks
the footer line, and the list stops taking keys.

| Keys on the footer | Effect |
|---|---|
| Enter on chat | `onRespondToClaude()` |
| Enter on skip | `onFinishPlanInterview()` |
| ↓ / ctrl+n on chat | in plan mode moves to skip. Otherwise nothing |
| ↑ / ctrl+p | from skip, back to chat. From chat, back to the list's last row |
| Esc | `onCancel()` |
| digits | nothing |

**External editor.** On the Other row, the chat external-editor binding
(ctrl+x ctrl+e by default) opens `$VISUAL`/`$EDITOR` on the current text. When
the editor returns different text, the row shows it and the parent hears
`onUpdateQuestionState(Q, { textInputValue: <text> }, <multiple choice?>)`. When
the text is unchanged, nothing is recorded.

### 3. The side-by-side view (`PreviewQuestionView`)

**Screen**:
- a blank line, a divider, the tab bar and the title;
- a 30-column list of `❯ N. <label>`, 4 columns of gap, then the preview box. The focused label is bold in the suggestion colour, and a chosen label is in the success colour followed by ` ✔`;
- the box holds the focused option's `preview`, or `No preview available`. Its `maxWidth` is the terminal width minus 34, its `minWidth` is `minContentWidth` (40 when unset), and its `maxLines` is `max(1, minContentHeight − 11)` (20 when unset);
- `Notes: ` in the suggestion colour, then the recorded notes or `press n to add notes`, dim and italic. While the notes are being typed, a text field with the placeholder `Add notes on this design…`;
- a divider, then `Chat about this` and, in plan mode, `Skip interview and plan immediately`, both unnumbered;
- the hint: `Enter to select · ↑/↓ to navigate · n to add notes`, then ` · Tab to switch questions` when there are several questions, ` · <key> to edit in <editor>` while the notes are open (Finding 3), and ` · Esc to cancel`.

**Keys on the options:**

| Keys | Effect |
|---|---|
| ↓ / ctrl+n | next option. On the last one, to the footer's chat line |
| ↑ / ctrl+p | previous option. Stays on the first |
| `1`–`9` | focus that option, **without answering**. Past the last option, nothing |
| Enter | `onUpdateQuestionState(Q, { selectedValue: label }, false)`, `onAnswer(Q, label)` (two arguments) |
| `n` | opens the notes: `onTextInputFocus(true)` |
| Esc | `onCancel()` |
| Tab, →, Shift+Tab, ← | `onTabNext()` / `onTabPrev()` when given. Without them, nothing |
| other letters, `0` | nothing |

**Notes.** Each key typed records `onUpdateQuestionState(Q, { textInputValue: <whole text> }, false)`.
Esc or Enter leaves the notes: `onTextInputFocus(false)`, then
`onAnswer(Q, <recorded choice>)` when a choice is recorded, and nothing more
when none is. While the notes are open, digits and letters are text, and the
arrows and Tab neither move the focus, answer, nor switch questions. The
external-editor binding works only while the notes are open, with the same
recording rule as the list.

**The footer** works as the list's footer, without numbers. Tab does nothing
there, and neither do digits or `n`. Up returns to the options, where the
focus is unchanged.

**Switching questions.** When the parent shows another question in the same
view, the focus moves to that question's recorded choice, or to the first
option when there is none, or when the recorded label is no longer an option.

### 4. The box (`PreviewBox`)

- **Content** is rendered as markdown: headings lose their `#`, emphasis its markers, and fenced blocks their fences. A run of blank lines collapses to one blank row, and a link shows its text as a terminal hyperlink to its URL.
- **Code** in a known language is coloured, unless the setting `syntaxHighlightingDisabled` is on. Until the highlighter has loaded, the box draws without colour.
- **Width.** It is `min(max(minWidth, widest line) + 4, maxWidth)`, where `minWidth` defaults to 40 and `maxWidth` to the terminal width minus 4. A row is `│ ` + text + padding + ` │`. A line wider than the inner width (the box minus 4) is cut there, wide characters whole.
- **Height.** At most `maxLines` rows of content (default 20). When there are more, a bar `├─── ✂ ─── <hidden> lines hidden ───…┤` follows in the warning colour. `minHeight`, capped at `maxLines`, pads with blank rows. A cut box is never padded, since its content already fills `maxLines` rows.
- **Style.** The frame is dim. The content keeps its own colours.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Enter on an empty Other row (single choice) | `onCancel()` | yes (Finding 6) |
| A digit past the last option | nothing, in both views | yes |
| Notes reopened over existing text | the text is kept, and typing adds to it | yes; where the cursor lands, no (Finding 4) |
| A recorded choice that is no longer an option | the focus goes to the first option | yes |
| No tab callbacks | Tab and the arrows do nothing | yes |
| A terminal narrower than 36 columns, side by side | rendering throws | no (Finding 2) |
| A box narrower than its cut bar | the bar overflows the frame | no (Finding 7) |
| 60 columns, side by side | the box shrinks to 26 columns. The notes line loses its gap | box yes, notes no (Finding 8) |
| Plan mode with a plan file | the planning line is drawn over | no (Finding 1) |

## Security requirements

- **Only an explicit choice answers.** Arrows, digits in the side-by-side view, letters, Tab and Esc never call `onAnswer`. Esc on the options or the footer only cancels. Leaving the notes with no recorded choice answers nothing.
- **The answer carries what was chosen.** Single choice reports the label, or `__other__` with the typed text. Multiple choice never reports the `__other__` marker as a label.
- **Footer lines act only where they are shown.** The skip line exists only in plan mode, and Enter on the chat line never ends the interview.
- **Model text cannot drive the terminal.** Control sequences in labels and in preview text are dropped: clear screen, cursor moves, the alternate screen, the window title and the bell. Colour codes in a preview pass through. See Finding 9 for hyperlinks.

## Tests that pin it

- **`src/permissions/ui/AskUserQuestionPermissionRequest/QuestionView.characterization.test.tsx`**, 43 tests:
  - the screen at 100 and 60 columns;
  - multiple choice (Next and Submit), plan-mode numbering, and the hidden submit tab;
  - four routing cases;
  - eight single-choice answers, the focus reports, and recorded choices;
  - eight multiple-choice cases, with the Other text;
  - twelve footer walks;
  - the editor hint, the editor in both kinds of question and an unchanged edit;
  - the hand-over to the side-by-side keys.
- **`.../PreviewQuestionView.characterization.test.tsx`**, 50 tests:
  - the screen at 60, 80 and 120 columns;
  - two questions in plan mode;
  - box width and height from the layout props;
  - twelve moves, focus on switching questions, and the answers;
  - Esc and the four tab keys;
  - the notes (nine cases: the editor opens only from them, and an unchanged edit records nothing);
  - the footer (eleven cases) and the colours;
  - the export mounted on its own.
- **`.../PreviewBox.characterization.test.tsx`**:
  - 30 tests under the plain runner: 17 geometry cases, five markdown cases, styling, the settings switch, five control sequences, and one test that runs the file again in a child with `FORCE_COLOR=3`;
  - in that child, two highlighting cases run, because the highlighter only colours where it detects a colour terminal.
- **The rig**: `src/permissions/ui/__testutils__/askUserQuestionViewsRig.tsx`. A stand-in parent merges recorded state the way the dialog does and logs every callback in order, with its argument count. It mounts through `promptFrameRig` (fake terminal, an isolated config home) and renders static frames through `renderToString`. The editor is a script from `modeDialogsRig`'s `fakeEditor`.
- **Coverage** (lines): `QuestionView.tsx` 98.7%, `PreviewQuestionView.tsx` 100%, `PreviewBox.tsx` 98.4%. The uncovered lines are compiler cache hits, plus one early return in a key handler that is only subscribed while the footer has the focus. 125 tests (two run only in the coloured child); three runs in a row passed.
- **`scripts/migrations/probes/rewrite-permissions-askUserQuestionViews.json`**: 40 probes (14 / 14 / 12). Every accept path is also mutated to fail open:
  - Enter on chat ends the interview;
  - the skip line appears outside plan mode;
  - Esc answers in chat;
  - the list stays live under the footer;
  - a digit answers;
  - leaving the notes answers with no choice;
  - a multiple-choice toggle advances;
  - Tab switches questions from the footer.

  A probe on whether the cut bar takes one of the `minHeight` rows was dropped: no input can observe it, because a cut box is never padded.

**Text pinned outside the unit:** none. The views send nothing to a model. The
answer text is built by the parent.

**Inherited tests to fold in:** none for this unit.

**Not pinned, and why:**
- the planning line (Finding 1), the narrow crash (2), the hint's key (3), where the notes cursor opens (4), the per-keystroke multiple-choice reports (5), the cut bar overflow (7), the 60-column notes line (8) and raw hyperlinks in previews (9). The old behaviour is wrong in each case.
- Image paste into the Other row. The views only forward `pastedContents`, `onImagePaste` and `onRemoveImage` to the list widget, and the paste path belongs to that widget and the dialog.
- The editor hint and the external editor when no editor can be found: `getExternalEditor` falls back to whatever is installed, so a test cannot reliably make it return nothing.

## Out of scope

- Answer building, question switching, submission and the tab bar (`permissions/askUserQuestion`).
- The list widgets' own keys and drawing (`src/terminal/custom-select`), beyond what these views pass them.
- Markdown rendering and the highlighter themselves.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **The planning line is never visible.** In plan mode with a `planFilePath`, the list draws `Planning: <path>` and then draws the next divider one row up, over it. The screen shows two dividers. | **Fix**: show the line, or drop it. Not pinned. |
| 2 | **Narrow terminals crash the side-by-side view.** Below 36 columns the preview box gets a negative width and rendering throws a `RangeError`. At exactly 36 it draws an empty `┌┐`. `PreviewBox` alone throws once its width falls under 2. | **Fix**: clamp the width, and below a usable width stack the preview under the list or drop it. Not pinned. |
| 3 | **The editor hint names the wrong key.** Both views say `ctrl+g to edit in <editor>`, but the key that opens the editor is the external-editor binding (ctrl+x ctrl+e by default). ctrl+g opens the diff reviewer. | **Fix**: take the key from the binding. Only `… to edit in <editor>` is pinned. |
| 4 | **Reopened notes put the cursor at the start**, so typing more inserts in front of the old text. | **Fix**: open at the end. Not pinned beyond "kept and added to". |
| 5 | **Multiple choice reports Other text one keystroke late.** Typing auto-selects Other, and each report is built from the text recorded before that key: typing `xy` reports `x`, and the first key reports no text. The parent joins these labels into the answer it submits, so unless the selection changes after typing, the submitted answer misses the last character. | **Fix**: report from the text being recorded. Pinned only where both agree, a selection change after typing. |
| 6 | **Enter on an empty Other row cancels the whole dialog** (single choice). This is the list widget's input row, which exits on an empty submit. | **Keep for parity** (pinned). **Track**: an empty Other should do nothing. |
| 7 | **The cut bar overflows a narrow box**: its label is never shortened, so a box under about 27 columns has a bar wider than its frame. | **Fix** (cosmetic). Not pinned. |
| 8 | **The side-by-side layout squeezes at about 60 columns**: `Notes:` loses its gap (`Notes:press n…`), a blank row appears, and the list shifts one column. | **Fix** (cosmetic). The box is pinned by its own edges at 60. |
| 9 | **Security: model text and terminal control.** Control sequences in labels and previews are dropped, while colour passes (both pinned). A markdown link in a preview becomes a terminal hyperlink whose visible text can differ from its target. A **raw** hyperlink escape sequence in the preview text also reaches the terminal. | Markdown links: **keep for parity** (pinned), **track**. Raw hyperlink sequences: **fix** (hardening: strip escapes other than colour from model text before rendering; legitimate previews never carry them). Not pinned. |
| 10 | **Digits mean different things in the two views**: the list answers on a digit, the side-by-side view only moves the focus. | **Keep for parity** (pinned). A user who has learned one view is surprised by the other, so **track** it. |
| 11 | **The side-by-side view does not focus the recorded choice on its first paint**, only after switching questions. The tick shows the choice. | **Keep for parity** (pinned: the focus starts on the first option). |

## Target design

- **Hand-written components** in this repo's Ink style, without compiler cache slots, keeping the three export names and the props above, the argument counts included.
- **One footer piece shared by the two views**: chat and skip, plan-mode gating, up, down and Enter, and an optional number prefix. That removes the duplicated key handler.
- **A pure layout function for the box**: `(content lines, limits, terminal width) → { width, rows, hidden }`, clamped so it never goes below a minimum (Finding 2). Unit-test it on the geometry table without Ink. The bar label is shortened to fit (Finding 7).
- **One sanitiser for model text** before markdown, which keeps only colour codes (Finding 9).
- **Hint text built from the key bindings** (Finding 3), and the multiple-choice report built from the text being recorded (Finding 5).
- **Tests**: these characterization suites unchanged, plus unit tests for the layout function and the sanitiser.
