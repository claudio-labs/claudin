# Spec: `permissions/promptFrame`

## Purpose

The frame every permission request is shown in, and the pieces each dialog
builds on. When a tool asks for permission, the REPL mounts
`PermissionRequest` for the request at the head of its queue. That component
picks the dialog for the tool, gives Ctrl+C its meaning, and leaves a desktop
notification if nobody answers. Most dialogs then draw themselves inside
`PermissionDialog` and end with `PermissionPrompt`, the question with its
numbered options and an optional note. `PermissionRuleExplanation` says which
rule, hook or check asked. `usePermissionRequestLogging` counts the prompt.
On the worker side of a team, `WorkerPendingPermission` is the card shown
while the team lead decides, and `WorkerBadge` names the worker.

The unit decides nothing about permissions itself. Every answer goes back
through the callbacks of the request (`ToolUseConfirm`) and of the caller.
Choosing the wrong one, an allow the user did not pick, is the risk this spec
guards against.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `PermissionRequest` | component, props `PermissionRequestProps` | `src/agent/repl/REPL.tsx` |
| `PermissionRequestProps<Input>` | `{ toolUseConfirm: ToolUseConfirm<Input>; toolUseContext: ToolUseContext; onDone(): void; onReject(): void; verbose: boolean; workerBadge: WorkerBadgeProps \| undefined; setStickyFooter?: (jsx: ReactNode \| null) => void }` | every dialog routed to (Fallback, Bash, PowerShell, Git, Monitor, WebFetch, Skill, File edit/write, Notebook, Filesystem, plan modes, AskUserQuestion, SedEdit) |
| `ToolUseConfirm<Input>` | `{ assistantMessage; tool: Tool<Input>; description: string; input; toolUseContext; toolUseID: string; permissionResult: PermissionDecision; permissionPromptStartTimeMs: number; classifierCheckInProgress?; classifierAutoApproved?; classifierMatchedRule?; workerBadge?; onUserInteraction(); onAbort(); onDismissCheckmark?(); onAllow(updatedInput, permissionUpdates: PermissionUpdate[], feedback?: string, contentBlocks?: ContentBlockParam[]); onReject(feedback?: string, contentBlocks?); recheckPermission(): Promise<void> }` | `REPL.tsx`, `useCanUseTool.tsx`, `toolPermission/PermissionContext.ts`, `agent/ui/Messages.tsx`, `useReplLifecycle.ts`, `useToolUseContext.ts`, `useCancelRequest.ts`, `useInboxPoller.ts`, `swarm/leaderPermissionBridge.ts`, `useShellPermissionFeedback.ts`, `FilePermissionDialog/*`, `hooks.ts`, the dialogs |
| `PermissionDialog` | component, props `{ title: string; subtitle?: ReactNode; color?: keyof Theme; titleColor?: keyof Theme; innerPaddingX?: number; workerBadge?: WorkerBadgeProps; titleRight?: ReactNode; children: ReactNode }` | 11 dialogs in `src/permissions/ui`, `trust/TrustDialog.tsx`, `lifecycleHooks/ui/PromptDialog.tsx`, `remote/RemoteCallout.tsx`, `ManagedSettingsSecurityDialog.tsx`, `providers/ui/EffortCallout.tsx`, `peers/ui/HeldPeerMessageDialog.tsx` |
| `PermissionRequestTitle` | component, props `{ title: string; subtitle?: ReactNode; color?: keyof Theme; workerBadge?: WorkerBadgeProps }` | `PermissionDialog`, the three AskUserQuestion views |
| `PermissionPrompt<T extends string>` | component, props `PermissionPromptProps<T>` | `FallbackPermissionRequest`, `GitPermissionRequest`, `MonitorPermissionRequest`, `SkillPermissionRequest` |
| `PermissionPromptProps<T>` | `{ options: PermissionPromptOption<T>[]; onSelect: (value: T, feedback?: string) => void; onCancel?: () => void; question?: string \| ReactNode; toolAnalyticsContext?: ToolAnalyticsContext }` | as above |
| `PermissionPromptOption<T>` | `{ value: T; label: ReactNode; feedbackConfig?: { type: FeedbackType; placeholder?: string }; keybinding?: KeybindingAction }` | as above |
| `FeedbackType` | `'accept' \| 'reject'` | as above |
| `ToolAnalyticsContext` | `{ toolName: string; isMcp: boolean }` | as above |
| `PermissionRuleExplanation` | component, props `PermissionRuleExplanationProps` | Fallback, Bash, PowerShell, Git, Monitor, Skill, WebFetch, ExitPlanMode, `SubmitQuestionsView` |
| `PermissionRuleExplanationProps` | `{ permissionResult: PermissionDecision; toolType: 'tool' \| 'command' \| 'edit' \| 'read' }` | as above |
| `usePermissionRequestLogging` | `(toolUseConfirm: ToolUseConfirm, unaryEvent: UnaryEvent) => void` | Fallback, Bash, PowerShell, Git, Monitor, Skill, WebFetch, `FilePermissionDialog` |
| `UnaryEvent` | `{ completion_type: CompletionType; language_name: string \| Promise<string> }` | as above |
| `WorkerBadge` | component, props `WorkerBadgeProps` | `WorkerPendingPermission` |
| `WorkerBadgeProps` | `{ name: string; color: string }` | `PermissionRequest`, `PermissionDialog`, `PermissionRequestTitle`, `FilePermissionDialog` |
| `WorkerPendingPermission` | component, props `{ toolName: string; description: string }` | `src/agent/repl/ui/REPLDialogs.tsx` (and an import in `REPL.tsx`) |

