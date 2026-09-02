---
name: isolation:worktree break-and-restore agents leak edits into the shared main checkout
description: parallel worktree review agents that mutate source (break-and-restore) can write to the real src/ via bun-test path canonicalization; their in-worktree restore does NOT revert main — verify git diff HEAD on the main tree afterward
type: feedback
---

Agent tools launched with `isolation:"worktree"` that do break-and-restore (Edit a source file → run a test → revert) can LEAK their edits into the shared main checkout instead of staying isolated.

**Why:** the worktree is nested under the repo at `.claudin/worktrees/agent-<id>/`, and `bun test` (and some Bash) canonicalize that path back to the main checkout, so an Edit "in the worktree" actually writes to the real `src/`. The agent's `git checkout -- <file>` restore then runs against the WORKTREE and does not revert the main tree — leaving main with reverted/broken source plus leftover `__probe`/`__fuzz` scratch test files. Observed 2026-06-28: a 3-agent review round reverted a committed `cell(undefined)→ABSENT` fix back to `''` and dropped a `__probe_savings.test.ts` into `src/utils/`; the harness even mislabeled the change as an intentional user edit. Distinct from the "STALE base" gotcha (that's about reading an old base) — this is WRITES escaping the sandbox.

**How to apply:** (1) Prefer READ-ONLY review agents (Read/Grep only) on the main tree over break-and-restore worktree agents whenever possible. (2) After any break-and-restore worktree agent finishes, do NOT trust its "main untouched / status clean" self-report — run `git diff HEAD` on the MAIN checkout yourself, `git checkout -- <files>` to restore to the committed SHA, and delete any untracked `__*` scratch test files. (3) The committed SHA is the source of truth; restoring the working tree to it is safe and reversible.
