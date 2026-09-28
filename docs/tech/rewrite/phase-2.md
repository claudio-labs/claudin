# Phase 2: `src/memory`, `src/vcs`, `src/sessions`

Drawn from the inventory on 2026-09-28: 17,253 inherited lines in 152 files.
The 22 units below hold 16,865 of them. The other 388 are residue in files
that are otherwise this project's own, most of it in tests that copied an
inherited harness. That residue is swept once the units have landed.

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

## Units

| Unit | Files | Inherited lines | Inherited tests it replaces | Status |
|---|---|---|---|---|
| `vcs/gitFilesystem` | 2 | 785 | — | pending |
| `vcs/git` | 7 | 808 | — | pending |
| `vcs/worktree` | 8 | 1104 | `worktree.test.ts` (76) | pending |
| `vcs/gitDiff` | 6 | 542 | — | pending |
| `vcs/structuredDiff` | 4 | 636 | — | pending |
| `vcs/diffHooks` | 4 | 563 | — | pending |
| `memory/markdownConfigLoader` | 2 | 459 | — | pending |
| `memory/claudemd` | 11 | 981 | `projectInstructions.test.ts` (77) | pending |
| `memory/memdir` | 10 | 798 | — | pending |
| `memory/teamMemSafety` | 4 | 318 | `memoryScan.test.ts` (37) | pending |
| `memory/extract` | 5 | 557 | — | pending |
| `memory/autoDream` | 4 | 310 | — | pending |
| `memory/ui` | 3 | 372 | `memoryFileSelectorPaths.test.ts` (58) | pending |
| `sessions/storagePure` | 6 | 858 | — | pending |
| `sessions/persistence` | 5 | 1315 | — | pending |
| `sessions/resume` | 7 | 1201 | `conversationRecovery.hooks.test.ts`, `conversationRecovery.test.ts`, `sessionStorage.test.ts` (377) | pending |
| `sessions/liteMetadata` | 2 | 856 | — | pending |
| `sessions/indexingScan` | 3 | 609 | — | pending |
| `sessions/lifecycle` | 8 | 1057 | — | pending |
| `sessions/remote` | 5 | 917 | — | pending |
| `sessions/historySearch` | 3 | 534 | — | pending |
| `sessions/ui` | 5 | 660 | — | pending |

### Files per unit

- `vcs/gitFilesystem`: `vcs/git/gitFilesystem.ts`, `vcs/git/gitConfigParser.ts`
- `vcs/git`: `vcs/git/git.ts`, `vcs/git/detectRepository.ts`, `vcs/git/githubRepoPathMapping.ts`, `vcs/git/gitignore.ts`, `vcs/git/getWorktreePaths.ts`, `vcs/git/getWorktreePathsPortable.ts`, `vcs/git/worktreeModeEnabled.ts`
- `vcs/worktree`: `vcs/git/worktree/createWorktree.ts`, `vcs/git/worktree/includeFiles.ts`, `vcs/git/worktree/mutationLock.ts`, `vcs/git/worktree/postCreationSetup.ts`, `vcs/git/worktree/session.ts`, `vcs/git/worktree/sessionLifecycle.ts`, `vcs/git/worktree/slugNaming.ts`, `vcs/git/worktree/tmuxSession.ts`
- `vcs/gitDiff`: `vcs/git/gitDiff.ts`, `vcs/git/diff.ts`, `vcs/git/diffStat.ts`, `vcs/git/gitStatusDelta.ts`, `vcs/git/commitAttribution.ts`, `vcs/git/attribution.ts`
- `vcs/structuredDiff`: `vcs/diff/structured/Fallback.tsx`, `vcs/diff/structured/StructuredDiff.tsx`, `vcs/diff/structured/StructuredDiffList.tsx`, `vcs/diff/structured/colorDiff.ts`
- `vcs/diffHooks`: `vcs/diff/hooks/useDiffInIDE.ts`, `vcs/diff/hooks/useTurnDiffs.ts`, `vcs/diff/hooks/useDiffData.ts`, `vcs/hooks/usePrStatus.ts`
- `memory/markdownConfigLoader`: `memory/instructions/markdownConfigLoader.ts`, `memory/instructions/ruleFrontmatter.ts`
- `memory/claudemd`: `memory/instructions/claudemd.ts`, `memory/instructions/claudemd/exclusions.ts`, `memory/instructions/claudemd/externalIncludes.ts`, `memory/instructions/claudemd/includes.ts`, `memory/instructions/claudemd/nestedDirectories.ts`, `memory/instructions/claudemd/parsing.ts`, `memory/instructions/claudemd/predicates.ts`, `memory/instructions/claudemd/processing.ts`, `memory/instructions/claudemd/types.ts`, `memory/instructions/projectInstructions.ts`, `memory/instructions/claudeMdDelta.ts`
- `memory/memdir`: `memory/memdir/memdir.ts`, `memory/memdir/memoryTypes.ts`, `memory/memdir/memoryAge.ts`, `memory/memdir/paths.ts`, `memory/memdir/teamMemPaths.ts`, `memory/memdir/memoryFileDetection.ts`, `memory/memdir/teamMemPrompts.ts`, `memory/memdir/pathScopedMemories.ts`, `memory/memdir/versions.ts`, `memory/memdir/types.ts`
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
