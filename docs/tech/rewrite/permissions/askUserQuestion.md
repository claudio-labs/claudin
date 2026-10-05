# Spec: `permissions/askUserQuestion`

## Purpose

The dialog the user answers when the model calls `AskUserQuestion`. The
request reaches it through `PermissionRequest`, which routes
`AskUserQuestionTool` here, with no `PermissionDialog` frame. The model sends
one to four questions, each with two to four options, a short header, and a
single- or multi-choice flag. The user picks options, types a free answer
under "Other", adds notes to options that carry a preview, can paste images,
and then submits. Instead of answering, the user can also send the model a
message ("Chat about this") or, in plan mode, tell it to stop the interview.

The answers go back to the model as the tool input of an allow, which the
tool turns into its result. Everything else is a reject. The unit owns the
dialog's state and answer object (`AskUserQuestionPermissionRequest`,
`useMultipleChoiceState`), the tab row (`QuestionNavigationBar`) and the
review step (`SubmitQuestionsView`). The question views it draws
(`QuestionView`, `PreviewQuestionView`, `PreviewBox`) are the
`permissions/askUserQuestionViews` unit. The behaviour below is pinned
through both, because only the two together can be driven by keys.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `AskUserQuestionPermissionRequest` | component, props `PermissionRequestProps` | `src/permissions/ui/PermissionRequest.tsx` (routing), `PermissionRequest.test.ts` |
| `SubmitQuestionsView` | component, props `{ questions: Question[]; currentQuestionIndex: number; answers: Record<string, string>; allQuestionsAnswered: boolean; permissionResult: PermissionDecision; minContentHeight?: number; onFinalResponse: (value: 'submit' \| 'cancel') => void }` | `AskUserQuestionPermissionRequest` |
| `QuestionNavigationBar` | component, props `{ questions: Question[]; currentQuestionIndex: number; answers: Record<string, string>; hideSubmitTab?: boolean }` | `QuestionView`, `PreviewQuestionView`, `SubmitQuestionsView` |
| `useMultipleChoiceState` | `() => MultipleChoiceState` | `AskUserQuestionPermissionRequest` |
| `MultipleChoiceState` | `{ currentQuestionIndex: number; answers: Record<string, AnswerValue>; questionStates: Record<string, QuestionState>; isInTextInput: boolean; nextQuestion(): void; prevQuestion(): void; updateQuestionState(questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean): void; setAnswer(questionText: string, answer: string, shouldAdvance?: boolean): void; setTextInputMode(isInInput: boolean): void }` | as above |
| `QuestionState` | `{ selectedValue?: string \| string[]; textInputValue: string }` | `QuestionView`, `PreviewQuestionView` |
| `AnswerValue` | `string` | as above |

`Question` and `QuestionOption` are `AskUserQuestionTool`'s types.
`src/__tests__/lazyToolImports.test.ts` lists this file among the modules
that import `AskUserQuestionTool` statically. A rewrite that drops that
import has to update the list.

## Observable behaviour

### 1. What the model gets back

**An answer** is reported to the caller first (`onDone()`), then to the
request: `onAllow(updatedInput, [], undefined, imageBlocks)`.
- `updatedInput` is the request's input with every field kept (`questions`,
  `metadata`, anything else), plus:
  - `answers`: an object from question text to answer string. It replaces
    any `answers` the model sent, as a whole. Only questions the user
    answered are in it.
  - `annotations`, present only when at least one question has one: from
    question text to `{ preview?, notes? }`. `preview` is the preview text of
    the chosen option, when it has one. `notes` is the question's note,
    trimmed, when it is not blank. A question with neither is left out.
- The permission updates are always `[]`: answering never writes a rule.
- The third argument is always `undefined`.
- The fourth is the pasted images as image blocks
  (`{ type: 'image', source: { type: 'base64', media_type, data } }`), or
  `undefined` when there are none.

**The answer string** of a question:

| How it was answered | Answer |
|---|---|
| a single-choice option | its label |
| Other, with text | the text exactly as typed, untrimmed |
| Other, with text and an image pasted on this question | `<text> (Image attached)` |
| Other, with only an image | `(Image attached)` |
| multi-choice | the checked labels joined by `, `, in the order they were checked, then the Other text when Other is checked |

**A way out** (below) is reported as `onDone()`, the caller's `onReject()`,
then the request's `onReject()` with no arguments.

**A message instead of answers** is reported as `onDone()`, then the
request's `onReject(message, imageBlocks)`, where `imageBlocks` is as above
and `undefined` without images. The message must:
- for "Chat about this": tell the model the user wants to clarify the
  questions and may have more context, that it should take the response into
  account and reformulate the questions if appropriate, and that it should
  start by asking what the user wants to clarify;
