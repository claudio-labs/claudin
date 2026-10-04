# Spec: `permissions/setup`

Files: `permissions/permissionSetup/{startupContext,autoModeGate,planAutoMode,cliToolParsing,modeTransition,autoModeAvailability,bypassPermissions}.ts`,
`permissions/getNextPermissionMode.ts`, `permissions/bypassPermissionsKillswitch.ts`,
`permissions/autoModeState.ts`.

## Purpose

This unit decides the permission mode a session starts in, and builds the
permission context the session's checks start from. It also owns the rules for
changing mode later:
- the bypass-permissions kill switch;
- the auto-mode gate, and the startup check that moves a session out of auto mode when the gate is closed;
- plan mode borrowing auto mode;
- the order shift+tab walks the modes in.

Startup (`src/platform/main/action/mcpAndPerms.ts`) calls it once. The prompt
footer, the plan tools, the settings watcher, the headless control channel and
the bridge call it on every mode change.

Auto mode exists only when the `TRANSCRIPT_CLASSIFIER` build flag is on. The
shipped build turns it on, so this spec describes the flag-on behaviour unless
a line says otherwise. Under `bun test` the flag reads false. "Flag off" below
gives the answers in that case, which the existing flag-off suites rely on.

## Public contract

The barrel `src/permissions/permissionSetup.ts` re-exports the
`permissionSetup/*` names, and callers import them from there. The barrel also
re-exports the dangerous-rule names, which belong to the `permissions/shellRules`
unit, not to this one. `src/permissions/permissionSetup/autoModeStateBridge.ts`
is not part of this unit. It is the single flag-gated handle on
`autoModeState.ts`, and it must keep working: it loads that module only when
the flag is on.