Collaborators the tests use to compute their expectations, which the rewrite
must use rather than restate: `toInkColor` (`src/terminal/render/ink.ts`) for
the badge colour, the theme keys of `src/terminal/theme/theme.ts`, and
`permissionRuleValueToString` (`src/permissions/permissionRuleParser.ts`) for
how a rule is written.

## Observable behaviour

### 1. Which dialog a request is shown in (`PermissionRequest`)

The dialog depends only on which tool object the request carries. The
headline is what the dialog shows first.

| Tool | Dialog | Its headline |
|---|---|---|
| `FileEditTool` | file edit | `Edit file` |
| `FileWriteTool` | file write | `Create file` (new file) |
| `BashTool` | Bash | `Bash command` |
| `PowerShellTool` | PowerShell | `PowerShell command` |
| `GitTool` | Git (its rules are `Bash(...)` rules, so it must not get the tool-wide dialog) | `Git` |
| `WebFetchTool` | web fetch | `Fetch` |
| `NotebookEditTool` | notebook edit | `Edit notebook` |
| `ExitPlanModeV2Tool` | exit plan mode | `Exit plan mode?` |
| `EnterPlanModeTool` | enter plan mode | `Enter plan mode?` |
| `SkillTool` | skill | `Use skill "<name>"?` |
| `AskUserQuestionTool` | ask-user-question (no frame) | `☐ <header>` |
| `MonitorTool` | shipped build: the Monitor dialog. A build without `MONITOR_TOOL`: the tool-wide dialog | `Monitor` / `Tool use` |
| `WaitForTool` | the Monitor dialog, which names itself after the tool | `Wait` |
| `GlobTool`, `GrepTool`, `FileReadTool` | filesystem (read) | `Read file` |
| anything else, MCP tools included | the tool-wide dialog | `Tool use` |

Every prop is passed on to the routed dialog unchanged: the request, the
context, `onDone`, `onReject`, `verbose`, `workerBadge` and
`setStickyFooter`. A worker badge shows in the dialog's title.

### 2. Ctrl+C (`PermissionRequest`)

While the request is mounted, the `app:interrupt` action (Ctrl+C) in the
`Confirmation` keybinding context answers it. It calls, in this order, the
caller's `onDone()`, the caller's `onReject()`, then the request's
`onReject()` with no arguments. It never calls `onAllow`, and it does not
count an escape. It does this whichever dialog the request was routed to.