- for "Skip interview and plan immediately": tell the model the user has
  given enough answers for the plan interview, to stop asking clarifying
  questions and to finish the plan with what it has;
- in both, end with every question, in order, as `- "<question>"` followed on
  the next line by `  Answer: <answer>`, or `  (No answer provided)` when it
  has none.

### 2. The flow

- **One single-choice question** answers at once: choosing an option, or
  Enter on a filled Other, is the allow. There is no Submit tab and no review.
- **Otherwise** each single-choice answer moves to the next question, and the
  one after the last question is the review (section 4). A multi-choice
  question does not move on when an option is checked; its button (`Next`,
  or `Submit` on the last question) moves on.
- **Moving between questions:** Tab and Right go to the next question, then
  to the review, and no further. Shift+Tab and Left go back, and stop at the
  first question. With one single-choice question they do nothing. They do
  nothing while the pointer is on Other (the field takes the keys).
  Nothing is reported by moving.
- Going back to an answered question and answering again replaces the
  answer; the earlier choice is shown ticked.
- **Images** pasted into an Other field belong to that question. Every image
  pasted in the request and not removed goes along with the answer or the
  message, in the order pasted, even when its question was then answered with
  an option.

### 3. The ways out

| Where | Key | Result |
|---|---|---|
| any question, the pointer on an option | Esc | way out |
| Other, typing | Esc | way out |
| the chat line | Esc | way out |
| anywhere | Ctrl+C | way out (through `PermissionRequest`) |
| Other, empty or blank | Enter | way out (Finding 5) |
| the review | `2`, Down then Enter, Esc | way out |

Answers already given are not sent on a way out.

### 4. The review (`SubmitQuestionsView`)

Top to bottom: a divider, the tab row with the Submit tab highlighted,
`Review your answers`, then:
- when `allQuestionsAnswered` is false: `⚠ You have not answered all
  questions`. The flag is the caller's; the view does not check the answers.
- for each question, in question order, that has a non-empty answer:
  ` ● <question>` and under it `   → <answer>`. Answers for questions not in
  `questions` are ignored. With none, there is no list.
- the explanation of the permission decision (`PermissionRuleExplanation`
  with tool type `tool`);
- `Ready to submit your answers?` and the choices `1. Submit answers`,
  `2. Cancel`.

`minContentHeight` pads the part below the title to at least that many
lines. Enter or `1` on Submit reports `'submit'`; `2`, Cancel, or Esc report
`'cancel'`; nothing else reports. The dialog turns `'submit'` into the allow
of every answer so far (skipped questions are left out) and `'cancel'` into a
way out.

### 5. The tab row (`QuestionNavigationBar`)

One line: `←`, one tab per question, a `✔ Submit` tab, `→`.
- A tab is ` ☐ <header> `, or ` ☒ <header> ` when its question has a
  non-empty answer. An empty header shows as `Q<position>`, counted from 1.
- The current tab (or Submit, at the review position) is drawn in
  `inverseText` on the `permission` background.
- `←` is in `inactive` on the first question; `→` is in `inactive` on the
  review.
- `hideSubmitTab` drops the Submit tab. With one question and no Submit tab
  the arrows go too. The dialog drops the Submit tab exactly when the request
  is one single-choice question.
- **Narrow terminals.** The arrows and the Submit tab are kept. When the
  headers do not fit in what is left, the current tab gets its full width but
  at most half of what is left, and every other tab shares the rest, at least
  6 columns each. A header longer than its tab, less 4 columns, is cut with
  `…`. When there is no room at all, the current header shows its first three
  characters. Examples at 60 and 40 columns are in the suite.

### 6. Height and width

So that the dialog does not jump between questions, every question of a
request is drawn at the same height: the height the tallest question needs,
at least 12 lines, and at most the terminal's rows less 15 (but never below
12). A plain question needs its option count plus 10 lines. A preview
question needs the taller of its option list and its preview box, plus 7.
A preview's lines are capped by the same bound less 11. The preview box is
at least 40 columns of content wide, and as wide as the widest rendered
preview line of the request. Measured: two questions of 2 and 4 options draw
17 lines in a 60-row terminal and 15 in a 24-row one.

### 7. The state hook (`useMultipleChoiceState`)

- Starts at question 0, with no answers, no question states, and not in
  text input.
- `nextQuestion` adds one, with no upper bound. `prevQuestion` subtracts one,
  never below 0. Both leave text input mode.
- `setAnswer(q, a, shouldAdvance = true)` stores `a` for `q` (an empty
  string included), replacing any earlier answer. With `shouldAdvance` it
  also moves on and leaves text input mode; without, it changes nothing else.
