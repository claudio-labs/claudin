---
name: team-path-symlink-case-gap
description: The team-memory path tests compare the path as written, so a symlink into team or a TEAM/ case variant on macOS/Windows still gets the private carve-out and skips the secret guard; found in the #305 review, not fixed
type: project
paths:
  - "src/memory/memdir/teamMemPaths.ts"
  - "src/memory/memdir/memoryDirs.ts"
  - "src/permissions/filePermissions/internalPaths.ts"
---

**Defect:** `isTeamMemPath` (`teamMemPaths.ts`) and `findMemoryDir` (`memoryDirs.ts`, behind `memoryScopeForPermission`) are prefix tests on the path as written. Two shapes reach the team dir without being seen as team:
- a symlink inside the private dir that points into team (`.claudin/memory/t2 -> team`): `echo k > .claudin/memory/t2/bugs/x.md` is allowed with no prompt by `checkShellEditableInternalPath`, and the file tools skip `checkTeamMemSecrets`;
- a case variant (`.claudin/memory/TEAM/x.md`) on macOS or Windows, whose filesystems are case-insensitive.

Creating the link itself (`ln -s`) asks, so the first shape needs a link that already exists, committed or made by hand. `claudin memory audit` still sees what lands in the real team dir, since it lists `<gitRoot>/.claudin/memory/team/` directly.

**Status:** found by the #305 correctness review on 2026-10-16 and left out of that PR on purpose: it predates the PR, and fixing it changes the team test every write path relies on.

**Fix when picked up:** treat a path as team when any of `getPathsForPermissionCheck(path)` (the symlink-resolved forms) is under the team root, compared through `normalizeCaseForComparison` on darwin and win32. Do it in `isTeamMemPath` and in the scope the shell carve-out reads, and pin both shapes red first.