| Export | Signature | Used by |
|---|---|---|
| `initialPermissionModeFromCLI` | `(args: { permissionModeCli: string \| undefined; dangerouslySkipPermissions: boolean \| undefined }) => { mode: PermissionMode; notification?: string }` | `platform/main/action/mcpAndPerms.ts` |
| `initializeToolPermissionContext` | `(args: { allowedToolsCli: string[]; disallowedToolsCli: string[]; baseToolsCli?: string[]; permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean; addDirs: string[] }) => Promise<{ toolPermissionContext: ToolPermissionContext; warnings: string[]; dangerousPermissions: DangerousPermissionInfo[] }>` | `mcpAndPerms.ts` |
| `parseToolListFromCLI` | `(tools: string[]) => string[]` | `memory/instructions/markdownConfig/toolLists.ts`, `agent/input/processSlashCommand.tsx`, `agent/coordinator/forkedAgent.ts` |
| `parseBaseToolsFromCLI` | `(baseTools: string[]) => string[]` | this unit, tests |
| `isBypassPermissionsModeDisabled` | `() => boolean` | `terminal/state/AppState.tsx`, `platform/settings/applySettingsChange.ts`, `platform/headless/print/controlHandlers.ts`, `platform/bridge/{useReplBridge.tsx,replBridge.ts,bridgeMessaging.ts}` |
| `createDisabledBypassPermissionsContext` | `(ctx: ToolPermissionContext) => ToolPermissionContext` | `AppState.tsx`, `applySettingsChange.ts` |
| `AutoModeUnavailableReason` (type) | `'settings' \| 'circuit-breaker' \| 'model'` | the callers below |
| `AutoModeGateCheckResult` (type) | `{ updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext; notification?: string }` | the callers of `verifyAutoModeGateAccess` |
| `getAutoModeUnavailableNotification` | `(reason: AutoModeUnavailableReason) => string` | `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`, `platform/notifications/useAutoModeUnavailableNotification.ts`, `controlHandlers.ts`, `useReplBridge.tsx` |
| `isAutoModeGateEnabled` | `() => boolean` | `ExitPlanModeV2Tool.ts`, `controlHandlers.ts`, `useReplBridge.tsx`, `replBridge.ts`, `bridgeMessaging.ts`, `permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx` |
| `getAutoModeUnavailableReason` | `() => AutoModeUnavailableReason \| null` | `ExitPlanModeV2Tool.ts`, `useAutoModeUnavailableNotification.ts`, `controlHandlers.ts`, `useReplBridge.tsx` |
| `__autoModeAllowedForModelForTests` | `(model: string) => boolean` | tests |
| `isAutoModeDisabledBySettings`, `autoModeAllowedForModel` (`autoModeAvailability.ts` only, not re-exported) | `() => boolean`, `(model: string) => boolean` | only this unit |
| `verifyAutoModeGateAccess` | `(ctx: ToolPermissionContext) => Promise<AutoModeGateCheckResult>` | `terminal/interactiveHelpers.tsx`, `useAutoModeUnavailableNotification.ts`, `platform/main/defaultAction/headless.ts`, `platform/headless/print/runHeadlessStreaming.ts` |
| `transitionPermissionMode` | `(fromMode: string, toMode: string, ctx: ToolPermissionContext) => ToolPermissionContext` | `terminal/prompt-input/PromptInput.tsx`, `controlHandlers.ts`, `useReplBridge.tsx`, `replBridge.ts` |
| `isDefaultPermissionModeAuto` | `() => boolean` | `mcpAndPerms.ts` |
| `shouldPlanUseAutoMode` | `() => boolean` | `ExitPlanModeV2Tool.ts` |
| `prepareContextForPlanMode` | `(ctx: ToolPermissionContext) => ToolPermissionContext` | `tools/EnterPlanModeTool/EnterPlanModeTool.ts`, `platform/bootstrap/state/sessionArtifacts.ts`, `commands/plan/plan.tsx` |
| `transitionPlanAutoMode` | `(ctx: ToolPermissionContext) => ToolPermissionContext` | `ExitPlanModeV2Tool.ts`, `platform/settings/ui/Config.tsx`, `applySettingsChange.ts`, `ExitPlanModePermissionRequest.tsx` |
| `getNextPermissionMode` (`getNextPermissionMode.ts`) | `(ctx: ToolPermissionContext, teamContext?: { leadAgentId: string }) => PermissionMode` | `PromptInput.tsx`, `platform/teams/TeamsDialog.tsx` |
| `cyclePermissionMode` (same file) | `(ctx: ToolPermissionContext, teamContext?: { leadAgentId: string }) => { nextMode: PermissionMode; context: ToolPermissionContext }` | `PromptInput.tsx` |
| `checkAndDisableAutoModeIfNeeded` (`bypassPermissionsKillswitch.ts`) | `(ctx: ToolPermissionContext, setAppState: (f: (prev: AppState) => AppState) => void) => Promise<void>` | `useAutoModeUnavailableNotification.ts`, `agent/repl/controllers/useOnQuery.ts` |
| `resetAutoModeGateCheck` (same file) | `() => void` | tests (meant for after `/login`) |
| `useKickOffCheckAndDisableAutoModeIfNeeded` (same file) | `() => void`, a React hook that needs an `AppStateProvider` | `agent/repl/REPL.tsx` |
| `setAutoModeActive` / `isAutoModeActive` (`autoModeState.ts`) | `(active: boolean) => void` / `() => boolean` | `ExitPlanModeV2Tool.ts`, `tools/AgentTool/spawnMultiAgent.ts`, `PromptInput.tsx`, `useReplBridge.tsx`, `replBridge.ts`, `ExitPlanModePermissionRequest.tsx`, `permissions/permissions.ts`, `providers/shims/claude/streaming.ts`, `agent/attachments/lifecycle.ts` |
| `setAutoModeFlagCli` / `getAutoModeFlagCli` | `(passed: boolean) => void` / `() => boolean` | `mcpAndPerms.ts` / this unit |
| `setAutoModeCircuitBroken` / `isAutoModeCircuitBroken` | `(broken: boolean) => void` / `() => boolean` | this unit |
| `_resetForTesting` | `() => void` | tests |

`autoModeState.ts` must stay a leaf module. Callers load it with a conditional
`require` behind the build flag.

## Observable behaviour

### 1. Tool lists from the command line

