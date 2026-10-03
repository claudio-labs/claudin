# Spec: `permissions/decision`

Six files: `src/permissions/permissions.ts` (the barrel and the decision),
`src/permissions/permissions/ruleLookup.ts`, `ruleMutation.ts`,
`requestMessage.ts`, `denial.ts`, and `src/permissions/denialTracking.ts`.

## Purpose

Every tool call the agent makes passes through this unit before it runs. Given
the tool, its input and the session's permission state, it answers **allow**
(run it, possibly with a rewritten input), **ask** (show the user a prompt) or
**deny** (refuse, with a message the model reads). It owns:

- **The rule lookup:** listing the allow, deny and ask rules a session holds,
  by source, and finding the rule that covers a whole tool, MCP tools
  included.
- **The decision:** combining those rules with the tool's own verdict and the
  permission mode (`default`, `acceptEdits`, `plan`, `bypassPermissions`,
  `dontAsk`, `auto`), plan mode's refusal of writes, sessions that cannot show
  a prompt and their `PermissionRequest` hooks, and, in the auto-mode build,
  routing to the auto-mode classifier.
- **The denial streak** auto mode keeps, and when it hands a call back to the
  user.
- **The request message** a prompt shows.
- **Changing the rules in force:** removing a rule, adding rules at startup,
  and re-syncing them when settings files change.

`.claudin/rules/code-design.md` names this the security hot path.
`phase-3.md` ("Order and security weight") gives it the strictest
characterization: every deny and ask outcome is probed, not just allow.

**The auto-mode build flags.** `feature('TRANSCRIPT_CLASSIFIER')` and
`feature('BASH_CLASSIFIER')` are on in the shipped build and off under plain
`bun test`. Auto mode, its classifier and two message details exist only with
them on. Each behaviour below that depends on them says so.

## Public contract

Everything is imported from the barrel `src/permissions/permissions.ts`,
except `getRuleByContentsForToolName`, which `filePermissions/rulePatterns.ts`
imports from `src/permissions/permissions/ruleLookup.ts`, and the denial
counter, which is imported from `src/permissions/denialTracking.ts`. Keep all
three module paths. Paths in "Used by" are under `src/`.

### The decision

| Export | Signature | Used by |
|---|---|---|
| `hasPermissionsToUseTool` | `CanUseToolFn`: `(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?) => Promise<PermissionDecision>`. The sixth argument is accepted and ignored. | `permissions/useCanUseTool.tsx`, `permissions/toolPermission/handlers/interactiveHandler.ts`, `platform/headless/structuredIO.ts`, `platform/headless/print/permissionGlue.ts`, `platform/headless/workflow/runWorkflowHeadless.ts`, `platform/entrypoints/mcp.ts`, `platform/lifecycleHooks/execAgentHook.ts`, `agent/coordinator/swarm/inProcessRunner.ts`, `agent/input/processSlashCommand.tsx`, `shared/proc/promptShellExecution.ts` |
| `checkRuleBasedPermissions` | `(tool: Tool, input: Record<string, unknown>, context: ToolUseContext) => Promise<PermissionAskDecision \| PermissionDenyDecision \| null>` | `agent/tools/toolHooks.ts` (when a `PreToolUse` hook answers allow) |
| `planModeDefersToClassifier` | `(toolName: string, autoModeActive: boolean) => boolean` | `permissions/permissions.test.ts` |

### The rule lookup

| Export | Signature | Used by |
|---|---|---|
| `getAllowRules`, `getDenyRules`, `getAskRules` | `(context: ToolPermissionContext) => PermissionRule[]` | `permissions/ui/rules/PermissionRuleList.tsx`, `permissions/shadowedRuleDetection.ts` |
| `toolAlwaysAllowedRule`, `getDenyRuleForTool`, `getAskRuleForTool` | `(context: ToolPermissionContext, tool: Pick<Tool, 'name' \| 'mcpInfo'>) => PermissionRule \| null` | `tools/tools.ts` (`getDenyRuleForTool`) |
| `getDenyRuleForAgent` | `(context: ToolPermissionContext, agentToolName: string, agentType: string) => PermissionRule \| null` | `tools/AgentTool/AgentTool.tsx` |
| `filterDeniedAgents` | `<T extends { agentType: string }>(agents: T[], context: ToolPermissionContext, agentToolName: string) => T[]` | `tools/AgentTool/AgentTool.tsx`, `agent/attachments/injections.ts` |
| `getRuleByContentsForTool` | `(context: ToolPermissionContext, tool: Tool, behavior: PermissionBehavior) => Map<string, PermissionRule>` | `tools/BashTool/bashPermissions/ruleMatching.ts`, `tools/WebFetchTool/WebFetchTool.ts`, `tools/SkillTool/SkillTool.ts` |
| `getRuleByContentsForToolName` | `(context: ToolPermissionContext, toolName: string, behavior: PermissionBehavior) => Map<string, PermissionRule>` | `tools/PowerShellTool/powershellPermissions.ts`, `permissions/filePermissions/rulePatterns.ts` |
| `permissionRuleSourceDisplayString` | `(source: PermissionRuleSource) => string` | `PermissionRuleList.tsx`, `shadowedRuleDetection.ts` |

