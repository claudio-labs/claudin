# Phase 3: `src/mcp`, `src/permissions`

Drawn from `provenance-baseline.json` on 2026-10-03, and checked against a
fresh `bun run provenance --json` at `f9fa2bdf`, which reads the same count for
every file. Production code holds **29,606 inherited lines in 176 files**:
28,554 Claude Code and 1,052 openclaude.

| Slice | Files | Inherited lines | In units | Residue |
|---|---|---|---|---|
| `src/mcp` | 57 | 11,636 | 11,605 in 13 units | 31 |
| `src/permissions` | 119 | 17,970 | 17,960 in 20 units | 10 |
| **Total** | **176** | **29,606** | **29,565 in 33 units** | **41** |

`src/permissions/ui` alone is 10,952 lines in 63 files, most of them
React-Compiler output. It is split into twelve units by dialog family.

The tests in these slices hold 743 more lines, in 23 files. Seven of them, 655
lines, are replaced by their unit's new suite. The other 88 lines are in the
residue sweep.

The pieces ported from opencode are this project's own, apart from the lines
that still match. `mcp/auth/claudeAuthProvider.ts` (16) and `oauthFlow.ts` (13)
are over 96% own, so they go to the residue sweep. `platform/lsp/LSPClient.ts`
and the Codex OAuth are outside this phase.

## How this phase runs

