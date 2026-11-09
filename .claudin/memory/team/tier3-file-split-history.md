---
name: tier3-file-split-history
description: What each giant-file split round moved and cost (2026-09-14..09-20, #216/#217) — the barrel table, the 09-18/09-19 re-measurements, Group A/B/C numbers, the orphaned-test splits, ProviderManager/BashTool composition roots; the rule and recipe live in tier3-file-split-roadmap
type: project
---

History behind [[tier3-file-split-roadmap]], moved out of it on 2026-11-08 so the rule stays
short. Numbers are as measured then; re-measure before acting on any of them.

## What is a barrel (2026-09-19)

| barrel | was | now | siblings |
|---|---|---|---|
| `src/tools/shared/codeOutline/scanSymbols.ts` | 3911 | 193 | 18 |
| `src/platform/headless/print/runHeadless.ts` | 4197 | 590 | 9 |
| `src/providers/shims/claude.ts` | — | 66 | `claude/` |
| `src/providers/shims/openaiShim.ts` | — | 51 | `openaiShim/` |
| `src/mcp/client.ts` | — | 66 | `client/` |
| `src/tools/BashTool/bashPermissions.ts` | 2528 | 68 | 7 |
| `src/tools/BashTool/bashSecurity.ts` | 2608 | 22 | 13 |
| `src/platform/config/config.ts` | 2276 | 101 | 7 |
| `src/platform/bootstrap/state.ts` | 1896 | 278 | 11 |
| `src/commands/insights.ts` | 2832 | 47 | 9 |
| `src/tools/PowerShellTool/pathValidation.ts` | 2055 | 19 | 6 |
| `src/mcp/auth.ts` | 1971 | 40 | 8 |
| `src/permissions/permissionSetup.ts` | 1454 | 60 | 10 |
| `src/vcs/git/worktree.ts` | 1544 | 54 | 8 |
| `src/agent/tools/toolResultSummarizer.ts` | 1396 | 259 | 11 |
| `src/memory/instructions/claudemd.ts` † | 1405 | 482 | 8 |
| `src/terminal/theme/theme.ts` † | 1282 | 82 | 14 |
| `src/agent/compact/compact.ts` † | 1540 | 1050 | 2 |

† not a pure barrel (`code-design.md` §1). The last four landed on
`refactor/split-group-a-round-2`, 2026-09-20 (#217); the four above them on
`refactor/split-remaining-giants`, 2026-09-19 (#216); the four above those on
`refactor/split-giant-modules`, 2026-09-14. **The BashTool pair is a RE-land** — PR #129 merged in
August and its code was then dropped from `main` by a non-fast-forward push; see
[[pr-129-lost-to-force-push]].

## Re-measurement 2026-09-18 — Group A (high churn AND relocatable)

Done on `refactor/split-group-a`, 2026-09-19. The table is the state that justified the work.

| file | lines | commits | shape | net |
|---|---|---|---|---|
| `src/agent/compact/stableStubState.ts` | 1529 | 21 | 77 syms, largest 5% | 2153-line test |
| `src/permissions/yoloClassifier.ts` | 1688 | 18 | 65 syms, largest 18% | 3 tests |
| `src/permissions/filesystem.ts` | 1860 | 15 | 46 syms, largest 11% | via permissions |
| `src/permissions/permissions.ts` | 1450 | 18 | mixed, ~430 lines out | 295-line test |

Result: `stableStubState.ts` 1529 → **66**, `filesystem.ts` 1860 → `filePermissions.ts` **23**,
`yoloClassifier.ts` 1688 → **19**, `permissions.ts` 1450 → **822** (re-exports plus the decision
core, which stayed on purpose — the security hot path). `filesystem.ts` failed the ownership check:
10 of its 30 exports, with 21 importers across six slices, moved first to `memory/session/paths.ts`,
`skills/bundledSkillsRoot.ts`, `agent/scratchpad.ts`, `platform/tmpdir.ts` and `shared/fs/path.ts`.
The mechanical diff caught the only two real deltas across ~5,500 relocated lines: the `./` → `../`
retarget of the classifier `.txt` requires, and one dropped section-header comment.

## Re-measurement 2026-09-19 — Group A moved down the list

The four biggest files were all Group C (frozen) — `pluginLoader.ts` 3274×**6**,
`marketplaceManager.ts` 2610×7, `normalize.ts` 2455×8, `bridgeMain.ts` 2411×8 — while every
remaining cheap target sat in the 1.2–1.8k band.

| file | lines | commits | syms | largest | coverage |
|---|---|---|---|---|---|
| `agent/tools/toolResultSummarizer.ts` | 1396 | 20 | 87 | 13% | 1377 + 982-line tests |
| `providers/auth/auth.ts` | 1775 | 11 | 78 | 8% | **none** (8 tests mock it away) |
| `agent/compact/compact.ts` | 1540 | 10 | 36 | 19% | yes |
| `memory/instructions/claudemd.ts` | 1405 | 11 | 39 | 20% | yes |
| `providers/transport/errors.ts` | 1295 | 15 | 36 | 40%¹ | yes |
| `terminal/theme/theme.ts` | 1282 | 11 | 22 | 8% | yes |

¹ 35 of 36 symbols are small message constants; the 40% is one dispatcher. `errors.ts` was dropped.

Round 2 (2026-09-20): `toolResultSummarizer.ts` 1396 → **259** (11 siblings), `claudemd.ts` 1405 →
**482** (8), `theme.ts` 1282 → **82** (14), `compact.ts` 1540 → **1050** (2, a deliberately narrow
cut). Plus two characterization suites from scratch: 26 tests for `claudemd.ts`, 54 for `auth.ts`
(which got a suite instead of a split). The "coverage: yes" column was wrong for `claudemd.ts` (no
colocated test at all) and `compact.ts` (101-line suite covering 2 of 36 symbols). The md5 gate came
back byte-identical first try for `theme.ts` and `toolResultSummarizer.ts`. The back-edge trap was
`compact.ts`'s `POST_COMPACT_*` budgets and `claudemd`'s `MAX_MEMORY_CHARACTER_COUNT`.

Break-probe findings that round (unguarded lines, not test defects): the `code`/`codespan` skip in
`extractIncludePathsFromTokens` is unreachable; the `isAnthropicAuthEnabled` gates inside
`getSubscriptionType`/`getRateLimitTier` cannot be reached machine-independently;
`!Number.isNaN(parsed)` in `calculateApiKeyHelperTTL` is redundant (`NaN >= 0` is false).

Read-outline corrections: `errors.ts` 15%→40%, `toolExecution.ts` 11%→**56%**,
`render-node-to-output.ts` 8%→58%. Two bench defaults were dead paths since the 2026-08 reorg,
**FIXED 2026-09-20** with an existence guard: `scripts/bench/tokens/cache-progression.sh:40,41`.

## Group B numbers (2026-09-18)

`REPL.tsx` 3082×**54** (`REPL` = 89%), `PromptInput.tsx` 2603×41 (91%, no test of its own),
`claude/streaming.ts` 2279×39 (`queryModel` 80%), `Config.tsx` 1929×29 (91%, React-Compiler output),
`AgentTool.tsx` 1412×22 (84%), `query.ts` 1480×15 (`queryLoop` 85%), `QueryEngine.ts` 1384×12
(`submitMessage` 74%), `ManagePlugins.tsx` 2218×8 (82%, no test at all). Group C: `replBridge.ts`
2327×9 (`initBridgeCore` 66%), `coreSchemas.ts` 1901×14 (136 exports), `providers/auth/auth.ts`
1775×11, `native-ts/yoga-layout/index.ts` 2578. The read-only-validation quartet is ~7.7k lines,
`COMMAND_ALLOWLIST` 52% of one file.

Two Group B members came out on `refactor/split-remaining-giants` (2026-09-19) as **composition root
+ siblings**:
- `ProviderManager.tsx` 3156 → **1851**: OAuth setup screens → `OAuthSetup.tsx`, four screens →
  `screens/`, pure helpers → `providerDrafts.ts` / `providerLookups.ts` /
  `providerManagerConstants.ts` / `ProviderManager.types.ts` (`.ts` so they load under `bun test`
  without `src/terminal/ink.js`). `renderMenu` stayed: it closes over 16 members of state.
- `BashTool.tsx` 1366 → **507** (`bashCommandClassification.ts`, `bashSchemas.ts`,
  `applySedEdit.ts`, `runShellCommand.tsx`). The `buildTool({…})` object stays in the root because
  two suites read it as TEXT.

## The three biggest files were orphaned TESTS (2026-09-19)

- `providers/shims/openaiShim.test.ts` 4756 → ten topic suites under `shims/openaiShim/`, over
  `__testutils__/shimHarness.ts`.
- `outputFilter/Bash/bashFilter.test.ts` 4233 → per-family suites under `Bash/filters/`.
- `codeOutline/scanSymbols.test.ts` 3322 → 15 siblings under `codeOutline/`.
- `FileReadTool/FileReadTool.test.ts` 2177 → eight suites over `__testutils__/fileReadHarness.ts`.

## Four production barrels (2026-09-19, #216)

| file | was | barrel | siblings | what the split had to respect |
|---|---|---|---|---|
| `src/tools/PowerShellTool/pathValidation.ts` | 2055 | **19** | 6 | had **zero** tests — written first |
| `src/mcp/auth.ts` | 1971 | **40** | 8 | 1 of 8 groups covered; state is per-instance |
| `src/permissions/permissionSetup.ts` | 1454 | **60** | 10 | one gated require read by five groups |
| `src/vcs/git/worktree.ts` | 1544 | **54** | 8 | a module mutable AND two `mock.module` consumers |

## Text-reading tests, re-scanned 2026-09-18

`REPL.hooksOrder.test.ts` → `REPL.tsx`; `configGroups.test.ts:167` → `Config.tsx`;
`lspDeferLatch.test.ts:53` and `deferredToolsDelta.test.ts:284` → `streaming.ts`;
`autoBackground.test.ts:65,83`, `prompts.test.ts:529` and `__tests__/bugfixes.test.ts:286` →
`AgentTool.tsx`; `toolRedirect.test.ts` and `RunTestsTool/redirect.test.ts` → `BashTool.tsx`;
`__tests__/bugfixes.test.ts:101,114,122,310` → `agent/query.ts`;
`security-hardening.test.ts:72,82,91` → `marketplaceManager.ts`; `deferredToolsDelta.test.ts:291` →
`compact.ts`; `toolRedirect.test.ts:18` needs `platform/bash/commands.ts` on disk;
`exploreAgentRemoved.test.ts` → `scripts/build/build.ts`.

Benches naming giants as fixtures: `cache-ab-bench.ts` (REPL.tsx, streaming.ts, query.ts,
QueryEngine.ts, normalize.ts, stableStubState.ts), `outline-symbols-ab.ts` (REPL.tsx,
PromptInput.tsx), `measure-outline-tokens.ts` (pluginLoader.ts, providers/auth/auth.ts, bridgeMain.ts
— samples by size tier), `repomap/05-ranking-variants.ts`, `read-strategy-ab.ts`. `6c574def` is the
worked repoint; `b21c20b5` the prose-rule update.

## Two notes from the BashTool split

- `bashCommandIsSafeAsync_DEPRECATED`'s body never executes under `bun test`: `ParsedCommand.parse`
  returns no tree-sitter analysis in the runner, so it always takes the `if (!tsAnalysis)` fallback.
- A `replacesInputs?: boolean` that defaulted to the leaking behavior became
  `mergeReplacingLiveCache` — deleting the footgun instead of testing it.