### Messages and rule changes

| Export | Signature | Used by |
|---|---|---|
| `createPermissionRequestMessage` | `(toolName: string, decisionReason?: PermissionDecisionReason) => string` | `tools/BashTool/bashPermissions/{decide,gates,ruleMatching}.ts`, `tools/BashTool/bashCommandHelpers.ts`, `tools/PowerShellTool/powershellPermissions.ts` |
| `deletePermissionRule` | `(args: { rule: PermissionRule; initialContext: ToolPermissionContext; setToolPermissionContext: (ctx: ToolPermissionContext) => void }) => Promise<void>` | `PermissionRuleList.tsx` |
| `applyPermissionRulesToPermissionContext` | `(context: ToolPermissionContext, rules: PermissionRule[]) => ToolPermissionContext` | `permissions/permissionSetup/startupContext.ts` |
| `syncPermissionRulesFromDisk` | `(context: ToolPermissionContext, rules: PermissionRule[]) => ToolPermissionContext` | `platform/settings/applySettingsChange.ts` |

### The denial counter (`denialTracking.ts`)

| Export | Signature | Used by |
|---|---|---|
| `DenialTrackingState` (type) | `{ consecutiveDenials: number; totalDenials: number }` | `tools/Tool.ts` (`ToolUseContext.localDenialTracking`), `terminal/state/AppStateStore.ts` (`AppState.denialTracking`) |
| `DENIAL_LIMITS` | `{ maxConsecutive: 3, maxTotal: 20 }` (readonly) | this unit |
| `createDenialTrackingState` | `() => DenialTrackingState` | `agent/coordinator/forkedAgent.ts` |
| `recordDenial`, `recordSuccess` | `(state: DenialTrackingState) => DenialTrackingState` | this unit |
| `shouldFallbackToPrompting` | `(state: DenialTrackingState) => boolean` | this unit |

`src/__tests__/barrelSurface.test.ts` checks that the barrel exports every
name in the three tables above.

## Observable behaviour

### 1. The rules a session holds

A `ToolPermissionContext` holds rule strings in `alwaysAllowRules`,
`alwaysDenyRules` and `alwaysAskRules`, each keyed by source.

- **Source order.** `userSettings`, `projectSettings`, `localSettings`,
  `flagSettings`, `policySettings`, `cliArg`, `command`, `session`. The
  listings return rules in this order, and within a source in the order
  written. A source that is absent contributes nothing.
- **Each rule** is `{ source, ruleBehavior, ruleValue }`. `ruleValue` is the
  string parsed by `permissionRuleValueFromString` (`permissions/ruleModel`):
  `Tool` or `Tool(content)`. `Tool()` and `Tool(*)` mean the whole tool,
  `\(` and `\)` in content are read back as parentheses, and retired tool names
  become current ones (`Task` → `Agent`, `KillShell` → `TaskStop`,
  `BashOutputTool` → `TaskOutput`).
- **Display names of the sources** (`permissionRuleSourceDisplayString`):

  | Source | Shown as |
  |---|---|
  | `userSettings` | `user settings` |
  | `projectSettings` | `shared project settings` |
  | `localSettings` | `project local settings` |
  | `flagSettings` | `command line arguments` |
  | `policySettings` | `enterprise managed settings` |
  | `cliArg` | `CLI argument` |
  | `command` | `command configuration` |
  | `session` | `current session` |

### 2. Which rule covers a whole tool