- `parseToolListFromCLI` splits every element on commas and spaces. It trims each entry and drops empty ones, and returns them in order. Elements never join each other.
- Inside parentheses, a comma or a space is part of the rule (`Bash(npm run test, lint)` stays one entry).
- An unclosed `(` keeps the rest of its element as one entry. The next element starts fresh.
- `parseBaseToolsFromCLI` joins the elements with spaces and trims the result.
  - If that names the preset `default` (in any case), it returns the default preset's tool names (`getToolsForDefaultPreset()`).
  - Otherwise it returns the list parsed as above. `[]` gives `[]`.

### 2. The start mode (`initialPermissionModeFromCLI`)

1. The candidates, in order of priority, are:
   - `bypassPermissions` when `--dangerously-skip-permissions` is set;
   - `--permission-mode`, where an unknown name becomes `default`;
   - `permissions.defaultMode` from the merged settings, where policy outranks the `--settings` file, which outranks local, then project, then user.
2. When `CLAUDE_CODE_REMOTE` is truthy, a settings `defaultMode` other than `default`, `acceptEdits` or `plan` is ignored. The flags are not filtered.
3. **The kill switch.** When the merged settings carry `permissions.disableBypassPermissionsMode: "disable"`, every `bypassPermissions` candidate is skipped. The result then carries `notification: "Bypass permissions mode was disabled by settings"`. Any layer can set it, a repository's own settings included.
4. The first remaining candidate wins. With none left, the mode is `default`. `notification` is present only when a bypass candidate was refused.
5. When the result is `auto`, the auto-mode "active" flag is turned on. This happens even when the gate is closed: the startup check (§5) moves the session out later.

### 3. The start context (`initializeToolPermissionContext`)

- **CLI rules.** The `--allowed-tools` rules go to `alwaysAllowRules.cliArg`, normalized: legacy tool names are mapped (`Task` becomes `Agent`), and parentheses inside the content are escaped (`Bash(echo (hi))` becomes `Bash(echo \(hi\))`). The `--disallowed-tools` rules go to `alwaysDenyRules.cliArg` exactly as typed. `alwaysAskRules` starts empty, apart from the rules loaded from disk.
- **Base tools.** With `--base-tools` given and not empty, every default-preset tool that the list does not name is appended to the CLI deny rules, after the `--disallowed-tools` entries and in preset order. Legacy names in the list count under their new name.
- **Rules from disk.** The rules in every settings file are loaded under the key of their source (`userSettings`, `projectSettings`, `localSettings`, `policySettings`, …).
- **Bypass in the mode list.** `isBypassPermissionsModeAvailable` is true when any of these holds and the kill switch is off:
  - the start mode is `bypassPermissions`;
  - `--allow-dangerously-skip-permissions` is set;
  - `permissions.allowBypassPermissionsMode` is true in the user, local, `--settings` or managed settings.

  A repository's `.claudin/settings.json` cannot turn it on.
