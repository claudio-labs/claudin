# Spec: `permissions/autoModeClassifier`

Files today: `yoloClassifier.ts` (barrel, this project's own), `yoloClassifier/{classify,transcript,prompts,xmlResponse,autoModeDumps,classifierConfig}.ts`,
`classifierApprovals.ts`, `classifierApprovalsHook.ts`, `classifierDecision.ts`, `classifierShared.ts`,
`bashClassifier.ts`, `autoModeRules.ts`, `autoModeDenials.ts`, all under `src/permissions/`.

## Purpose

Auto mode lets the agent run tool calls without a permission prompt when a
model judges them safe. This unit is that judge and what surrounds it:

- **The auto-mode classifier** (`classifyYoloAction`). Given the conversation
  and the tool call about to run, it asks the main-loop model whether to block
  it, and returns a verdict. The permission engine (`permissions.ts`) calls it
  for every tool call in auto mode that is not on the skip list; the Agent tool
  calls it once more when a sub-agent hands back control.
- **What feeds it**: the transcript it reads, the system prompt it sends (with
  the user's `autoMode` rules), and the vetting of those rules.
- **The skip list**: tools that never need a verdict.
- **The Bash prompt-rule classifier** (`classifyBashCommand`), which matches a
  shell command against the natural-language `Bash(prompt: …)` permission rules,
  and the helper that generalizes a command into such a rule.
- **Small stores the UI reads**: which tool uses a classifier approved, which are
  being checked right now, and the recent auto-mode denials.

It is security-weighted: a wrong "allow" runs a command the user never saw.
**Every outcome other than a clean allow from the model must come back as a
block** (`shouldBlock: true`); the caller then asks the user or denies.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| **barrel `yoloClassifier.ts`** (its export list is pinned by `src/__tests__/barrelSurface.test.ts`) | | |
| `classifyYoloAction` | `(messages: Message[], action: TranscriptEntry, tools: Tools, context: ToolPermissionContext, signal: AbortSignal) => Promise<YoloClassifierResult>` | `permissions/permissions.ts`, `tools/AgentTool/agentToolUtils.ts` |
| `formatActionForClassifier` | `(toolName: string, toolInput: unknown) => TranscriptEntry` | `permissions/permissions.ts` |
| `buildTranscriptForClassifier` | `(messages: Message[], tools: Tools, maxChars?: number) => string` (default 200,000) | `tools/AgentTool/agentToolUtils.ts` |
| `buildYoloSystemPrompt` | `(context: ToolPermissionContext) => Promise<string>` | `platform/headless/handlers/autoMode.ts` |
| `buildDefaultExternalSystemPrompt` | `() => string` | `platform/headless/handlers/autoMode.ts`, `commands/auto-mode-setup/analyzeRules.ts` |
| `getDefaultExternalAutoModeRules` | `() => AutoModeRules` | `platform/headless/handlers/autoMode.ts` |
| `isClassifierBundled` | `() => boolean` | `commands/auto-mode-setup/index.ts`, `platform/headless/handlers/autoMode.ts` |
| `getAutoModeClassifierErrorDumpPath` | `() => string` | barrel surface test |
| `YOLO_CLASSIFIER_TOOL_NAME` | `'classify_result'` | `classifierDecision.ts`, `permissions/classifierProbe.ts` |
| `YOLO_CLASSIFIER_TOOL_SCHEMA` | `BetaToolUnion` | `permissions/classifierProbe.ts` |
| `__setClassifierPromptsForTests` | `(override: { basePrompt: string; externalTemplate: string } \| null) => void` | tests only |
| `AutoModeRules` (type) | `{ allow: string[]; soft_deny: string[]; environment: string[] }` | `commands/auto-mode-setup/*`, `headless/handlers/autoMode.ts` |
| `TranscriptEntry` (type) | `{ role: 'user' \| 'assistant'; content: Array<{ type: 'text'; text: string; agent?: string } \| { type: 'tool_use'; name: string; input: unknown }> }` | `agentToolUtils.ts`, barrel surface test |
| **`classifierDecision.ts`** | | |
| `isAutoModeAllowlistedTool` | `(toolName: string) => boolean` | `permissions.ts` |
| `isAutoModeAllowlistedReadOnlyToolUse` | `(toolName: string, isReadOnly: () => boolean) => boolean` | `permissions.ts` |
| **`classifierShared.ts`** | | |
| `extractToolUseBlock` | `(content: BetaContentBlock[], toolName: string) => ToolUseBlock \| null` | `classifierProbe.ts`, `auto-mode-setup/analyzeRules.ts` |
| `parseClassifierResponse` | `<T extends z.ZodType>(block: ToolUseBlock, schema: T) => z.infer<T> \| null` | inside the unit |
| **`bashClassifier.ts`** | | |
| `classifyBashCommand` | `(command: string, cwd: string, descriptions: string[], behavior: ClassifierBehavior, signal: AbortSignal, isNonInteractiveSession: boolean) => Promise<ClassifierResult>` (the last argument is ignored) | `tools/BashTool/bashPermissions/{decide,speculative}.ts` |
| `generateGenericDescription` | `(command: string, draft: string \| undefined, signal: AbortSignal) => Promise<string \| null>` | `ui/BashPermissionRequest/BashPermissionRequest.tsx` |
| `getBashPromptAllowDescriptions`, `getBashPromptDenyDescriptions`, `getBashPromptAskDescriptions` | `(context: ToolPermissionContext) => string[]` | `BashPermissionRequest.tsx`, `bashPermissions/{decide,speculative}.ts` |
| `extractPromptDescription` | `(ruleContent: string \| undefined) => string \| null` | inside the unit |
| `createPromptRuleContent` | `(description: string) => string` | `BashPermissionRequest.tsx`, `ExitPlanModePermissionRequest.tsx` |
| `PROMPT_PREFIX` | `'prompt:'` | `ExitPlanModePermissionRequest.tsx` |
| `isClassifierPermissionsEnabled` | `() => boolean` | `useCanUseTool.tsx`, Bash and ExitPlanMode dialogs, `bashPermissions/*` |
| `__setBashClassifierEnabledForTests` | `(v: boolean \| undefined) => void` | tests only |
| `ClassifierResult` (type) | `{ matches: boolean; matchedDescription?: string; confidence: 'high' \| 'medium' \| 'low'; reason: string }` | `useCanUseTool.tsx`, `speculative.ts`, `shared/types/permissions.ts` |
| `ClassifierBehavior` (type) | `'deny' \| 'ask' \| 'allow'` | `speculative.ts`, `shared/types/permissions.ts` |
| **`autoModeRules.ts`** | | |
| `sanitizeRuleEntries` | `(entries: readonly string[]) => SanitizedRules` | `platform/settings/settings.ts`, `analyzeRules.ts` |
| `filterBroadAllowEntries` | `(entries: readonly string[]) => SanitizedRules` | `analyzeRules.ts` |
| `expandDefaults` | `(user: readonly string[], defaults: readonly string[]) => string[]` | `headless/handlers/autoMode.ts` |
| `hasDefaultsSentinel` | `(entries: readonly string[]) => boolean` | `analyzeRules.ts`, `headless/handlers/autoMode.ts` |
| `describeDropReason` | `(reason: RuleDropReason) => string` | `settings.ts`, `analyzeRules.ts` |
| `parseBulletBlock`, `renderRuleSection` | `(block: string) => string[]`; `(entries: readonly string[], defaultsBlock: string) => string` | inside the unit |
| `DEFAULTS_SENTINEL`, `MAX_ENTRIES_PER_SECTION`, `MAX_ENTRY_CHARS` | `'$defaults'`, `200`, `10_000` | `ReviewRules.tsx`, `analyzeRules.ts` |
| `AutoModeSectionName`, `RuleDropReason`, `DroppedRule`, `SanitizedRules` (types) | see "Rule vetting" | `settings.ts` |
| **`classifierApprovals.ts`** | | |
| `setClassifierApproval`, `getClassifierApproval` | `(toolUseID, matchedRule) => void`; `(toolUseID) => string \| undefined` | `PermissionContext.ts`, `interactiveHandler.ts`, `useCanUseTool.tsx`; `UserToolSuccessMessage.tsx` |
| `setYoloClassifierApproval`, `getYoloClassifierApproval` | `(toolUseID, reason) => void`; `(toolUseID) => string \| undefined` | same |
| `setClassifierChecking`, `clearClassifierChecking`, `isClassifierChecking` | `(toolUseID: string) => void / boolean` | `permissions.ts`, `interactiveHandler.ts`, `useCanUseTool.tsx` |
| `subscribeClassifierChecking` | `(listener: () => void) => () => void` | the hook |
| `deleteClassifierApproval`, `clearClassifierApprovals` | `(toolUseID) => void`; `() => void` | `UserToolSuccessMessage.tsx`; `agent/compact/postCompactCleanup.ts` |
| **`classifierApprovalsHook.ts`** `useIsClassifierChecking` | `(toolUseID: string) => boolean` (React hook) | `agent/ui/messages/AssistantToolUseMessage.tsx`, two memory benches |
| **`autoModeDenials.ts`** `recordAutoModeDenial`, `getAutoModeDenials`, `AutoModeDenial` | `(d: AutoModeDenial) => void`; `() => readonly AutoModeDenial[]`; `{ toolName; display; reason; timestamp }` | `useCanUseTool.tsx`; `ui/rules/{PermissionRuleList,RecentDenialsTab}.tsx` |

The other exports of the unit's files (the XML parsers, the transcript
serializer, the timeout and thinking helpers, the dump writer, the plan-mode
rule lists) are imported only inside the unit or by its own old tests
(`yoloClassifier/xmlResponse.test.ts`, `yoloClassifier.planMode.test.ts`). The
rewrite may reshape them, and must then update those tests.

`YoloClassifierResult` lives in `src/shared/types/permissions.ts`; the unit fills
it as below.

## Observable behaviour

### Build flags

`TRANSCRIPT_CLASSIFIER` and `BASH_CLASSIFIER` are on in the build and off under
`bun test`. With `TRANSCRIPT_CLASSIFIER` off: the prompt templates are empty (so
`isClassifierBundled()` is false), auto-mode approvals and denials are not
recorded, and the settings' `autoMode` rules are not read. With
`BASH_CLASSIFIER` off, Bash rule approvals are not recorded and
`isClassifierPermissionsEnabled()` is false unless a test switches it on. With
both off, the checking marker is not recorded either.

### 1. The auto-mode verdict (`classifyYoloAction`)

**Decided without a model call**
1. **No templates bundled** (`isClassifierBundled()` false): allow, `{ shouldBlock: false, reason: <says the prompts are not bundled>, model }`. The first time in a process (and again after each `__setClassifierPromptsForTests` call) a warning is written to stderr: it starts `claudin: `, says the auto-mode classifier prompts are not bundled, that non-allowlisted tools fall back to auto-allow, and that safetyCheck (sensitive paths) and `permissions.deny` rules still apply.
2. **Nothing to judge**: when the action renders to an empty string (see §2: a tool whose projection is `''`, a tool missing from `tools`, an assistant action with only text), allow with `{ shouldBlock: false, reason: 'Tool declares no classifier-relevant input', model }`.

**Which route.** The model is the main-loop model (`getMainLoopModel()`).
Models that always think (`modelRequiresAdaptiveThinking`, i.e. Fable 5, Sonnet 5,
Opus 5) take the two-stage XML route; all others take the tool_use route. Every
request goes out through `sideQuery` with `temperature: 0`, `thinking: false`
and `maxRetries` = `getDefaultMaxRetries()`. Always-thinking models get 2,048
extra `max_tokens` on every request.

**What the model receives (both routes)**
- **System**: one text block, the assembled prompt (§3), with `cache_control` from `getCacheControl({ querySource: 'auto_mode' })`.
- **CLAUDE.md**: when the bootstrap cache holds CLAUDE.md content (`getCachedClaudeMdContent()` not null), a first user message with one cached text block. It tells the model that this is the user's CLAUDE.md configuration, instructions the user gave the agent, to be treated as part of the user's intent. The content is wrapped exactly as `<user_claude_md>\n<content>\n</user_claude_md>`. Without it there is no such message.
- **The transcript and the action**: one user message whose blocks are the transcript lines (§2), one block per line, oldest first, then the action line as the last block, the only one with `cache_control`. The transcript gets 200,000 characters minus the action's length.

**tool_use route**
- `max_tokens` 4,096 (plus headroom), `tools: [YOLO_CLASSIFIER_TOOL_SCHEMA]`, `tool_choice: { type: 'tool', name: 'classify_result' }`.
- The verdict is the first `classify_result` tool call. Its input must have `thinking` (string), `shouldBlock` (boolean) and `reason` (string); the result copies them.
- No such call → block, reason says no tool use block was returned. Input failing that shape (a missing field, a wrong type) → block, reason says the response was invalid. Neither sets `unavailable`.

**XML route**
- **The prompt.** The system prompt has its line `Use the classify_result tool to report your classification.` replaced by output-format instructions. They state that a block is answered `<block>yes</block><reason>one short sentence</reason>`, an allow is answered `<block>no</block>` with no `<reason>`, and the answer must begin with `<block>`, with no preamble. If the line is missing, the prompt goes out unchanged.
- **The user message.** It is wrapped: a first block `<transcript>\n`, the transcript and action blocks, a block `</transcript>\n`, then a stage suffix block.
- **Stage 1.**
  - The request: `max_tokens` 64 (plus headroom) and `stop_sequences: ['</block>']`. Its suffix tells the model to err on the side of blocking and to answer `<block>` immediately.
  - Reading the answer: the text blocks are concatenated, and API thinking blocks are ignored. Anything inside `<thinking>…</thinking>` is dropped, and so is an unclosed `<thinking>` to the end of the text. The verdict is then the first `<block>yes` or `<block>no`, in any letter case, followed by a word boundary; the closing tag is optional.
  - `<block>no` → allow: `{ shouldBlock: false, reason: <says the fast classifier allowed it>, stage: 'fast', usage, durationMs, stage1RequestId, promptLengths, model }`.
  - Anything else (a block, no tag, `<block>noted`, an empty answer, an allow inside reasoning) → stage 2.
- **Stage 2.**
  - The request: same system and the same blocks except the suffix, `max_tokens` 4,096 (plus headroom), no stop sequence. Its suffix tells the model to review the classification process and follow it carefully, to deny what should be blocked, that only explicit (not suggestive or implicit) user confirmation overrides a block, and to use `<thinking>` before `<block>`.
  - Reading the answer: the verdict is read as in stage 1. `reason` is the first `<reason>…</reason>` outside the reasoning, trimmed, or `'No reason provided'`. `thinking` is the first `<thinking>…</thinking>`, trimmed.
  - The retry: when there is no verdict and the answer stopped on `max_tokens` or is blank, stage 2 runs once more with `max_tokens` 8,192 (plus headroom). Otherwise there is no retry.
  - No verdict after that → block, not `unavailable`. The reason says stage 2 was unparseable and carries a detail `stop_reason=<reason or unknown>, <n> output tokens, <empty response | no <block> tag>` for the last attempt.
  - The result carries `stage: 'thinking'`, `stage1Usage`, `stage2Usage` (summed over attempts), `usage` (both stages summed), `stage1DurationMs`, `stage2DurationMs`, `stage1RequestId`, `stage2RequestId` (last attempt), `durationMs`, `promptLengths`, `model`.

**Telemetry fields.**
- `usage` maps `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` to `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }`. The cache fields default to 0.
- The request ids come from the response's `_request_id`.
- `promptLengths`:
  - `systemPrompt` is the length of the assembled prompt, before the XML swap;
  - `toolCalls` is the action line plus the assistant lines;
  - `userPrompts` is the user and agent-message lines.
- After every model call, `getLastClassifierRequests()` (bootstrap state) holds the requests sent for this decision: `[request]` for tool_use and the fast allow, and `[stage 1, last stage 2]` otherwise.

**Failures (fail safe)**

| What happened | Result |
|---|---|
| The request failed before any answer (any route, or XML stage 1) | `shouldBlock: true, unavailable: true`, `deterministic` and `transcriptTooLong` as below; reason says the classifier is unavailable, or that the error was deterministic, or that the transcript exceeded the context window |
| The error message contains `prompt is too long` (any case) | `transcriptTooLong: true`, `deterministic: false` |
| An SDK `APIError` with status 400–499 other than 408, 409 and 429 | `deterministic: true` |
| Anything else (network, 408/409/429, 5xx) | both false |
| XML stage 2 failed after a stage 1 answer | `shouldBlock: true, unavailable: false, deterministic: false`, `transcriptTooLong` as above, `stage: 'thinking'`, `usage` = the stage 1 usage, reason says it blocks on the stage 1 assessment |
| The signal was aborted (before or during) | `{ shouldBlock: true, unavailable: true, reason: 'Classifier request aborted', model }` |
| The transcript cannot be read at all (a message whose content is not a list) | the promise rejects; no request is sent |

On every failure but an abort, the unit writes the session's error dump (below)
and sets `errorDumpPath` to it, or leaves it undefined when writing failed.

**The time budget.** One decision, retries included, is bounded by
`CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS`:
- The default is 60,000 ms. An empty, non-numeric or negative value keeps the default. The value is parsed as a decimal integer, and `0` removes the bound.
- When the budget runs out, the in-flight request's signal is aborted, and the verdict is `{ shouldBlock: true, reason: 'Classifier timed out after <round(ms/1000)>s', model, unavailable: true, timedOut: true, durationMs: <budget> }`. An answer arriving later is ignored.
- The caller's own abort is passed through and still yields the abort verdict.

**The error dump.**
- The path is `<getClaudeTempDir()>auto-mode-classifier-errors/<sessionId>.txt`, where `getClaudeTempDir()` is `<CLAUDIN_TMPDIR or /tmp, realpath>/claude-<uid>/`. It is overwritten on each failure.
- The format is pinned byte for byte by `src/permissions/__fixtures__/rewrite/classifierErrorDump.txt`, with `<timestamp>` standing for an ISO-8601 time. The sections are ERROR, CONTEXT COMPARISON (timestamp, model, main-loop tokens, classifier characters, the estimate at chars/4 rounded, transcript entries, messages, delta), ACTION BEING CLASSIFIED, SYSTEM PROMPT (as sent, so XML-swapped on that route) and USER PROMPT (the transcript text followed by the action).

### 2. The transcript (`buildTranscriptForClassifier`, and the request above)

One line per block, each ending in `\n`:

| Source | Line |
|---|---|
| user text (string content or each `text` block; images, tool results and other blocks skipped) | `User: <text>` |
| user text whose `origin` is agent-authored (`agent`, `subagent`, `peer`, `peer-notice`) | `Agent message (not from the user) from <JSON name>: <JSON text>`; the JSON keeps it on one line |
| `queued_command` attachment: a string prompt, or its text blocks joined by `\n` | as user text (agent-labelled by the same rule); no text → nothing |
| assistant `tool_use` | `<name as called> <projection>` |
| assistant text, `system`, `progress` and other messages | nothing |

`task-notification`, `channel` and `human` origins read as `User:`.

**The projection** is the tool's `toAutoClassifierInput(input)`. The tool is
looked up by name or alias in `tools`, and its input is `{}` when the call has
none.
- A string is used as is.
- Any other value is written as JSON.
- `undefined` → the raw input as JSON. A throw → the raw input as JSON.
- `''` → no line. A tool not in `tools` → no line.

**Truncation.** A user text, agent text or string projection longer than 32,000
characters keeps its first 32,000 and gets `… [truncated <n> chars]` appended.
Agent text is cut before it is JSON-quoted. A JSON projection is never cut.

**The budget** (`maxChars`, default 200,000).
- Messages are taken newest first while the total stays within the budget. A message that does not fit stops the walk, and older ones are dropped.
- If the newest message alone does not fit, its blocks are taken from the last one backwards, each that still fits; one that does not is skipped.
- The output is in conversation order. `formatActionForClassifier(name, input)` is `{ role: 'assistant', content: [{ type: 'tool_use', name, input }] }`.

### 3. The system prompt

The build bundles two text templates (`yolo-classifier-prompts/*.txt`, data
outside the unit): a base prompt holding `<permissions_template>`, and a
permissions template holding three sections, each wrapped in
`<user_allow_rules_to_replace>`, `<user_deny_rules_to_replace>` and
`<user_environment_to_replace>`. Each wrapper holds that section's shipped
defaults as `- ` bullets, one per line.

- `buildDefaultExternalSystemPrompt()` inserts the permissions template at the placeholder and drops the three wrappers, keeping their bodies. Both insertions are literal: a `$&` or `$1` in a template stays as it is.
- `getDefaultExternalAutoModeRules()` returns each wrapper's lines that start with `- ` (after trimming), without the marker. A missing section is `[]`.
- `buildYoloSystemPrompt(context)` does the same, then:
  - **Each section** is resolved against the user's settings rules (`getAutoModeConfig()`: `allow`, `soft_deny`, `environment`; read only with the flag on, from the trusted sources). No entries keeps the wrapper body untouched. Otherwise the entries replace the defaults, `$defaults` splices them in at its position, and the section is rendered `\n- a\n- b\n`; an empty result renders as nothing.
  - **Plan mode** (`context.mode === 'plan'`): after resolving, two bullets are appended to the allow section and one to the deny section, each starting `- Plan mode is active: `. The environment section gets none.
    - The deny bullet says to block anything that changes the project or the machine: writing, moving or deleting a file inside the working directory (a redirect into it counts), editing configuration, installing or removing software, or changing git state (commit, checkout, stash, reset, branch, rebase, push).
    - The first allow bullet allows commands that only read, including pipelines over files with globs, `sort`, `uniq`, `awk`, `cut`, `wc`, `diff`, `jq`.
    - The second allow bullet allows creating or editing files under the OS temp directory or the session scratchpad, and running `bun`, `node`, `python3` or `deno` on a script there or under the repository's `scripts/` directory when the script only reads the tree.
  - `Bash(prompt: …)` permission rules are **never** added to this prompt, in any build.
- `isClassifierBundled()` is true exactly when the base template is non-empty.
- `__setClassifierPromptsForTests(override)` replaces both templates; `null` goes back to what the build bundled. Either one re-arms the not-bundled warning.

### 4. Rule vetting (`autoModeRules.ts`)

- **`sanitizeRuleEntries`.** It keeps the entries in order, trimmed, and reports each one it drops as `{ entry, reason }`, in order. The first failing check, in this order, decides the reason:

  | Check | Reason |
  |---|---|
  | not a string, or blank | `empty` (the entry is reported as `String(entry)`) |
  | longer than 10,000 characters | `too-long` |
  | a C0 or C1 control character, `\t`, `\n` and `\r` included | `control-characters` |
  | a format character (`\p{Cf}`: bidi and zero-width), U+2028/2029, U+FE00–FE0F or U+E0100–E01EF | `invisible-characters` |
  | `<settings_` or `</settings_`, in any case | `settings-token` |
  | the section already holds 200 entries | `over-entry-cap` |
- **`filterBroadAllowEntries`** drops, with reason `too-broad`, any entry that, once trimmed, is one of these:
  - a tool rule whose content is `*`, `:*` or blank (e.g. `Bash(*)`, `Edit()`);
  - a `Bash(…)` or `PowerShell(…)` rule (any case) that starts with `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `curl`, `wget`, `eval`, `python`, `python3`, `node`, `perl`, `ruby`, `env`, `xargs`, `sudo`, `doas`, `pwsh` or `powershell` and contains a `*`;
  - prose that starts with an optional `allow`, then `any`, `all` or `every`, then `command(s)`, `bash/shell command(s)`, `tool call(s)`, `tool use(s)`, `action(s)` or `operation(s)`.
- **`expandDefaults`.** No user entries gives the defaults. Without a `$defaults` entry, the user entries replace the defaults. A `$defaults` entry (trimmed) is replaced by the defaults, only the first one expands, and the others are dropped. `hasDefaultsSentinel` checks the same trimmed match.
- **`describeDropReason`** gives the words for each reason. They name, in turn: an empty entry; control characters; invisible or bidirectional characters; a settings delimiter token; `longer than 10000 characters`; `beyond the 200-entry limit`; too broad for auto mode to honor safely.

### 5. The skip list (`classifierDecision.ts`)

`isAutoModeAllowlistedTool` is true for exactly `Read`, `Grep`, `Glob`,
`ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `TodoWrite`,
`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop`, `TaskOutput`,
`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `TeamCreate`, `TeamDelete`,
`SendMessage`, `ListAgents`, `Sleep` and `classify_result`. The match is
case-sensitive. `isAutoModeAllowlistedReadOnlyToolUse` is true only for `Git`
when `isReadOnly()` returns true; a throw counts as false, and for any other
tool the predicate is not called.

### 6. The Bash prompt-rule classifier (`bashClassifier.ts`)

- **Rules.**
  - `extractPromptDescription` takes a rule whose content, after leading spaces, starts with `prompt:` (any case), and returns the trimmed rest, or `null` when that is empty or the content is not prompt-shaped.
  - `createPromptRuleContent(d)` is `prompt: <d trimmed>`.
  - `getBash…Descriptions(context)` gather, from every source of the allow, deny or ask bucket, the descriptions of `Bash(prompt: …)` rules. They are parsed with the project's rule parser, kept in source order, and deduplicated; other tools and other rule shapes are ignored.
- **`classifyBashCommand`**
  - It is switched off (`isClassifierPermissionsEnabled()` false) → `{ matches: false, confidence: 'high', reason: 'classifier disabled' }`. With no descriptions → `{ matches: false, confidence: 'high', reason: 'no descriptions to match against' }`. Neither case calls the model.
  - Otherwise there is one call on the main-loop model: `max_tokens: 512`, `temperature: 0`, `thinking: false`, a forced `classify_match` tool, and `maxRetries` as above.
    - The tool takes `matchedIndex` (an integer or null, zero-based), `confidence` (`high` | `medium` | `low`) and `reason` (a string), all required.
    - The system text depends on the behaviour. It always says to match against the descriptions only, and that `high` is reserved for unambiguous matches. For `allow` it is deciding whether to auto-approve: the command as written must fall clearly under what the description authorizes, and extra flags, pipes into other commands or network calls the description did not mention mean no match. For `deny` it is deciding whether the command falls under a deny rule: an unambiguous match only, and not a command that merely shares a prefix. For `ask` it is deciding whether the user must be asked: the command falls within the area the description scopes.
    - The user text is exactly these lines: `<cwd>{cwd}</cwd>`, a blank line, `<descriptions>`, one `[i] {description}` per description, `</descriptions>`, a blank line, `<command>`, the command, `</command>`, a blank line, and a line telling the model to report through the `classify_match` tool.
  - The answer:
    - a valid index → `{ matches: true, matchedDescription, confidence, reason }`;
    - null, negative or past the end → `{ matches: false, confidence, reason }` from the model;
    - no `classify_match` call → `{ matches: false, confidence: 'low', reason: 'classifier returned no tool_use block' }`;
    - an invalid shape (a fractional index, an unknown confidence) → `… 'classifier returned malformed response'`;
    - an error → `{ matches: false, confidence: 'low', reason: 'classifier error: <message>' }`. An aborted signal rethrows instead.
- **`generateGenericDescription`**
  - Switched off, it returns the draft, or `null` for an empty or absent draft.
  - Otherwise it makes one call: `max_tokens: 256` and a forced `propose_description` tool (`description`: a non-empty string, required).
    - The system text asks for a single imperative sentence naming the class of action (its verbs and category, not the exact arguments). It must refine the user's draft without narrowing it, and return the draft unchanged when the command is too narrow to generalize.
    - The user text is `<command>`, the command, `</command>`, a blank line, `<user_draft>{draft or empty}</user_draft>`, a blank line, and a line telling the model to propose through the `propose_description` tool.
  - It returns the trimmed proposal. A blank proposal, a missing call, an invalid shape or an error falls back to the draft (or `null`); an abort rethrows.
- **`isClassifierPermissionsEnabled`** gives the test switch when one is set, and otherwise `BASH_CLASSIFIER`.

### 7. The stores

- **Approvals** are keyed by tool-use id. A Bash rule approval keeps the rule, and an auto-mode approval keeps the reason. Each getter answers only for its own kind, and setting one kind replaces the other. `deleteClassifierApproval` removes one, and `clearClassifierApprovals` removes all of them along with every checking marker.
- **The checking marker**: `setClassifierChecking` and `clearClassifierChecking` notify every subscriber on each call. `clearClassifierApprovals` notifies always, even with the flags off. `useIsClassifierChecking(id)` re-renders on each notification with the current state of `id`.
- **Denials**: `recordAutoModeDenial` puts the denial first and keeps the newest 20. Each record makes a new list, so a list already handed out never changes.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| Unknown tool in the action, or a projection of `''` | allow, without a model call (see Findings) |
| Malformed transcript message | the promise rejects |
| A projection that throws | the raw input is used; nothing is thrown |
| Templates not bundled | allow, plus one stderr warning per process |
| Budget under 500 ms | the reason reads `after 0s` |
| `CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS=2.9` | a 2 ms budget (integer parse) |
| The dump directory cannot be created | `errorDumpPath` undefined; the verdict is unchanged |
| Stage 1 answers `<block>no` and the stop sequence eats `</block>` | allow |

## Security requirements

Each of these is pinned by the suite and guarded by a probe.

- Every answer that is not a clean allow blocks:
  - no tool call, an invalid shape, or a call to another tool (tool_use);
  - no verdict tag, a verdict only inside reasoning (inline or an API thinking block), a word that only starts like `no`, or no verdict after the retry (XML);
  - any error, an abort, or the time budget running out.
- `unavailable`, `deterministic`, `transcriptTooLong` and `timedOut` are what the permission engine uses to choose between denying with retry guidance and asking the user. They must be set exactly as in §1.
- Assistant prose never reaches the classifier, only tool calls. Text another agent wrote is labelled and kept on one line, so it cannot pose as a `User:` line.
- Rule entries that could forge a bullet, hide text, or close a prompt section are dropped. Allow entries broad enough to approve everything are dropped by `filterBroadAllowEntries` (the `/auto-mode-setup` path).
- The skip list holds no shell, edit, write, network or agent tool. Git skips only for read-only calls, and a predicate that throws does not skip.
- The Bash classifier never matches on an error, an out-of-range index or a malformed answer.

## Tests that pin it

- `src/permissions/autoModeClassifier.characterization.test.ts` (96 tests): the verdict, both routes, failures, the budget, the dump, the Bash classifier. It fakes only `sideQuery`.
- `src/permissions/autoModeClassifier.rules.characterization.test.ts` (116): the transcript, the prompt assembly, rule vetting, the skip list, Bash rules, and the stores with the flags off.
- `src/permissions/autoModeClassifier.shipped.characterization.test.tsx` (2 under the plain runner; its first test re-runs the file with both flags on, which runs 13 more): the bundled templates, the settings rules, the Bash rules kept out, the real XML swap, approvals, the hook (mounted through `fakeTerminal`), denials, and the Bash classifier switched on by the build.
- Helpers: `src/permissions/__testutils__/autoModeClassifierScene.ts`; the dump fixture is `src/permissions/__fixtures__/rewrite/classifierErrorDump.txt`.
- Probes: `scripts/migrations/probes/rewrite-permissions-autoModeClassifier.json`, 40 probes over all 13 files. Every one turns the suite red.
- Kept, this project's own: `bashClassifier.test.ts` (its inherited cases were removed), `bashClassifier.adversarial.test.ts`, `autoModeRules.test.ts`, `classifierDecision.test.ts`, `yoloClassifier/xmlResponse.test.ts` and `yoloClassifier.{deterministicError,fableXmlRouting,fallback,planMode,stallBudget,live}.test.ts`. `yoloClassifier.test.ts` was deleted; its four cases are in the rules suite.

**Text outside the unit that pins prompt wording.** The rewrite must regenerate these if the wording changes:
- `src/permissions/yoloClassifier.planMode.test.ts`: the phrases `Plan mode is active` and `- Plan mode is active: allow commands that only read`, and the exported plan-rule lists.
- `src/permissions/bashClassifier.adversarial.test.ts`: the tool names `classify_match` and `propose_description`, and `deny rule` in the deny instructions.
- `src/permissions/yolo-classifier-prompts/prompts.test.ts`: that the base template contains `Use the classify_result tool to report your classification.`, the line the XML swap looks for.
- `scripts/bench/ab/wire-proxy.test.ts`: a hand-built copy of the stage-1 suffix and the CLAUDE.md lead sentence. It does not load the unit, so it drifts silently.

## Out of scope

- **The request/response dump** behind `CLAUDE_CODE_DUMP_AUTO_MODE`. It does nothing today, and the rewrite drops it.
- **The Bash prompt rules in the auto-mode prompt.** The branch that would add them can never run, so the rewrite drops it. The observable behaviour, never adding them, stays.
- **The debug-mode context-comparison logs.** They are not contract.

## Findings

1. **An import cycle that reads the classifier tool name before it exists.**
   - The cycle: `yoloClassifier/classify.ts` → `agent/messages/messages.ts` → `messages/lookups.ts` → `agent/attachments/attachments.ts` → `attachments/injections.ts` → `permissions/permissions.ts`. With `TRANSCRIPT_CLASSIFIER` on, that file loads `classifierDecision.ts` with a top-level `require`, and `classifierDecision.ts` reads `YOLO_CLASSIFIER_TOOL_NAME` through the barrel, whose module is still mid-evaluation.
   - **In source mode** (`bun test --feature=TRANSCRIPT_CLASSIFIER`) it throws `Cannot access 'YOLO_CLASSIFIER_TOOL_NAME' before initialization` whenever the barrel or `classify.ts` loads before `permissions.ts`. Loading `permissions.ts` or `classifierDecision.ts` first is fine. So the `classifierProbe.test.ts` failure seen in the planning run was a test-order artifact.
   - **In the bundle** it does not happen today. Bun hoists the literal into a top-level `var` that is set when the chunk loads, before any lazy module init runs. A flags-on `Bun.build` of an entry that imports the barrel first loads cleanly, and the name is on the skip list. This was checked on a minimal bundle in a scratch dir, not on the full CLI bundle (`bun run build` is off-limits in the sandbox).
   - It stays fragile. If the name were ever computed, the bundle would read `undefined` silently.
   - **Decision: fix.** The tool name must live in a leaf the skip list can import without reaching the classifier. No caller depends on the cycle.
2. **Fail-open without templates** (§1.1). This is security-weighted, but it is the documented fallback for builds without the `.txt` templates, and it warns. **Decision: keep for parity.** The shipped build bundles them.
3. **An action that renders to nothing is allowed unjudged.** This covers a tool missing from `tools` and an assistant action with only text. The callers always pass a tool from the registry, so legitimate use never reaches this. **Decision: fix (pure hardening).** Only a tool that declares `''` should skip, and an unknown tool should be judged on its raw input.
4. **`channel` (MCP channel server) messages read as `User:` lines.** The agent-authored check that decides this belongs to `agent/messages/interAgentMessages.ts`. **Decision: keep for parity**, and raise it with that module's owner.
5. **JSON projections are never truncated.** A huge structured input can use up the whole budget, or overflow the context, in which case the classifier asks the user (`transcriptTooLong`). This fails safe. **Decision: keep for parity.**
6. **An oversized newest message keeps its older blocks that fit** and skips a newer one that does not. **Decision: keep for parity**; nothing depends on it either way.
7. **A transcript the classifier cannot read rejects** instead of returning a verdict. The tool call errors out rather than running, so this fails closed. **Decision: keep for parity.**
8. **XML route with a base prompt that lacks the tool-use line**: the model gets a tool instruction with no tool. `prompts.test.ts` guards the template. **Decision: keep for parity.**
9. **The kind checks in the approval getters cannot be observed** (the other kind's field is absent anyway). This is not a defect, and no probe can guard it.

## Target design

- **A leaf `autoModeClassifier/protocol.ts`.** It holds the tool name and the tool schema, the verdict shape, and the XML stage formats. The skip list and the probe import it, which ends the cycle in Finding 1.
- **`transcript.ts`.** A pure function from messages and tools to lines, with the budget as a separate step. The projection rules and the agent labelling are explicit, tested functions.
- **`prompt.ts`.**
  - The template source, injectable instead of a test override that mutates module state.
  - Section resolution, reusing `autoModeRules.ts`.
  - Plan-mode rules.
  - The CLAUDE.md message.
- **Two route strategies behind one interface** (`judge(request) => Verdict`), tool_use and two-stage XML, chosen by a model predicate. Each maps every model answer to a verdict in one place, and a block is the default.
- **A wrapper for the budget and the abort.** It owns the deadline and the error-to-verdict mapping (`unavailable`, `deterministic`, `transcriptTooLong`, `timedOut`), and the dump writer is injected.
- **`bashPromptRules.ts`** for the rule helpers and **`bashClassifier.ts`** for the two model calls. They share one small "forced tool call → validated input or null" helper, which is today's `classifierShared.ts`.
- **The stores stay tiny modules with signals.** The flag gates stay at their edges.
- **Types.** No `any`. `ClassifierUsage` and `YoloClassifierResult` stay in `shared/types/permissions.ts` until every consumer has been rewritten.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.** All 50 inherited bodies were written anew. The classifier protocol
  lives in a leaf, `yoloClassifier/protocol.ts`: the tool name, the XML
  suffixes and the tool-use instruction. The routing is split into `route`,
  `toolUseRoute`, `xmlRoute` and `failureVerdict`.
- **Fixes, each with a test.**
  - **Finding 1.** The skip list reads the tool name from the leaf, and the
    decision rewrite loads the classifier lazily, so the import cycle is
    broken from both sides. The probe written for this fix could no longer
    turn anything red, which is how that showed up, so it was dropped.
    `importOrder.test.ts` keeps pinning the load order.
  - **Finding 3.** An action on a tool missing from the tool list now goes to
    the model on its raw input instead of being allowed unasked. The
    characterization row that pinned the fail-open behaviour ("a tool missing
    from the tool list is allowed without a model call") was removed: it
    contradicted the spec's own fix decision.
- **Kept.** All "keep" findings.
- **Probes.**
  - `rewrite-permissions-autoModeClassifier.json` holds 115 probes.
  - Two older specs were re-pointed at the new code with the same mutations:
    `planModeClassifierPrompt.json` (3 probes) and `crossSessionMessaging.json`
    (the agent-authored label).
- **Residue, reviewed.** 114 lines of Claude Code and 0 of openclaude remain:
  - the signatures of the exported classifier functions;
  - the classifier result and usage types;
  - the dump-file layout that the error-dump fixture pins byte for byte.
