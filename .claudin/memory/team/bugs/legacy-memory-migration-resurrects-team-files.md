---
name: legacy-memory-migration-resurrects-team-files
description: FIXED on feat/memory-hygiene (2026-10-31) — migrateLegacyMemoryIfNeeded re-copied the whole legacy ~/.claudin/projects/<slug>/memory/ tree, team/ included, whenever the private dir had no top-level .md; it now never copies team/ and leaves a .migrated marker so it runs once
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

**Where:** `migrateLegacyMemoryIfNeeded` in `src/memory/memdir/memoryMigration.ts`,
called once per process (memoized `getPrivateMemPath`) from `src/memory/memdir/paths.ts`.
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
`memoryMigration.test.ts` pinned "copies the team/ subtree" as intended.

**Status:** FIXED 2026-10-31 on `feat/memory-hygiene`. The copy filters out
`team/` and then writes `.migrated` into the legacy dir, so a private dir that
empties later is not refilled with the old snapshot either. Red tests first
(`never copies the legacy team/…`, `migrates once…`); the "copies the team/
subtree" pin was deleted with the fix. The 29 root copies of 09-28 were
untracked and are gone. Why the private dir was empty is unknown: it was intact at 2026-09-27 22:08 and
empty before 09-28 18:30. The 14 private memories written after June were lost
with it and restored from session transcripts.
Design context: [[memory-subsystem-design-doc]].
