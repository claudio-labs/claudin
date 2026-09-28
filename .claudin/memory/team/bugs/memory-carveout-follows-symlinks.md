---
name: memory-carveout-follows-symlinks
description: The memory-path permission carve-out is lexical, so a symlink committed inside a repo's .claudin/memory/ gets Read (and Write) with no prompt, and a symlinked team/MEMORY.md is loaded into context — not fixed, found 2026-09-28
type: project
---

**Symptom:** none visible. A cloned repository that commits `.claudin/memory/team/docs/notes.md` as a link to `~/.ssh/id_rsa` has that file read, or written, without a permission prompt, and a `team/MEMORY.md` that is a link puts its target in the context at session start.

**Where:** `isAutoMemPath` and `isTeamMemPath` (`src/memory/memdir/`) compare paths as text and never resolve links. The permission layer auto-approves a path they accept before its link-aware working-directory checks (`checkReadableInternalPath` / `checkEditableInternalPath` in `src/permissions/filePermissions/internalPaths.ts`, called from `readWriteChecks.ts`). The containment check covers `.claudin` and `.claudin/memory` themselves, not the entries inside them. The extraction fork has its own lexical check since its rewrite: `isInsideDirectory` in `src/memory/extract/fork/permissions.ts` (findings 4 and 5 of `docs/tech/rewrite/memory/extract.md`).

**Status 2026-09-28:** described by the clean-base rewrite (finding 1 of `docs/tech/rewrite/memory/memdir.md`) and kept for parity there; the suite does not exercise it. The fix belongs to the permission layer, the loader and the fork's `isInsideDirectory`: resolve the real path and require it to stay under the memory directory's real path. Take it up with the `permissions` phase or sooner.