Phase 3 runs per method ([levers.md](levers.md#rewriting-per-method)): one
`char` sandbox per unit to bring its files to target, then one `bodies`
sandbox to rewrite the inherited bodies. Most units start far below target
(see [Coverage](#coverage-baseline-2026-10-03)), so characterization is most of
the work. [Cover before touching](levers.md#cover-before-touching) applies to
every file: 70% for both slices, since `testing.md` sets no target for either.

Three barrels are this project's own and have no inherited lines:
`src/mcp/client.ts`, `src/mcp/auth.ts` and `src/permissions/filePermissions.ts`.
`permissionSetup.ts` and `yoloClassifier.ts` are the same. Each unit behind one
of them is characterized through it, and the barrel keeps every name it exports.

The units are defined in `scripts/migrations/rewrite/units/phase-3.json`,
which the sandbox tools read. The lists below are the same.

## Units

| Unit | Files | Inherited lines | Inherited tests it replaces | Status |
|---|---|---|---|---|
| `mcp/core` | 5 | 713 | — | done |
| `mcp/config` | 2 | 1291 | — | done |
| `mcp/auth` | 7 | 658 | `auth.test.ts` (50) | pending |
| `mcp/connection` | 5 | 1305 | `client.test.ts` (34) | pending |
| `mcp/capabilities` | 6 | 924 | — | pending |
| `mcp/callTool` | 5 | 983 | — | pending |
| `mcp/connectionManager` | 3 | 726 | — | pending |
| `mcp/elicitation` | 3 | 535 | — | done |
| `mcp/doctor` | 1 | 620 | `doctor.test.ts` (443) | done |
| `mcp/elicitationDialog` | 1 | 1105 | — | pending |
| `mcp/settingsUi` | 5 | 1258 | — | pending |
| `mcp/serverMenus` | 6 | 1075 | — | pending |
| `mcp/approvalDialogs` | 5 | 412 | — | pending |
| `permissions/ruleModel` | 8 | 910 | — | done |
| `permissions/decision` | 6 | 1026 | — | done |
| `permissions/shellRules` | 5 | 711 | — | done |
| `permissions/filePaths` | 5 | 1002 | `filePermissions.test.ts` (24) | done |
| `permissions/fileRules` | 2 | 641 | — | done |
| `permissions/setup` | 10 | 702 | `autoModeGate.test.ts` (22) | done |
| `permissions/autoModeClassifier` | 13 | 887 | `yoloClassifier.test.ts`, `bashClassifier.test.ts` (82) | done |
| `permissions/toolPermission` | 6 | 985 | — | done |
| `permissions/promptFrame` | 8 | 862 | — | done |
| `permissions/decisionExplanation` | 3 | 815 | — | pending |
| `permissions/shellDialogs` | 7 | 1102 | — | pending |
| `permissions/fileDialogs` | 11 | 1269 | — | pending |
| `permissions/toolDialogs` | 4 | 866 | — | pending |
| `permissions/modeDialogs` | 4 | 787 | — | pending |
| `permissions/askUserQuestion` | 4 | 980 | — | pending |
| `permissions/askUserQuestionViews` | 3 | 893 | — | pending |
| `permissions/sandboxUi` | 7 | 828 | — | pending |
| `permissions/ruleList` | 3 | 1239 | — | pending |
| `permissions/ruleEditors` | 5 | 856 | — | pending |
| `permissions/sessionDialogs` | 4 | 599 | — | pending |

A test file goes to a unit under the same rule as a production file: it goes
to the residue sweep only when it is over 90% own and has fewer than 20
matching lines. Three of the seven listed above pass the first test and fail the
second: `auth.test.ts` (90% own), `filePermissions.test.ts` (95%) and
`autoModeGate.test.ts` (90%). Their matches are runs of `expect(f(x)).toBe(y)`
shape, and the rest is this project's own cases. The `bodies` sandbox takes
these files out, so the unit's characterization carries their cases over
before the rewrite starts.

### Files per unit

- `mcp/core`: `mcp/types.ts`, `mcp/utils.ts`, `mcp/mcpStringUtils.ts`, `mcp/normalization.ts`, `mcp/mcpInstructionsDelta.ts`
- `mcp/config`: `mcp/config.ts`, `mcp/envExpansion.ts`
- `mcp/auth`: `mcp/auth/authFetch.ts`, `mcp/auth/callbackParams.ts`, `mcp/auth/clientSecretStore.ts`, `mcp/auth/oauthErrors.ts`, `mcp/auth/serverKey.ts`, `mcp/auth/tokenRevocation.ts`, `mcp/headersHelper.ts`
- `mcp/connection`: `mcp/client/connection.ts`, `mcp/client/transport.ts`, `mcp/client/fetch.ts`, `mcp/client/authCache.ts`, `mcp/mcpWebSocketTransport.ts`
- `mcp/capabilities`: `mcp/client/fetchCapabilities.ts`, `mcp/client/sdkClients.ts`, `mcp/SdkControlTransport.ts`, `mcp/vscodeSdkMcp.ts`, `mcp/client/ide.ts`, `mcp/claudeai.ts`
- `mcp/callTool`: `mcp/client/callTool.ts`, `mcp/client/toolResult.ts`, `mcp/client/errors.ts`, `mcp/mcpValidation.ts`, `mcp/mcpOutputStorage.ts`
- `mcp/connectionManager`: `mcp/useManageMCPConnections.ts`, `mcp/MCPConnectionManager.tsx`, `mcp/hooks/useMergedClients.ts`
- `mcp/elicitation`: `mcp/elicitationHandler.ts`, `mcp/elicitationValidation.ts`, `mcp/dateTimeParser.ts`
- `mcp/doctor`: `mcp/doctor.ts` (all 620 lines are openclaude's)
- `mcp/elicitationDialog`: `mcp/ui/ElicitationDialog.tsx`
- `mcp/settingsUi`: `mcp/ui/MCPSettings.tsx`, `mcp/ui/MCPListPanel.tsx`, `mcp/ui/McpParsingWarnings.tsx`, `mcp/ui/MCPToolListView.tsx`, `mcp/ui/MCPToolDetailView.tsx`
- `mcp/serverMenus`: `mcp/ui/MCPRemoteServerMenu.tsx`, `mcp/ui/MCPStdioServerMenu.tsx`, `mcp/ui/MCPAgentServerMenu.tsx`, `mcp/ui/CapabilitiesSection.tsx`, `mcp/ui/reconnectHelpers.tsx`, `mcp/ui/MCPReconnect.tsx`
- `mcp/approvalDialogs`: `mcp/mcpServerApproval.tsx`, `mcp/ui/MCPServerApprovalDialog.tsx`, `mcp/ui/MCPServerMultiselectDialog.tsx`, `mcp/ui/MCPServerDialogCopy.tsx`, `mcp/ui/MCPServerDesktopImportDialog.tsx`
- `permissions/ruleModel`: `permissions/PermissionRule.ts`, `permissions/PermissionResult.ts`, `permissions/PermissionMode.ts`, `permissions/permissionRuleParser.ts`, `permissions/permissionsLoader.ts`, `permissions/PermissionUpdateSchema.ts`, `permissions/PermissionUpdate.ts`, `permissions/PermissionPromptToolResultSchema.ts`
- `permissions/decision`: `permissions/permissions.ts`, `permissions/permissions/ruleLookup.ts`, `permissions/permissions/ruleMutation.ts`, `permissions/permissions/requestMessage.ts`, `permissions/permissions/denial.ts`, `permissions/denialTracking.ts`
- `permissions/shellRules`: `permissions/shellRuleMatching.ts`, `permissions/shadowedRuleDetection.ts`, `permissions/dangerousPatterns.ts`, `permissions/permissionSetup/dangerousRuleDetection.ts`, `permissions/permissionSetup/dangerousRuleStash.ts`
- `permissions/filePaths`: `permissions/pathValidation.ts`, `permissions/filePermissions/internalPaths.ts`, `permissions/filePermissions/dangerousPaths.ts`, `permissions/filePermissions/workingDirs.ts`, `permissions/filePermissions/pathCase.ts`
- `permissions/fileRules`: `permissions/filePermissions/readWriteChecks.ts`, `permissions/filePermissions/rulePatterns.ts`
- `permissions/setup`: `permissions/permissionSetup/startupContext.ts`, `permissions/permissionSetup/autoModeGate.ts`, `permissions/permissionSetup/planAutoMode.ts`, `permissions/permissionSetup/cliToolParsing.ts`, `permissions/permissionSetup/modeTransition.ts`, `permissions/permissionSetup/autoModeAvailability.ts`, `permissions/permissionSetup/bypassPermissions.ts`, `permissions/getNextPermissionMode.ts`, `permissions/bypassPermissionsKillswitch.ts`, `permissions/autoModeState.ts`
- `permissions/autoModeClassifier`: `permissions/yoloClassifier/classify.ts`, `permissions/yoloClassifier/transcript.ts`, `permissions/yoloClassifier/prompts.ts`, `permissions/yoloClassifier/xmlResponse.ts`, `permissions/yoloClassifier/autoModeDumps.ts`, `permissions/yoloClassifier/classifierConfig.ts`, `permissions/classifierApprovals.ts`, `permissions/classifierApprovalsHook.ts`, `permissions/classifierDecision.ts`, `permissions/classifierShared.ts`, `permissions/bashClassifier.ts`, `permissions/autoModeRules.ts`, `permissions/autoModeDenials.ts`
- `permissions/toolPermission`: `permissions/useCanUseTool.tsx`, `permissions/toolPermission/PermissionContext.ts`, `permissions/toolPermission/handlers/interactiveHandler.ts`, `permissions/toolPermission/handlers/swarmWorkerHandler.ts`, `permissions/toolPermission/handlers/coordinatorHandler.ts`, `permissions/toolPermission/permissionLogging.ts`
- `permissions/promptFrame`: `permissions/ui/PermissionRequest.tsx`, `permissions/ui/PermissionDialog.tsx`, `permissions/ui/PermissionRequestTitle.tsx`, `permissions/ui/PermissionPrompt.tsx`, `permissions/ui/PermissionRuleExplanation.tsx`, `permissions/ui/hooks.ts`, `permissions/ui/WorkerBadge.tsx`, `permissions/ui/WorkerPendingPermission.tsx`
- `permissions/decisionExplanation`: `permissions/ui/PermissionDecisionDebugInfo.tsx`, `permissions/ui/PermissionExplanation.tsx`, `permissions/permissionExplainer.ts`
- `permissions/shellDialogs`: `permissions/ui/BashPermissionRequest/BashPermissionRequest.tsx`, `permissions/ui/BashPermissionRequest/bashToolUseOptions.tsx`, `permissions/ui/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx`, `permissions/ui/PowerShellPermissionRequest/powershellToolUseOptions.tsx`, `permissions/ui/shellPermissionHelpers.tsx`, `permissions/ui/useShellPermissionFeedback.ts`, `permissions/ui/SedEditPermissionRequest/SedEditPermissionRequest.tsx`
- `permissions/fileDialogs`: `permissions/ui/FilePermissionDialog/FilePermissionDialog.tsx`, `permissions/ui/FilePermissionDialog/permissionOptions.tsx`, `permissions/ui/FilePermissionDialog/useFilePermissionDialog.ts`, `permissions/ui/FilePermissionDialog/usePermissionHandler.ts`, `permissions/ui/FilePermissionDialog/ideDiffConfig.ts`, `permissions/ui/FileEditPermissionRequest/FileEditPermissionRequest.tsx`, `permissions/ui/FileWritePermissionRequest/FileWritePermissionRequest.tsx`, `permissions/ui/FileWritePermissionRequest/FileWriteToolDiff.tsx`, `permissions/ui/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx`, `permissions/ui/NotebookEditPermissionRequest/NotebookEditPermissionRequest.tsx`, `permissions/ui/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx`
- `permissions/toolDialogs`: `permissions/ui/FallbackPermissionRequest.tsx`, `permissions/ui/SkillPermissionRequest/SkillPermissionRequest.tsx`, `permissions/ui/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx`, `permissions/ui/MonitorPermissionRequest/MonitorPermissionRequest.tsx`
- `permissions/modeDialogs`: `permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`, `permissions/ui/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx`, `permissions/ui/AutoModeOptInDialog.tsx`, `permissions/ui/BypassPermissionsModeDialog.tsx`
- `permissions/askUserQuestion`: `permissions/ui/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx`, `.../SubmitQuestionsView.tsx`, `.../QuestionNavigationBar.tsx`, `.../use-multiple-choice-state.ts`
- `permissions/askUserQuestionViews`: `permissions/ui/AskUserQuestionPermissionRequest/QuestionView.tsx`, `.../PreviewQuestionView.tsx`, `.../PreviewBox.tsx`
- `permissions/sandboxUi`: `permissions/ui/sandbox/SandboxSettings.tsx`, `permissions/ui/sandbox/SandboxOverridesTab.tsx`, `permissions/ui/sandbox/SandboxConfigTab.tsx`, `permissions/ui/sandbox/SandboxDependenciesTab.tsx`, `permissions/ui/sandbox/SandboxDoctorSection.tsx`, `permissions/ui/SandboxPermissionRequest.tsx`, `permissions/ui/SandboxViolationExpandedView.tsx`
- `permissions/ruleList`: `permissions/ui/rules/PermissionRuleList.tsx`, `permissions/ui/rules/PermissionRuleDescription.tsx`, `permissions/ui/rules/PermissionRuleInput.tsx`
- `permissions/ruleEditors`: `permissions/ui/rules/AddPermissionRules.tsx`, `permissions/ui/rules/AddWorkspaceDirectory.tsx`, `permissions/ui/rules/RemoveWorkspaceDirectory.tsx`, `permissions/ui/rules/WorkspaceTab.tsx`, `permissions/ui/rules/RecentDenialsTab.tsx`
- `permissions/sessionDialogs`: `permissions/ui/trust/TrustDialog.tsx`, `permissions/ui/trust/utils.ts`, `permissions/ui/WorktreeExitDialog.tsx`, `permissions/ui/CostThresholdDialog.tsx`

## Order and security weight

**What the others depend on.**
- `permissions/ruleModel` comes first. Its types and schemas are imported
  across the tree: `PermissionResult` by 66 production files, and
  `PermissionMode` and `PermissionUpdateSchema` by 35 each. Every other
  permissions unit builds on it.
- `mcp/core` comes first on the MCP side. `types.ts` has 90 production
  importers, `utils.ts` 20 and `mcpStringUtils.ts` 14. It also comes before
  `permissions/decision`, because rule lookup matches `mcp__server__tool` names
  through `mcpStringUtils.ts`.
- `mcp/connection`, `mcp/capabilities` and `mcp/callTool` import each other.
  `connection.ts` and `fetchCapabilities.ts` import one another, and
  `callTool.ts` imports `connection.ts`. Characterize all three through the
  `src/mcp/client.ts` barrel, in the same round. `mcp/auth` and `mcp/config`
  come before them. `mcp/connectionManager` and the MCP UI units come last.
- `permissions/decision` (`hasPermissionsToUseTool` and the rule lookup) sits
  under `permissions/fileRules`, `permissions/setup`,
  `permissions/shellRules` (shadowed-rule detection) and
  `permissions/toolPermission`. It calls the auto-mode classifier, so
  `permissions/autoModeClassifier` comes before it or alongside it.
- `permissions/promptFrame` comes before the other UI units.
  `PermissionRequest.tsx` has 30 production importers, and every dialog renders
  inside `PermissionDialog.tsx`, which has 17.
- `mcp/elicitation` and `mcp/doctor` are leaves, and they can go in any round.

**What carries security weight.** These units decide what runs without asking
the user, so they get the strictest characterization. Probes go on every deny
and ask branch, not just on the allow path.
- **The decision core:** `permissions/decision`, `permissions/ruleModel` (the
  rule parser's escaping and the loader decide which rules are in force) and
  `permissions/toolPermission` (how a decision is routed: interactive, swarm
  worker, coordinator, and the bridge race).
- **The Bash and file rules:**
  - `permissions/shellRules`: wildcard and prefix matching for Bash rules, and the dangerous-rule detection and stash used on entry to auto mode.
  - `permissions/filePaths`: path validation for shell commands, the internal and dangerous paths, and the working directories.
  - `permissions/fileRules`: the read and write checks, and the rule patterns.
- **Auto-approval:** `permissions/autoModeClassifier` and
  `permissions/setup` (the auto-mode gate, the bypass-permissions kill switch,
  and the startup mode).
- **The rule that "always allow" writes:** `permissions/shellDialogs`. The
  editable rule it suggests comes from `shellPermissionHelpers.tsx`. The
  arity-table port showed how a change there widens the default
  ([levers.md](levers.md#replacements), `rm build:*` becoming `rm:*`). Pin the
  suggested rule for one-word and multi-word commands before the rewrite.
- **What gets to run from a checkout:** `permissions/sessionDialogs` (the trust
  dialog, and the checks in `trust/utils.ts` on the settings a repository brings),
  `mcp/approvalDialogs` (the approval of the project's `.mcp.json` servers),
  `mcp/config` (the managed allow and deny policy for MCP servers) and `mcp/auth`
  (OAuth tokens and client secrets; `headersHelper.ts` runs a configured
  command).

## Residue sweep

Production files over 90% this project's own, with fewer than 20 matching
lines. They are swept once the units have landed: 41 lines.

| File | Matching | Lines |
|---|---|---|
| `mcp/auth/claudeAuthProvider.ts` (opencode port) | 16 | 519 |
| `mcp/auth/oauthFlow.ts` (opencode port) | 13 | 336 |
| `mcp/serverStatus.ts` | 2 | 80 |
| `permissions/ui/GitPermissionRequest/GitPermissionRequest.tsx` | 10 | 144 |

Test files, 88 lines in 16 files, each over 90% own: `mcp/client.regression.test.ts` (7),
`autoModeRules.test.ts` (8), `bypassPermissions.test.ts` (3),
`checkBatchReadPermission.test.ts` (2), `checkBatchWritePermission.test.ts` (8),
`classifierProbe.test.ts` (2), `dangerousRuleDetection.test.ts` (10),
`dangerousRuleStash.test.ts` (3), `modeTransition.test.ts` (5),
`permissions.test.ts` (2), `yolo-classifier-prompts/prompts.test.ts` (7),
and the five `yoloClassifier.*.test.ts` suites (deterministicError 6,
fableXmlRouting 6, fallback 4, live 9, stallBudget 6).

Some inherited tests in other slices load phase 3 code, but they belong to their
own phase:
- `terminal/claudinUiSurfaces.test.ts` (49) loads `AddPermissionRules.tsx`;
- `platform/entrypoints/mcp.test.ts` (52) loads the MCP client;
- `tools/BashTool/bashPermissions.test.ts` (44) loads the permission types.

## Cut candidates

**None at file level.** Each of the 176 files was checked in two ways:
- **Importers.** Every file has at least one production importer, in an import graph resolved over `src/`.
- **Build gates.** Every `feature()` gate in both slices is on in the build: `TRANSCRIPT_CLASSIFIER` (51 calls), `BASH_CLASSIFIER` (30), `MONITOR_TOOL` (2) and `BRIDGE_MODE` (1).

The runtime gates of the files most likely to be dead:

| File | Reached from | Runtime gate | Verdict |
|---|---|---|---|
| `mcp/vscodeSdkMcp.ts` | `headless/print/mcpRuntime.ts`; the four write paths call `notifyVscodeFileUpdated` | an SDK MCP server named `claude-vscode` connects over stream-json | kept: an external extension can reach it |
| `mcp/SdkControlTransport.ts`, `client/sdkClients.ts` | `setupSdkMcpClients` in `mcpRuntime.ts` | SDK MCP servers in the stream-json control channel | kept |
| `mcp/ui/MCPServerDesktopImportDialog.tsx` | `claudin mcp add-from-claude-desktop` (`main/commands/mcp.ts`) | macOS and WSL | kept |
| `permissions/ui/MonitorPermissionRequest` | `PermissionRequest.tsx`; `MonitorTool` in `tools.ts` | `MONITOR_TOOL`, on | kept |
| `permissions/ui/CostThresholdDialog.tsx` | `REPL.tsx` and `REPLDialogs.tsx` | `hasConsoleBillingAccess()`: an Anthropic login with org and workspace roles | kept: it needs a login, but a user can reach it |
| `mcp/claudeai.ts` | `config.ts`, `fetchCapabilities.ts`, `useManageMCPConnections.ts` | a claude.ai OAuth token | kept: it needs a login |
| `toolPermission/handlers/coordinatorHandler.ts`, `swarmWorkerHandler.ts`, `ui/WorkerPendingPermission.tsx`, `ui/WorkerBadge.tsx` | `useCanUseTool.tsx`, `REPL.tsx` | coordinator mode and the swarm | kept by the 2026-10-02 reversal |
| `ui/PowerShellPermissionRequest/*` | `PermissionRequest.tsx` | the PowerShell tool | kept by the 2026-10-02 reversal |
| `bypassPermissionsKillswitch.ts` | `REPL.tsx`, `useOnQuery.ts` | `TRANSCRIPT_CLASSIFIER`, on | kept |

**One dead branch inside a kept file.** In `bypassPermissionsKillswitch.ts`,
`useKickOffCheckAndDisableAutoModeIfNeeded` returns early on
`getIsRemoteMode()`. That is always false: `STATE.isRemoteMode` starts false,
and its setter went with the `--remote` TUI. The `bodies` rewrite drops the
branch rather than reproducing it.

These stay, because a user can reach them with an Anthropic login or server:
- the bridge race in `interactiveHandler.ts`;
- the CCR proxy URL unwrapping in `config.ts`;
- the `CLAUDE_CODE_REMOTE` mode filter in `startupContext.ts`.

## Coverage baseline (2026-10-03)

Measured by
`bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage src/mcp src/permissions src/tools/BashTool src/tools/FileEditTool src/tools/FileWriteTool`
(1,368 pass, 2 skip, 0 fail, 76 files), then
`bun run rewrite:coverage --unit <unit>`. The target is 70% for every file. In
the table, "not loaded" means no test in the run imports the file. The
"weighted" column weights each file's line coverage by its inherited lines, and
counts a file that is not loaded as 0.

Only two units start at target, `mcp/doctor` and `permissions/fileRules`. In
the other 31, 139 of their 169 files are below it.

| Unit | Weighted | Below target | Files below target |
|---|---|---|---|
| `mcp/elicitationDialog` | 0% | 1/1 | `ElicitationDialog.tsx` not loaded |
| `mcp/settingsUi` | 0% | 5/5 | all five not loaded |
| `mcp/serverMenus` | 0% | 6/6 | all six not loaded |
| `mcp/approvalDialogs` | 0% | 5/5 | all five not loaded |
| `permissions/sandboxUi` | 0% | 7/7 | all seven not loaded |
| `permissions/ruleList` | 0% | 3/3 | all three not loaded |
| `permissions/ruleEditors` | 0% | 5/5 | all five not loaded |
| `permissions/sessionDialogs` | 0% | 4/4 | all four not loaded |
| `mcp/elicitation` | 1% | 3/3 | `dateTimeParser.ts` and `elicitationValidation.ts` not loaded, `elicitationHandler.ts` 3% |
| `permissions/promptFrame` | 3% | 8/8 | `PermissionRequest.tsx`, `WorkerBadge.tsx` and `WorkerPendingPermission.tsx` not loaded; `PermissionPrompt.tsx` 4%, `PermissionRequestTitle.tsx` 4%, `PermissionDialog.tsx` 5%, `hooks.ts` 6%, `PermissionRuleExplanation.tsx` 7% |
| `permissions/toolDialogs` | 3% | 4/4 | `MonitorPermissionRequest.tsx` not loaded, `FallbackPermissionRequest.tsx` 3%, `SkillPermissionRequest.tsx` 4%, `WebFetchPermissionRequest.tsx` 4% |
| `mcp/config` | 4% | 2/2 | `envExpansion.ts` 0%, `config.ts` 4% |
| `mcp/connectionManager` | 5% | 3/3 | `useMergedClients.ts` and `MCPConnectionManager.tsx` not loaded, `useManageMCPConnections.ts` 6% |
| `permissions/shellDialogs` | 5% | 7/7 | `useShellPermissionFeedback.ts` 2%, `shellPermissionHelpers.tsx` 3%, `bashToolUseOptions.tsx` 4%, `powershellToolUseOptions.tsx` 4%, `SedEditPermissionRequest.tsx` 6%, `BashPermissionRequest.tsx` 7%, `PowerShellPermissionRequest.tsx` 7% |
| `permissions/modeDialogs` | 5% | 4/4 | `AutoModeOptInDialog.tsx` and `BypassPermissionsModeDialog.tsx` not loaded, `EnterPlanModePermissionRequest.tsx` 6%, `ExitPlanModePermissionRequest.tsx` 6% |
| `permissions/askUserQuestion` | 5% | 4/4 | `AskUserQuestionPermissionRequest.tsx` 4%, `QuestionNavigationBar.tsx` 4%, `SubmitQuestionsView.tsx` 6%, `use-multiple-choice-state.ts` 7% |
| `permissions/askUserQuestionViews` | 5% | 3/3 | `QuestionView.tsx` 3%, `PreviewQuestionView.tsx` 5%, `PreviewBox.tsx` 9% |
| `permissions/fileDialogs` | 6% | 11/11 | `ideDiffConfig.ts` 0%, `useFilePermissionDialog.ts` 3%, `NotebookEditPermissionRequest.tsx` 4%, `FilesystemPermissionRequest.tsx` 5%, `permissionOptions.tsx` 6%, `NotebookEditToolDiff.tsx` 6%, `FileEditPermissionRequest.tsx` 7%, `FilePermissionDialog.tsx` 8%, `FileWritePermissionRequest.tsx` 9%, `FileWriteToolDiff.tsx` 9%, `usePermissionHandler.ts` 12% |
| `permissions/decisionExplanation` | 8% | 3/3 | `PermissionDecisionDebugInfo.tsx` 3%, `PermissionExplanation.tsx` 5%, `permissionExplainer.ts` 25% |
| `mcp/connection` | 10% | 5/5 | `fetch.ts` 6%, `transport.ts` 6%, `connection.ts` 7%, `mcpWebSocketTransport.ts` 25%, `authCache.ts` 26% |
| `mcp/capabilities` | 10% | 6/6 | `sdkClients.ts` 6%, `fetchCapabilities.ts` 8%, `SdkControlTransport.ts` 10%, `claudeai.ts` 15%, `ide.ts` 15%, `vscodeSdkMcp.ts` 38% |
| `mcp/core` | 13% | 5/5 | `mcpInstructionsDelta.ts` 0%, `normalization.ts` 0%, `utils.ts` 8%, `types.ts` 18%, `mcpStringUtils.ts` 44% |
| `mcp/callTool` | 19% | 5/5 | `callTool.ts` 3%, `mcpOutputStorage.ts` 8%, `mcpValidation.ts` 26%, `toolResult.ts` 39%, `errors.ts` 62% |
| `permissions/decision` | 35% | 6/6 | `ruleMutation.ts` 3%, `denial.ts` 5%, `denialTracking.ts` 29%, `requestMessage.ts` 34%, `permissions.ts` 39%, `ruleLookup.ts` 61% |
| `permissions/ruleModel` | 37% | 6/8 | `PermissionPromptToolResultSchema.ts` not loaded, `PermissionResult.ts` 0%, `permissionsLoader.ts` 11%, `PermissionUpdateSchema.ts` 12%, `PermissionUpdate.ts` 44%, `PermissionRule.ts` 50% |
| `permissions/toolPermission` | 37% | 5/6 | `coordinatorHandler.ts`, `swarmWorkerHandler.ts` and `useCanUseTool.tsx` not loaded; `interactiveHandler.ts` 46%, `PermissionContext.ts` 57% |
| `permissions/setup` | 45% | 6/10 | `autoModeState.ts`, `bypassPermissionsKillswitch.ts` and `getNextPermissionMode.ts` not loaded; `startupContext.ts` 22%, `planAutoMode.ts` 41%, `modeTransition.ts` 54% |
| `permissions/filePaths` | 68% | 1/5 | `internalPaths.ts` 43% |
| `permissions/autoModeClassifier` | 72% | 4/13 | `autoModeDenials.ts` not loaded, `classifierApprovals.ts` 27%, `classifierApprovalsHook.ts` 40%, `yoloClassifier/classify.ts` 65% |
| `permissions/shellRules` | 74% | 1/5 | `shadowedRuleDetection.ts` 3% |
| `permissions/fileRules` | 79% | 0/2 | — |
| `mcp/auth` | 85% | 1/7 | `headersHelper.ts` 9% |
| `mcp/doctor` | 95% | 0/1 | — |

The dialogs that read 2–9% are loaded but never rendered. The figure is the
module's top level only.

**Two lcov traps** (`.claudin/rules/testing.md`):
- **Feature flags read false under `bun test`.** In these slices that hides
  every `TRANSCRIPT_CLASSIFIER` and `BASH_CLASSIFIER` branch: 81 calls, all on
  in the build. They sit in `interactiveHandler.ts`, `useCanUseTool.tsx`,
  `swarmWorkerHandler.ts`, `permissionLogging.ts`, `yoloClassifier/prompts.ts`,
  `ExitPlanModePermissionRequest.tsx`, `BashPermissionRequest.tsx`, `ui/hooks.ts`,
  `PermissionRuleExplanation.tsx` and `PermissionDecisionDebugInfo.tsx`.
  `interactiveHandler.ts` was already a recorded exception at 46% for this
  reason ([levers-findings.md](levers-findings.md)).
  - **Turning the flags on is no fix.** The same run with `--feature` for the four build flags gives 88 failures, in about 20 of the 76 suites. The suites pin the flags-off behaviour: the plan-mode hard gate, the Bash permission decision and the classifier prompt fallback among them.
  - **One failure looks like a defect.** `classifierProbe.test.ts` fails with `Cannot access 'YOLO_CLASSIFIER_TOOL_NAME' before initialization`. That is an import cycle through `yoloClassifier/classify.ts`, and it only closes with `TRANSCRIPT_CLASSIFIER` on. Whether the bundle hits it is unverified.
  - **What to do.** Characterize the flag-on paths in suites that turn the flag on for themselves, and measure those suites alone.
- **Query-string imports keep one record per file.** No suite in this run
  imports a phase 3 module under a query string, so the numbers above are not
  affected. `oauthFlow.characterization.test.ts` and five of the tool suites use
  the pattern for other modules. When a unit's characterization adds such an
  import, measure the unit with a run limited to its own suites.

This run also leaves out tests in other slices that load phase 3 code. Two
examples are `vcs/diff/hooks/useDiffInIDE.characterization.test.tsx` (which
loads `permissionOptions.tsx`) and `platform/headless/print.test.ts` (which
loads `mcp/config.ts`). A full `bun run test:coverage` can read a few files
higher. Use a unit-scoped run for the gate.