- **Auto in the mode list.** `isAutoModeAvailable` is set to the live gate (§4). Flag off, the field is absent.
- **Working directories.**
  - The directories in `permissions.additionalDirectories` (merged settings, a repository's included) come first, then `--add-dir`.
  - Each one that exists, and is not already inside a working directory, is added with `source: "cliArg"`, whichever of the two it came from.
  - A path that does not exist, and one already covered, are skipped silently.
  - Anything else adds one warning to `warnings`: a file (the message names the path and says it `is not a directory`), or an empty string.
- **A symlinked PWD.** When `PWD` differs from the session's start directory, and is a symlink that resolves to it, `PWD` is added with `source: "session"`. In every other case nothing is added.
- **`dangerousPermissions`.** Empty unless the start mode is `auto`. In auto mode it lists every allow rule, from disk or `--allowed-tools`, that would let commands through before the classifier sees them (for example `Bash(*)`, `Bash(python:*)`, `Agent(*)`), with `source`, `ruleDisplay` and `sourceDisplay` (`--allowed-tools` for CLI rules, the file path otherwise). The rules are reported, not removed: the caller removes them.

### 4. The auto-mode gate (synchronous)

- **Which models may enter auto mode.**
  - Claude models of family 4.6 or later, and 5.x, are cleared by name, in any case.
  - Claude 3.x, and Claude 4 models before 4.6, are not.
  - Any other model is cleared only by a stored capability probe with `ok: true`, under the key of the active provider's transport, base URL and that model. A failed probe, a probe for another model or endpoint, or no active provider: not cleared.
  - Flag off, no model is cleared.
- `isAutoModeGateEnabled()` is false when any of these holds, and true otherwise:
  - the circuit breaker is latched;
  - `disableAutoMode: "disable"` is set, either at the top level or under `permissions`, in any settings layer, a repository's included;
  - the session's model is not cleared.
- `getAutoModeUnavailableReason()` returns `'settings'`, then `'circuit-breaker'`, then `'model'`, whichever applies first, and `null` when the gate is open.
- `getAutoModeUnavailableNotification` returns:
  - `settings`: `auto mode disabled by settings`
  - `circuit-breaker`: `auto mode is unavailable for your plan`
  - `model`: `auto mode unavailable for this model`

### 5. The startup check (`verifyAutoModeGateAccess`)

- **The circuit breaker.** The check latches the breaker when settings disable auto mode, and releases it otherwise. Flag off, it does nothing to the breaker.
- **The capability probe.** The check probes the session model's capability once when all of these hold: the model is not cleared by name, settings do not disable auto mode, a provider is active, and no result is stored for its key. The probe asks the model for a forced tool call. Its result is stored whatever it is: a tool call is `ok`, while plain text or an error is not. A stored result is never probed again.
- **Gate open.** `notification` is absent, and `updateContext` sets `isAutoModeAvailable: true`. It returns the same object when that was already true. The mode is never changed.
- **Gate closed.** `updateContext` acts on the context it is applied to, not the one that was checked:
  - **In `auto`:** the mode becomes `default`. The allow rules auto mode set aside come back, and the stash is cleared. `isAutoModeAvailable` becomes false, the "active" flag goes off, and the auto-exit notice is queued.
  - **In `plan` running with auto** (`prePlanMode: "auto"`, or a stash present): the mode stays `plan`, and `prePlanMode: "auto"` becomes `"default"`, while any other value is kept. The rules come back, and the flags change as above.
  - **Otherwise:** only `isAutoModeAvailable` becomes false. The same object comes back when it already was false.
- **The notice, closed gate only.** The text is that of the reason, `settings` or `model`, never `circuit-breaker`. It is decided on the context that was checked:
  - in `auto`, or in `plan` running with auto: present;
  - otherwise, when auto was asked for at startup (`setAutoModeFlagCli(true)`): present only if the checked context still offered auto (`isAutoModeAvailable: true`);
  - otherwise absent.
- Flag off, the check behaves the same, except that no model is cleared and no flag is touched.

### 6. The startup check against the app state

- `checkAndDisableAutoModeIfNeeded` runs once per process, until `resetAutoModeGateCheck()` is called. On that run it calls `setAppState` exactly once.
  - The update applies `updateContext` to the state's current `toolPermissionContext`, not to the snapshot it was given.
  - When the context is unchanged and there is no notice, the update returns the previous state object.
  - A notice is appended to `notifications.queue`, after the entries already there, as `{ key: "auto-mode-gate-notification", text, color: "warning", priority: "high" }`.
- Flag off, it never calls `setAppState`.
- `useKickOffCheckAndDisableAutoModeIfNeeded` runs the check on mount. It runs it again, after a reset, whenever `mainLoopModel` or `mainLoopModelForSession` in the app state changes. Other state changes do not re-run it.

### 7. Mode changes (`transitionPermissionMode`)

It returns the context prepared for the new mode, and never sets `mode`: the caller does.

- **Same mode:** the same object back, and no side effect.
- **Plan.**
  - Entering plan withdraws a pending plan-exit notice.
  - Leaving plan queues the plan-exit notice and marks the session as having left plan once. It also clears `prePlanMode`, and returns the same object when there was none to clear.
- **Leaving `auto`** for anything but `plan` queues the auto-exit notice. Entering `auto` from anything but `plan` withdraws it.
- **Flag on:**
  - Entering plan goes through `prepareContextForPlanMode` (§8).
  - Entering `auto` from a mode that is not using auto: when the gate is closed it throws `Cannot transition to auto mode: gate is not enabled`, and turns nothing on. Otherwise the "active" flag goes on, and the allow rules that would pre-empt the classifier move from `alwaysAllowRules` to `strippedDangerousRules`.
  - Leaving a mode that was using auto (`auto` itself, or `plan` while the "active" flag is on) for a mode that is not: the flag goes off, the auto-exit notice is queued, and the stashed rules come back.
  - `plan` with auto active, going to `auto`, is not a new entry: the gate is not asked, and the rules stay aside.

### 8. Plan mode borrowing auto

- **Opting in.** `shouldPlanUseAutoMode()` is true when all three hold:
  - the user opted in: `skipAutoPermissionPrompt: true` in the user, local, `--settings` or managed settings (a repository's `.claudin/settings.json` does not count);
  - the gate is open;
  - none of the same four layers sets `useAutoModeDuringPlan: false`. The repository's settings do not count here either.

  Flag off, it is false.
- `isDefaultPermissionModeAuto()` is true when the merged `permissions.defaultMode` is `auto`, from any layer. Flag off, it is false.
- **`prepareContextForPlanMode`** returns the same object when the context is already in plan. Otherwise it records the current mode as `prePlanMode` and leaves `mode` alone. With the flag on:
  - **From `auto`, opted in:** auto stays on, and the rules stay aside.
  - **From `auto`, not opted in:** the "active" flag goes off, the auto-exit notice is queued, and the rules come back.
  - **From any other mode except `bypassPermissions`, opted in:** the "active" flag goes on, and the rules are set aside.
  - **From `bypassPermissions`:** plan never borrows auto.
- **`transitionPlanAutoMode`** reconciles plan mode with a settings change. It returns the same object when:
  - the flag is off;
  - the context is not in plan;
  - `prePlanMode` is `bypassPermissions`;
  - auto is neither wanted nor on.

  When it is wanted and on, rules reloaded from disk that are risky are set aside again. When it is wanted and off, the "active" flag goes on, the auto-exit notice is withdrawn and the rules are set aside. When it is on and no longer wanted, the flag goes off, the notice is queued and the rules come back.

### 9. Shift+tab (`getNextPermissionMode`, `cyclePermissionMode`)

- **The order:**
  - `default` goes to `acceptEdits`, and `acceptEdits` to `plan`.
  - `plan` goes to `bypassPermissions` when it is offered, else to `auto` when auto may be cycled to, else to `default`.
  - `bypassPermissions` goes to `auto` when auto may be cycled to, else to `default`.
  - `dontAsk`, `auto` and any other mode go to `default`.
- Auto may be cycled to only when the flag is on, the context offers it (`isAutoModeAvailable`) and the gate is open right now.
- `teamContext` changes nothing.
- `cyclePermissionMode` returns the next mode and the context passed through `transitionPermissionMode(current, next, ctx)`.

### 10. The bypass kill switch, later in the session

- `isBypassPermissionsModeDisabled()` is true exactly when the merged settings carry `permissions.disableBypassPermissionsMode: "disable"`, from any layer.
- `createDisabledBypassPermissionsContext` returns a new context with `isBypassPermissionsModeAvailable: false`. A context in `bypassPermissions` moves to `default`. Every other mode, and all rules, are kept, and the input is not changed.

### 11. Session flags (`autoModeState.ts`)

There are three independent booleans: active, asked for on the command line,
and circuit broken. Each starts false, holds the last value it was given, and
goes back to false on `_resetForTesting()`.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `--permission-mode` with an unknown name | `default` |
| Bypass refused, and no other candidate | `{ mode: "default", notification: "Bypass permissions mode was disabled by settings" }` |
| Entering auto through a closed gate | `transitionPermissionMode` throws `Cannot transition to auto mode: gate is not enabled`. The shift+tab path never gets there, because it checks the live gate first |
| A probe request that throws | A stored failure, so the gate stays closed and nothing is thrown |
| `--add-dir` naming a file, or an empty entry | One warning each. The session still starts |
| `--add-dir` naming a missing directory | Skipped silently |
| `--base-tools default` or an empty list | No extra deny rules |

## Security requirements

These decide what runs without asking. The tests pin each one, and the probe
spec mutates every refusal.

- The bypass kill switch refuses bypass from every source (the skip flag, `--permission-mode` and `defaultMode`) and removes it from the mode list. Any settings layer can set it. Revoking it later moves a session out of `bypassPermissions`.
- Only the user, local, `--settings` and managed settings can offer bypass without the flag. A repository's own settings cannot.
- Auto mode is entered only through an open gate: settings, the circuit breaker and the model can each close it. The start mode is the one exception, and the startup check moves that session out (§2.5, §5).
- Rules that would let commands through before the classifier sees them are set aside on every entry to auto, and on plan borrowing auto. They come back on every exit. A reload during plan with auto sets them aside again.
- Plan mode borrows auto only after an opt-in from a trusted layer. It never does so after entering from `bypassPermissions`. A repository can neither opt in nor opt out.
- A stored failed probe keeps a model out of auto until something re-probes it. The check never probes when settings disable auto.

## Tests that pin it

- `src/permissions/permissionSetup/setup.characterization.test.ts` covers the flag-independent behaviour (§1–3, the kill switch, the reasons, the shift+tab order, the mode-change notices and the session flags). It also has a flag-off block.
- `src/permissions/permissionSetup/setup.autoGate.characterization.test.tsx` covers §4–6, the auto start, and the hook, which it mounts on the fake terminal. The probe's model call is the only thing replaced.
- `src/permissions/permissionSetup/setup.autoModes.characterization.test.ts` covers §7–9 with the flag on.
- The two `auto*` suites need the flag. Under the plain runner, each starts a flagged child run of itself (`__testutils__/shippedFlag.ts`). Measure them with `bun test --feature=TRANSCRIPT_CLASSIFIER <suites> --coverage`.
- All settings are real files in a temp tree, with the managed directory redirected (`__testutils__/permissionScene.ts`).
- `scripts/migrations/probes/rewrite-permissions-setup.json` has 40 probes over all ten files, and every one turns the suites red.
- These pre-existing suites also exercise the unit, and must stay green: `src/permissions/{modeTransition,bypassPermissions,cliToolParsing,permissionSetup.surface}.test.ts` and `src/permissions/permissions.test.ts`.
- `src/permissions/autoModeGate.test.ts` was folded in and deleted.
- `scripts/migrations/probes/permissionSetup.json` and `forkDefaults.json` quote this unit's old code, or list the deleted test. They are retired or re-pointed with the rewrite.

No text in this unit is sent to a model. The capability probe's prompt belongs
to `permissions/classifierProbe.ts`. No file outside the unit pins the notice
texts byte for byte, apart from the two older probe specs above.

## Out of scope

- **Cut: the remote-mode early return in the model-change hook.** The hook skips the check when the session is in remote mode, but nothing in the tree can set remote mode (the flag is false from boot, and it has no setter). The branch never runs. The rewrite drops it.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **A repository can start a session in `bypassPermissions`.** `defaultMode: "bypassPermissions"` in a checkout's `.claudin/settings.json` (or `settings.local.json`) is honoured as the start mode, and so bypass is also offered in the mode list. This unit sets no limit on it. In an interactive session, the caller shows the bypass confirmation unless a trusted layer has skipped it. Headless (`-p`) sessions have no such confirmation, so in that checkout they run with no permission checks. `defaultMode: "auto"` from a repository is honoured too, behind the classifier. | **Keep for parity** in this unit. Teams and CI setups can depend on a checked-in `defaultMode`, so dropping it is not invisible hardening. Route to `permissions/sessionDialogs` (the trust boundary) for a decision: the fix would ignore a repo-controlled bypass `defaultMode`, or confirm it, in headless runs. |
| 2 | **A repository can widen the working directories.** `permissions.additionalDirectories` from the project or local settings is added like `--add-dir`, with source `cliArg`. A checkout can therefore put any existing directory inside the file tools' working scope. Relative entries resolve against the process's directory, not the settings file's. | **Keep for parity.** Monorepo setups rely on it, and the source label drives what `/permissions` shows. Route to `permissions/filePaths` together with finding 1. |
| 3 | **A comma or space after nested parentheses splits a rule.** In `Bash(f(x) y)`, the inner `)` ends the parenthesized part, so the list parse returns `Bash(f(x)` and `y)`, two malformed rules. On `--disallowed-tools`, that silently weakens a deny. | **Fix.** Track nesting depth, so that only the outermost `)` closes. No caller can depend on getting two broken rules. Not pinned. |
| 4 | **Auto starts before the gate is checked.** A start mode of `auto` turns auto on even when the model or settings close the gate. The startup check corrects it moments later, with a notice. | **Keep for parity.** Callers rely on the start mode reflecting what was asked for. The notice explains the move out. |
| 5 | **The circuit-breaker notice mentions a plan.** In this fork, only a settings disable latches the breaker. The `circuit-breaker` reason shows up only when that setting was removed mid-session, before the next check, and its text then says "unavailable for your plan". | **Keep for parity.** The text reaches the headless control channel and the plan tool, and nothing that is shown is wrong enough to justify a change. |
| 6 | **Deny rules from the command line are not normalized.** Allow rules are. Matching normalizes legacy names, so the effect is cosmetic: `/permissions` shows `Task`. | **Keep for parity.** |

## Target design

- **Split by question, not by caller.**
  - The start mode is a pure function of the flags, the merged settings and the environment, plus one side effect (auto on).
  - The start context is a builder that takes its inputs explicitly (rules from disk, settings, directories), with the directory validation injected.
  - The gate is a synchronous predicate over a small snapshot (settings disable, breaker, model clearance), with the reason computed from the same snapshot, so the two cannot disagree.
  - The startup check is the asynchronous step: probe if needed, then return the context transform and the notice.
  - The mode transitions and the plan-borrowing rules are one module of pure context transforms. Their session-flag effects go through one small interface.
- **Keep the flag handle single.** Read auto-mode state only through `autoModeStateBridge.ts`. Do not add a second `feature()` site for the same flag (see that file's header).
- **Types.** Name the layer set that is trusted to opt in or offer bypass (user, local, `--settings`, managed) once, and use it for both questions. Model the closed-gate reason as the union above. `teamContext` is unused, but stays in the signature until `TeamsDialog.tsx` and `PromptInput.tsx` are rewritten.
- **Findings.** Apply finding 3. Leave findings 1 and 2 to the routed units.

## Outcome

Rewritten per method on 2026-10-03.
- **What changed.** All 29 inherited bodies were written anew.
  - `trustedSettings.ts` names the trusted settings layers once. The bypass
    offer and the plan opt-in both use it.
  - `autoSession.ts` is now the only place auto mode is switched on or off.
  - `startup/startMode.ts` (a pure function) and `startup/startContext.ts` hold
    the start-up choice.

  The three characterization suites pass unchanged, both plain and with
  `TRANSCRIPT_CLASSIFIER`.
- **Fix, tested.** Finding 3: parentheses are counted by depth, so
  `Bash(f(x) y)` stays one rule.
- **Cut.** The `getIsRemoteMode()` early return.
- **Kept for parity.** Findings 1, 2 and 4–6, with findings 1 and 2 tracked in
  `bugs/permission-core-security-findings.md`. A repository can still choose
  bypass or auto as the start mode, and its `additionalDirectories` still join.
- **Deviation.** A refused entry into auto throws before any notice changes.
- **Probes.**
  - `rewrite-permissions-setup.json` holds 111 probes.
  - The older `permissionSetup.json` (20 probes) and `forkDefaults.json` (2)
    were re-pointed at the new code with the same mutations. None were
    deleted, and every one still goes red.
- **Residue, reviewed.** 85 lines of Claude Code remain. They are signatures,
  and the module-level auto-mode state in `autoModeState.ts`, whose
  getter/setter pairs the contract dictates.
