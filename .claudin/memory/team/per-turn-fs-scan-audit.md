---
name: per-turn-fs-scan-audit
description: Audit 2026-08-07 of claudin's repeated filesystem/directory scans — scanMemoryFiles is uncached (but gated OFF per-turn in the open build; see the correction), getMemoryFiles' memo omits cwd, and the worktree-exit dialog leaks stale rule caches
type: project
---

Read-only audit 2026-08-07 of every filesystem-scanning path that runs more than
once per session ("cache de diretórios"). Nothing was changed; these are the open
findings.

**Why:** the per-turn attachment pipeline was assumed to be memoized end to end.
It is not — one directory walk plus a read of every memory `.md` happens on every
single user turn.

**How to apply:** treat items 1-3 as the fix queue; check item 4 before trusting
any cwd-sensitive memo.

1. **`scanMemoryFiles` has no cache at all** — `src/memory/memdir/memoryScan.ts:35-84`.
   It `readdir`s the memory tree recursively and opens the first ~30 lines of
   **every** `.md`.
   **CORRECTION 2026-08-07 (re-verified):** it does NOT run every user turn in
   the open build. The per-turn caller
   `startRelevantMemoryPrefetch` (`src/agent/attachments/memory.ts:344-353`,
   from `query.ts:342`) returns `undefined` before touching the filesystem
   unless the GrowthBook flag **`tengu_moth_copse`** is true — and that key is
   absent from `_openBuildDefaults` in `scripts/no-telemetry-plugin.ts:52-58`,
   so it resolves to `false` unless the user writes
   `~/.claudin/feature-flags.json`. The live per-session caller is
   `extractMemories.ts:448`, which sits **after** the `tengu_bramble_lintel`
   throttle → one scan per ~15 eligible turns, not per turn.
   Also: when the prefetch *is* on, the scan is the cheap half — the same
   function then fires a **Sonnet `sideQuery`** to pick 5 files
   (`findRelevantMemories.ts:98`). Caching the readdir would not touch that.
2. **Same function reads everything then throws most away** —
   `memoryScan.ts:52-80` runs an unbounded `Promise.allSettled` over all `.md`
   (unbounded fd usage) and applies `MAX_MEMORY_FILES=200` *after* reading them
   all, with `maxBytes: undefined`. openclaude's counterpart (255 lines vs our
   101) already streams a generator through 8 workers and caps headers at 64 KB —
   see [[openclaude-sibling-fork-reference]].
   **Measured, do not chase:** `scripts/profile/memory-bench.ts` (baseline in
   `scripts/profile/README.md:234-253`) puts this at ~0.014 ms/file, flat —
   2.77 ms p50 at 200 files, ~1 ms at this repo's 72. The round-1 "concurrency
   cap" finding was explicitly debunked there. It is a tidiness fix with no
   measurable runtime win. The stale "once per turn" comments in
   `memory-bench.ts:4,192` come from the same wrong premise.
3. **BUG — the worktree-exit *dialog* leaks stale project rules.**
   `ExitWorktreeTool.ts:143-144` clears `clearSystemPromptSections()` +
   `clearMemoryFileCaches()` after its chdir; `WorktreeExitDialog.tsx:18-29`
   (`recordWorktreeExit`) only calls `invalidateToolResultCache()`, and
   `worktree.ts:948` (`keepWorktree`) / `:982` (`cleanupWorktree`) chdir back and
   clear nothing. Exiting through the dialog keeps the worktree's memoized
   `CLAUDE.md` + `.claudin/rules` for the rest of the session. Asymmetry, not a
   design choice. `runWorkflowHeadless.ts:103/159` has the same gap (harmless —
   process start).
4. **`getMemoryFiles`' memo key is `forceIncludeExternal` only, no cwd** —
   `src/memory/instructions/claudemd.ts:761`. Safe today only because six call sites clear it by
   hand. `markdownConfigLoader.ts:429` shows the right shape (`${subdir}:${cwd}`).

Verified as already correct, do not "fix": `getChangedFiles`
(`attachments/services.ts:309-407`) is mtime-gated per entry; skill listings
(`commands.ts:541`) are cwd-memoized; `findGitRoot` (`git.ts:27`) uses
`memoizeWithLRU(50)`; `getPathsForSuggestions` (`fileSuggestions.ts:549`) has a
5s throttle keyed on `.git/index` mtime; `getGitStatus`/`getSystemContext` are
deliberate session snapshots. `toolResultCache` TTLs: Read 60s, Glob/Grep 30s,
LSP 15s, LRU 500 / 10 MB — see the `cache.md` rule for its cwd invariant.

**Neither fork has a directory/glob/ripgrep *result* index** (no cached
`readdir`, no project file index). That is greenfield, not a port.
