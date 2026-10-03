# Spec: `permissions/ruleModel`

Eight files in `src/permissions/`: `PermissionRule.ts`, `PermissionResult.ts`,
`PermissionMode.ts`, `permissionRuleParser.ts`, `permissionsLoader.ts`,
`PermissionUpdateSchema.ts`, `PermissionUpdate.ts` and
`PermissionPromptToolResultSchema.ts`.

## Purpose

This unit is the vocabulary of the permission system, and the part of it that
decides which rules are in force.

- **Rules.** A rule is written `Tool` or `Tool(content)`, with an allow, deny
  or ask behavior. The unit reads and writes that string form, including its
  escaping and the old tool names.
- **The loader.** It reads the rules from the settings layers on disk. When the
  managed layer asks for it, it ignores every other layer. It also adds rules to
  the user, project and local settings files, and deletes rules from them.
- **Updates.** A permission update is the message the dialogs, the CLI and SDK
  hosts use to change permissions: add, replace or remove rules, set the mode,
  add or remove working directories. The unit applies an update to the
  session's permission context in memory, and saves it when its destination is
  a file.
- **Modes.** The permission modes, their labels, and how an internal mode is
  reported outside.
- **The permission prompt tool.** In headless runs, an SDK host or an MCP tool
  answers permission questions. The unit defines the shapes of the question
  and the answer, and turns an answer into a decision.
- **Shared types.** `PermissionResult` and the decision types. 74 files
  import them, 66 of them production code.

Every other permissions unit builds on this one.

## Public contract

Every export keeps its name and signature. Paths in "Used by" are under `src/`.
The type-only re-exports (`PermissionBehavior`, `PermissionRule`,
`PermissionRuleSource`, `PermissionRuleValue`, `PermissionResult`,
`PermissionDecision`, `PermissionDecisionReason`, `PermissionAllowDecision`,
`PermissionAskDecision`, `PermissionDenyDecision`, `PermissionMetadata`,
`PermissionMode`, `ExternalPermissionMode`, `PermissionUpdate`,
`PermissionUpdateDestination`, `AdditionalWorkingDirectory`,
`WorkingDirectorySource`) and the constants `PERMISSION_MODES` and
`EXTERNAL_PERMISSION_MODES` are defined in `shared/types/permissions.ts`. Each
file of this unit re-exports them from that module, and they must stay
importable from the same path.

