# Spec: `permissions/modeDialogs`

Files: `permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`,
`permissions/ui/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx`,
`permissions/ui/AutoModeOptInDialog.tsx`, `permissions/ui/BypassPermissionsModeDialog.tsx`.

## Purpose

These four dialogs are where the user agrees to a change of permission mode:
- **The bypass warning.** Before an interactive session starts in `bypassPermissions`, startup shows it. Its accept is remembered, and every other answer ends the process.
- **The auto-mode consent.** Startup shows it before a session starts in `auto`, and the prompt shows it when shift+tab first reaches auto.
- **The plan-tool dialogs.** The model's EnterPlanMode tool asks through one of them. Its ExitPlanMode tool asks through the other, "Ready to code?", which also picks the mode the session works in after the plan.

Two of the dialogs change the mode themselves:
- **The bypass warning** lets the session start in bypass, where nothing is asked again.
- **The plan-exit dialog** sends a mode update with the approval, or switches the session to auto right away.

So the security question for this unit is simple. No answer may lead into a
more permissive mode than the one the user picked.

Auto mode exists only with the `TRANSCRIPT_CLASSIFIER` build flag, which the
shipped build turns on. Under the plain `bun test` the flag is off. "Flag on"
marks behaviour that only the shipped build has.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `BypassPermissionsModeDialog` | component, props `{ onAccept(): void }` | `terminal/interactiveHelpers.tsx` (startup, when the start mode is bypass or `--allow-dangerously-skip-permissions` is given, unless the skip is already recorded) |
| `AutoModeOptInDialog` | component, props `{ onAccept(): void; onDecline(): void; declineExits?: boolean }` | `terminal/interactiveHelpers.tsx` (startup in auto: `declineExits`, and `onDecline` exits with code 1), `terminal/prompt-input/PromptInput.tsx` (shift+tab into auto: decline reverts the mode) |
| `AUTO_MODE_DESCRIPTION` | `string` | the dialog, `agent/repl/REPL.tsx` (a warning system message when auto turns on), `commands/auto-mode-setup/EnableAutoMode.tsx` |
| `EnterPlanModePermissionRequest` | component, props `PermissionRequestProps` | `permissions/ui/PermissionRequest.tsx` (the `EnterPlanModeTool` route) |
| `ExitPlanModePermissionRequest` | component, props `PermissionRequestProps` (it uses `setStickyFooter` when given) | `PermissionRequest.tsx` (the `ExitPlanModeV2Tool` route) |
| `buildPermissionUpdates` | `(mode: PermissionMode, allowedPrompts?: AllowedPrompt[]) => PermissionUpdate[]` | `REPL.tsx` (applies the mode of a clear-context plan message) |
| `autoNameSessionFromPlan` | `(plan: string, isClearContext: boolean) => void` | this unit (tests) |
| `buildPlanApprovalOptions` | `(args: { showClearContext: boolean; usedPercent: number \| null; isAutoModeAvailable: boolean \| undefined; isBypassPermissionsModeAvailable: boolean \| undefined; onFeedbackChange: (v: string) => void }) => OptionWithDescription<string>[]` | this unit (tests) |

`PermissionRequestProps` and `ToolUseConfirm` belong to `permissions/promptFrame`.
The plan dialogs report only through them: `onDone()` and `onReject()` of the
caller, and `toolUseConfirm.onAllow(input, updates, feedback?)` and
`toolUseConfirm.onReject(feedback?, imageBlocks?)` of the request. Every answer
listed below gives the exact calls, in order. An answer not listed makes no call.

## Observable behaviour

### 1. The bypass warning (`BypassPermissionsModeDialog`)

- **What it shows.** A frame titled `WARNING: Claudin running in Bypass Permissions mode`, in the error colour. The text states that:
  - Claudin will not ask for approval before running potentially dangerous commands;
  - the mode is meant for a sandboxed container or VM, with restricted internet access, that can easily be restored;
  - by proceeding, the user accepts all responsibility.

  It links `https://code.claude.com/docs/en/security`. The answers are `1. No, exit` (focused) and `2. Yes, I accept`.