`toolAlwaysAllowedRule`, `getDenyRuleForTool` and `getAskRuleForTool` each
look only at their own kind and return the **first** covering rule in source
order, or `null`. A rule covers a whole tool when it has no content and:

- **Built-in tools:** its name equals the tool's name exactly. Case matters, and a prefix or a longer name does not match.
- **MCP tools** (tools with `mcpInfo`) are matched by their full name `mcp__<server>__<tool>`, built from `mcpInfo` with both parts normalized by `buildMcpToolName` (`mcp/core`: characters outside `[A-Za-z0-9_-]` become `_`). A tool's display name never matches. So an MCP tool shown as `Write` (skip-prefix mode) is not covered by a `Write` rule, only by `mcp__<server>__Write`. A tool named `mcp__…` with no `mcpInfo` is matched on its name the same way.
  - `mcp__server__tool` covers that tool only.
  - `mcp__server` and `mcp__server__*` cover every tool of that server, and no other server's.
  - A partial server name, a glob on the server name (`mcp__forge*`), a sibling tool, `mcp__` alone, or a content rule (`mcp__forge(x)`) cover nothing.
  - Server and tool are read back out of the full name by `mcpInfoFromString` (`mcp/core`), which splits at the first `__` after `mcp`. So for a server named `team__a`, `mcp__team` covers its tools and `mcp__team__a` does not (Finding 3).

**Content lookups.** `getRuleByContentsForToolName(context, name, behavior)`
returns a map from content to rule for the content rules of that kind that
name exactly that tool. When two sources hold the same content, the later
source in the order wins. `getRuleByContentsForTool` does the same with the
tool's full MCP name, or its name.

**Agent rules.** `getDenyRuleForAgent(context, agentToolName, agentType)`
returns the first deny rule `agentToolName(agentType)` (exact, case-sensitive),
including one written with the retired `Task` name. `filterDeniedAgents` drops
the agents whose `agentType` is named by such a deny rule and keeps the rest
in their order. A whole-tool `Agent` deny filters none.

### 3. The decision: `hasPermissionsToUseTool`

The tool's own verdict is what its `checkPermissions(parsedInput, context)`
returns. It is asked once, with the input as parsed by the tool's schema. When
the input fails the schema, or the check throws, the verdict counts as "no
opinion" (passthrough) and the tool is not asked. An abort thrown by the check
(`AbortError` or an SDK user abort) is rethrown.

A call whose abort signal has already fired fails with `AbortError` before
anything is looked at.

The outcome is the first row that applies:

| # | When | Outcome |
|---|---|---|
| 1 | a deny rule covers the whole tool | **deny**, `decisionReason: { type: 'rule', rule }`, a message that names the tool and says it was denied |
| 2 | an ask rule covers the whole tool (the Bash sandbox exception aside, below) | **ask**, `decisionReason: { type: 'rule', rule }`, the default request message |
| 3 | plan mode refuses the call (section 4) | **deny**, `decisionReason: { type: 'mode', mode: 'plan' }` |
| 4 | the tool denies | the tool's verdict, unchanged |
| 5 | the tool asks and declares `requiresUserInteraction()` | the tool's verdict, unchanged |
| 6 | the tool asks with a `rule` reason whose `ruleBehavior` is `ask` (a content ask rule) | the tool's verdict, unchanged |
| 7 | the tool asks with a `safetyCheck` reason | the tool's verdict, unchanged |
| 8 | mode `bypassPermissions`, or mode `plan` in a session started with bypass available (`isBypassPermissionsModeAvailable`) | **allow**, `decisionReason: { type: 'mode', mode }` with the current mode |
| 9 | an allow rule covers the whole tool | **allow**, `decisionReason: { type: 'rule', rule }` |
| 10 | otherwise | the tool's verdict; a passthrough becomes **ask** with the tool's other fields kept and `message` set to `createPermissionRequestMessage(name, verdict.decisionReason)` |

- **Input on allow.** Rows 8 and 9 carry the tool's `updatedInput` when its verdict has one, and the input given otherwise.
- Rows 4–7 return the verdict object as the tool gave it, so rows 4, 6 and 7 hold in every mode, `bypassPermissions` included.
- **The Bash sandbox exception to row 2.** For a tool named `Bash`, when sandboxing is enabled, `autoAllowBashIfSandboxed` is on, and the input would run sandboxed (`shouldUseSandbox`), the ask rule is skipped and the decision continues at row 3. This build has no sandbox runtime (`SandboxManager.checkDependencies` reports "sandbox-runtime not available in open build"), so the exception never fires here. The suite pins that the ask rule holds with `sandbox.enabled` set.