The action is resolved in the `Confirmation` context. No default binding
gives Ctrl+C another meaning there, so it is the global `ctrl+c` binding that
fires. A context where Ctrl+C means something else (`Transcript`, say) would
take the key away from the request.

### 3. The notification (`PermissionRequest`)

The component asks for a desktop notification of type `permission_prompt`,
which the notification hook delivers only after an idle spell. The message:

| Request | Message |
|---|---|
| `ExitPlanModeV2Tool` | `Claudin needs your approval for the plan` |
| `EnterPlanModeTool` | `Claudin wants to enter plan mode` |
| a tool whose user-facing name is empty or blank | `Claudin needs your attention` |
| any other | `Claude needs your permission to use <user-facing name>` |

The user-facing name is `tool.userFacingName(input)`, as shown (an MCP tool
keeps its ` (MCP)` suffix).

### 4. The frame (`PermissionDialog`, `PermissionRequestTitle`)

Top to bottom, at any width:
- one blank line;
- a rule of `─` as wide as the terminal: the top edge of a rounded border
  whose sides and bottom are not drawn. No corner, side or bottom edge
  appears;
- the title block, indented one column: the title in bold, then, when there
  is a worker badge, ` · @<name>` (dim) on the same line. Under it, the
  subtitle when there is one;
- the children, in a column, indented by `innerPaddingX` columns (default 1,
  and 0 is allowed). The padding moves only the body, never the title.

`titleRight` is drawn on the title's line, pushed to its right edge, which
is one column in from the terminal's.

A subtitle given as a string is dim and keeps one line. When it is too long,
it loses its start, never its end: `…` followed by the tail of the string.
With nothing else on the title's row, it is exactly as wide as the terminal
less two columns. A subtitle given as an element is drawn as it is.

Colours, all theme keys:
- the rule is in `color`, default `permission`;
- the title is in `titleColor`, default `permission`. `color` does not change
  the title, and `titleColor` does not change the rule.

`PermissionRequestTitle` on its own is the title block alone, with no
padding: title (bold, `color`, default `permission`), the badge and the
subtitle as above. Without a subtitle or badge it is one line.

A long title on its own wraps as one paragraph.

### 5. The question and its options (`PermissionPrompt`)

**Layout.** Top to bottom: the question, the options as a numbered list with
the first one pointed at (`❯ 1. Yes`), a blank line, then the hint line. The
question defaults to `Do you want to proceed?`. A string replaces it, and an
element is drawn as it is.

The hint line reads `Esc to cancel`, followed by ` · Tab to amend` when the
pointed option takes a note (has `feedbackConfig`) and its note line is not
open. It stays one sentence when it wraps.

**Answers.**

| Key | Effect |
|---|---|
| Enter | `onSelect(<pointed value>, <note or undefined>)` |
| Up / Down | move the pointer, wrapping from the first option to the last |
| a digit `1`..`n` | `onSelect` for that option at once, whatever is pointed at |
| a digit past the last option | nothing |
| Esc | adds 1 to `attribution.escapeCount` in the app state, then calls `onCancel` (if given). Never `onSelect` |
| `y`, `n` | nothing, unless an option is bound to the action (below) |
| Ctrl+C | not handled here |

A digit answers by position, so when a dialog leaves an option out, the
digit of every later option changes. Under managed policy that keeps rules to
itself, the tool-wide dialog drops its allow-always option and `2` is its
deny.

**The note.** An option with `feedbackConfig` takes a note:
- Tab on it opens a note line in place of the label, shown as
  `<label>, <placeholder>`, and Tab again closes it. Tab on an option without
  `feedbackConfig` does nothing.
- The placeholder is the option's own, or by default
  `tell Claude what to do next` (`accept`) or
  `tell Claude what to do differently` (`reject`).
- While the note is open, typed keys (digits included) are text, Enter
  answers with that option, and Esc cancels the prompt, discarding the note.
- The note is reported trimmed. An empty or blank note is reported as
  `undefined`, and Enter on it still answers with the option (it never
  cancels).
