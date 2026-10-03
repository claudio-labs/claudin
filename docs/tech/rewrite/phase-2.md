# Phase 2: `src/memory`, `src/vcs`, `src/sessions`

Drawn from the inventory on 2026-09-28: 17,253 inherited lines in 152 files.
The 22 units below hold 16,820 of them, after `getWorktreePathsPortable.ts` (17) was cut as dead. The other 416 are residue in files
that are otherwise this project's own, most of it in tests that copied an
inherited harness. That residue is swept once the units have landed.
`teamMemPrompts.ts` and `pathScopedMemories.ts` moved from `memory/memdir` to
the sweep after its characterization, and `claudeMdDelta.ts` from
`memory/claudemd`: their 28 matching lines are signatures in files that are
over 93% this project's, the tuned team prompt among them.

Each unit goes through the [definition of done](README.md#definition-of-done-per-module)
as one module. The session-storage barrel (`src/sessions/sessionStorage.ts`)
fronts five units. Each of them is characterized through it, and the barrel
keeps every name it exports.

## How this phase runs

Two changes from the pilot let units run side by side:

- **Characterization gets a sandbox too.** Each unit is characterized in its own copy of `HEAD`, with the old code, and its probes are proved there. The main checkout never holds a mutated source, so the pilot's rule of one probe run at a time no longer applies.
- **The implementer proves its own probes.** Once the implementation passes, the same agent writes the probe spec against the new code and runs it in its sandbox. That folds the pilot's third agent into the second.

The main checkout only takes finished work. A unit's tests and spec land as one
commit, and its implementation as the next one.

The units are defined in `scripts/migrations/rewrite/units/phase-2.json`,
which the sandbox tools read; the lists below are the same.

## Units

| Unit | Files | Inherited lines | Inherited tests it replaces | Status |
|---|---|---|---|---|
| `vcs/gitFilesystem` | 2 | 785 | — | done |
| `vcs/git` | 6 | 791 | — | done |
| `vcs/worktree` | 8 | 1104 | `worktree.test.ts` (76) | done |
| `vcs/gitDiff` | 6 | 542 | — | done |
| `vcs/structuredDiff` | 4 | 636 | — | done |
| `vcs/diffHooks` | 4 | 563 | — | pending |
| `memory/markdownConfigLoader` | 2 | 459 | — | done |
| `memory/claudemd` | 10 | 979 | `projectInstructions.test.ts` (77) | pending |
| `memory/memdir` | 8 | 772 | — | done |
| `memory/teamMemSafety` | 4 | 318 | `memoryScan.test.ts` (37) | pending |
| `memory/extract` | 5 | 557 | — | done |
| `memory/autoDream` | 4 | 310 | — | pending |
| `memory/ui` | 3 | 372 | `memoryFileSelectorPaths.test.ts` (58) | pending |
| `sessions/storagePure` | 6 | 858 | — | done |
| `sessions/persistence` | 5 | 1315 | — | pending |
| `sessions/resume` | 7 | 1201 | `conversationRecovery.hooks.test.ts`, `conversationRecovery.test.ts`, `sessionStorage.test.ts` (377) | pending |
| `sessions/liteMetadata` | 2 | 856 | — | pending |
| `sessions/indexingScan` | 3 | 609 | — | pending |
| `sessions/lifecycle` | 8 | 1057 | — | done |
| `sessions/remote` | 5 | 917 | — | pending |
| `sessions/historySearch` | 3 | 534 | — | done |
| `sessions/ui` | 5 | 660 | — | pending |

### Files per unit

- `vcs/gitFilesystem`: `vcs/git/gitFilesystem.ts`, `vcs/git/gitConfigParser.ts`
- `vcs/git`: `vcs/git/git.ts`, `vcs/git/detectRepository.ts`, `vcs/git/githubRepoPathMapping.ts`, `vcs/git/gitignore.ts`, `vcs/git/getWorktreePaths.ts`, `vcs/git/worktreeModeEnabled.ts`
- `vcs/worktree`: `vcs/git/worktree/createWorktree.ts`, `vcs/git/worktree/includeFiles.ts`, `vcs/git/worktree/mutationLock.ts`, `vcs/git/worktree/postCreationSetup.ts`, `vcs/git/worktree/session.ts`, `vcs/git/worktree/sessionLifecycle.ts`, `vcs/git/worktree/slugNaming.ts`, `vcs/git/worktree/tmuxSession.ts`
- `vcs/gitDiff`: `vcs/git/gitDiff.ts`, `vcs/git/diff.ts`, `vcs/git/diffStat.ts`, `vcs/git/gitStatusDelta.ts`, `vcs/git/commitAttribution.ts`, `vcs/git/attribution.ts`
- `vcs/structuredDiff`: `vcs/diff/structured/Fallback.tsx`, `vcs/diff/structured/StructuredDiff.tsx`, `vcs/diff/structured/StructuredDiffList.tsx`, `vcs/diff/structured/colorDiff.ts`
- `vcs/diffHooks`: `vcs/diff/hooks/useDiffInIDE.ts`, `vcs/diff/hooks/useTurnDiffs.ts`, `vcs/diff/hooks/useDiffData.ts`, `vcs/hooks/usePrStatus.ts`
- `memory/markdownConfigLoader`: `memory/instructions/markdownConfigLoader.ts`, `memory/instructions/ruleFrontmatter.ts`
- `memory/claudemd`: `memory/instructions/claudemd.ts`, `memory/instructions/claudemd/exclusions.ts`, `memory/instructions/claudemd/externalIncludes.ts`, `memory/instructions/claudemd/includes.ts`, `memory/instructions/claudemd/nestedDirectories.ts`, `memory/instructions/claudemd/parsing.ts`, `memory/instructions/claudemd/predicates.ts`, `memory/instructions/claudemd/processing.ts`, `memory/instructions/claudemd/types.ts`, `memory/instructions/projectInstructions.ts`
- `memory/memdir`: `memory/memdir/memdir.ts`, `memory/memdir/memoryTypes.ts`, `memory/memdir/memoryAge.ts`, `memory/memdir/paths.ts`, `memory/memdir/teamMemPaths.ts`, `memory/memdir/memoryFileDetection.ts`, `memory/memdir/versions.ts`, `memory/memdir/types.ts`
- `memory/teamMemSafety`: `memory/memdir/secretScanner.ts`, `memory/memdir/teamMemSecretGuard.ts`, `memory/memdir/teamMemoryOps.ts`, `memory/memdir/memoryScan.ts`
- `memory/extract`: `memory/extract/extractMemories.ts`, `memory/extract/prompts.ts`, `memory/session/prompts.ts`, `memory/session/sessionMemoryUtils.ts`, `memory/session/paths.ts`
- `memory/autoDream`: `memory/autoDream/autoDream.ts`, `memory/autoDream/consolidationLock.ts`, `memory/autoDream/consolidationPrompt.ts`, `memory/autoDream/config.ts`
- `memory/ui`: `memory/ui/MemoryFileSelector.tsx`, `memory/ui/memoryFileSelectorPaths.ts`, `memory/ui/MemoryUpdateNotification.tsx`
- `sessions/storagePure`: `sessions/sessionStoragePortable.ts`, `sessions/pure/firstPrompt.ts`, `sessions/pure/jsonlStripping.ts`, `sessions/pure/logging.ts`, `sessions/pure/paths.ts`, `sessions/pure/typeGuards.ts`
- `sessions/persistence`: `sessions/persistence/project.ts`, `sessions/persistence/metadata.ts`, `sessions/persistence/record.ts`, `sessions/persistence/_helpers.ts`, `sessions/persistence/flush.ts`
- `sessions/resume`: `sessions/conversationRecovery.ts`, `sessions/resume/chain.ts`, `sessions/resume/transcriptLoad.ts`, `sessions/resume/subagents.ts`, `sessions/resume/cache.ts`, `sessions/sessionCandidates.ts`, `sessions/crossProjectResume.ts`
- `sessions/liteMetadata`: `sessions/indexing/liteMetadata.ts`, `sessions/indexing/search.ts`
- `sessions/indexingScan`: `sessions/indexing/boundaryScan.ts`, `sessions/indexing/crossProject.ts`, `sessions/indexing/agents.ts`
- `sessions/lifecycle`: `sessions/sessionRestore.ts`, `sessions/sessionStart.ts`, `sessions/sessionEnvironment.ts`, `sessions/sessionState.ts`, `sessions/sessionActivity.ts`, `sessions/sessionTitle.ts`, `sessions/concurrentSessions.ts`, `sessions/sessionEnvVars.ts`
- `sessions/remote`: `sessions/hooks/useRemoteSession.ts`, `sessions/hooks/useSSHSession.ts`, `sessions/sessionIngressAuth.ts`, `sessions/sessionUrl.ts`, `sessions/hooks/useTeleportResume.tsx`
- `sessions/historySearch`: `sessions/hooks/useHistorySearch.ts`, `sessions/ui/HistorySearchDialog.tsx`, `sessions/transcriptSearch.ts`
- `sessions/ui`: `sessions/ui/ResumeConversation.tsx`, `sessions/ui/SessionPreview.tsx`, `sessions/ui/SessionBackgroundHint.tsx`, `sessions/hooks/useSessionBackgrounding.ts`, `sessions/hooks/useFileHistorySnapshotInit.ts`

## Findings outside the units

The units' agents found these in code no phase 2 unit owns. Each goes to the
phase that owns the code; none was changed here.

| Finding | Where | For |
|---|---|---|
| Output is decoded one 64 KB chunk at a time, so a multi-byte character across a chunk boundary becomes U+FFFD and large diffs show garbled text | `execFileNoThrowWithCwd` | `shared` |
| `logError` records nothing at the default privacy level | `src/shared/log.ts` | `shared` |
| The paste store names a file after a history line's hash without checking it (hardening) | the paste cache behind history search | `terminal` |
| Callers put commit and PR attribution text into their output without escaping it | the attribution consumers of `vcs/git/attribution.ts` | `tools` |
| Under git 2.55, `stash show -p` garbles its path prefixes, so the /diff stash view comes up empty | the /diff stash reader | `vcs/diffHooks` |
| `conversationRecovery.hooks.test.ts`, the REPL harness and `useReplExit.test.tsx` never restore their module mocks, and mocking a facade replaces the function behind it, so combined runs depend on file order | the tests named | `sessions/resume`, `agent` |
| Five probe specs were already stale on `main` before the rewrite (69 probes): `antiNarrationRemoved`, `patchResubmit`, `providerScreens`, `requestLevers2`, `responseChain` | `scripts/migrations/probes/` | the residue sweep; `stale-probes.ts` lists them |

The older specs the ten units displaced were re-pointed, not pruned: their 15
stale probes (`catAsRead`, `forkDefaults`, `memoryIndex`, `nestedMemoryBatch`,
`promptsV2`, `teamMemSecretGuard`) now target the lines that carry the same
behaviour in the new code, and each still turns its spec's own suites red.
Pruning would have left this project's tests unproven against the rewrite.
