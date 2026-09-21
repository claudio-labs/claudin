---
name: Diff reviewer canonicalizes git worktrees to the main repo
description: /diff multi-repo grouping collapses git worktrees into their main checkout; known limitation, fix intentionally deferred 2026-06-18
type: project
---

The `/diff` reviewer's multi-repo grouping does NOT treat a git worktree as its own project. Both root-resolution paths — `resolveWorkspaceRoots` (cwd + `/add-dir`) and `findNestedGitRoots` (nested discovery) — pass each root through `findCanonicalGitRoot`/`resolveCanonicalRoot`, which maps a worktree (`.git` is a file → follows `gitdir:`→`commondir`) to the MAIN repo root. So a worktree as cwd/add-dir is diffed via `git -C <mainRepo>` (shows the main checkout's changes, labeled with the main repo's basename), and multiple worktrees of the same repo dedupe into ONE group. Verified empirically 2026-06-18 (temp repo + `git worktree add`: `canonical(wt-feature) → .../main`).

The visual/UX features layered on top — colored repo square (`entityColorByIndex`), branch glyph, bold `N files changed` meta, and the Log-tab project selector — are entirely group-source-agnostic (they render from `RepoGroup[]`), so they apply to whatever groups exist regardless of origin.

**Why:** Canonicalization is intentional for project IDENTITY (shared config/memory/agent state across worktrees) and `resolveCanonicalRoot` carries security validation. The user reviewed the trade-off and chose to leave it as-is for now — independent nested repos (each its own `.git` directory, e.g. the aargau-*/business monorepo) are the real use case and work fully.

**How to apply:** Don't "fix" worktree grouping casually — it's a deliberate deferral, not a bug. If asked to make worktrees distinct groups, use the real worktree path for the diff `git -C` while keeping the canonical root only for identity; preserve `resolveCanonicalRoot`'s security checks.
