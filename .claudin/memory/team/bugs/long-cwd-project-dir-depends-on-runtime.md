---
name: long-cwd-project-dir-depends-on-runtime
description: A cwd longer than 200 sanitized chars gets a different ~/.claudin/projects/ dir under Bun (the npm native binary) than under Node (the fallback bundle, bin/claudin), so /resume misses sessions after switching — kept for parity in the rewrite, found 2026-09-28
type: project
---

**Symptom:** a user whose cwd sanitizes to more than 200 characters switches between the native binary and the Node bundle (an `--ignore-scripts` install, `cli-wrapper.cjs` falling back, or a checkout's `bin/claudin`), and `/resume` and `--continue` show none of the sessions made under the other one.

**Where:** `sanitizePath` in `src/sessions/sessionStoragePortable.ts` appends `Bun.hash(name)` in base 36 when `Bun` is defined, and `djb2Hash(name)` otherwise; `getProjectDir` joins that name with no fallback. Every caller of `sanitizePath` is affected the same way (auto-memory base in `src/memory/memdir/paths.ts`, the bridge pointer, `/tmp/claude-<uid>/<project>`). `src/shared/fs/cachePaths.ts` keeps its own copy, djb2 only.

**Repro:** `/` + 250 `a` gives the suffix `-lni537xdrusg` under Bun and `-feo44x` under Node; both are pinned in `src/sessions/storagePure.portable.characterization.test.ts`.

**Status 2026-09-28:** kept for parity by the clean-base rewrite (finding 1 of `docs/tech/rewrite/sessions/storagePure.md`). Settling on one suffix orphans the sessions stored under the other, and the native binary is the main distribution, so the fix is a lookup that tolerates both: on a miss, fall back to a sibling directory with the same 200-character prefix.
