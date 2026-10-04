# Spec: `permissions/decisionExplanation`

## Purpose

Two panels the shell permission dialogs (Bash and PowerShell) can open under
the command they ask about.

- **The explanation (ctrl+e).** The user asks the model what the command
  does, why the agent wants it, and how risky it is. The answer is a short
  explanation, the agent's reasoning, a risk level (low, medium, high) and a
  one-line risk. `permissionExplainer.ts` builds and sends the question and
  checks the answer. `PermissionExplanation.tsx` holds the toggle and draws the
  panel.
- **The debug panel (ctrl+d, debug sessions only).** `PermissionDecisionDebugInfo`
  shows the raw decision: its behaviour, message and reason, the updates it
  suggests, and the allow rules that can never fire because a broader deny or
  ask rule hides them.

Neither panel decides anything. The explanation is advice the user reads
before answering; the debug panel only shows what the decision already was.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `RiskLevel` | `'LOW' \| 'MEDIUM' \| 'HIGH'` | `PermissionExplanation.tsx` |
| `PermissionExplanation` (type) | `{ riskLevel: RiskLevel; explanation: string; reasoning: string; risk: string }` | `PermissionExplanation.tsx` |
| `isPermissionExplainerEnabled` | `() => boolean` | `PermissionExplanation.tsx` |
| `generatePermissionExplanation` | `(params: { toolName: string; toolInput: unknown; toolDescription?: string; messages?: Message[]; signal: AbortSignal }) => Promise<PermissionExplanation \| null>` | `PermissionExplanation.tsx` |
| `usePermissionExplainerUI` | `(props: { toolName: string; toolInput: unknown; toolDescription?: string; messages?: Message[] }) => { visible: boolean; enabled: boolean; promise: Promise<PermissionExplanation \| null> \| null }` | `BashPermissionRequest.tsx`, `PowerShellPermissionRequest.tsx` |
| `PermissionExplainerContent` | `(props: { visible: boolean; promise: Promise<PermissionExplanation \| null> \| null }) => ReactNode` | the same two dialogs |
| `PermissionDecisionDebugInfo` | `(props: { permissionResult: PermissionDecision & { message?: string }; toolName?: string }) => ReactNode` | the same two dialogs, with `toolName` `"Bash"` or `"PowerShell"` |

The dialogs pass the tool's name, its input, the request's description and
the session's messages to the hook. They show the hint `ctrl+e to explain` /
`ctrl+e to hide` from `enabled` and `visible`, dim the command while
`visible`, and hide the request's description while `visible`.

## Observable behaviour

### 1. The switch

- `isPermissionExplainerEnabled()` is true unless the global config key
  `permissionExplainerEnabled` is exactly `false`. Unset and `true` both mean
  on.
- When it is off, `generatePermissionExplanation` resolves to `null` without
  calling the model, and the hook reports `enabled: false` and ignores ctrl+e.

### 2. The request to the model

One call through `sideQuery` with exactly these fields, and no others (no
token limit, temperature or source of its own):

- `model`: the session's main-loop model, the one the user selected. Not a
  small or fast model (Finding 1).
- `system`: a one-sentence instruction to analyse shell commands and say what
  they do, why the agent runs them, and their risks. It must mention shell
  commands, what they do, why, and risk.
- `messages`: a single user turn whose content is a plain string (below).
- `tools`: exactly one tool, named `explain_command`, described as explaining
  a shell command. Its input is an object of four string fields, all
  required:
  - `explanation`: what the command does, in 1-2 sentences;
  - `reasoning`: why *you* (the agent) run it, starting with "I";
  - `risk`: what could go wrong, under 15 words;
  - `riskLevel`: one of `LOW`, `MEDIUM`, `HIGH`, with the description naming
    LOW as safe dev workflows, MEDIUM as recoverable changes, HIGH as
    dangerous or irreversible.
- `tool_choice`: forced to that tool (`{ type: 'tool', name: 'explain_command' }`).
- `signal`: the caller's signal, passed through unchanged.

### 3. The user turn

Line by line, in this order:

1. `Tool: <toolName>`.
2. Only when a description is given: `Description: <toolDescription>`. With
   none, the turn has no `Description:` text at all.
3. A line `Input:` and, starting on the next line, the formatted input,
   followed by a newline.
   - A string is sent as is, newlines included.
   - Anything else is JSON with two-space indentation (`42` for a number, a
     multi-line object or array).
   - A value JSON cannot encode (a `bigint`, a cycle) is sent as its
     `String(...)` form (`9`, `[object Object]`).
4. Only when there is context: a blank line, `Recent conversation context:`,
   and the context on the following lines.
5. The turn ends with a blank line and `Explain this command in context.` as
   its last line.

