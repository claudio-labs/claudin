---
name: worktree-exit-dialog-data-loss
description: The worktree exit dialog force-removes a worktree the session only attached to (and deletes its branch), and silently discards commits when the session has no recorded start commit — live on main, queued as fixes for the sessionDialogs rewrite
type: project
paths:
  - src/permissions/ui/WorktreeExitDialog.tsx
---

**Symptom:** leaving a worktree session through `WorktreeExitDialog` can lose work:
- a pre-existing worktree the session only attached to is removed with
  `git worktree remove --force` and its branch deleted;
- when the session has no recorded start commit, its commits are discarded
  without a warning.

Also: the caller hears a false "No active worktree session found" before and
after the real outcome, and "keep" hangs if the original directory is gone.

**Where:** `src/permissions/ui/WorktreeExitDialog.tsx` (unit `permissions/sessionDialogs`).

**Repro:** confirmed on real repositories by the 2026-10-04 characterization
(`WorktreeExitDialog.characterization.test.tsx`, branch `rewrite`).

**Status (2026-10-04):** open on `main`; decided "fix" in
`docs/tech/rewrite/permissions/sessionDialogs.md`, so the old behaviour is NOT
pinned and the fixes land with the per-method rewrite of that unit.

**Why not fixed:** found during characterization; the rewrite owns the fix.
Until then, attach-only worktree sessions on `main` are unsafe to exit with
"remove".