- **Accept** (`2`, or down and Enter):
  - `skipDangerousModePermissionPrompt: true` is merged into the **user** settings file (`$CLAUDIN_CONFIG_DIR/settings.json`). Every other key is kept, and nothing is written in the checkout.
  - Then `onAccept()` is called once. By then the skip can already be read back.
- **Decline** (Enter on the focused answer, or `1`): the process exits with code **1**. `onAccept` is not called, and no settings are written.
- **Esc**: the process exits with code **0**, also without accepting or writing.
- **A single Ctrl+C** does nothing: no acceptance, and no exit.
- The dialog itself never changes the permission mode. The session runs in the mode startup chose, or does not run at all.

### 2. The auto-mode consent (`AutoModeOptInDialog`, `AUTO_MODE_DESCRIPTION`)

- **`AUTO_MODE_DESCRIPTION`** is one line. It must state that:
  - auto mode handles permission prompts automatically;
  - it checks each tool call for risky actions and prompt injection before executing;
  - actions judged safe run, while risky ones are blocked and Claudin may try a different approach;
  - it suits long-running tasks;
  - sessions are slightly more expensive;
  - Claudin can make mistakes that let harmful commands run, so it should only be used in isolated environments;
  - Shift+Tab changes the mode.

  It names the product as Claudin.
- **What it shows.** A frame titled `Enable auto mode?`, in the warning colour, holding the description and the security link. The answers, in order:
  1. `Yes, and make it my default mode` (focused)
  2. `Yes, enable auto mode`
  3. `No, exit` with `declineExits`, or `No, go back` without it
- **The answers.** Every write goes to the user settings file by deep merge, and never to the checkout.

| Answer | Written to the user settings | Callback |
|---|---|---|
| 1 | `skipAutoPermissionPrompt: true` and `permissions.defaultMode: "auto"`. Other `permissions` keys stay, and a previous `defaultMode` is replaced | `onAccept()` once |
| 2 | `skipAutoPermissionPrompt: true` only. An existing `defaultMode` is kept | `onAccept()` once |
| 3, or Esc | nothing | `onDecline()` once |

  With no user settings file, an accept creates it.
- The dialog neither exits nor changes the mode. Its callers do both.

### 3. Entering plan mode (`EnterPlanModePermissionRequest`)

- **What it shows.** A plan-coloured permission frame titled `Enter plan mode?`, with a worker's badge in the title when one is given. The text says that:
  - Claude wants to enter plan mode to explore and design an implementation approach;
  - in plan mode it will explore the codebase thoroughly, identify existing patterns, design an implementation strategy, and present a plan for approval;
  - no code changes will be made until the plan is approved.

  The answers are `1. Yes, enter plan mode` (focused) and `2. No, start implementing now`.
- **Yes:**
  - When the current mode is not `plan`, a pending plan-exit notice is withdrawn. From `plan`, nothing is.
  - Then: caller `onDone()`, and `onAllow({}, [{ type: "setMode", mode: "plan", destination: "session" }])`.
  - The app state's mode is left for the permission pipeline to change.
- **No, or Esc:** caller `onDone()`, caller `onReject()`, then the request's `onReject()` with no arguments. The notice is not touched.

### 4. Leaving plan mode: what "Ready to code?" shows (`ExitPlanModePermissionRequest`)

- **The plan** is read from the session plan file, never from `input.plan`. The plan file is the one at `getPlanFilePath()`.
  - It is rendered as Markdown under `Here is Claude's plan:`, inside a plan-coloured permission frame titled `Ready to code?`.
  - Under the plan comes the explanation of the request's `permissionResult`, then `Claude has written up a plan and is ready to execute. Would you like to proceed?` and the answers.
