---
name: Read-only tool-result cache keys omit cwd — invalidate on any chdir
description: toolResultCache keys are tool+input with no cwd; any mid-session process.chdir must invalidateAll() or relative-path Read/Glob/Grep/LSP serve stale hits
type: project
---

`src/services/tools/toolResultCache.ts` keys entries as `tool::stableStringify(input)` — **no cwd component**. So a relative-path arg (`path:'src'`, `file_path:'README.md'`) maps to the SAME key before and after a `process.chdir()`, serving a stale hit that resolves against the wrong directory. The Read mtime guard is NOT a backstop (it `statSync`s the relative path against the new cwd); Glob/Grep/LSP have no guard at all.

**Why:** worktree enter/exit and `/resume` do `process.chdir()` mid-session. Closed across THREE homes (2026-06-24/25), one per chdir surface:
- Agent-driven tools (EnterWorktree/ExitWorktree) → `invalidateCacheForWrite` branch in `cacheInvalidation.ts` calls `invalidateAll()` (unit-tested in `cacheInvalidation.test.ts`).
- Interactive `WorktreeExitDialog.tsx` → `recordWorktreeExit()` calls `invalidateAll()` (no tool dispatch fires on this path). All 4 dialog branches call it via `finally`/`.finally()` so it runs even if a chdir throws after the helper already moved cwd internally.
- `/resume` slash command → `sessionRestore.ts` `restoreWorktreeForResume` + `exitRestoredWorktree` call `invalidateAll()` next to the existing `clearMemoryFileCaches`/`clearSystemPromptSections`/`getPlansDirectory.cache.clear` (the file's own comment admits this runs "after caches have been populated against the old cwd").

**How to apply:** any NEW mid-session `process.chdir()` site (a future `cd`-like tool, bridge mode, etc.) must call `invalidateAll()` from toolResultCache after the chdir, or it silently serves stale relative-path reads. EXEMPT: only true session-boundary chdirs where the cache is still empty — `setup.ts` startup and the CLI `--resume`/`--continue` flag path (`resume.ts`). NOT exempt (this was the trap): the `/resume` *slash command* reuses the same warm-cache process — that is why `sessionRestore.ts` is a real home, not a boundary. The robust-but-bigger alternative (encode cwd into makeKey) was NOT taken — it would broadly change cache semantics and interact with path-based invalidation.
