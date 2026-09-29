---
name: legacy-memory-migration-resurrects-team-files
description: migrateGlobalMemoryIfNeeded re-copies the whole legacy ~/.claudin/projects/<slug>/memory/ tree, team/ included, whenever the private dir has no top-level .md — moved or deleted team memories come back as untracked files at the team root
type: project
paths:
  - "src/memory/memdir/memoryMigration.ts"
  - "src/memory/memdir/paths.ts"
---

**Symptom:** 29 stale team memories reappeared as untracked files at the root
of `.claudin/memory/team/`, all with one mtime (2026-09-28 18:30:14): the
pre-category copies of files that now live under `decisions/`/`bugs/`/`docs/`
(`fork-subagent-by-default`, `checkbatchwrite-updatedinput-clobbers-input`,
`diff-reviewer-*`…), files renamed since (`repo-prs-go-to-gitea-via-tea` →
`repo-prs-github-via-gh`, `native-1m-context-window-branch`), files deleted on
purpose (`lsp-tool-rejected-empirically`, `windsurf-provider-branch-state`),
and gotchas that moved into `.claudin/rules/` (`ink-*`,
`bun-mock-module-cross-file-leak`, `feature-macro-breaks-bun-test-outside-if`).
In the same instant the private dir came back as the legacy June 26 snapshot.

**Where:** `migrateGlobalMemoryIfNeeded` in `src/memory/memdir/memoryMigration.ts`,
called on every auto-memory path resolution from `src/memory/memdir/paths.ts`.
Its "already migrated" test, `hasMemoryContent(newDir)`, looks only at
`MEMORY.md` and top-level `*.md` in the private dir — the git-tracked `team/`
subdirectory does not count. With the private files absent it runs
`cpSync(oldDir, newDir, {recursive: true, force: false})`: existing names are
kept, so exactly the legacy `team/*.md` whose names are *missing* from the live
team dir — i.e. the ones since moved, renamed or deleted — are written back.

**Repro:** keep a legacy `~/.claudin/projects/<slug>/memory/` that has a `team/`
(this machine still does: 64 team files from June 2026), leave only `team/` in
the project-local memory dir, start a session.

**Also bites:** a teammate who clones the repo while holding a legacy dir for
the same slug — a fresh clone has no private files, so their stale team files
land in the tracked team dir and show up in `git status`, ready to be committed.
`memoryMigration.test.ts` pins "copies the team/ subtree" as intended.

**Status:** open, 2026-09-28. The 29 root copies are untracked and all
superseded — delete them, don't commit them (none is linked from the index).
Why the private dir was empty is unknown: it was intact at 2026-09-27 22:08 and
empty before 09-28 18:30. The 14 private memories written after June were lost
with it and restored from session transcripts
([[feedback-memory-maintenance-restricted-tools]] has the recipe).

**Why not fixed:** found by a memory-maintenance pass, which cannot edit `src/`.
Likely fix: count an existing `team/` (or a marker file) as "already migrated",
and never copy the legacy `team/` into the git-tracked team dir. Design context:
[[memory-subsystem-design-doc]].