- **The answers** (`buildPlanApprovalOptions`) depend on the context's `isAutoModeAvailable` and `isBypassPermissionsModeAvailable`, and on the `showClearContextOnPlanAccept` setting.
  1. **Clear-context slot**, only when that setting is on. Auto wins over bypass, and bypass over edits:
     - `Yes, clear context{u} and use auto mode` (flag on, auto offered)
     - `Yes, clear context{u} and bypass permissions` (bypass offered)
     - `Yes, clear context{u} and auto-accept edits` (otherwise)
  2. **Keep-context slot**, always present, with the same order:
     - `Yes, and use auto mode` (flag on, auto offered)
     - `Yes, and bypass permissions` (bypass offered)
     - `Yes, auto-accept edits` (otherwise)
  3. `Yes, manually approve edits`.
  4. A text field labelled `No, keep planning`, with the placeholder `Tell Claudin what to change` and the hint `shift+tab to approve with this feedback`.

  `{u}` is ` (N% used)` in the dialog. N is the share of the model's context window filled by the request's input tokens, cache writes and cache reads. Output tokens do not count. 3,000 input and 1,000 cache-read tokens on `claude-sonnet-4-6` show `2%`, and 50k + 30k + 20k show `50%`. Through `buildPlanApprovalOptions`, `usedPercent: null` leaves `{u}` out.

  Flag off, auto is never offered.
- **The values** `buildPlanApprovalOptions` returns, slot by slot:
  1. the clear-context slot: `yes-auto-clear-context`, `yes-bypass-permissions`, or `yes-accept-edits`;
  2. the keep-context slot: `yes-resume-auto-mode`, or else `yes-accept-edits-keep-context` (for both its bypass and its edits labels);
  3. `yes-default-keep-context`;
  4. `no`, the only option of `type: "input"`. Its `onChange` is `onFeedbackChange`.
- **Requested prompts.** When the Bash classifier is on, the request's `input.allowedPrompts` are listed under `Requested permissions:`, one line each, as `· {tool}(prompt: {prompt})`. Otherwise they are not shown.
- **The editor hint.** `ctrl-g to edit in {editor}` shows the display name of `$VISUAL` or `$EDITOR`, followed by `· {plan file path}`.
- **The sticky footer.** When `setStickyFooter` is given and the plan is not empty, the question and the answers move to the footer, which reads `Would you like to proceed?`. The editor hint and the saved note go with them, and the in-frame question is not drawn. The footer's bottom border carries the working directory and branch, as the prompt's border does. The footer is cleared when the dialog goes away.

### 5. Leaving plan mode: the answers

The table assumes the auto-mode "active" flag is off. §6 covers it being on.
"Plan exit marked" means that the session has left plan mode once and that a
plan-exit notice is pending.

| Answer | Reported, in order | Session effects |
|---|---|---|
| Keep-context slot, edits label | `onDone()`, `onAllow(input, [setMode acceptEdits], feedback)` | plan exit marked |
| Keep-context slot, bypass label | `onDone()`, `onAllow(input, [setMode bypassPermissions], feedback)` | plan exit marked |
| `Yes, manually approve edits` | `onDone()`, `onAllow(input, [setMode default], feedback)` | plan exit marked |
| Clear-context slot | `onDone()`, caller `onReject()`, request `onReject()` | see below |
| Shift+tab, setting off | the keep-context slot's answer, so **bypass** when bypass is offered | as that answer |
| Shift+tab, setting on | the clear-context answer **with `acceptEdits`**, whatever the slot offers | as that answer |
| Esc | `onDone()`, caller `onReject()`, request `onReject()` | none |
| Enter on `No` with nothing typed, or only spaces | the same as Esc | none |
| Enter on `No` with text typed | `onDone()`, caller `onReject()`, request `onReject(trimmedText, undefined)` | none |

- **The setMode updates** are `{ type: "setMode", mode, destination: "session" }`.
  - When the Bash classifier is on and the request carries `allowedPrompts`, an `addRules` update follows: `{ toolName: tool, ruleContent: "prompt: " + prompt }` for each, with `behavior: "allow"` and `destination: "session"`.
  - `buildPermissionUpdates(mode, prompts)` builds exactly this list. It reports the mode in its external form, so `auto` becomes `default`.