- `updateQuestionState(q, updates, isMultiSelect)` merges: each field given
  replaces the old value, a missing one keeps it. A question seen for the
  first time starts with no selection (an empty list for a multi-choice
  question) and empty text. It neither moves nor answers.
- `setTextInputMode(b)` sets the flag.
- The five functions keep their identity across renders.

## Edge cases and errors

| Case | What the user sees | Pinned |
|---|---|---|
| Input that does not parse (duplicate questions, say) | an empty review with no warning; Submit allows with `answers: {}` | yes (Finding 7) |
| Enter on an empty or blank Other | the whole request is cancelled | yes (Finding 5) |
| The digit of an empty Other | the pointer moves there; nothing is answered | yes |
| Digits typed into Other | text | yes |
| A preview question | a digit only moves the pointer; Enter answers | yes |
| A blank note | no `notes`, and no annotation when there is no preview either | yes |
| Unchecking every option of a multi-choice question | the tab and the review show it unanswered, but an empty answer is sent | the screen only (Finding 4) |
| Text typed into a multi-choice Other just before moving on | the answer lacks the last keystroke | no (Finding 3) |
| Other text, then another option chosen | the abandoned text is sent as the question's notes | no (Finding 2) |
| A terminal under ~40 columns | the tab row wraps tab by tab | no (Finding 11) |
| Keys pressed before the syntax highlighter has loaded | lost | no (Finding 9) |
| Plan mode | `Planning: <plan file>` should show above the tabs, but is drawn over | no (Finding 8) |
| Enter pressed twice on the chat line before the dialog closes | two rejects | no (the REPL unmounts the dialog on the first) |

## Security requirements

- **Only an explicit answer allows.** An allow is reported only for a choice
  on the one single-choice question, or Submit on the review. Esc, Ctrl+C,
  review Cancel, and Enter on an empty Other are plain rejects with no
  arguments. Chat about this and Skip interview are rejects with a message.
  None of them may report an allow.