- There is one note per kind. The `accept` note is only ever reported with an
  `accept` option, and the `reject` note with a `reject` option.
- Moving the pointer away from an open note that is empty closes it. A
  written note stays open and shows its text (`Yes, x`), and it is still
  reported when that option is chosen.

**Bound options.** An option with a `keybinding` is chosen whenever that
action fires in the `Confirmation` context, wherever the pointer is: with the
default bindings, `y` for `confirm:yes`, `n` for `confirm:no`. Esc still
cancels even when an option is bound to `confirm:no`. See Finding 1 about
Enter. No caller sets `keybinding` today.

`toolAnalyticsContext` is accepted and has no observable effect.

### 6. What the tool-wide dialog reports (the default route)

Every tool without a dialog of its own, MCP tools among them, gets this one,
so its answers are pinned through `PermissionRequest`. Its options are `Yes`
(takes an accept note), `Yes, and don't ask again for <name> commands in
<original cwd>` (only when policy allows always-allow rules), and `No` (takes
a reject note).

| Answer | Calls, in order |
|---|---|
| Yes (Enter, `1`) | `onAllow(input, [], undefined)`, `onDone()` |
| Yes with a note | `onAllow(input, [], '<note>')`, `onDone()` |
| Yes, and don't ask again (`2`, or Down then Enter) | `onAllow(input, [{ type: 'addRules', rules: [{ toolName: <tool.name> }], behavior: 'allow', destination: 'localSettings' }])`, `onDone()`. No third argument |
| No (`3`) | `onReject(undefined)`, caller's `onReject()`, `onDone()` |
| No with a note | `onReject('<note>')`, caller's `onReject()`, `onDone()` |
| Esc, even with a Yes note written | `onReject()` with no arguments, caller's `onReject()`, `onDone()`. One escape counted |
| Ctrl+C | as section 2 |
| `y`, `n` | nothing |

### 7. Why the prompt asked (`PermissionRuleExplanation`)

It reads `permissionResult.decisionReason`. `<kind>` is the `toolType` prop.
Each shown explanation is followed by one blank line.

| Reason | Lines |
|---|---|
| `rule` | `Permission rule <rule> requires confirmation for this <kind>.`, then `/permissions to update rules` (dim), except for a rule from `policySettings`, which gets no hint. `<rule>` is the rule value as `permissionRuleValueToString` writes it, in bold |
| `hook` with a reason | `Hook <name> requires confirmation for this <kind>:`, then the reason on the next line, then `/hooks to update` (dim). The hook name is bold |
| `hook` without a reason | `Hook <name> requires confirmation for this <kind>.`, then `/hooks to update` |
| `hook` with `hookSource` | ` [<source>]` follows the reason (or the `.`), dim with the plain SGR dim attribute |
| `safetyCheck`, `other` | the reason alone, line breaks kept |
| `workingDir` | the reason, then `/permissions to update rules` |
| `classifier`, in a build with `TRANSCRIPT_CLASSIFIER` or `BASH_CLASSIFIER` | `auto-mode`: `Auto mode classifier requires confirmation for this <kind>.` then the reason, all in the `error` colour. Any other: `Classifier <name> requires confirmation for this <kind>.` (name bold) then the reason. No hint either way |
| `classifier` in a build without those flags, `mode`, `subcommandResults`, `permissionPromptTool`, `asyncAgent`, `sandboxOverride`, no reason, no result | nothing at all, not even the blank line |

In `auto` permission mode, a hook's explanation is in the `warning` colour;
otherwise, and for every other reason, it has no colour of its own. The
sentence is one paragraph and wraps as one.

### 8. The prompt counter (`usePermissionRequestLogging`)

Adds 1 to `attribution.permissionPromptCount` in the app state once per tool
use id seen by one mounted component. A new request object with the same id,
or a different `unaryEvent`, does not count again. A different id counts,
and so does going back to an earlier id after another. The `unaryEvent`
argument has no other effect. The REPL keys `PermissionRequest` by tool use
id, so in practice each request counts once.

### 9. The worker side (`WorkerBadge`, `WorkerPendingPermission`)