- **The input** is `{}`, unless the plan was changed through ctrl+g in this dialog. Then it is `{ plan: editedText }`.
- **Feedback** text typed under `No` is trimmed and passed as the third argument of `onAllow` when an approval follows (empty becomes `undefined`). Images pasted there are not passed on an approval.
- **The keep-context answers** leave the app state's mode alone. The update carries it, and the dialog sets no message for the next turn.
- **The clear-context answers** set `initialMessage` in the app state to:
  - `clearContext: true`;
  - `mode`: `acceptEdits` for the edits label, or `bypassPermissions` for the bypass label;
  - `allowedPrompts`: the request's, as given;
  - `message`: a user message carrying `planContent` (the plan text), whose content is the prompt below.

  "Plan exit marked" is then only half true: the session has left plan once, but no plan-exit notice is raised.
- **The prompt sent to the model** on clear-context must, in this order:
  - open with `Implement the following plan:`, a blank line, and the plan text verbatim;
  - give the transcript path of the current session (`getTranscriptPath()`, captured before the context is cleared), saying it holds the earlier details: exact code snippets, error messages, generated content;
  - with agent teams enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` or `--agent-teams`), suggest breaking the plan into multiple independent tasks and naming the `TeamCreate` tool to create a team;
  - when feedback was typed, end with `User feedback on this plan: {trimmed feedback}`.
- **Images under `No`.** A pasted image file shows as `[Image #n]` and can be removed again with Delete. Then Enter on `No`:
  - with an image only: `onReject("(See attached image)", [imageBlock])`;
  - with text as well: `onReject(text, [imageBlock])`.

  An image block is `{ type: "image", source: { type: "base64", media_type, data } }`, after the usual resize.
- **Ctrl+G** opens `$VISUAL`/`$EDITOR` on the plan file itself.
  - On return, the plan shown is the file's new content, and `Plan saved!` appears for 5 seconds. It appears even when nothing changed.
  - The approval input carries the plan only when the content changed.
  - An editor that exits non-zero raises the notification `{ key: "external-editor-error", text: "{Editor} exited with code {n}", color: "warning", priority: "high" }`, and the plan is left as it was.
- **The empty plan.** With no plan file, or only whitespace in it, the dialog is a short `Exit plan mode?` frame: `Claude wants to exit plan mode`, with `1. Yes` and `2. No`.
  - Yes: `onDone()`, `onAllow({}, [setMode default])`, plan exit marked. The mode is always `default`, even when bypass or auto is offered.
  - No, or Esc: as Esc above.
  - It never uses the sticky footer.

### 6. Leaving plan mode with auto (flag on)

- **"Yes, and use auto mode"**: the gate (`isAutoModeGateEnabled()`) is checked when the answer is given, not when the dialog opened.
  - **Gate open:** the app state's context becomes `mode: "auto"`, `prePlanMode` cleared, and the allow rules that would let commands past the classifier (for example `Bash(*)`) are moved to `strippedDangerousRules`. The auto-mode "active" flag goes on, and plan exit is marked. Reported: `onDone()`, then `onAllow(input, [], feedback)`, with no updates.
  - **Gate closed:** it behaves as `Yes, manually approve edits` (setMode `default`), and auto stays off.
- **"Yes, clear context and use auto mode"**:
  - Gate open: `initialMessage.mode` is `auto` and the "active" flag goes on.
  - Gate closed: the mode is `default` and the flag stays off.

  The context itself is not changed: the REPL prepares it when it sends the message.
- **Auto was running during the plan** (the "active" flag is on). Any approval that does not end in auto turns it off. That covers the manual, edits, bypass, shift+tab and clear-context answers, the auto answer once the gate has closed, and the empty plan's Yes. In each case:
  - the "active" flag goes off and the auto-exit notice is raised;
  - the context's set-aside rules go back into `alwaysAllowRules`, the stash is emptied, and `prePlanMode` is cleared;
  - then the answer proceeds as in §5.

  An answer that ends in auto (gate open), `No`, or Esc leaves the flag on, the rules aside, and `prePlanMode` as it was.

### 7. Naming the session after the plan (`autoNameSessionFromPlan`)

- Every approval with a plan triggers it: the clear-context, keep-context and shift+tab answers, but not the empty plan's Yes. `No` and Esc never do.
- **It does nothing when:**
  - session persistence is off;
  - the user keeps no transcripts (`cleanupPeriodDays: 0`);
  - the session already has a title, for a keep-context answer only.
- **Otherwise** it asks the small model for a name, sending the **first** 1,000 characters of the plan.
  - When a name comes back and the session still has no title, the name becomes the current session's title and is appended to its transcript as a custom-title line.
  - An unusable reply or a failed request leaves the title alone and throws nothing.
  - A title present when the reply arrives is never overwritten. That includes the clear-context case, which asks even when a title exists.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| User settings file holds invalid JSON, bypass accepted | `onAccept()` is still called; the file is left as it was, so the skip is not recorded and the warning returns next start |
| Auto-mode gate closes between showing and answering | The auto answers fall back as in §6; the session does not enter auto |
| `input.plan` differs from the plan file | The file wins on screen and in the clear-context message |
| Plan file missing or blank | The short `Exit plan mode?` dialog |
| Enter on an empty `No` field | Declines like Esc, with no reason |
| Editor exits non-zero | Warning notification; plan unchanged; no saved note |
| Image paste of a file that is not an image | Treated as pasted text (paste handling belongs to the terminal) |
| Small-model naming fails | Nothing visible; no title |

## Security requirements

These are the paths into a more permissive mode. The tests pin each one, and
the probe spec mutates each one.

- **The bypass warning.** The focused answer and Esc both end the process, and only an explicit accept lets the session continue in bypass. The skip is written only to the user's own settings, never to the checkout.
- **The auto consent.** The consent and the "default mode" write go only to the user's own settings, and declining writes nothing.
- **Entering plan mode** sends a session-scoped update, never a persisted one.
- **The plan exit.** A plan approval leads into bypass only through an answer labelled with bypass, through shift+tab when the keep-context slot offers bypass, or through the empty-plan path, which always leads to `default`.
- **Auto, entered from the plan dialog.** It requires the gate to be open at the moment of the answer, and entering it sets the risky allow rules aside.
- **Auto, left from the plan dialog.** Leaving a plan that ran with auto, by any route but auto, turns auto off and gives the rules back.

## Tests that pin it

- `src/permissions/ui/BypassPermissionsModeDialog.characterization.test.tsx`. The exits are driven in a child `bun test` of the same file, which reports its exit code and whether it accepted.
- `src/permissions/ui/AutoModeOptInDialog.characterization.test.tsx`.
- `src/permissions/ui/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.characterization.test.tsx`.
- `src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.characterization.test.tsx`, with the flags off. The small-model naming request is the only thing replaced.
- `src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.shipped.characterization.test.tsx`, with `TRANSCRIPT_CLASSIFIER` on. Under the plain runner it starts a flagged child run of itself.
- Shared harness: `src/permissions/ui/__testutils__/modeDialogsRig.tsx` (the request ledger, the plan file, the sticky-footer host, the editor and image helpers) and `promptFrameRig.tsx`.
- `scripts/migrations/probes/rewrite-permissions-modeDialogs.json` has 40 probes over the four files, and every one turns the suites red.
- Outside the unit:
  - `src/permissions/ui/PermissionRequest.characterization.test.tsx` pins the headlines `Enter plan mode?` and `Exit plan mode?`;
  - `src/permissions/ui/PermissionRequest.test.ts` pins the routing to both plan dialogs;
  - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts` pins `Exit plan mode?` as the tool's own ask message.

  No snapshot or generated file pins the clear-context prompt or `AUTO_MODE_DESCRIPTION` byte for byte.

## Out of scope

The rewrite drops these: none of them can be reached, so none is behaviour.
- **The "V1" plan path.** A request from a plan tool not named `ExitPlanMode` would show `input.plan`, and ctrl+g would edit it through a temp file. Only `ExitPlanModeV2Tool` is routed here, and its name is `ExitPlanMode`.
- **A second approval route for the clear-context values.** Those values always take the clear-context path first, so the later fallback for them never runs.
- **Ignoring Enter on an empty `No`.** The answer would be ignored, but the field declines on an empty submit before the dialog ever sees it.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **One bypass acceptance covers every checkout from then on.** The accept writes `skipDangerousModePermissionPrompt` to the user settings. Startup also honours the skip from `.claudin/settings.local.json` (`hasSkipDangerousModePermissionPrompt` in `settings.ts`). A repository's own settings can set `defaultMode: "bypassPermissions"` ([setup finding 1](setup.md#findings)). So after one accept anywhere, or with a checkout that ships a `settings.local.json` holding both keys, an interactive session in that checkout starts in bypass with no warning. | **Keep for parity** (pinned). Users rely on being asked once. Track with setup finding 1 and route to `permissions/sessionDialogs` (the trust boundary): the fix there would confirm a repo-chosen bypass start, or ignore the skip from the checkout's local file. |
| 2 | **Esc on the bypass warning exits with code 0; "No, exit" with code 1.** Both refuse, but a wrapper sees Esc as success. | **Keep for parity** (pinned). It is cancel versus refuse, and no permission is granted either way. |
| 3 | **A failed write of the bypass skip is silent.** With a malformed user settings file the session proceeds, and the warning returns next time. | **Keep for parity** (pinned). It fails safe. |
| 4 | **Shift+tab can approve into bypass.** In "Ready to code?" the shortcut picks the keep-context answer, which is bypass whenever bypass is offered. Nothing on screen says shift+tab means bypass. With clear-context on, the same key gives `acceptEdits` instead, even though the first answer then offers bypass. | **Keep for parity** (pinned), track. Users who start with bypass offered use it. Changing it would be noticed, so it is not pure hardening. A rewrite may add a visible hint. |
| 5 | **Images pasted under "No" are dropped on approval.** Only typed feedback travels with an approval, although the request's `onAllow` accepts content blocks. | **Keep for parity** (pinned). It changes what the model receives, so it is a feature decision, not a fix. |
| 6 | **The empty plan's Yes always lands in `default`**, even when bypass or auto is offered. It also stops a running auto mode. | **Keep for parity** (pinned). It is the conservative choice. |

## Target design

- **One slice folder.** `permissions/ui/modeDialogs/` holds the four dialogs, with the plan-exit logic split from its view:
  - a pure `planExitChoices(context, settings)` that returns the answers;
  - a pure `planExitOutcome(answer, state)` that returns the calls to make, the session-flag changes, the context transform and the next message. It has no React and no `feature()` reads: the flag and the gate come in as inputs.
  - a thin component that draws them and wires the keys.
- **Make the answer type explicit.** A discriminated union `{ kind: 'keep' | 'clear' | 'manual' | 'feedback' | 'cancel', elevation: 'auto' | 'bypass' | 'edits' }` replaces the string values. `buildPlanApprovalOptions` keeps its exported shape until no test reads the values.
- **One auto-mode handle.** Read and switch auto mode only through `permissionSetup/autoModeStateBridge.ts` and `autoSession.ts`, not a second `feature()` site.
- **Process exit is injected.** The bypass warning takes its decline and cancel actions from its caller, as the auto consent already does. Startup passes the exit codes. Then the dialog no longer ends the process itself, and its tests need no child process.
- **Settings writes go through one function per consent** (`recordBypassAccepted`, `recordAutoConsent({ asDefault })`), so the destination layer is stated once.
- **Findings.** None is fixed in this unit. Findings 1 and 4 go to the trust-boundary work.