**The context** comes from the assistant turns of `messages` only; user turns
never travel.
- At most the last three assistant turns, oldest first, separated by a blank
  line.
- A turn contributes the text of its text blocks joined by single spaces;
  tool calls and other blocks are skipped. A turn with no text contributes
  nothing.
- The budget is 1000 characters, spent newest turn first. A turn longer than
  what is left is cut to what is left and ends with `...` (three dots). A turn
  that fits exactly is kept whole. Once the budget is spent, older turns are
  left out entirely.
- No messages, only user turns, or no text at all: no context section.

### 4. The answer

- The first `tool_use` block of the reply is read. If its input has all four
  fields as strings and `riskLevel` is one of the three upper-case values, the
  result is exactly those four fields; any other fields are dropped. Text
  blocks around the tool call are ignored.
- Anything else resolves to `null` and records no error: a level outside the
  enum (`CRITICAL`, or lower-case `low`), a missing field, a non-string field,
  a reply with only text, an empty reply.
- A failed call resolves to `null` and is recorded in the error log
  (`logError`), unless the caller's signal was aborted by then, in which case
  it is not recorded.
- The function never rejects.

### 5. The toggle (`usePermissionExplainerUI`)

- Starts with `visible: false`, `promise: null`; nothing is sent.
- The `confirm:toggleExplanation` action (ctrl+e by default, `Confirmation`
  context) flips `visible`. The first time it opens, it starts one
  explanation request with the props it has, and `promise` holds it.
- Closing and opening again reuses that promise: the model is asked at most
  once per mounted dialog, even when the panel is closed before the answer
  lands.
- The request is never cancelled by the panel (Finding 2).

### 6. The panel (`PermissionExplainerContent`)

- Renders nothing unless `visible` is true and `promise` is set.
- While the promise is pending: one line, `Loading explanation…` (with a
  shimmer), below a blank line.
- With an explanation, after a blank line: the explanation; a blank line;
  the reasoning; a blank line; the risk line `<Label>: <risk>`. The labels are
  `Low risk`, `Med risk` and `High risk`, coloured in the theme's `success`,
  `warning` and `error` colours (label and colon only); the risk text is
  plain.
- With `null` (disabled, unusable or failed): `Explanation unavailable`,
  dimmed, below a blank line.

### 7. The debug panel (`PermissionDecisionDebugInfo`)

Rows of a label right-aligned in a ten-column gutter, then the value starting
at column 10:

- `Behavior`: `allow`, `ask` or `deny`.
- `Message`: the decision's message. Not shown for `allow`.
- `Reason`: `undefined` when the decision has none; otherwise one line by
  kind (bold parts marked **thus**):

  | Kind | Line |
  |---|---|
  | rule | **`<rule as written>`** `rule from <source, lower case>` (e.g. `user settings`, `project local settings`) |
  | mode | `<mode title> mode` (e.g. `Accept edits mode`, `Plan Mode mode`) |
  | sandbox override | `Requires permission to bypass sandbox` |
  | working dir, safety check, other, async agent | the reason text |
  | permission prompt tool | **`<tool name>`** `permission prompt tool` |
  | hook | **`<hook name>`** `hook: <reason>`, or **`<hook name>`** `hook` with no reason |
  | classifier | with `BASH_CLASSIFIER` or `TRANSCRIPT_CLASSIFIER` on (the shipped build): **`<classifier>`** `classifier: <reason>`; with both off, an empty value |

- **Compound commands** (`subcommandResults`): one block per subcommand, in
  the map's order, the first on the `Reason` row. Each block is a tick in the
  `success` colour for `allow` or a cross in the `error` colour otherwise, then
  the subcommand. Below it, indented behind `⎿`, the subcommand's reason
  (same table; a nested compound reason shows no line), and for an `ask` with
  rule suggestions, `Suggested rules: ` and the rules, each bold, comma
  separated.
