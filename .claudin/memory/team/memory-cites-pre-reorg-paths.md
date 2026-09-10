---
name: Team memories still cite paths the 2026-08 reorg retired
description: 23 of the 135 team memories point at src/utils|services|components or scripts/profile; resolve the basename with Glob, and fix the path in place rather than writing a second memory
type: project
---

The 2026-08 reorg retired seven catch-all directories, but it never touched the
memory corpus — memory files are not source, so the tree-wide rewrite skipped
them entirely. Measured 2026-09-10: **23 of the 135 team memories carry 55
citations of a directory that no longer exists.**

Treat any such path inside a memory as a stale *label* for a file that usually
still exists under another name. Glob the basename before concluding anything is
gone. The resolutions confirmed on 2026-09-10:

| cited in memory | actual location |
|---|---|
| `src/utils/context.ts` | `src/agent/context/context.ts` |
| `src/utils/providerProfiles.ts` | `src/providers/presets/providerProfiles.ts` |
| `src/utils/jsonArrayCompress.ts` | `src/agent/tools/jsonArrayCompress.ts` |
| `src/services/tools/toolResultCache.ts` | `src/agent/tools/toolResultCache.ts` |
| `src/services/api/claude/paramBuilders.ts` | `src/providers/shims/claude/paramBuilders.ts` |
| `src/services/lsp/` | `src/platform/lsp/` |
| `src/components/ProviderManager.tsx` | `src/providers/ui/ProviderManager.tsx` |
| `src/components/StartupScreen.ts` | `src/platform/StartupScreen.ts` |
| `src/tools.ts` | `src/tools/tools.ts` |
| `scripts/profile/` | `scripts/bench/` (e.g. `scripts/bench/ab/cache-ab-bench.ts`) |
| `docs/discovery/` | `docs/archive/discovery/` |
| `src/utils/memoryDelta.ts` | genuinely gone — deleted 2026-08-07 |

**The second-order effect is duplicate memories, not just dead links.** Two of
the three duplicate pairs merged on 2026-09-10 were the same fact written twice:
once with a pre-reorg path and once post-reorg, because a later session created a
new file instead of correcting the old one's path. `native-1m-context-window.md`
and `lsp-tool-reintroduced-plugin-only.md` each had a byte-identical twin whose
only difference was the directory. So when you notice a stale path: **edit it in
place.** A new file under a new slug leaves the wrong one indexed and readable.

The corollary for the tidy pass: two memory files that differ *only* in their
paths are duplicates, and the survivor is the one whose paths resolve today —
not the newer file, which in both those cases was the pre-reorg copy.

Related: [[reorg-catch-all-dirs-retired]] for what the slices are and what
enforces them, [[mechanical-rewrites-skip-producers]] for the same blind spot
hitting generators and script globs during that move.