Then the mode adjusts an **ask** (an allow or deny is returned as it is):

- **`dontAsk`** turns any ask into **deny**, with `decisionReason: { type: 'mode', mode: 'dontAsk' }` and `message: DONT_ASK_REJECT_MESSAGE(toolName)`. That covers ask rules, safety checks and tools that need the user. No hook runs.
- **`auto`, with the classifier build:** section 6.
- **A session that cannot prompt** (`shouldAvoidPermissionPrompts`): section 5.
- **`auto` without the classifier build** behaves like `default`: the ask is returned.

**The default request message** names the tool, says it requested permission
to use it, and that it has not been granted yet.

### 4. Plan mode

In mode `plan`, a call is refused unless one of these holds:

- the session started with bypass available (it is then allowed, row 8);
- the tool is `ExitPlanMode` (the v2 name);
- the tool's own verdict is allow (this is how the plan file is written);
- the call is read-only: `tool.isReadOnly(parsedInput)` is true. A read-only check that throws, or input that fails the schema, counts as a write;
- with the classifier build: the tool is `Bash` and auto mode is active (`isAutoModeActive()`). `planModeDefersToClassifier(name, active)` is exactly `active && name === 'Bash'`, case-sensitive.

The refusal comes after a whole-tool deny or ask rule (rows 1–2) and before
everything else, so it beats the tool's own deny, a content ask, a safety
check and an allow rule. Sub-agents inherit the mode, so it covers them.

**The refusal message** is read by the model. It must state that plan mode is
active, name the tool, say that the call is not read-only and cannot run
until `ExitPlanMode` is called, and give the plan file's path in parentheses:
`getPlanFilePath(context.agentId)`, which for a sub-agent includes its agent
ID. If the path cannot be computed, it says only the plan file may be edited,
without a path.

### 5. Sessions that cannot prompt, and `PermissionRequest` hooks

When `shouldAvoidPermissionPrompts` is set and the outcome is still ask
(after `dontAsk`, and after auto mode when that applies), the session's
`PermissionRequest` hooks run (`executePermissionRequestHooks`, owned by
`platform/lifecycleHooks`). Each hook gets the tool name, the input, the
current mode as `permission_mode`, and the tool's `suggestions` as
`permission_suggestions`. The first hook that decides wins:

- **allow:** **allow** with `decisionReason: { type: 'hook', hookName: 'PermissionRequest' }` and the hook's `updatedInput`, or the original input. Its `updatedPermissions`, if any, are saved to their destinations (`persistPermissionUpdates`; a `localSettings` rule lands in `.claudin/settings.local.json`) and applied to the session's permission context through `setAppState`.
- **deny:** **deny** with `decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason: <hook message> }` and the hook's message, or a stock one saying the hook denied permission when the message is empty. With `interrupt: true`, the turn's abort controller is aborted as well.
- No hook, no decision, a hook that fails, prints something that is not a decision, or exits non-zero: **deny** with `decisionReason: { type: 'asyncAgent', reason }`, where the reason says prompts are not available in this context, and `message: AUTO_REJECT_MESSAGE(toolName)`.

### 6. Auto mode (classifier build only)

Applies when the outcome is ask and the mode is `auto`, or the mode is `plan`
with auto mode active. In order:

1. **A safety check only a person may approve** (`safetyCheck` with `classifierApprovable` false or absent): the ask is returned. Where no one can be asked, it becomes **deny** with the tool's message and an `asyncAgent` reason saying the safety check needs interactive approval.
2. **A tool that needs the user** keeps its ask.
3. **PowerShell** (the tool named `PowerShell`) keeps its ask. It is never classified nor given the acceptEdits check. Where no one can be asked, it becomes **deny**: the message names PowerShell and says it requires interactive approval, and the reason is `asyncAgent`.
4. **What acceptEdits would allow.** Outside plan mode, and for any tool but `Agent`, the tool is asked again with the mode shown as `acceptEdits`. If that verdict is allow, the call is **allowed** with `decisionReason: { type: 'mode', mode: 'auto' }` and that verdict's `updatedInput`, or the input. If that second check throws, the call goes on to the classifier; an abort is rethrown.
5. **The safe tools.** `isAutoModeAllowlistedTool(tool.name)` (`permissions/autoModeClassifier`) lets a call through as **allow** `{ type: 'mode', mode: 'auto' }`, with the input unchanged. Today that is `Read`, `Grep`, `Glob`, `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop`, `TaskOutput`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `TeamCreate`, `TeamDelete`, `SendMessage`, `ListAgents`, `Sleep` and `classify_result`. `Git` is let through the same way only when `isReadOnly` on the parsed input is true. A read-only check that throws sends it to the classifier.
6. **The classifier.** `classifyYoloAction(context.messages, formatActionForClassifier(name, input), context.options.tools, permissionContext, abortSignal)` decides. While it runs, `isClassifierChecking(toolUseID)` is true. It is false afterwards, whether the classifier answered or failed. Each answer that reports a duration adds to the turn's classifier tally (`addToTurnClassifierDuration`); outages report none.
   - **Allowed:** **allow**, `decisionReason: { type: 'classifier', classifier: 'auto-mode', reason }`, with the input unchanged.
   - **Blocked:** **deny**, the same reason shape, and `message: buildYoloRejectionMessage(reason)`. The denial is counted (section 7).
   - **Unavailable** (an outage, a transient status such as 429): **deny**, `decisionReason: { type: 'classifier', classifier: 'auto-mode', reason: 'Classifier unavailable' }`, `message: buildClassifierUnavailableMessage(toolName, model)`. No denial is counted.
   - **A permanent failure** (the transcript is too long for the classifier, or the API answered with a non-transient 4xx) or **running out of time** (`CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS`): with someone to ask, the original **ask** is returned with `decisionReason: { type: 'other', reason }`. The reason says the auto mode classifier failed and the call falls back to manual approval, and names the cause (context window, deterministic error, time budget).
     - Where no one can be asked, the two permanent causes throw `AbortError`. Its message says the auto mode classifier failed in headless mode and names the cause.
     - Running out of time there is treated as **unavailable** instead, so the model gets the retry guidance.

These steps all come after rows 1–10 of section 3, so a whole-tool deny rule
(MCP server rules included) still refuses before any classifier call, and a
whole-tool ask rule is settled by the classifier like any other ask.

The model call is `sideQuery`. The suite stubs only that, and the classifier's
own prompt building and parsing run as shipped.

### 7. The denial streak