- **Suggestions** (the decision's `suggestions`, absent on `deny`):
  - none or an empty list: `Suggestions None`;
  - updates of which none is listable: one row reading `None` (Finding 3);
  - otherwise a `Suggestions` row, then a `Rules` row with one bulleted rule
    per line (every rule of every `addRules` update), a `Directories` row with
    one bulleted directory per line (every `addDirectories` update), and a
    `Mode` row with the title of the last `setMode` update. Each row only
    when it has something, in that order.
- **Unreachable rules**: allow rules in the session's permission context that
  a tool-wide deny or ask rule for the same tool hides. Which are listed:
  - when the decision suggests rules: only those equal to a suggested rule
    (same tool and same content), whatever `toolName` is;
  - otherwise, with `toolName`: only that tool's;
  - otherwise: all.
  When any are listed: a blank line, `⚠ Unreachable Rules (<n>)` in the
  `warning` colour, then per rule, indented two columns, the rule in the
  `warning` colour, then two dimmed lines indented two more: the reason
  (`Blocked by "<tool>" deny rule (from <source>)` or `Shadowed by "<tool>" ask
  rule (from <source>)`) and `Fix: ` with the fix text. The wording of reason
  and fix belongs to `permissions/shellRules`.
- When the sandbox is on and auto-allows Bash, a personal tool-wide Bash ask
  rule does not count as hiding anything (the panel passes that state to the
  detection).

## Edge cases and errors

- Explainer off: `null`, no call; the hook never opens the panel.
- Unserialisable input: sent in its string form, no error.
- Model failure, network error: `null`, one error record; the panel says
  `Explanation unavailable`. An aborted call is not an error.
- A malformed answer: `null`, no error record.
- A panel closed before the answer: the request runs on; reopening shows its
  result without a second request.
- Debug panel with no reason: `Reason undefined`. Allow decisions: no
  `Message` row. Deny decisions: `Suggestions None`.

## Security requirements

- **Advice never decides.** Nothing the model answers may change the
  permission decision, the suggested rules, the options offered or the
  default focus. The risk level only colours a label. A command crafted to
  talk the model into `LOW` (prompt injection through the command, its
  description or the agent's own text) can only mislead the reader, which is
  why the panel stays opt-in per request (Finding 4).
- **No new recipient.** The request goes to the session's own main-loop model
  and provider. It carries the command, its description and at most about a
  thousand characters of the agent's recent text, all of which that provider
  already received. User turns are never included.
- **No spend without asking.** Nothing is sent until the user presses ctrl+e,
  at most one request per dialog, and none when the config switch is off.
- **The debug panel shows, never writes.** It only reads the app state and
  the decision; it adds and removes no rule.

## Tests that pin it

- **`src/permissions/permissionExplainer.characterization.test.ts`**: 38
  tests. The switch (3 settings), the request fields and the forced tool,
  the facts in each field description, the user turn's lines and the six
  input forms, the conversation context (turn count, order, block joining,
  three quiet cases, the budget and its cut), the answer (three levels, six
  unusable replies, failure, abort). Only `sideQuery` is replaced.
- **`src/permissions/ui/PermissionExplanation.characterization.test.tsx`**: 15
  tests. The hook through a small host on the fake terminal with real key
  bindings: closed at start, ctrl+e opens and asks once with the dialog's
  props, the answer's lines, close and reopen without a second request,
  closing before the answer, the config switch, the three labels and their
  colours, the two `Explanation unavailable` cases, and the panel alone in
  four visibility cases. Only `sideQuery` is replaced.
- **`src/permissions/ui/PermissionDecisionDebugInfo.characterization.test.tsx`**:
  37 tests. Gutter and rows, the three behaviours, twelve reason kinds with
  their bold parts, the classifier reason with the flags off, compound
  commands (layout, colours, no suggestion line), suggestions (seven cases and
  the value column), unreachable rules (layout, six filter cases, deny wording,
  none). Real rules in the app state; nothing is replaced.
- **`src/permissions/ui/PermissionDecisionDebugInfo.classifier.characterization.test.tsx`**:
  2 tests under the plain runner. Each runs the file again with one of
  `BASH_CLASSIFIER` and `TRANSCRIPT_CLASSIFIER` on, where 2 tests pin the
  classifier line, alone and inside a compound command.
- The Ink suites use `src/permissions/ui/__testutils__/promptFrameRig.tsx`
  (fresh config home and project per test, the app's providers, truecolor,
  colours compared against a reference `<Text>`).
- 92 tests. Three runs in a row passed. Coverage of the plain run:
  `permissionExplainer.ts` 100%, `PermissionDecisionDebugInfo.tsx` 90.0%,
  `PermissionExplanation.tsx` 93.3% (lines). What is left is compiler cache
  hits, and the classifier line, which the flagged children cover.
- **`scripts/migrations/probes/rewrite-permissions-decisionExplanation.json`**:
  40 probes: 17 on the explainer, 10 on the panel and toggle, 13 on the debug
  panel. Each turns the suites red.

**Text pinned outside the unit.** None byte for byte.
`scripts/bench/ab/wire-proxy.test.ts` builds its own request that forces a
tool named `explain_command`, to check that the A/B proxy files it under
`other`; it holds none of this unit's text and passes whatever the tool is
called. The prompt is pinned only by this unit's suites, by facts.

**Inherited tests to fold in:** none listed for this unit.

**Not pinned, and why:**
- The debug-log lines (latency, stop reason, the answer's first 500
  characters): diagnostics, not contract.
- The loading shimmer's frames.
- The sandbox auto-allow branch of the unreachable-rule filter: it needs
  bubblewrap on the host. The detection itself is pinned by
  `permissions/shellRules`.
- The singular `Suggestion` label and the `Directories` label overflowing the
  gutter (Finding 3): the old output is wrong.
- The config switch being read once per mount rather than live.

## Out of scope

- The dialogs that host the panels, the ctrl+d toggle and the debug-mode
  condition (`permissions/shellDialogs`).
- The key-binding resolver and the default binding of ctrl+e
  (`src/terminal/keybindings`).
- Unreachable-rule detection and its reason and fix wording
  (`permissions/shellRules`), and rule-to-string formatting
  (`permissions/ruleModel`).
- `sideQuery` itself (`src/agent`).

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **The explainer uses the main-loop model**, while its own comments and the config key's comment say Haiku. On an expensive main model each explanation costs a main-model call. | **Keep for parity** (pinned). With a third-party provider, the main model is the one the user is known to have; a small-model default is a product change. Fix the comments in the rewrite. |
| 2 | **The request is never cancelled.** The hook builds a signal nobody aborts, so closing the dialog leaves the call running and its tokens spent. | **Track.** Abort on unmount is pure hardening, but it needs the hook to own a controller; pinned only as "asked at most once". |
| 3 | **Debug-panel labels.** Updates of which none is listable read `Suggestion None` (singular, unpadded), and ` Directories ` is wider than the ten-column gutter, so its values sit two columns right of the others. | **Fix** (not pinned). Debug-only view; no caller, data or workflow depends on it. |
| 4 | **Prompt injection reaches the explanation.** The command, its description and the agent's text go verbatim into the turn, so a hostile command can steer the model to call itself `LOW` risk. | **Keep for parity**, as advice only: see Security requirements. The rewrite must keep the answer out of every decision. |
| 5 | **Model text is drawn as the model wrote it.** The unit strips nothing from the four answer fields before handing them to Ink; whether escape sequences in them reach the terminal depends on the renderer, and was not checked here. | **Track** with the other places that render model text. Not pinned. |
| 6 | **Outside the unit:** `resetGlobalConfigForTests` copies the defaults over the test config, and the defaults have no `permissionExplainerEnabled` entry, so a test that turns the switch off leaks it to the next test unless it clears the key itself. | Route to `src/platform/config`. The suites clear it by hand. |

## Target design

- **`permissionExplainer.ts` split in three pure parts and one call:** a
  prompt builder `(toolName, toolInput, description?, messages?) => string`
  with the context budget as a named constant; the tool definition and the
  answer schema derived from one source so the enum and required fields cannot
  drift; an answer parser `(reply) => PermissionExplanation | null`; and the
  call that wires them to `sideQuery`. Unit-test the builder and the parser
  without a model.
- **The hook** owns an `AbortController`, aborted on unmount (Finding 2), and
  keeps the "ask once per dialog" rule. Read the switch once per mount.
- **The panel** as hand-written Ink components with typed props, no compiler
  cache slots: a label table from risk level to text and theme colour.
- **The debug panel** as one `<Row label value>` component with a fixed
  gutter wide enough for every label (Finding 3), a table from reason kind to
  line builder with the classifier entry behind its build flags, and the
  unreachable-rule filter as a pure function `(rules, suggestions, toolName)`.
- **Tests.** The characterization suites unchanged, plus unit tests for the
  prompt builder, the answer parser and the unreachable-rule filter.

## Outcome

Rewritten per method on 2026-10-04.

**Code.**
- `permissionExplainer.ts` holds the switch and the model call.
- New `explainer/answer.ts` drives the tool definition and the answer parser from one field table, and new `explainer/prompt.ts` is a pure prompt builder.
- Both panels are hand-written. Small rows live in `ui/decisionDebug/`, with a pure unreachable-rule filter.
- The four characterization suites pass.

**Fixes, each with a test.**
- Finding 3, debug labels:
  - "Suggestions None" replaces "Suggestion None".
  - The directories label is `Dirs`, so it fits the 10-column gutter.
  - The two pinned rows that expected `Directories` now expect `Dirs`.
- Finding 1's comments now say the explanation comes from the main-loop model, including the comment on `permissionExplainerEnabled` in `platform/config/config/types.ts`.

**Kept.** Finding 4 keeps the explanation advisory. A new test fails if any production module other than the panel imports the explainer. Findings 2 and 5 are tracked.

**Probes.** 103 in `rewrite-permissions-decisionExplanation.json`.

**Residue, reviewed.** 17 lines of Claude Code remain: the `RiskLevel` and `PermissionExplanation` types and the explainer's signature.
