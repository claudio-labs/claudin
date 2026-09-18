---
name: unreachable-clusters-inventory-2026-09-18
description: Ranked inventory of ~8k lines that ship but no execution path can reach — found by a symbol-level reachability walk, all PRE-EXISTING (not caused by the dead-code rounds); includes the five false-positive classes that make this analysis lie
type: project
---

> **Status after round 3 (same day, PR #212): rows 3, 4, 6, 7, 9, 10 and 12 are
> DELETED, and row 5's file-based half is gone. What is still standing is rows
> 1, 2, 8, 11 — the product-decision group — re-measured in
> [[dead-code-round-4-seed]], which supersedes this table. Row 2's headline
> claim is WRONG: the SDK schemas are partly live.**

Measured 2026-09-18 by a reachability walk from `src/platform/entrypoints/cli.tsx`,
as validation of [[dead-code-round-2-2026-09-18]]. **All of these predate that
branch** — `git diff main...HEAD` touches only two of the files, and neither
touch caused the finding.

The class is **reachable-by-import, unreachable-by-execution**: one live file
imports one symbol, so the whole module ships, while the functions that would
drive it have no caller. `knip` cannot see any of it by construction.

| # | cluster | dead lines | why it ships / what is missing |
|---|---|---|---|
| 1 | `platform/lifecycleHooks/hookChains.ts` | 1319 | `dispatchHookChainsForEvent` sits after `if (!feature('HOOK_CHAINS')) return` — off-map ⇒ unconditional return |
| 2 | `entrypoints/sdk/coreSchemas.ts` + `controlSchemas.ts` + `agentSdkTypes.ts` | 2651 | ~100 `lazySchema` thunks never invoked; the whole SDK API (`query`, `tool`, `listSessions`, `forkSession`, …) is uncallable — the build has ONE entrypoint and `package.json` has no `exports`/`main` |
| 3 | `terminal/logo/*` (10 files) + `logoV2Utils.ts` | 1482 | `Messages.tsx:37` imports `LogoV2`, but the React-Compiler output sets that slot to `t1 = null` (line 70). Clawd, AnimatedClawd, CondensedLogo, Feed, EmergencyTip, Opus1mMergeNotice have no outside importer at all |
| 4 | `sessions/listSessionsImpl.ts` + part of `sessionStoragePortable.ts` | 507 | `consolidationLock.ts` imports only `listCandidates`; `listSessionsImpl()` is callerless |
| 5 | `coordinator/swarm/permissionSync.ts` | 374 / 877 | the file-based protocol (`writePermissionRequest`→`pollForResponse`→`resolvePermission`) was superseded by the mailbox half, which IS live |
| 6 | `platform/settings/ui/Usage.tsx` | 363 / 882 | `AnthropicUsage` (+`LimitBar`, `ExtraUsageSection`) has one occurrence — its own declaration; `firstParty` now routes to `UsageGlobalScroll` |
| 7 | `shared/proc/tmuxSocket.ts` | 287 / 338 | `doInitialize`/`checkTmuxAvailable`/`setClaudeSocketInfo` callerless. NOTE the live `isTmuxAvailable` is a **namesake** in `swarm/backends/detection.ts` |
| 8 | `agent/context/conversationArc.ts` | 262 / 379 | `/knowledge` imports the readers, but every WRITER (`addGoal`, `addDecision`, `addEntity`, `initializeArc`) has 0 callers ⇒ readers can only ever see an empty arc |
| 9 | `agent/context/contextAnalysis.ts` | 247 / 273 | `compact.ts:41-43` value-imports `analyzeContext` + `tokenStatsToStatsigMetrics` and calls neither — a dangling import. The live twin is the separate `context/analyzeContext.ts` |
| 10 | `agent/hooks/useTaskListWatcher.ts` | 191 / 222 | `REPL.tsx:189` imports the hook and never invokes it |
| 11 | `platform/MagicDocs/magicDocs.ts` | 183 / 229 | `initMagicDocs()` is an **empty body**; `updateMagicDocs`/`detectMagicDocHeader` unreachable |
| 12 | `shared/fs/generatedFiles.ts` | 120 / 128 | knock-on of the inert `commitAttribution` half — decide with it |

**Rot** (delete): 3, 4, 5, 6, 7, 9, 10, 12. **Deliberate but inert** (a wiring
or flag decision, not a delete): 1, 8 (flip the flag or drop the feature), 2
(the SDK surface needs a real build entry to mean anything), 11 (an explicit
internal-only no-op). Add [[bash-parser-unreachable-behind-tree-sitter-flag]]
(~4.5k lines) to the second list — same shape, found the same way.

## The five false-positive classes — read before trusting any rerun

Each of these inflated or deflated the result by hundreds of lines before it was
fixed, and #6 produced a confident 477-line false finding that was withdrawn:

1. import statements counted as top-level references;
2. trailing statements absorbed into the last declaration's span;
3. `export default class X` not linked to the `default` import name;
4. the spread `...fn()` eaten by property-access stripping;
5. JSX text containing `https://` parsed as a line comment;
6. **local `export { X as Y }` aliasing** — this is what made
   `powershell/parser.ts` look 477 lines dead. `keybindings/validate.ts`,
   `McpParsingWarnings.tsx`, `status.tsx` and `tipRegistry.ts` all cleared too.

Two structural limits remain: the walk does **not** fold `feature()`, so it
OVER-reports liveness behind the 11 off-map flags (#1 and #8 were found by
grepping gate sites by hand, so more flag-gated clusters likely remain); and
dynamic-`import`/`require` targets get all exports marked live, so lazily
imported dead code is UNDER-reported. MCP tool handlers and plugin-loaded
commands resolve by string at runtime and were not followed.

Scale, for calibrating a rerun: 3271 files, 22750 import sites, 18223 resolved
internally, 8 unresolved. From `cli.tsx`, 2526 files are reachable by any edge
and only 12 are unreachable outright — all ambient stubs. The finding lives at
the **symbol** level: 20241 nodes, 19043 live, 779 dead.
