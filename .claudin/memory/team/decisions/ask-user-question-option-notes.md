---
name: ask-user-question-option-notes
description: Since 2026-11-01 (PR #335) AskUserQuestion takes a note on ANY option — `n` on the focused option in normal, multi-select and preview questions — sent in the existing annotations[q].notes; the option is deliberately NOT turned into a type:'input' row
type: project
scope: AskUserQuestion (permissions/ui + tools/AskUserQuestionTool)
impact: functional
paths:
  - "src/permissions/ui/AskUserQuestionPermissionRequest/**"
  - "src/tools/AskUserQuestionTool/**"
---

**Decision:** every AskUserQuestion option can carry its own note. `n` on the focused option opens a
`Note on "<label>":` line between the list and the footer (Enter/Esc save, ctrl+g editor); the note
shows as `⎿ <note>` under the option's description, in the Review (Submit) tab and in the transcript.
Preview questions switched too: their notes are per design now, no longer one per question.

**Why:** the user asked on 2026-11-01 to comment while picking options ("adicionar comentário em
qualquer opção"); before, only preview questions had notes. In plan mode they picked, all as
recommended: per option incl. preview, `⎿` under the description (from an ASCII-preview mockup of
their own screenshot), notes in Review + transcript, and the two Other bugs fixed in the same PR.

**What changes for a teammate:**
- `QuestionState.notes` is `Record<label, string>`; `textInputValue` is the Other text only, never a
  note. The wire format lives in `src/tools/AskUserQuestionTool/optionNotes.ts` — one
  `"<label>": <note>` line per commented option, in option order, whitespace collapsed.
- A note on an unpicked option is sent too, and a question with notes but no answer reaches the
  model as `"Q"=(no answer) user notes: …`.
- No schema change: `annotations[q].notes` already existed and is model-facing.
- `scripts/migrations/probes/askUserQuestionDialog.json` (37 probes) and the keystroke harness
  `__testutils__/askDialogHarness.tsx` pin the dialog; before this there were no dialog tests.
  The harness marks the shared highlighter promise fulfilled (the dialog's `use()` suspends once
  on an untracked promise, and a key sent to the Suspense fallback is lost) and waits 50 ms after
  the first frame (the Select reports its initial focus from a passive effect).

**Rejected:**
- A per-question "Notes:" line (the old preview shape) — the user wanted it per option.
- Bash's "Tab to amend" — Tab and ←/→ already switch questions in this dialog.
- Turning the option into a `type:'input'` row like "Yes, and tell Claude…" — in `SelectMulti` Esc
  inside an input cancels the whole dialog, and typing/clearing toggles the option's checkbox.
- A new `annotations.optionNotes` field — it grows the model-facing schema and diverges from upstream.

**Evidence:** session 2026-11-01 (plan `iterative-mixing-pudding`). Fixed alongside, own commits:
the Other text was sent twice (as answer and again as `user notes`), and a multi-select Other
answer lost its last keystroke ("foo" → "fo") because SelectMulti reports the selection in the
same tick as the keystroke, before `questionStates` re-renders.
