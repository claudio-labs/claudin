---
name: /diff reviewer has a living design doc (feature 8.1)
description: The /diff diff reviewer is actively iterated; its canonical spec lives in docs/features/8.1-diff-reviewer.md and is kept in sync as features land
type: project
---

The `/diff` diff reviewer (feature "8.1") is an actively-developed Ink/TUI feature whose
canonical spec is **`docs/features/8.1-diff-reviewer.md`** — a detailed living design doc updated
in lockstep as each feature lands. It is the longest-running TUI thread in this repo and several
team memories orbit it (fileTree, ScrollBox clipping, gitdiff prefix parsing, worktree grouping).

**How to apply:** before changing diff-reviewer behavior, read the doc; after changing it, update
the doc to match. That convention has held across every round so far, and the doc is where the
*reasoning* for each decision lives — not the commit messages.

## 2026-09-12/13 — the side-panel round (issue #187)

Branch `feat/diff-fullscreen-takeover`, ~37 files in one commit. It sat uncommitted across
several sessions first while the user validated each round by hand
(see [[feedback-tui-feature-branch-uncommitted-rounds]]) — so the *reasoning* is in the spec
doc, not in the commit history, which squashes to a single subject.

What the round turned `/diff` into, in fullscreen:

- A **side panel beside a live chat** (50/50 above 120 columns, full takeover below), with the
  prompt spanning the full width under both columns. Three arrangements now live in a new
  `src/terminal/ModalSlot.tsx`; a command opts in with `fullscreenPanel` on `CommandBase`.
- **The prompt stays typable while the panel is open** — a first for this codebase. Exactly one
  side owns the keyboard, arbitrated through `src/terminal/contexts/sidePanelContext.tsx`;
  `ctrl+→`/`ctrl+←` step in and out, `ctrl+↑`/`ctrl+↓` move between the stacked sections.
- **Selecting diff lines sends them with the prompt** — `v` visual mode or a plain mouse drag
  inserts `@path#La-Lb` at the cursor, riding the existing @-mention path so nothing new reaches
  the message pipeline.
- Local Changes lost its left Files pane: file list stacked over the diff, each under a
  **top-border-only titled rule** rather than a box.

**Why it matters beyond /diff:** three of the mechanisms are general and the next feature that
wants them should reuse rather than rebuild — `ModalSlot`'s three arrangements,
`src/terminal/ink/selectionBands.ts` (mouse selection clamped to a screen region, which a split
layout *requires*), and `src/terminal/promptMention.ts` (insert-or-rewrite a mention in the
prompt). All three are documented in the spec doc with the traps that produced them.
