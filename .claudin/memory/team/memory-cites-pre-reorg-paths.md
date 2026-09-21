---
name: Team memories cited paths the 2026-08 reorg retired — swept 2026-09-21
description: The reorg never touched the memory corpus — 23 of 135 files carried 55 dead citations; the live ones were swept 2026-09-21, and this is the resolution table plus the rule for telling a live citation from a historical one
type: project
---

The 2026-08 reorg retired seven catch-all directories, but it never touched the
memory corpus — memory files are not source, so the tree-wide rewrite skipped
them entirely. Measured 2026-09-10: **23 of the 135 team memories carried 55
citations of a directory that no longer exists.** The ones presented as *where
the code is today* were fixed in place on 2026-09-21 (list below); what remains
is historical narrative, which is correct as written.

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
| `src/ink/*` | `src/terminal/ink/*` (confirmed 2026-09-13; 10 citations across 5 files) |
| `scripts/profile/` | `scripts/bench/` (e.g. `scripts/bench/ab/cache-ab-bench.ts`) |
| `docs/discovery/` | `docs/archive/discovery/` |
| `src/utils/memoryDelta.ts` | genuinely gone — deleted 2026-08-07 |
| `src/utils/config.js` | `src/platform/config/config.js` |
| `src/utils/browser.ts` | `src/shared/browser.ts` |
| `src/utils/tokensSaved.ts` | `src/agent/context/tokensSaved.ts` |
| `src/utils/detectCodeLang.ts` | `src/shared/fs/detectCodeLang.ts` |
| `src/utils/startupUpdateCheck.test.ts` | `src/platform/install/startupUpdateCheck.test.ts` |
| `src/services/tools/toolResultCache.ts` | `src/agent/tools/toolResultCache.ts` |
| `src/services/oauth/` | `src/providers/oauth/` |
| `src/services/extractMemories/loopDetector.ts` | `src/memory/extract/loopDetector.ts` |
| `src/components/StructuredDiff/colorDiff.ts` | `src/vcs/diff/structured/colorDiff.ts` |
| `src/components/diff/*` | `src/vcs/diff/ui/*` |
| `src/constants/querySource.ts` | `src/agent/prompts/querySource.ts` — **exists now**, so "absent from the repo" is stale |
| `src/query.ts` / `src/commands.ts` | `src/agent/query.ts` / `src/commands/commands.ts` |
| `src/ink.js` | `src/terminal/ink.js` |
| `scripts/no-telemetry-plugin.ts` | `scripts/build/no-telemetry-plugin.ts` |
| `scripts/profile/cache-ab-bench.ts` | `scripts/bench/ab/cache-ab-bench.ts` |
| `scripts/profile/agent-bg-token-bench.ts` | `scripts/bench/ab/agent-bg-token-bench.ts` |
| `scripts/profile/code-outline-ab.ts` | `scripts/bench/ab/code-outline-ab.ts` |
| `scripts/profile/memory-turn-by-turn-bench.test.ts` | `scripts/bench/perf/memory-turn-by-turn-bench.test.ts` |
| `scripts/profile/fixtures/big-json.sh` | `scripts/bench/perf/fixtures/big-json.sh` |
| `scripts/profile/json-salient-probe.ts` | `scripts/bench/tokens/json-salient-probe.ts` |
| `scripts/profile/devin-*` | genuinely gone — archived with the port |
| `docs/tech/devin-provider-blocker.md` | `docs/tech/devin-provider/README.md` |

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

**Swept 2026-09-21 — the live citations are fixed in place.** Fourteen files
were corrected during a `/memory` pass: the four ink/renderer ones
(`ink-diff-damage-xbounds`, `ink-bordered-fillheight-panes-recipe`,
`scrollbox-inline-no-clip`, `ink-modules-unimportable-in-tests` —
`ink-legacyroot-vestigial` had already been fixed and this note was wrong to
list it), the cache/bench cluster (`defer-cache-marker-shipped`,
`cache-head-anchor-branch-state`, `cache-ab-bench-unreliable`,
`toolresult-cache-cwd-invalidation`, `memory-turn-by-turn-bench-flaky-full-suite`,
`headless-bg-agents-not-drained`), and `bun-mock-module-cross-file-leak`,
`web-login-provider-port-queue`, `feature-macro-breaks-bun-test-outside-if`,
`openai-compat-preset-recipe`, `token-efficiency-roadmap`. None of the ink five
is indexed — `.claudin/rules/ink-tui.md` carries the distilled version with
current paths, so they are detail behind the rule, not orientation.

**What was deliberately NOT rewritten, and must not be.** A retired path is
often the *point* of the sentence: the resolution table above,
`reorg-catch-all-dirs-retired` ("one `src/utils/foo.ts` added in a hurry
re-opens the bucket"), `typecheck-backlog-shape` ("the reorg dissolved
`src/services/`"), `mechanical-rewrites-skip-producers` (which is about the
rewrite itself), `memory-delta-removed-double-send` (that file is genuinely
gone), `worktree-agent-edits-leak-to-main-checkout` (an incident report), and
every openclaude path in `openclaude-sibling-fork-reference`, which names
*their* tree, not ours. Read the sentence before fixing the path.

Related: [[reorg-catch-all-dirs-retired]] for what the slices are and what
enforces them, [[mechanical-rewrites-skip-producers]] for the same blind spot
hitting generators and script globs during that move.