`WorkerBadge` is one line, `● @<name>`, in the colour `toInkColor(color)`
gives, with the name in bold. An agent colour name maps to its theme colour,
another ANSI name is used as it is, and an empty colour gets the default
agent colour.

`WorkerPendingPermission` is a rounded box in the `warning` colour, as wide
as the terminal, with one column of padding. Inside, top to bottom:
- a spinner and ` Waiting for team lead approval` (bold, `warning`), then a
  blank line;
- when this session has both an agent name and a colour: the worker badge,
  then a blank line;
- `Tool: <toolName>` (`Tool: ` dim);
- `Action: <description>` (`Action: ` dim);
- when the session has a team name: a blank line, then
  `Permission request sent to team "<team>" leader` (dim).

The agent name, colour and team come from the teammate context
(`src/agent/coordinator/teammate.ts`), read when the card mounts.

## Edge cases and errors

| Case | What the user sees | Pinned |
|---|---|---|
| A digit past the last option | nothing | yes |
| Esc with no `onCancel` | the escape is counted, nothing is reported | yes |
| Enter on an empty note | the option's answer, with no note | yes, both kinds |
| A blank note | reported as `undefined` | yes |
| Digits typed in a note | text | yes |
| Managed policy keeps rules to itself | no allow-always option in the tool-wide dialog, and `2` denies | yes |
| `MonitorTool` in a build without `MONITOR_TOOL` | the tool-wide dialog | yes (and the shipped side in a flagged child run) |
| A worker without a colour, or a session with no team | no badge, or no team line | yes |
| The teammate context changes while the card is shown | the card keeps what it read when it mounted | no |
| A worker colour that is neither an agent colour nor an ANSI name | the badge is uncoloured | no |
| `permissionResult` missing | no explanation | yes |
| A narrow terminal, title row with a badge or `titleRight` | **Broken in the old module**: title, badge and right part wrap as side-by-side columns. At 40 columns `A fairly long · RIGHT` / `permission title @researcher` | no: the old output is wrong (Finding 2) |
| A narrow terminal, the worker card | **Broken in the old module**: the labels lose their colon and space (`Action:rebuild…` at 44 columns, `Actionrebuild…` at 30) and the waiting line wraps beside the spinner | the words and their order: yes. The label punctuation: only at 80 columns (Finding 3) |

## Security requirements

- **Only an explicit choice allows.** An allow is reported only for Enter on
  an allow option, its digit, or an action bound to it. Esc, Ctrl+C, `y` and
  `n` without a binding, and a digit out of range never report an allow.
- **Every way out is a deny.** Esc and Ctrl+C both reach the request's
  `onReject` with no note, and Esc does so even when a Yes note is written.
- **Notes do not cross.** An accept note is never reported with a deny, and
  a reject note never with an allow.
- **Routing keeps the narrow dialogs.** A tool with a dialog of its own must
  not fall to the tool-wide one, whose "don't ask again" writes a whole-tool
  allow rule. For `GitTool`, that rule would bypass the `Bash(...)` rules it
  is checked against.
- **Allow-always is withheld when policy forbids it**, and its rule goes to
  `localSettings` only.
- **No option binding may answer through a key the list itself uses.** See
  Finding 1: the old module breaks this, latently.

## Tests that pin it

