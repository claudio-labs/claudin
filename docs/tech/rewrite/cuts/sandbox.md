# Cut: the Bash command sandbox (decided 2026-10-04)

**Why it is dead.** `scripts/build/build.ts` lists `@anthropic-ai/sandbox-runtime` among the
`native-stub` modules, and every function of that stub returns `null`. So
`SandboxManager.isSupportedPlatform()` is falsy, `isSandboxingEnabled()` is false, `/sandbox` is
hidden and refuses, and every sandbox branch in the shipped bundle is unreachable. Tests see the same
thing through `src/stubs/test-preload.ts`. The real package exists under Apache-2.0. The user chose
to cut the feature as dead code rather than enable it.

**Size.** About 2,100 inherited lines in the deleted files (2,018 Claude Code, 84 openclaude), plus
the branches removed from roughly 60 surviving files.

## Order

1. **Throw-probe.** Make the sandbox-only bodies throw (`sandbox-adapter`'s manager, `shouldUseSandbox`,
   the startup blocks), then run the full `bun test`, build, smoke and a real interactive boot. All
   green proves them unreachable. Revert the probe.
2. **Pin the surviving surface.** The edit sites below are already pinned by the phase-3
   characterizations in their unsandboxed form. Remove only the probes that mutate sandbox code, and
   say so in the commit.
3. **Delete**, in one commit, at file granularity, checking each file's importers first.
4. **Gates:** typecheck, full `bun test`, build, smoke, `verify:privacy`, `provenance:baseline`,
   `deadcode:baseline`, and the commands registry snapshot (it drops `sandboxToggle`).

## Delete

- `src/platform/sandbox/` (`sandbox-adapter.ts`, `sandbox-ui-utils.ts`)
- `src/platform/entrypoints/sandboxTypes.ts`
- `src/permissions/ui/sandbox/`
- `src/permissions/ui/SandboxPermissionRequest.tsx`
- `src/permissions/ui/SandboxViolationExpandedView.tsx`
- `src/commands/sandbox-toggle/`
- `src/agent/repl/controllers/useSandboxAsk.ts`
- `src/terminal/prompt-input/SandboxPromptFooterHint.tsx`
- `src/tools/BashTool/shouldUseSandbox.ts`, plus `shouldUseSandbox.test.ts` and
  `safeAnnotateStderrWithSandboxFailures.test.ts`
- `src/stubs/sandbox-runtime-stub.ts`, the test-preload mock, the build stub entry,
  `bunfig.toml:2`, and `src/stubbed-modules.d.ts:115`

## Edit sites (keep the sandbox-off branch)

- **Permissions:** `bashPermissions/decide.ts` and `gates.ts` (the auto-allow), `permissions.ts`
  (`sandboxWillContain`), `pathValidation.ts` (the write allowlist), `shadowedRuleDetection.ts`,
  `PermissionDecisionDebugInfo.tsx`, `AddPermissionRules.tsx`, `BashPermissionRequest.tsx` (the
  sandboxed title and options), and the `sandboxOverride` decision reason (`shared/types/permissions.ts`,
  `requestMessage.ts`, `reasonLine.tsx`).
- **Shell:** `shared/proc/Shell.ts`, `platform/shell/{shellProvider,bashProvider,powershellProvider}.ts`,
  `BashTool/{runShellCommand,BashTool,bashSchemas,prompt,BashToolResultMessage,readOnlyValidation}`
  and `PowerShellTool`. The model-visible schema already omits `dangerouslyDisableSandbox`. Removing
  `getSimpleSandboxSection()` changes the Bash description by one blank line.
- **REPL and startup:** `REPL.tsx`, `REPLDialogs.tsx`, `REPLTranscriptView.tsx`,
  `getFocusedInputDialog.ts`, `useReplLifecycle.ts`, `AppStateStore.ts`, `startupSequence.ts`,
  `Notifications.tsx`, `runHeadless.ts`, `structuredIO.ts`, `lifecycle.ts`, `commands.ts`,
  `add-dir.tsx`, `cd.ts`, `Status.tsx`, `status.tsx`, `Doctor.tsx`, `doctorContextWarnings.ts`,
  `doctorDiagnostic.ts`, `execHttpHook.ts`, `FallbackToolUseErrorMessage.tsx`, `processBashCommand.tsx`
  and `TaskOutputTool.tsx`.
- **Settings:** the `sandbox:` key in `platform/settings/types.ts` and in `settings.ts`. The schema is
  `.passthrough()`, so old settings files still validate.
- **Swarm:** sandbox-permission plumbing in `teammateMailbox.ts`, `permissionSync.ts`,
  `useSwarmPermissionPoller.ts`, `useInboxPoller.ts` and `inProcessTeammateHelpers.ts`. It only
  works with the cut subsystem, so it is cut too.
- **Kept:** the remote bridge's `--sandbox` boolean. It is the bridge's own flag, not this
  subsystem.

## Probes removed with the code

- `rewrite-permissions-decision.json`: the `shouldUseSandbox` probe.
- `rewrite-permissions-filePaths.json`: 7 probes on the sandbox write allowlist.
- `rewrite-permissions-shellRules.json`: 4 probes on `askIsBypassedBySandbox`.
- `rewrite-permissions-shellDialogs.json`: the sandboxed-title probe.
- `rewrite-permissions-decisionExplanation.json`: the `sandboxOverride` reason probe.
- `permissions/sandboxUi`: its characterization is not landed. The unit is dropped from
  `units/phase-3.json`.