| Export | Signature | Used by |
|---|---|---|
| `permissionBehaviorSchema` (`PermissionRule.ts`) | `() => ZodEnum<'allow' \| 'deny' \| 'ask'>` (lazy) | `shared/types/hooks.ts`, `PermissionUpdateSchema.ts` |
| `permissionRuleValueSchema` (`PermissionRule.ts`) | `() => ZodObject<{ toolName: string; ruleContent?: string }>` (lazy) | `PermissionUpdateSchema.ts` |
| `getRuleBehaviorDescription` (`PermissionResult.ts`) | `(behavior: PermissionResult['behavior']) => string` | `agent/tools/toolHooks.ts` |
| `permissionModeSchema` (`PermissionMode.ts`) | `() => ZodEnum<PERMISSION_MODES>` (lazy) | `tools/AgentTool/AgentTool.tsx` |
| `externalPermissionModeSchema` (`PermissionMode.ts`) | `() => ZodEnum<EXTERNAL_PERMISSION_MODES>` (lazy) | `PermissionUpdateSchema.ts` |
| `isExternalPermissionMode` | `(mode: PermissionMode) => mode is ExternalPermissionMode` | `platform/settings/ui/Config.tsx` |
| `toExternalPermissionMode` | `(mode: PermissionMode) => ExternalPermissionMode` | `terminal/state/onChangeAppState.ts`, `Config.tsx`, `ExitPlanModePermissionRequest.tsx`, `agent/coordinator/useInboxPoller.ts` |
| `permissionModeFromString` | `(str: string) => PermissionMode` | `onChangeAppState.ts`, `platform/teams/TeamsDialog.tsx`, `Config.tsx`, `permissionSetup/startupContext.ts`, and one more |
| `permissionModeTitle` | `(mode: PermissionMode) => string` | `PromptInputFooterLeftSide.tsx`, `Config.tsx`, `PermissionDecisionDebugInfo.tsx`, `permissions/requestMessage.ts` |
| `isDefaultMode` | `(mode: PermissionMode \| undefined) => boolean` | `PromptInputFooterLeftSide.tsx` |
| `permissionModeSymbol` | `(mode: PermissionMode) => string` | `PromptInputFooterLeftSide.tsx`, `TeamsDialog.tsx` |
| `getModeColor` | `(mode: PermissionMode) => 'text' \| 'planMode' \| 'permission' \| 'autoAccept' \| 'error' \| 'warning'` | six tool UIs (`ReportFindingsTool`, `ExitPlanModeTool`, `EnterPlanModeTool`, `AskUserQuestionTool`, …) |
| `normalizeLegacyToolName` (`permissionRuleParser.ts`) | `(name: string) => string` | `sessions/conversationRecovery.ts`, `platform/lifecycleHooks/matching.ts`, `startupContext.ts`, `dangerousRuleDetection.ts`, and one more |
| `getLegacyToolNames` | `(canonicalName: string) => string[]` | `platform/lifecycleHooks/matching.ts` |
| `escapeRuleContent`, `unescapeRuleContent` | `(content: string) => string` | no caller outside the unit; part of the contract |
| `permissionRuleValueFromString` | `(ruleString: string) => PermissionRuleValue` | 11 files: `platform/settings/permissionValidation.ts`, `tools/AgentTool/agentToolUtils.ts`, `lifecycleHooks/matching.ts`, `ui/rules/PermissionRuleInput.tsx`, `permissions/ruleLookup.ts`, … |
| `permissionRuleValueToString` | `(ruleValue: PermissionRuleValue) => string` | 13 files: `BashTool/bashPermissions/decide.ts`, `platform/doctor/doctorContextWarnings.ts`, `ui/rules/PermissionRuleList.tsx`, … |
| `shouldAllowManagedPermissionRulesOnly` (`permissionsLoader.ts`) | `() => boolean` | `permissions/ruleMutation.ts` |
| `shouldShowAlwaysAllowOptions` | `() => boolean` | seven permission dialogs (`WebFetch`, `Skill`, `PowerShell`, `Monitor`, …) |
| `loadAllPermissionRulesFromDisk` | `() => PermissionRule[]` | `platform/settings/applySettingsChange.ts`, `startupContext.ts` |
| `getPermissionRulesForSource` | `(source: SettingSource) => PermissionRule[]` | `permissions/ui/trust/utils.ts` |
| `PermissionRuleFromEditableSettings` (type) | `PermissionRule & { source: EditableSettingSource }` | `ruleMutation.ts` |
| `deletePermissionRuleFromSettings` | `(rule: PermissionRuleFromEditableSettings) => boolean` | `ruleMutation.ts` |
| `addPermissionRulesToSettings` | `({ ruleValues, ruleBehavior }: { ruleValues: PermissionRuleValue[]; ruleBehavior: PermissionBehavior }, source: EditableSettingSource) => boolean` | `PermissionUpdate.ts` |
| `permissionUpdateDestinationSchema` (`PermissionUpdateSchema.ts`) | `() => ZodEnum<…5 destinations>` (lazy) | no caller outside the unit |
| `permissionUpdateSchema` | `() => ZodDiscriminatedUnion<'type', …6 variants>` (lazy) | `shared/types/hooks.ts`, `PermissionPromptToolResultSchema.ts`, `agent/coordinator/hooks/useSwarmPermissionPoller.ts` |
| `extractRules` (`PermissionUpdate.ts`) | `(updates: PermissionUpdate[] \| undefined) => PermissionRuleValue[]` | `bashPermissions/decide.ts`, `ui/hooks.ts`, `PermissionDecisionDebugInfo.tsx`, `BashPermissionRequest.tsx` |
| `applyPermissionUpdate` | `(context: ToolPermissionContext, update: PermissionUpdate) => ToolPermissionContext` | 16 files, among them `EnterPlanModeTool.ts`, the rule dialogs, `ruleMutation.ts`, `startupContext.ts` |
| `applyPermissionUpdates` | `(context: ToolPermissionContext, updates: PermissionUpdate[]) => ToolPermissionContext` | `headless/structuredIO.ts`, `PermissionContext.ts`, `ruleMutation.ts`, `requestMessage.ts`, … |
| `supportsPersistence` | `(destination: PermissionUpdateDestination) => destination is EditableSettingSource` | `toolPermission/PermissionContext.ts` |
| `persistPermissionUpdate` | `(update: PermissionUpdate) => void` | `PermissionRuleList.tsx`, `AddPermissionRules.tsx`, `commands/add-dir/add-dir.tsx`, `REPLDialogs.tsx`, … |
| `persistPermissionUpdates` | `(updates: PermissionUpdate[]) => void` | `structuredIO.ts`, `PermissionContext.ts`, `requestMessage.ts`, `PermissionPromptToolResultSchema.ts`, … |
| `createReadRuleSuggestion` | `(dirPath: string, destination?: PermissionUpdateDestination) => PermissionUpdate \| undefined` | `PowerShellTool/pathValidation/statementConstraints.ts`, `BashTool/pathValidation.ts`, `filePermissions/readWriteChecks.ts` |
| `inputSchema` (`PermissionPromptToolResultSchema.ts`) | `() => ZodObject<{ tool_name: string; input: Record<string, unknown>; tool_use_id?: string }>` (lazy) | `agent/queryHelpers.ts` |
| `Input` (type) | the parsed `inputSchema` | `agent/queryHelpers.ts` |
| `outputSchema` | `() => ZodUnion<[allow, deny]>` (lazy) | `structuredIO.ts`, `headless/print/permissionGlue.ts`, `queryHelpers.ts` |
| `Output` (type) | the parsed `outputSchema` | `structuredIO.ts` |
| `permissionPromptToolResultToPermissionDecision` | `(result: Output, tool: Tool, input: { [key: string]: unknown }, toolUseContext: ToolUseContext) => PermissionDecision` | `structuredIO.ts`, `permissionGlue.ts` |