- **`src/permissions/ui/PermissionRequest.characterization.test.tsx`**: 34 tests. The routing table (17 tools and the badge), Ctrl+C on two routes, eleven answers of the tool-wide dialog plus the managed-policy case, and the prompt counter through the dialog and through the hook alone.
- **`src/permissions/ui/PermissionPrompt.characterization.test.tsx`**: 38 tests. Layout, the question, the hint line at three widths, every key, the note in both kinds, and bound options.
- **`src/permissions/ui/PermissionDialog.characterization.test.tsx`**: 82 tests. The frame at two widths, its edges, padding, badge, `titleRight`, subtitle truncation at three widths, title wrapping at three widths, colours, `PermissionRequestTitle`, `WorkerBadge` for four colours, `WorkerPendingPermission` (four team contexts, the box, three widths), and `PermissionRuleExplanation` (nine reasons × four tool types, seven silent reasons, styling, auto mode, three widths).
- **`src/permissions/ui/PermissionRequest.notify.characterization.test.tsx`**: 5 tests. Only the notification hook is replaced, since it stays silent under the test runner.
- **`src/permissions/ui/promptFrame.shipped.characterization.test.tsx`**: 1 test under the plain runner. It runs the file again with `MONITOR_TOOL`, `TRANSCRIPT_CLASSIFIER` and `BASH_CLASSIFIER` on, where 6 tests pin the Monitor route and both classifier explanations.
- **The rig**: `src/permissions/ui/__testutils__/promptFrameRig.tsx`. It mounts a component on `src/terminal/__testutils__/fakeTerminal.ts` inside `AppStateProvider` and `KeybindingSetup` only, follows the app state through the provider's change callback, and gives each test a fresh config home, project directory and managed-settings directory. Colours are read at truecolor and compared with a reference `<Text>` in the same theme key.
- 160 tests in all (plus 6 in the flagged child). Three runs in a row passed. Coverage under the plain run: `PermissionDialog` 96.2%, `PermissionPrompt` 98.0%, `PermissionRequest` 97.2%, `PermissionRequestTitle` 90.0%, `PermissionRuleExplanation` 85.6%, `WorkerBadge` 91.2%, `WorkerPendingPermission` 86.8%, `hooks.ts` 30.1%. The rest of `hooks.ts` is two private functions nothing calls (Finding 6), and its exported hook is fully covered. The other gaps are compiler cache hits and flag-gated lines that the child run covers.
- **`scripts/migrations/probes/rewrite-permissions-promptFrame.json`**: 40 probes over the eight files. 18 of them are on a routing, answer or cancel path, and each turns the suites red. One first draft moved the interrupt to the `Settings` context and stayed green. That is an equivalent change, since neither context binds Ctrl+C, so the probe uses `Transcript`, where Ctrl+C means something else.
- **Kept, this project's own:** `src/permissions/ui/PermissionRequest.test.ts` checks that each routed tool's `name` matches its name constant, for a future name-keyed routing.

**Text pinned outside the unit.** None. No other test or snapshot holds this
unit's text, and the unit sends nothing to a model: the notes travel in the
callbacks, and other modules build the model's message from them.

**Inherited tests to fold in:** the unit's entry in
`scripts/migrations/rewrite/units/phase-3.json` lists none.

**Not pinned, and why:**
- The narrow-width title row and the worker card's label punctuation: the old output is wrong (Findings 2 and 3).
- Enter on a pointed option while another option is bound to `confirm:yes`: the old behaviour is the defect in Finding 1.
- `setStickyFooter` and `verbose` reaching the dialog: only the plan-exit dialog uses them, in fullscreen.
- The notification's delivery (idle timer, channels, hooks): that belongs to `src/platform/notifications`.
- The spinner's frames.

## Out of scope

- The dialogs themselves (`permissions/toolDialogs`, `shellDialogs`,
  `fileDialogs`, `modeDialogs`, `askUserQuestion`). The tool-wide dialog's
  answers are pinned here only because they are what `PermissionRequest`
  reports for every tool without a dialog of its own.