The streak lives in `context.localDenialTracking` when the context has one (a
sub-agent's own counter, updated in place) and otherwise in
`AppState.denialTracking`, written through `setAppState`. A missing streak
starts at zero.

- **Every allow outcome in mode `auto`** ends the streak: consecutive goes to 0, and the total is kept. That covers rules, bypass, the acceptEdits check, the safe tools and the classifier. In other modes the streak is not touched. When the streak is already 0, the app state object is left as it was.
- **A classifier block** counts: consecutive +1 and total +1.
- **At the limit** (`shouldFallbackToPrompting`: 3 in a row, or 20 in all), the blocked call is not denied. The original **ask** comes back, with `decisionReason: { type: 'classifier', classifier, reason }`:
  - `classifier` is the classifier named in the tool's own ask reason, or `auto-mode`.
  - The reason states the count, either `N consecutive actions were blocked` or `N actions were blocked this session` when the total limit is the one hit. It asks the user to review the transcript, and ends with the latest blocked action's reason.
  - Reaching the total limit resets both counts to 0.
  - Where no one can be asked, reaching the limit throws `AbortError`, saying there were too many classifier denials in headless mode.

### 8. `checkRuleBasedPermissions`

The rule-only subset, for when a `PreToolUse` hook has already allowed the
call. It returns:

- the deny of row 1 or the ask of row 2 (with the same Bash sandbox exception);
- plan mode's refusal (section 4), so a hook allow cannot get around it;
- the tool's own deny, its content ask (row 6) and its safety-check ask (row 7, approvable or not), unchanged;
- `null` otherwise. That includes allow rules, plain tool asks, tools that need the user (the caller checks that), any mode, `dontAsk`, and sessions that cannot prompt.

The tool check is handled as in section 3: a failure is no opinion, and an
abort is rethrown.

### 9. `createPermissionRequestMessage(toolName, reason?)`

| Reason | The message |
|---|---|
| none | the default request message (section 3) |
| `hook` with a reason | `Hook '<name>'`, says it blocked this action, then `: <reason>` |
| `hook` without one | `Hook '<name>'` requires approval for this `<tool>` command |
| `rule` | `Permission rule '<rule string>'`, `from <source display name>`, requires approval for this `<tool>` command. The rule string is written with escaped parentheses, as `permissionRuleValueToString` writes it. |
| `subcommandResults` | says the `<tool>` command contains multiple operations, and lists the parts whose result is ask or passthrough, in order, joined by `, `: "the following part requires" or "the following parts require" approval. With none, it says that it contains multiple operations that require approval, with no list. For `Bash` only, a part's output redirections are cut off (`echo hi > out.txt` shows as `echo hi`). |
| `permissionPromptTool` | `Tool '<prompt tool>'` requires approval for this `<tool>` command |
| `sandboxOverride` | says to run outside of the sandbox |
| `workingDir`, `safetyCheck`, `other`, `asyncAgent` | the reason text, as it is |
| `mode` | `Current permission mode (<title>)` requires approval for this `<tool>` command. Titles: `Default`, `Plan Mode`, `Accept edits`, `Bypass Permissions`, `Don't Ask`, and for `auto` `Auto mode` with the classifier build or `Default` without it. |
| `classifier`, with the classifier build | `Classifier '<name>'` requires approval for this `<tool>` command, then `: <reason>` |
| `classifier`, without it | the default request message |

### 10. Changing the rules in force

- **`deletePermissionRule({ rule, initialContext, setToolPermissionContext })`**
  - For a rule from `policySettings`, `flagSettings` or `command`, it rejects with an error saying the rule is in read-only settings, and calls nothing.
  - Otherwise it removes the rule from its source and kind in the context and calls `setToolPermissionContext` once with the new context. `initialContext` is not mutated.
  - For `userSettings`, `projectSettings` and `localSettings`, it also removes the entry from that settings file. Entries are compared in canonical form, so a retired name on disk matches. Other keys and other kinds are kept.
  - A rule missing from the file still leaves the session.
  - `cliArg` and `session` rules are never written to disk.
- **`applyPermissionRulesToPermissionContext(context, rules)`** appends each rule string, in canonical form, to its source and kind, after what is there. It returns a new context, and an empty list gives back an equal one.
- **`syncPermissionRulesFromDisk(context, rules)`**
  - It empties all three kinds for `userSettings`, `projectSettings` and `localSettings`, then replaces each source and kind present in `rules` with exactly those rules. Other sources are kept unless `rules` holds some for them.
  - When managed settings set `allowManagedPermissionRulesOnly: true`, the `cliArg` and `session` rules are emptied too. `command` rules are kept.
  - It returns a new context.

### 11. The denial counter (`denialTracking.ts`)

- `createDenialTrackingState()` returns a new `{ 0, 0 }` on each call.
- `recordDenial(s)` returns a new state with both counts +1, and leaves `s` as it was.
- `recordSuccess(s)` returns a new state with consecutive 0 and the total kept, or `s` itself when consecutive is already 0.
- `shouldFallbackToPrompting(s)` is true when `consecutive >= 3` or `total >= 20`.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| the turn already aborted | `AbortError`, the tool not asked |
| the tool's check throws | treated as passthrough (and logged) |
| the tool's check aborts | the abort is rethrown, in both entry points |
| input the tool's schema rejects | the tool is not asked, and the outcome is ask (or what the mode makes of it) |
| `isReadOnly` throws in plan mode | counts as a write: refused |
| an allow with no `updatedInput` | the input given |
| a rule `Tool()` or `Tool(*)` | the whole tool |
| a rule differing in case | no match |
| an MCP tool under a built-in display name | matched only by its full name |
| an empty context | no rules, ask (default mode) |
| a hook that prints garbage or exits non-zero | refusal as with no hook |
| classifier outage | deny, no denial counted |
| classifier permanent failure, no one to ask | `AbortError` |
| denial limit, no one to ask | `AbortError` |
| deleting a policy, flag or command rule | rejected promise, nothing changed |

## Security requirements

- **Deny is final.** A whole-tool deny rule from any source refuses in every mode, `bypassPermissions` included, and before any hook, classifier or allow rule. The same holds for a tool's own deny, except that plan mode's refusal replaces it.
- **Some asks survive bypass mode.** Content ask rules, safety checks and tools that need the user keep their ask in `bypassPermissions`. In `dontAsk` they become a deny, never an allow.
- **No prompt means no.** In a session that cannot prompt, an ask never becomes an allow without a `PermissionRequest` hook saying allow.
- **Plan mode cannot be bypassed by a hook.** `checkRuleBasedPermissions` applies the same refusal.
- **Auto mode fails closed.** An unavailable classifier denies. A safety check only a person may approve, a tool that needs the user, and PowerShell never reach the classifier, nor any auto-allow shortcut.
- **MCP rules use full names**, so a rule for a built-in never covers an MCP tool that borrows its name.
- **Managed policy can lock the rules.** With `allowManagedPermissionRulesOnly`, re-syncing drops the CLI and session rules.
- **Read-only settings stay read-only.** Rules from managed, flag or command settings cannot be deleted through the UI.

## Tests that pin it

- `src/permissions/permissions.decision.characterization.test.ts` (114 tests, flags off):
  - the whole-tool matrix: 3 kinds × 8 sources × 6 modes × 3 tools (writing, read-only, MCP), and no rule;
  - precedence and rule shapes, MCP matching, the tool's verdict;
  - plan mode, `dontAsk`, auto mode without the build, and sessions that cannot prompt, with real `PermissionRequest` command hooks;
  - the Bash ask rule with sandboxing on, and `checkRuleBasedPermissions`.
- `src/permissions/permissions.rules.characterization.test.ts` (64 tests): listings, finders, agent and content lookups, source names, the request message, rule deletion against real settings files, the add and sync of rules (managed-only through a real managed-settings file), and the denial counter.
- `src/permissions/permissions.autoMode.characterization.test.ts`: 1 test under plain `bun test`, which runs the file again in a child `bun test --feature=TRANSCRIPT_CLASSIFIER --feature=BASH_CLASSIFIER`. There, 50 tests cover sections 6 and 7 and the two flag-dependent messages, with only `sideQuery` stubbed.
- The harness is `src/permissions/__testutils__/decisionWorld.ts`. It sets a temp config home, managed-settings directory and project per test, and puts back every global it touches.
- `scripts/migrations/probes/rewrite-permissions-decision.json`: 40 probes over the six files. 36 of them guard a deny, an ask or a refusal, and each one turns the suites red.
- Kept, this project's own: `src/permissions/permissions.test.ts` (plan-mode gate), `src/permissions/planFilePermission.test.ts`, `src/__tests__/barrelSurface.test.ts`.

**Text pinned outside the unit.** `src/permissions/permissions.test.ts` pins
the first sentence of the plan-mode refusal byte for byte. The rewrite must keep
that sentence or update that test. No snapshot holds this unit's text. The
rejection texts (`AUTO_REJECT_MESSAGE`, `DONT_ASK_REJECT_MESSAGE`,
`buildYoloRejectionMessage`, `buildClassifierUnavailableMessage`) belong to
`agent/messages/rejection.ts` and are snapshotted there
(`light-buckets.test.ts.snap`). This unit only chooses among them.

**Inherited tests to fold in:** the unit's entry in
`scripts/migrations/rewrite/units/phase-3.json` lists none, so none were
deleted.

## Out of scope

- The rule parser and the loader (`permissions/ruleModel`), the MCP name parsing (`mcp/core`), the classifier itself and its allowlist (`permissions/autoModeClassifier`), the hooks runner (`platform/lifecycleHooks`), and the tools' own checks.
- The cost of a classifier call is computed and then dropped, as is a decision label. Nothing observes either, and the rewrite need not compute them.
- **Not pinned:**
  - The plan-file clause without a path, when the path cannot be computed: no input makes `getPlanFilePath` fail in a test.
  - The `Bash` sandbox exception firing (the open build has no sandbox runtime).
  - A `PermissionRequest` hook runner that throws: the runner catches hook failures itself, so the unit's own fallback is unreachable through real hooks.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **An import cycle trips under `bun test` with the classifier flag.** Loading the classifier barrel (`src/permissions/yoloClassifier.js`) before this unit throws `Cannot access 'YOLO_CLASSIFIER_TOOL_NAME' before initialization`. The chain is `yoloClassifier/classify.ts` → `agent/messages/messages.ts` → `planMode.ts` → `ExitPlanModeV2Tool.ts` → `permissionSetup.ts` → `permissionSetup/startupContext.ts` → `permissions.ts`. The decision module loads the safe-tool list when it loads, and that list reads the classifier's tool name, which is not yet initialized. **The shipped bundle does not hit it.** `bun run build` (v1.1.40, in this sandbox) wraps every module in a lazy initializer and emits the name as a chunk-level constant (`YOLO_CLASSIFIER_TOOL_NAME="classify_result"`), assigned before any initializer runs. `node dist/cli.mjs --version` boots. A test-order hazard only: `classifierProbe.test.ts` fails in a multi-file flagged run and passes alone. | **Fix.** Nothing depends on the load order. The new decision module reaches the classifier and its allowlist at decision time, not at load time. The auto-mode suite imports the decision module first, so it passes either way. |
| 2 | **MCP tools can ride the safe-tool allowlist.** In auto mode the allowlist is checked against `tool.name`. In skip-prefix mode (`CLAUDE_AGENT_SDK_MCP_NO_PREFIX`), an MCP tool's name is its bare display name, so a server exposing a tool named `Read`, `Grep`, `TodoWrite` or `classify_result` is auto-allowed without the classifier. The rule lookup was hardened against this by matching full names (section 2); the allowlist was not. | **Fix** (hardening). Check the allowlist against the full MCP name, so only built-ins qualify. Built-in tools are unaffected, and an MCP tool merely goes to the classifier. Not pinned. |
| 3 | **Server names containing `__` break MCP rules.** For a server named `team__a`, `mcp__team__a` and `mcp__team__a__*` do not cover its tools, so a deny written that way fails open, while `mcp__team` covers them, so an allow for server `team` widens to `team__a`. The cause is the name parser in `mcp/core`, which documents it as a known limitation. A server name ending in `_` is affected the same way. | **Keep for parity.** A fix changes which existing rules match in both directions. Route it to `mcp/core` (for example, refusing `__` in server names at config time). Pinned. |
| 4 | **Managed-only leaves `flagSettings` rules in force.** With `allowManagedPermissionRulesOnly`, a re-sync empties user, project, local, CLI and session rules but keeps rules that a `--settings` file loaded before the policy changed. At startup under that policy, such rules are never loaded. | **Fix** (hardening): empty `flagSettings` too. Keep `command` rules, which commands rely on. Left unpinned in the suite on purpose. |
| 5 | **A tool's own allow passes plan mode.** The refusal is skipped whenever the tool's verdict is allow. That is how the plan file is written, but the file tools and Bash also answer allow for content allow rules (`Edit(src/**)`, `Bash(npm test)`), so those writes run in plan mode. A whole-tool allow rule does not get through. | **Keep for parity.** Users rely on allow-listed commands working while planning, and narrowing this is a product decision for `permissions/fileRules` and the plan-mode owner. Pinned through a stand-in tool. |
| 6 | **A whole-tool ask rule beats plan mode.** In plan mode an `ask: ["Write"]` rule prompts instead of refusing, so a user's yes lets the write run before `ExitPlanMode`. | **Keep for parity.** The user is asked, so nothing runs without consent. Pinned. |
| 7 | **The whole-tool ask message does not name the rule.** An ask from row 2 carries the rule in its reason but shows the default request message. | **Keep for parity.** The prompt UI explains the rule from the reason. Pinned. |
| 8 | **The Bash sandbox exception is dead in this build.** Sandboxing reports "sandbox-runtime not available in open build", so `autoAllowBashIfSandboxed` never relaxes a Bash ask rule. | **Keep for parity.** The contract stays for a build with a sandbox runtime. Not testable here. |

## Target design

- **One slice, three responsibilities:**
  - `ruleLookup.ts`, pure functions over a `ToolPermissionContext`.
  - The decision, a pipeline of small named steps (rule gate, plan gate, tool verdict, mode adjustment, headless hooks, auto mode) whose order is data the tests can read.
  - `ruleMutation.ts`, context transforms plus the one disk write.
- **The auto-mode path is its own module**, given the classifier and the allowlist as dependencies. That makes the flag check one place, removes the load-time cycle (Finding 1), and allows a unit test without the build flag.
- **Make the decision record explicit.** Return the `PermissionDecision` union unchanged, and derive the reason types from `PermissionResult.ts` (`permissions/ruleModel`) rather than restating them.
- **The denial counter stays pure:** immutable updates, and one persistence function that knows the sub-agent and app-state cases.
- **No telemetry.** Drop the unused cost and decision-label computations.