- **Answering never writes a permission rule:** the updates are always `[]`.
- **The model must not be able to speak for the user.** The answers sent
  back replace the model's own `answers` as a whole (pinned). The same must
  hold for `annotations` (Finding 1: the old module lets the model's survive).
- **Answers stay with their question:** an answer, a note or an Other text
  is only reported under the question it was given for.

## Tests that pin it

- **`AskUserQuestionPermissionRequest.characterization.test.tsx`**: 75 tests
  through `PermissionRequest`. Layout, the single-question answers, Other
  (text, digits, padding, empty), the ways out, the input that goes back,
  several questions (moves, review, partial and empty submit, re-answering),
  multi-choice, Chat about this and the plan interview with the facts of both
  messages, previews and notes, pasted images, height and width, input that
  does not parse, and highlighting turned off.
- **`SubmitQuestionsView.characterization.test.tsx`**: 16 tests, mounted
  alone. Layout, the warning flag, order and filtering of the list, the rule
  explanation, the minimum height, and every key.
- **`QuestionNavigationBar.characterization.test.tsx`**: 17 tests, mounted
  alone. Eleven rows (ticks, hidden Submit, `Q<n>`, 60/50/40 columns), three
  for a terminal with no room, and the colours against reference `<Text>`s.
- **`use-multiple-choice-state.characterization.test.tsx`**: 16 tests of the
  hook in a host component.
- The rigs reused: `promptFrameRig.tsx` (mount, keys, isolated config home),
  `modeDialogsRig.tsx` (the request skeleton, the PNG and bracketed paste),
  `toolDialogRig.tsx` (`shown`). Rows are set with `TerminalSizeContext`.
- 124 tests. Three runs in a row passed. Coverage of a run limited to these
  suites: `AskUserQuestionPermissionRequest.tsx` 98.5%,
  `QuestionNavigationBar.tsx` 97.4%, `SubmitQuestionsView.tsx` 89.8%,
  `use-multiple-choice-state.ts` 100%. What is left is React Compiler
  cache hits and one unreachable branch (the dialog draws nothing when the
  position is past the review, which no key reaches).
- **`scripts/migrations/probes/rewrite-permissions-askUserQuestion.json`**:
  40 probes over the four files. Every way out and both messages are also
  mutated into an allow (fail open), and each turns the suites red. Two
  stayed green on the first run, both on tab moves: going past the review
  draws nothing, and the screen keeps its last frame, so the tests now check
  that Enter afterwards still answers.
- **Kept, this project's own:** `src/permissions/ui/PermissionRequest.test.ts`
  checks the routed tool's name.

**Text pinned outside the unit.** None. The model-facing messages are pinned
here by their facts only. The tool's result text, built from `answers` and
`annotations`, is `AskUserQuestionTool`'s and is outside this unit.

**Inherited tests to fold in:** none listed for this unit.

**Not pinned, and why:** Findings 1–4, 9 and 11 (the old behaviour is the
defect); the plan file line (Finding 8, drawn over); the external editor
(`ctrl+g`) and the clipboard paste key, which belong to the views and the
list widget; the exact sentences of the two messages (facts only).

## Out of scope

- The question views (`permissions/askUserQuestionViews`): option rows,
  the Other field, the preview box, the notes field, the footer lines and the
  hint line. They are pinned here only as far as the answers need them.
- The list widgets (`src/terminal/custom-select`), image paste and resizing
  (`src/terminal/image`), and the tool's own schema, validation and result
  text (`src/tools/AskUserQuestionTool`).
- Dropped on purpose: the `metadata.source` value is read and has no effect.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Security: the model can put notes in the user's mouth.** The answer keeps every input field, and `annotations` is only overwritten when the user added one. A request carrying `annotations: { "<q>": { notes: "…" } }` comes back, after a plain answer, with those notes, and the tool reports them as `user notes`. | **Fix** (hardening): `annotations` in the answer is built only from what the user gave, and absent otherwise. A legitimate model never sends it. Not pinned. |
| 2 | **Other text is reported as notes.** For a question without previews, whatever was typed into Other is sent as the question's `notes`: duplicated when Other is the answer, and sent even when the user then chose an option instead. | **Fix:** `notes` comes only from the notes field of preview questions. Not pinned (the suite checks `answers` and leaves `annotations` out on these paths). |
| 3 | **A multi-choice Other answer lags one keystroke** when typing is the last thing before moving on (`TS, Go, x` for `xy`). | **Fix.** Not pinned. |
| 4 | **Unchecking everything sends an empty answer** (`"<q>": ""`) while the screen calls the question unanswered. | **Fix:** leave the question out. The screen side is pinned. |
| 5 | **Enter on an empty Other cancels the whole request**, answers given so far included. It is the list widget's rule, reported through the dialog's cancel. | **Keep for parity** (pinned). It fails closed, and the widget is shared. |
| 6 | **Images outlive their question's answer.** An image pasted under Other is sent even when that question was answered with an option. | **Keep for parity** (pinned). The user pasted it. Track for a UX change. |
| 7 | **Input that does not parse gives an empty review whose Submit allows with no answers.** Unreachable: the tool input is validated before permission is asked. | **Keep for parity** (pinned). A rewrite may reject instead; no caller can tell. |
| 8 | **Outside the unit:** in plan mode the `Planning: <plan file>` line is drawn over by the divider below it, so the path the dialog passes is never seen. | Route to `permissions/askUserQuestionViews`. Not pinned. |
| 9 | **Keys pressed before the highlighter loads are lost.** The dialog first renders without highlighting and is replaced once it loads, losing its state. | **Fix:** keep the dialog's state above whatever waits for the highlighter. Not pinned (timing). |
| 10 | **The Chat about this message carries stray indentation** on its middle lines. | **Fix:** the facts are pinned, not the layout. |
| 11 | **The tab row wraps tab by tab under ~40 columns**, and in a terminal with no room the other tabs fall back to their full header. Same shape as promptFrame Finding 2 (`.claudin/rules/ink-tui.md` §10). | **Fix:** one `<Text>` for the row, other tabs cut too. The 40-column and wider rows are pinned. |
| 12 | **The caller hears first.** On an answer or a message, `onDone()` comes before the request's callback; on a way out, `onDone()`, the caller's `onReject()`, then the request's. | **Keep for parity** (pinned), as promptFrame Finding 5. |

## Target design

- **A pure answer model** in `ui/AskUserQuestionPermissionRequest/answerModel.ts`:
  `(questions, state) → updatedInput` and `(questions, answers, kind) →
  message`, unit-tested without Ink. It owns Findings 1, 2 and 4: annotations
  from the user only, notes from the notes field only, no empty answers.
- **The state hook as a reducer** with typed actions, exported for the tests,
  keeping the `MultipleChoiceState` shape callers use. Other text and
  selection live in one place, so the multi-choice answer is computed from
  the state after the keystroke (Finding 3).
- **Hand-written components** in this repo's Ink style, no compiler cache
  slots: a dialog that picks question view or review, the review, and the tab
  row as one `<Text>` (Finding 11).
- **Highlighting** loads below the state (Finding 9), and the height and
  width budget is a pure function of questions, rows and highlighter, tested
  on its own.
- **Tests:** the characterization suites unchanged, plus unit tests for the
  answer model and the height budget, a narrow render of the tab row, and a
  test that a request's `annotations` never reach the answer.