- The list widget (`src/terminal/custom-select`) and the keybinding resolver.
- Dropped on purpose: the two log-formatting functions in `hooks.ts` that
  nothing calls (Finding 6).

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **An option bound to `confirm:yes` captures Enter.** The default bindings put Enter on `confirm:yes` in the `Confirmation` context. With `{ value: 'yes', keybinding: 'confirm:yes' }` and the pointer moved to `No`, Enter answers `yes`. That is an allow the user did not choose. No caller sets `keybinding` today, so it is latent. | **Fix** (hardening). A bound action may not answer through a key the list uses (Enter, Esc, arrows, Tab, space, digits), or the field goes. No caller can notice. Not pinned. |
| 2 | **The title row breaks at narrow widths.** Title, badge and `titleRight` are side-by-side items that wrap on their own, as `.claudin/rules/ink-tui.md` §10 describes. | **Fix.** Title and badge are one `<Text>`. `titleRight` takes its width first, and the title wraps in what is left. Pin it with a narrow render in the new module's tests. |
| 3 | **The worker card's label lines break at narrow widths.** `Tool:` / `Action:` and the waiting line have the same shape as Finding 2. | **Fix**, the same way. |
| 4 | **Mixed product names.** The notification for a named tool says `Claude needs your permission…` while the other three say `Claudin`, and the note placeholders say `tell Claude…`. | **Keep for parity** (pinned). A user's notification hook may match on the text. Change it after the rewrite, in one change with the dialogs' own wording. |
| 5 | **Ctrl+C and Esc report in different orders.** Ctrl+C: caller done, caller reject, request reject. Esc in the tool-wide dialog: request reject, caller reject, done. Only Esc counts an escape. | **Keep for parity** (pinned). The REPL's queue and the request's promise are settled either way. |
| 6 | **Dead code in `hooks.ts`.** Two private functions format a permission result for a log, and nothing calls them. They are about 60% of the file, which caps its coverage at 30%. The `unaryEvent` argument and `toolAnalyticsContext` prop have no effect. | **Fix:** drop the dead functions. Keep both parameters in the signatures while callers pass them (README, "Contracts during the transition"). |
| 7 | **The hook source uses the plain dim attribute**, not the theme's dim colour used by the hints. | **Keep for parity** (pinned). It is cosmetic. |
| 8 | **Outside the unit:** the Skill dialog's second option renders misaligned (`  2.Yes, and don't ask again…`, with no space after the number) at 100 columns. | Route to `permissions/toolDialogs`. Not pinned here. |

## Target design

- **Hand-written components** in this repo's Ink style, with typed props and
  no React Compiler cache slots. They keep every export name and props type
  above.
- **Routing as data.** A table from tool to dialog component, with the
  fallback as its default. Keep it keyed by the tool object for now. The
  name-keyed form `PermissionRequest.test.ts` prepares for is a separate change. The Monitor
  entry stays behind its build flag.
- **One answer model for `PermissionPrompt`.** A small pure reducer over
  `{ pointer, open note per kind, note text per kind }` that turns key events
  into `select(value, note?)` or `cancel`. Unit-test it without Ink, and give
  it the rule from Finding 1: a bound action never shadows a list key.
- **Explanations as a table** from decision-reason type to a line builder,
  with the classifier entries behind the build flags. Each sentence is one
  `<Text>`, with the bold and dim parts nested.
- **One `<Text>` per logical line** throughout: the title row (Finding 2) and
  the worker card (Finding 3).
- **`usePermissionRequestLogging`** is just the per-id counter (Finding 6).
- **Tests.**
  - The characterization suites, unchanged.
  - Unit tests for the answer reducer.
  - A narrow render of the title row and the worker card that asserts each
    line stays whole and in order.

## Outcome

Rewritten per method on 2026-10-04.

**Rewrite.** All 8 files are now hand-written components and hooks, with no React Compiler output
left. The note and answer state became a pure reducer, `prompt/answerModel.ts`, and the option key
bindings moved to `prompt/useBoundOptions.ts`. The five characterization suites pass unchanged.

**Fixes, each with a test:**
- **1.** An option's key binding never answers through a key the list itself uses (Enter, Esc,
  Tab, the arrows, the page keys, space, digits). It is also off while a note is being typed. Enter
  on "No" can no longer allow.
- **2 and 3.** The title and badge, and "Tool:" / "Action:", each keep one `<Text>`. They were
  tested at three widths.
- **6.** The dead log functions in `hooks.ts` are gone.

Findings 4, 5 and 7 are kept as they were.

**Probes.** `rewrite-permissions-promptFrame.json`, 84 probes, all proved in the checkout. Probes
31–50 were proved a second time after a concurrent landing overlapped the first run.

**Residue.** None in the eight files, apart from the props types that callers import.