The schemas are lazy: each export is a function that builds and returns the
schema, so importing a file costs no Zod work. `PermissionUpdateSchema.ts` is
imported by `shared/types/hooks.ts`, so it must import nothing heavier than the
schemas of this unit and `shared/`.

**The classifier build flag.** `feature('TRANSCRIPT_CLASSIFIER')` is on in the
shipped build (`scripts/build/build.ts`) and off under plain `bun test`. It
adds the `auto` mode. The mode suite runs itself again in a child
`bun test --feature=TRANSCRIPT_CLASSIFIER` to check the shipped behaviour.

## Observable behaviour

### 1. The rule string

**Reading** (`permissionRuleValueFromString`):

- A string with no unescaped `(` is a bare tool name: `{ toolName }`, with no
  `ruleContent`.
- `Tool(content)` splits at the first unescaped `(` and the last unescaped `)`.
  - A paren is escaped when an odd number of backslashes precedes it.
  - Everything between the two is content, inner parens included:
    `Bash(print(1))` → `print(1)`, `Bash((x))` → `(x)`, `Bash(a)(b)` → `a)(b`.
- The content is unescaped: `\(` → `(`, `\)` → `)`, `\\` → `\`. A backslash
  before any other character stays, so `Bash(\*)` keeps `\*`.
- `Tool()` and `Tool(*)` are the whole tool, with no content. `Tool(**)` and
  `Tool( )` keep their content.
- **The whole string becomes the tool name**, with no content, when it cannot
  be split:
  - nothing before the paren: `(foo)`;
  - text after the last `)`: `Bash(foo) bar`;
  - no unescaped `)`, or the last `)` comes before the first `(`;
  - the only `(` or `)` is escaped.
- Nothing is trimmed. `Bash (rm *)` reads as tool `Bash ` (with the space) and
  content `rm *`, and ` Bash` keeps its leading space.
- Tool names are case-sensitive.
- **Old tool names** are read as today's names, both alone and before
  content:

  | Old | Now |
  |---|---|
  | `Task` | `Agent` |
  | `KillShell` | `TaskStop` |
  | `AgentOutputTool`, `BashOutputTool` | `TaskOutput` |
  | `apply_patch` | `Patch` |

  - A string read as a whole name is not renamed: `Task(oops` stays.
  - Names of built-in object members (`constructor`, `toString`, `__proto__`,
    `hasOwnProperty`) are not aliases, and read as plain names.
- `normalizeLegacyToolName` applies the rename table to one name and returns
  any other name unchanged.
- `getLegacyToolNames(now)` lists the old names of a current name: `Agent` →
  `[Task]`, `TaskOutput` → `[AgentOutputTool, BashOutputTool]` (order not
  pinned), and `[]` for any other name, old names included.

**Writing** (`permissionRuleValueToString`):

- No content, or empty content, gives the bare tool name.
- Otherwise the result is `Tool(escaped content)`. Escaping doubles every
  backslash first, then puts a backslash before each `(` and `)`.
- The tool name is written as given. Writing does not rename old names, and a
  content of `*` is written as `Tool(*)`.

`escapeRuleContent` and `unescapeRuleContent` are those two transforms on
their own. Unescaping undoes escaping for every string.

**Round trips, which callers rely on to compare rules.**
- Writing a rule value and reading it back gives the same value, for any
  content other than `''` and `*`. Those two come back as the whole tool.
- Reading then writing any string gives its **canonical form**. A second pass
  does not change it.
- Examples of canonical forms:
  - `Bash(*)` and `Bash()` → `Bash`;
  - `Task(foo)` → `Agent(foo)`, and `KillShell` → `TaskStop`;
  - `Bash(print(1))` → `Bash(print\(1\))`;
  - `Bash(\*)` → `Bash(\\*)`.
- Two strings are the same rule when their canonical forms are equal. The
  loader and the persistence below compare rules this way.

**Schemas.**
- `permissionBehaviorSchema` accepts exactly `allow`, `deny` and `ask`.
- `permissionRuleValueSchema` needs a string `toolName` (the empty string is
  accepted), takes an optional string `ruleContent`, and drops unknown keys.

**The behavior verb.** `getRuleBehaviorDescription` returns `allowed` for
allow, `denied` for deny, and `asked for confirmation for` for anything else.
`toolHooks.ts` builds the message the model reads from it:
`Hook PreToolUse:<tool> <verb> this tool`. The facts that message must state
are the tool name and which of the three outcomes happened.

### 2. Reading the rules on disk

The settings layers and their files belong to `platform/settings`. The user
file is `<CLAUDIN_CONFIG_DIR>/settings.json`. The project and local files are
`.claudin/settings.json` and `.claudin/settings.local.json` under the session's
original directory. The `--settings` file is the flag layer, and the managed
layer is described below. Rules live in a file as
`permissions.allow|deny|ask`, each an array of rule strings.

`getPermissionRulesForSource(source)` returns that layer's rules as
`{ source, ruleBehavior, ruleValue }`:
- all allow rules first, then deny, then ask, each in file order;
- each string read as in section 1.

What a layer contributes:
- **The `--settings` layer** adds the rules an SDK host hands over inline, after
  the file's own rules. Inline rules load even with no file.
- **The managed layer** (`policySettings`) is taken whole from the first of
  these that has any content. Layers are never merged:
  1. the admin registry (MDM);
  2. the managed file (`managed-settings.json`) together with its
     `managed-settings.d/*.json` drop-ins, merged in name order with arrays
     joined;
  3. the user registry (HKCU).
- **No rules** come from a layer when:
  - its file is missing, empty, or not valid JSON;
  - it is a JSON array;
  - it has no `permissions`, or empty lists.
- **What validation skips** (owned by `platform/settings`):
  - Entries it rejects are skipped and the rest load. It rejects non-strings,
    `''`, unbalanced parens, empty parens and lowercase tool names.
  - A file where any other field fails the settings schema gives **no rules at
    all** (Findings, 3).
- **Malformed rules that pass validation** load as a rule for a tool literally
  named that whole string, which matches no tool. Examples: `Bash(rm:*) now`,
  `Bash(curl) x`, and `Bash (rm *)`, which loads as tool `Bash `
  (Findings, 1).

`loadAllPermissionRulesFromDisk()` returns the rules of every enabled layer,
concatenated in this order:
- With every source enabled (the default): user, project, local,
  `--settings`, managed.
- With `--setting-sources` narrowing the list: the allowed file layers in that
  order, then managed, then `--settings`. The managed and `--settings` layers
  are always read.

**Managed rules only.**
- `allowManagedPermissionRulesOnly: true` in the managed layer (from any of
  its three origins, drop-ins included) means only the managed layer's rules
  are returned. Every other layer is ignored, inline SDK rules included.
- With no managed rules, the result is empty.
- Only the boolean `true` counts. `"true"`, `1` and `"yes"` do not.
- The same key in the user, project, local or `--settings` layer, or inline,
  has no effect.
- `shouldAllowManagedPermissionRulesOnly()` answers whether this is on, and
  `shouldShowAlwaysAllowOptions()` is its negation. The dialogs hide their
  "always allow" options when it is on.

### 3. Adding rules to a settings file

`addPermissionRulesToSettings({ ruleValues, ruleBehavior }, source)` writes to
the user, project or local file:
- **Refused** while managed rules only is on. It returns `false` and writes
  nothing.
- **An empty list** returns `true` and writes nothing.
- **New rules** are written in their canonical string form (section 1,
  escaped), after the existing entries of that behavior's list.
  - A rule whose canonical form is already in that list is skipped, whatever
    its spelling there. When nothing is new, it returns `true` and the file is
    left byte for byte as it was.
  - Existing entries keep their spelling. Every other key of the file is kept,
    inside and outside `permissions`.
  - The same rule under another behavior is a new rule.
- **Missing files** and their directories are created. The text written is the
  settings writer's format: two-space JSON with a final newline. The
  `rules-after-add.settings.json` fixture shows it.
- **A file that fails validation in another field** (an invalid `hooks`, say)
  is edited as it is on disk, so its rules and the invalid field survive.
- **A file with broken JSON** is never overwritten. The function returns
  `false`.
- **The managed file is never written**, even when `policySettings` is passed
  against the type.
- The rule is in force on the next read of the disk.

### 4. Deleting a rule from a settings file

`deletePermissionRuleFromSettings(rule)` returns `true` when the rule was
removed:
- Only the `userSettings`, `projectSettings` and `localSettings` sources can be
  edited. A rule from the managed layer, `--settings`, the session, the CLI or
  a command returns `false`, and no file changes.
- **Every entry** of that behavior's list whose canonical form equals the
  rule's goes, whatever its spelling:
  - `Bash` also takes `Bash(*)`;
  - `TaskStop` takes `KillShell`, and `Agent(reviewer)` takes
    `Task(reviewer)`;
  - `Bash(print(1))` takes its escaped and its plain spelling.

  A scoped rule never takes the tool-wide rule with it.
- **Everything else is kept**: the other lists and keys of the file.
- **`false`, with the file unchanged**, when:
  - there is no file, no `permissions`, or no list for that behavior;
  - the rule is not in that list;
  - the file fails validation.
- Deleting still works while managed rules only is on.

### 5. Permission updates

The schema (`permissionUpdateSchema`) has six variants, keyed by `type`:
- `addRules`, `replaceRules` and `removeRules`: `{ rules: PermissionRuleValue[],
  behavior, destination }`;
- `setMode`: `{ mode: ExternalPermissionMode, destination }`;
- `addDirectories` and `removeDirectories`: `{ directories: string[],
  destination }`.

What it accepts:
- The destinations are exactly `userSettings`, `projectSettings`,
  `localSettings`, `session` and `cliArg`. The managed layer, `--settings` and
  `command` are rejected.
- `setMode` takes only an external mode, so `auto` and `bubble` are rejected.
- Rules must be objects with a `toolName`.

**In memory** (`applyPermissionUpdate`, `applyPermissionUpdates`):
- **The context given is never changed.** Each update returns a new context.
  The rule maps and the directory map are copied, never edited in place. An
  update of an unknown `type` returns the same context object.
- **Which map.** Rules live in `alwaysAllowRules`, `alwaysDenyRules` or
  `alwaysAskRules`, chosen by behavior. Each map is keyed by destination and
  holds rule strings.
- **`addRules`** appends the written form of each rule to that destination's
  list, creating the list if needed. Other destinations and behaviors are
  untouched.
- **`replaceRules`** sets that destination's list to the written forms. An
  empty list clears it.
- **`removeRules`** drops the entries equal to a rule's written form from that
  destination's list, leaving an empty list if there was none.
- **`setMode`** changes `mode` only.
- **`addDirectories`** records each directory as `{ path, source: destination }`,
  overwriting an existing entry. **`removeDirectories`** forgets them, and
  ignores directories it does not know.
- `applyPermissionUpdates` applies a list in order, each update seeing the
  previous result. An empty list changes nothing.

**Saved to a file** (`persistPermissionUpdate`, `persistPermissionUpdates`):
- **Which updates are saved.** Only those with a file destination
  (`supportsPersistence`: user, project, local). A `session` or `cliArg`
  update writes nothing.
- **`addRules`** behaves as in section 3, managed-only refusal included.
- **`removeRules`** drops every entry of that behavior's list whose canonical
  form equals one of the rules. Other lists and keys are kept.
- **`replaceRules`** sets that behavior's list to the written forms.
- **`setMode`** writes `permissions.defaultMode`.
- **`addDirectories`** appends the directories not yet in
  `permissions.additionalDirectories`. When all are there, the file is not
  rewritten. **`removeDirectories`** filters them out.
- `persistPermissionUpdates` saves a list in order.

**What an update list adds.** `extractRules(updates)` returns the rules of the
`addRules` updates, in order. Rules from `replaceRules` and `removeRules` are
not included. No list gives `[]`.

**Read rule for a directory.** `createReadRuleSuggestion(dir, destination =
'session')` returns an `addRules` allow update with one `Read` rule:
- an absolute directory `/a/b` gets the pattern `//a/b/**`;
- a relative one gets `dir/**`;
- the root `/` gets nothing (`undefined`).

On Windows the path is first converted to POSIX form; that conversion is not
pinned here (see Out of scope).

### 6. Permission modes

The external modes, in this order, are `acceptEdits`, `bypassPermissions`,
`default`, `dontAsk` and `plan`. `PERMISSION_MODES`, the modes a setting or a
flag may name, are those five, plus `auto` last in a classifier build.

| Mode | Title | Symbol | Colour | External |
|---|---|---|---|---|
| `default` | `Default` | (empty) | `text` | `default` |
| `plan` | `Plan Mode` | `⏸` (U+23F8) | `planMode` | `plan` |
| `acceptEdits` | `Accept edits` | `⏵⏵` (U+23F5 ×2) | `autoAccept` | `acceptEdits` |
| `bypassPermissions` | `Bypass Permissions` | `⏵⏵` | `error` | `bypassPermissions` |
| `dontAsk` | `Don't Ask` | `⏵⏵` | `error` | `dontAsk` |
| `auto` (classifier build) | `Auto mode` | `⏵⏵` | `warning` | `default` |

- **Fallback.** Any other mode (`bubble`, unknown names, and `auto` in a build
  without the flag) gets the `default` row.
- **The title reaches the model.** The "requires approval" message in
  `permissions/requestMessage.ts` names the mode by its title. It must state
  the exact title of the current mode.
- **Reading a mode name.** `permissionModeFromString` returns the mode for an
  exact, case-sensitive member of `PERMISSION_MODES`, and `default` for
  anything else (`Plan`, ` plan`, `bubble`, `''`, `__proto__`).
- **Default mode.** `isDefaultMode` is true for `default` and `undefined`
  only.
- **External modes.** `isExternalPermissionMode` is false for `auto` and true
  for the five external modes (and see Findings, 5).
- **Schemas.**
  - `externalPermissionModeSchema` accepts the five external modes only.
  - `permissionModeSchema` accepts `PERMISSION_MODES`, so `auto` only in a
    classifier build, and never `bubble`.

### 7. The permission prompt tool

**The question** (`inputSchema`): `{ tool_name: string, input: object,
tool_use_id?: string }`.

**The answer** (`outputSchema`) is one of two shapes. Unknown keys are
dropped from both.
- **allow**: `{ behavior: 'allow', updatedInput: object,
  updatedPermissions?: PermissionUpdate[], toolUseID?: string,
  decisionClassification? }`.
- **deny**: `{ behavior: 'deny', message: string, interrupt?: boolean,
  toolUseID?: string, decisionClassification? }`.
- `decisionClassification` is `user_temporary`, `user_permanent` or
  `user_reject`.

Any other `behavior` is rejected, and so is an allow without `updatedInput` or
a deny without `message`.

**A malformed optional part does not reject the answer.**
- `updatedPermissions` that fail the update schema (an unknown type, a managed
  destination, mode `auto`, a non-list) are dropped, and the allow stands. A
  warning goes to the debug log.
- A `decisionClassification` outside the three values is dropped as well.

**From answer to decision**
(`permissionPromptToolResultToPermissionDecision(result, tool, input, ctx)`):
- **The returned decision** is the answer's fields plus
  `decisionReason: { type: 'permissionPromptTool', permissionPromptToolName:
  tool.name, toolResult: result }`.
- **An allow:**
  - An empty `updatedInput` (`{}`) is replaced by the original `input`, so the
    tool never runs with no arguments. Any other `updatedInput` is used as
    given.
  - With `updatedPermissions`, the updates are applied to
    `appState.toolPermissionContext` through one `ctx.setAppState` call (the
    rest of the state is kept). The file-bound ones are then saved, as in
    section 5.
  - Without updates, the app state is not touched.
- **A deny:**
  - With `interrupt: true`, it aborts `ctx.abortController`, which stops the
    turn.
  - Without it, nothing is aborted and nothing is applied.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `permissionRuleValueFromString('')` | `{ toolName: '' }` |
| a rule string with unbalanced or trailing parens | the whole string as the tool name |
| content ending in a backslash, `Bash(a\\)` | content `a\` |
| `permissionRuleValueToString({ toolName: 'Bash', ruleContent: '' })` | `Bash` |
| a settings file with broken JSON | no rules; adding to it returns `false` and leaves it untouched |
| a settings file with an invalid unrelated field | no rules are read from it (Findings, 3); adding keeps its fields; deleting returns `false` |
| deleting from a file that does not exist | `false`, and no file is created |
| adding an empty list | `true`, nothing written |
| an update of an unknown type | the same context object; persisting it writes nothing |
| `createReadRuleSuggestion('/')` | `undefined` |
| `permissionModeFromString` with any non-member | `default` |
| a malformed `updatedPermissions` from an SDK host | dropped; the allow stands |
| none of these functions throws for bad input | the loader logs and returns `false` on write errors |

## Security requirements

- **Deny and ask are never weaker than written.**
  - Every deny and ask rule in an enabled layer is loaded, whatever its
    neighbours in the file.
  - The managed layer's rules always load. Its managed-only switch can only
    come from the managed layer, and only from the value `true`.
- **Nothing writes the managed layer or `--settings`.** Deletion refuses those
  sources, the update schema rejects them as destinations, and adding with
  them writes nothing.
- **Managed rules only holds.**
  - While it is on, no layer but the managed one contributes rules.
  - No new rule is saved through `addPermissionRulesToSettings` or an
    `addRules` update.
  - The "always allow" options are hidden.
- **Rule identity is canonical.** Dedupe on add, deletion and persisted removal
  compare canonical forms, so a rule cannot be kept alive by spelling it
  another way (`Bash(*)`, `KillShell`, unescaped parens). Removal from memory
  does not compare this way yet (Findings, 2).
- **The escape grammar is part of the contract.** A paren is escaped by an odd
  run of backslashes. A rewrite that splits rule strings differently changes
  which content a Bash or file rule matches, so the reading tables in the suite
  must pass unchanged.
- **A broken file is never clobbered.** A JSON syntax error refuses the write.
- **The host's answer is untrusted.** Only the schema's shapes reach the
  decision. Malformed updates are dropped rather than applied. Only a deny can
  abort the turn, and only with `interrupt: true`.
- **The suggested Read rule is never the whole filesystem** (`/` gives
  nothing). See Findings, 4 for the gaps.

## Tests that pin it

- `src/permissions/ruleModel.parser.characterization.test.ts` (127 tests): the
  reading table, the whole-name fallbacks, old names, writing, escaping, round
  trips and canonical forms, the rule schemas, and the behavior verb.
- `src/permissions/ruleModel.modes.characterization.test.ts`: 15 tests
  in-process, one of which runs the child. The child
  `bun test --feature=TRANSCRIPT_CLASSIFIER` runs 16 tests, among them `auto`.
- `src/permissions/ruleModel.loader.characterization.test.ts` (70 tests):
  each layer, source order, `--setting-sources`, the managed origins, managed
  rules only, adding and deleting, all on real files in temp directories.
- `src/permissions/ruleModel.updates.characterization.test.ts` (58 tests):
  in-memory updates, immutability, `extractRules`, `supportsPersistence`, the
  Read suggestion, the update schema, and persistence to real files.
- `src/permissions/ruleModel.promptTool.characterization.test.ts` (31 tests):
  the question and answer schemas, malformed host answers, and the decision,
  with saved updates checked on disk.
- `src/permissions/__testutils__/ruleModelWorld.ts`: the temp settings world
  the loader, update and prompt-tool suites share. It holds the user, project,
  local, `--settings` and managed layers, and the registry caches. It
  sets `CLAUDIN_CONFIG_DIR`, `HOME`, `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1`, and restores everything afterwards.
- Fixtures in `src/permissions/__fixtures__/rewrite/`:
  `rules-on-disk.settings.json` (a file read through the loader) and
  `rules-after-add.settings.json` (the exact text two adds write).
- `scripts/migrations/probes/rewrite-permissions-ruleModel.json`: 40 probes
  over all eight files, each of which turns the suites red. Two of them go red
  only through the classifier child run.
- Existing tests that load the unit through its contract, not replaced:
  `permissions/permissions.test.ts`, `toolPermission/persistPermissions.test.ts`,
  `toolPermission/handlers/interactiveHandler.characterization.test.ts`,
  `tools/BashTool/bashPermissions.test.ts`, `platform/lifecycleHooks/hookUnits.test.ts`,
  `tools/toolSchemaStability.invariant.test.ts`, and others under
  `permissions/` and `tools/`.
- **Text pinned outside the unit.** The mode titles are pinned in
  `src/platform/settings/ui/Config.characterization.test.tsx` (the settings
  pane). No test outside the unit pins the hook verb message or the
  "requires approval" message byte for byte.

The unit has no inherited tests to fold in: `phase-3.json` names none for it.

## Out of scope

- **Validating rule strings and settings files.** That belongs to
  `platform/settings` (`permissionValidation.ts`, `validation.ts`). The loader
  only reads what validation lets through.
- **Matching a rule against a tool call.** That belongs to
  `permissions/decision`, `shellRules` and `fileRules`.
- **The Windows path conversion** inside `createReadRuleSuggestion`. It is
  `shared/fs/path.ts`'s, and cannot run on the Linux test host.
- **The short mode titles.** They exist in the old module but no export
  returns them, so they are dropped.
- **The debug-log lines** that updates and malformed answers write. They are not
  a contract.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **A malformed rule is silently inert.** A rule that validation lets through but the reader cannot split loads as a rule for a tool named by the whole string, which matches nothing. Examples: `Bash(rm:*) now`, `Bash(curl) x`, and `Bash (rm *)`, which loads as tool `Bash `. In a deny list, the user believes a deny is in force that is not. | **Keep for parity** in the reader: trimming or re-splitting would turn inert allow rules into live ones. Route to `platform/settings` validation: reject tool names with whitespace or parens, with the usual "was skipped" warning. That drops only rules that never matched. |
| 2 | **Removing a rule in memory can miss it.** The in-memory `addRules` stores the rule as written, so `{ Bash, '*' }` is stored as `Bash(*)` and an old name stays old. The in-memory `removeRules` compares exact strings. The rule list reads `Bash(*)` as `Bash` and asks to remove `Bash`, so a session allow added as `Bash(*)` (an SDK host can send one) stays in force after the user deletes it. Saved files do not have this problem. | **Fix** (hardening). Store the canonical form on `addRules` and `replaceRules`, and compare canonical forms on `removeRules`. Nothing depends on the non-canonical strings. Not pinned. |
| 3 | **One invalid field drops every rule in a file.** If any field fails the settings schema (an invalid `hooks` entry, say), the whole file is rejected and none of its rules load, deny and ask included. | **Keep for parity** here. The loader reads what `platform/settings` returns. Route it there: rules already survive bad entries one by one, and the same leniency per top-level field would keep denies in force. Pinned, so a change shows up. |
| 4 | **The Read suggestion's root check is narrow.** Only `/` is refused. `//` gives `////**`, `''` gives `/**`, and a trailing slash doubles (`/a/b/` → `//a/b//**`). On Windows a drive root converts to something other than `/` and is not refused. | **Fix** (hardening). Strip trailing separators, and refuse any root (`/`, `//`, a drive root, `''`). Callers pass real directories, so legitimate use never notices. Not pinned beyond `/`. |
| 5 | **`isExternalPermissionMode('bubble')` is true.** `bubble` is not an external mode. The only caller maps the result through `toExternalPermissionMode`, which gives `default` either way. | **Fix.** True only for the five external modes. Not pinned for `bubble`. |
| 6 | **Adding rules drops entries that validation skipped.** The add is built from the validated read of the file, so entries validation skipped (`Bash(foo`, `42`, lowercase names) disappear from the file on the next add. This happens in every behavior list, not only the one written to. | **Fix.** Build the edit from the file as written, so a skipped entry is kept (still skipped on read). The settings writer replaces arrays wholesale, so passing the raw lists is enough. Not pinned. |
| 7 | **New rules are not de-duplicated among themselves or canonicalized.** Adding `[Read, Read]` writes both, and adding `Task` to a file holding `Agent` writes `Task`. | **Fix.** De-duplicate the batch, and write canonical forms. Not pinned. |
| 8 | **Managed rules only does not stop every saved update.** `replaceRules` (and `setMode`, and the directory updates) are still saved to the user, project and local files while it is on. They have no effect while it lasts, but replaced rules come into force if the admin lifts it. | **Fix** (hardening). Refuse `replaceRules` too while it is on. Removals, modes and directories may stay. Not pinned. |
| 9 | **Persisting a removal to a missing file creates it** with an empty list. | **Fix.** Write nothing when the list does not change. Not pinned. |

## Target design

- **`permissionRuleParser.ts`** is a pure module.
  - One scanner finds unescaped delimiters, and two functions read and write
    rules.
  - The rename table is data, with an own-key lookup.
  - Export a `canonicalRuleString(raw)` helper, and use it wherever rules are
    compared: the loader, persistence, and in-memory removal (Findings, 2).
- **`permissionsLoader.ts`** splits reading from editing.
  - **Reading:** per-layer reads and the managed-only gate.
  - **Editing:** one "edit the rule lists of a file" function, fed the file as
    written (Findings, 6). Add and delete are thin callers of it.
  - The managed-only check lives in one place, shared by add and persistence
    (Findings, 8).
- **`PermissionUpdate.ts`**: a table maps behavior to its context key, which
  replaces the repeated selection. In-memory and persisted handling follow
  the same six cases. Persistence goes through the loader's edit function, not
  straight to the settings writer.
- **`PermissionMode.ts`**: one table of mode rows, typed by `PermissionMode`.
  The `auto` row is added under the flag. `isExternalPermissionMode` checks
  membership (Findings, 5).
- **Schemas** stay lazy, and `PermissionUpdateSchema.ts` keeps its light
  imports for `shared/types/hooks.ts`.
- **`PermissionPromptToolResultSchema.ts`**: the schemas, then one function
  that builds the decision. The app-state update and the save are passed in or
  called through `PermissionUpdate.ts`. It has no other side effects.
- **Types.** Explicit throughout, with no `any`. `getModeColor` returns a named
  exported union.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.** All 43 inherited bodies were written anew.
  - `permissionsLoader.ts` is now a thin facade over `ruleSettings/`: the rule
    lists, reading rules, the file edits, and persisting an update.
  - Edits refuse non-editable sources at one gate, `editPermissionSettings`.
  - The managed-only lock lives in one place, `ruleFileEdits.ts`.
  - The five characterization suites pass unchanged, the classifier child run
    included.
- **Fixes, each with a test.** Findings 2 and 4–9: the session `Bash(*)`
  deletion, Read-suggestion roots, `bubble`, add-rule keeping unvalidated
  entries, de-duplication and canonical form, managed-only `replaceRules`, and
  a removal no longer creating a missing file. Findings 1 and 3 are kept.
- **Probes.**
  - `rewrite-permissions-ruleModel.json` holds 119 probes.
  - `patchRename.json`'s probe on the `apply_patch` alias was re-pointed at the
    new rename table.
- **Found outside the unit, not fixed.** The settings parser memoizes its
  results, and the settings reader then filters rule lists in place on those
  cached objects. A later reader of the same text gets the filtered lists.
  This belongs to `platform/settings`. The rule edits parse the file
  themselves to avoid it.
- **Residue, reviewed.** 106 lines of Claude Code remain, all of them contract:
  - `PermissionPromptToolResultSchema.ts`, 44: the permission prompt tool's
    wire schema, meaning its field names and their `.describe()` text, which
    SDK callers read.
  - `PermissionUpdate.ts`, 23: the update union's signatures.
  - `PermissionUpdateSchema.ts`, 10.
  - `permissionsLoader.ts`, 8.
  - `PermissionMode.ts` and `PermissionRule.ts`, 7 each: the mode and rule
    enums.

  One fixes-test table matched openclaude by shape. It was reworded at landing.
