# Spec: `permissions/toolDialogs`

## Purpose

Four of the dialogs a permission request can be shown in. `PermissionRequest`
(see [promptFrame.md](promptFrame.md)) picks one by the tool the request
carries:

- **the tool-wide dialog** (`FallbackPermissionRequest`): every tool without a dialog of its own, MCP tools among them. `FilesystemPermissionRequest` also falls back to it when a read tool gives no path;
- **the skill dialog** (`SkillPermissionRequest`): `SkillTool`;
- **the fetch dialog** (`WebFetchPermissionRequest`): `WebFetchTool`;
- **the shell-delegate dialog** (`MonitorPermissionRequest`): `WaitForTool` always, and `MonitorTool` in a build with `MONITOR_TOOL` (the shipped build). Both tools check their command against the Bash rules.

Each shows what the tool is about to do, asks, and reports the answer
through the request's callbacks (`ToolUseConfirm.onAllow` / `onReject`) and
the caller's (`onDone`, `onReject`). The answers include an "allow, and
don't ask again", which carries the permission rule to save. That rule is the
security weight of the unit: an allow the user did not pick, or a rule wider
than the one the option names, is the failure this spec guards against.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `FallbackPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx` (default route, and `MonitorTool` in a build without `MONITOR_TOOL`), `FilesystemPermissionRequest.tsx` |
| `SkillPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx`, `PermissionRequest.test.ts` |
| `WebFetchPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx`, `PermissionRequest.test.ts` |
| `MonitorPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx` (for `WaitForTool` always, for `MonitorTool` behind `feature('MONITOR_TOOL')`) |

`PermissionRequestProps` and `ToolUseConfirm` are the promptFrame unit's
(see its spec). The dialogs read `toolUseConfirm.tool`, `.input`,
`.description`, `.permissionResult` and `.toolUseID`, and the props
`onDone`, `onReject`, `verbose` (fetch dialog only) and `workerBadge`.

Collaborators the dialogs use and the rewrite must keep using, rather than
restate: `PermissionDialog`, `PermissionPrompt`, `PermissionRuleExplanation`
and `usePermissionRequestLogging` (promptFrame); the `Select` list
(`src/terminal/custom-select/select.tsx`) for the fetch dialog;
`shouldShowAlwaysAllowOptions` (`src/permissions/permissionsLoader.ts`);
`getOriginalCwd` (`src/platform/bootstrap/state.ts`); `SkillTool.inputSchema`,
`WebFetchTool.inputSchema` and `WebFetchTool.renderToolUseMessage`; and the
tool's own `userFacingName` / `renderToolUseMessage`.

## Observable behaviour

Common to all four:
- Each draws inside `PermissionDialog`, with the worker badge, when given, after the title (` · @<name>`).
- The explanation of why the prompt asked (`PermissionRuleExplanation`, kind `tool`) sits right above the question.
- Each counts one permission prompt (`attribution.permissionPromptCount`) through `usePermissionRequestLogging`.
- `<cwd>` below is `getOriginalCwd()`, the directory the session started in, in bold.
- **"Allow always" is offered only when `shouldShowAlwaysAllowOptions()` is true.** Managed settings with `allowManagedPermissionRulesOnly` turn it off. The option is then left out, and every later option's digit moves up by one.
- Every saved rule is one `addRules` update: `{ type: 'addRules', rules: [<one rule value>], behavior: 'allow', destination: 'localSettings' }`. The destination is always `localSettings`.

### 1. The tool-wide dialog (`FallbackPermissionRequest`)

**Screen**, top to bottom:
- the title `Tool use`;
- `<name>(<call>)`, indented. `<name>` is `tool.userFacingName(input)` with a trailing ` (MCP)` removed. When it had that suffix, ` (MCP)` follows the closing parenthesis, dim. `<call>` is `tool.renderToolUseMessage(input, { theme, verbose: true })`, always verbose whatever the caller's `verbose`;
- the request's `description`, dim. It keeps its first three lines, and when there are more, the third is followed by `…`;
- the prompt: `Do you want to proceed?`, then the options `Yes` (takes an accept note), `Yes, and don't ask again for <name> commands in <cwd>` (`<name>` bold, without the MCP suffix), and `No` (takes a reject note). Then the hint line.

**Answers.** `INPUT` is `toolUseConfirm.input`, unchanged.

| Answer | Calls, in order |
|---|---|
| Yes (Enter, `1`) | `onAllow(INPUT, [], undefined)`, `onDone()` |
| Yes with a note | `onAllow(INPUT, [], '<note, trimmed>')`, `onDone()` |
| Allow always (`2`, Down+Enter) | `onAllow(INPUT, [addRules { toolName: tool.name }])`, `onDone()`. Exactly two arguments. The rule has no `ruleContent`: it allows the **whole tool**, and it names the tool's `name` (`mcp__server__tool`), never the shown name |
| No (`3`) | `onReject(undefined)`, caller's `onReject()`, `onDone()` |
| No with a note | `onReject('<note>')`, caller's `onReject()`, `onDone()` |
| Esc (even with a Yes note written) | `onReject()` with no argument, caller's `onReject()`, `onDone()`; one escape counted |
| `y`, `n`, a digit past the last option | nothing |

### 2. The skill dialog (`SkillPermissionRequest`)

`<skill>` is the `skill` field of the input as `SkillTool.inputSchema` reads
it, unchanged (a leading slash or space is kept).

**Screen**:
- the title `Use skill "<skill>"?`;
- a line that says the model may use the skill's instructions, code or files. Today: `Claude may use instructions, code, or files from this Skill.`;
- when the permission result is an `ask` whose `metadata.command` exists, that command's `description`, dim and indented. Nothing otherwise, not even for an allow carrying the same metadata;
- the prompt: `Do you want to proceed?`, then:
  - `Yes` (accept note);
  - `Yes, and don't ask again for <skill> in <cwd>` (`<skill>` bold);
  - only when `<skill>` has a space after its first character: `Yes, and don't ask again for <first>:* commands in <cwd>`, where `<first>` is the text before the first space, shown bold with the `:*`;
  - `No` (reject note);
  - the hint line.

**Answers**: as the tool-wide dialog for Yes, No, notes, Esc, `y`/`n`. The
allow-always options:

| Option | Rule value |
|---|---|
| exact | `{ toolName: 'Skill', ruleContent: '<skill>' }` |
| prefix | `{ toolName: 'Skill', ruleContent: '<first>:*' }` |

| `<skill>` | Options after Yes | Rules |
|---|---|---|
| `release` | exact, No | `release` |
| `review pr` | exact, prefix, No | `review pr`, `review:*` |
| `a b c` | exact, prefix, No | `a b c`, `a:*` |
| `/commit` | exact, No | `/commit` (the slash is kept; SkillTool strips it when matching) |
| `plugin:deploy` | exact, No | `plugin:deploy` |
| ` lead` (leading space) | exact, No | ` lead` |

With two allow-always options the digits are Yes `1`, exact `2`, prefix `3`, No `4`.

### 3. The fetch dialog (`WebFetchPermissionRequest`)

`<host>` is the WHATWG URL parser's `hostname` of `input.url`: lower case, no
port, no credentials, punycode for an internationalised name, and an IPv6
address in brackets.

**Screen**:
- the title `Fetch`;
- `WebFetchTool.renderToolUseMessage(input, { theme, verbose })` with the caller's `verbose`. Today that is the URL, or `url: "<url>", prompt: "<prompt>"` when verbose;
- the request's `description`, dim;
- the question, which asks whether to let the model fetch this content. Today: `Do you want to allow Claude to fetch this content?`;
- a plain list (not `PermissionPrompt`): `Yes`, `Yes, and don't ask again for <host>` (`<host>` bold), `No, and tell Claude what to do differently (esc)` (`(esc)` bold). No hint line, and no notes.

**Answers**:

| Answer | Calls, in order |
|---|---|
| Yes (Enter, `1`) | `onAllow(INPUT, [])`, `onDone()`. Exactly two arguments |
| Allow always (`2`) | `onAllow(INPUT, [addRules { toolName: tool.name, ruleContent: 'domain:<host>' }])`, `onDone()` |
| No (`3`), Esc | `onReject()` with no argument, caller's `onReject()`, `onDone()`. Esc is **not** counted as an escape |
| Tab, `y`, `n` | nothing (Tab opens no note) |

The rule holds the host alone. The scheme, port, path, query and credentials
are dropped, and a sub-domain is not widened to its parent:

| URL | Rule content |
|---|---|
| `https://Docs.Example.COM:8443/x` | `domain:docs.example.com` |
| `https://api.github.com/repos` | `domain:api.github.com` |
| `https://user:secret@files.example.org/a` | `domain:files.example.org` |
| `https://bücher.example/katalog` | `domain:xn--bcher-kva.example` |
| `http://127.0.0.1:3000/health` | `domain:127.0.0.1` |
| `http://[::1]:8080/` | `domain:[::1]` (label) |

### 4. The shell-delegate dialog (`MonitorPermissionRequest`)

`<label>` is `tool.userFacingName(input)`: `Wait` for WaitFor and `Monitor`
for Monitor.

**Screen**:
- the title `<label>`;
- `<label>(<input.command>)`, or `<label>()` when there is no command. The tool's other fields (`until`, `setup`) are not shown;
- `input.description`, dim, when it is non-empty. The request's `description` is not used;
- the prompt: `Do you want to proceed?`, `Yes` (accept note), `Yes, and don't ask again for <label> commands in <cwd>` (`<label>` bold), `No` (reject note), then the hint line.

**Answers**: as the tool-wide dialog for Yes, No, notes, Esc, `y`/`n`. Allow
always reports `onAllow(INPUT, <updates>)` then `onDone()`. The updates hold
a **Bash** rule (not a rule for the tool), whose content is the first two
whitespace-separated words of `input.command` with the edges trimmed, joined
by one space, followed by `:*`. When there are no words, nothing is saved.

| `input.command` | Updates |
|---|---|
| `make` | `Bash(make:*)` |
| `npm test` | `Bash(npm test:*)` |
| `tail -f build.log` | `Bash(tail -f:*)` |
| `rm -rf /tmp/scratch` | `Bash(rm -rf:*)` |
| `   npm    run   dev  ` | `Bash(npm run:*)` |
| `echo hi` + newline + `rm -rf /tmp/x` | `Bash(echo hi:*)` |
| `cd /srv && make deploy` | `Bash(cd /srv:*)` |
| empty, blank, or missing | `[]`: the answer allows once and saves nothing |

For WaitFor, only `command` makes the rule. `setup` is ignored
(`tmux capture-pane -p -t build` with a setup gives `Bash(tmux capture-pane:*)`).

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Managed policy keeps rules to itself | no allow-always option in any of the four; `2` is No | yes, all four |
| A digit past the last option, `y`, `n` | nothing | yes |
| Esc with a Yes note written (three prompt dialogs) | a plain deny, the note dropped | yes |
| Skill input that `SkillTool.inputSchema` rejects | the dialog opens with `<skill>` empty, and Yes allows that input once. An error is logged | Yes: yes. Allow-always: **no** (Finding 1) |
| A fetch input that `WebFetchTool.inputSchema` rejects but whose URL parses | the rule content is `input:` followed by the input's string form (`input:[object Object]`) | no (Finding 4) |
| A fetch URL that does not parse | the dialog throws while rendering | no (Finding 4) |
| A monitor command with no words | allow-always allows once, saves nothing | yes |
| A narrow terminal where an allow-always label wraps | the option's number loses its space (`2.Yes, …`) | no (Finding 6) |

## Security requirements

- **Only an explicit choice allows.** Esc, `y`, `n`, Tab and an out-of-range digit never report an allow. No and Esc always reach the request's `onReject`.
- **Allow once saves nothing.** Yes reports an empty update list in all four dialogs.
- **Each allow-always saves exactly the rule its label names, locally:**
  - tool-wide: the whole tool by its `name`;
  - skill: the exact skill, or `<first>:*`;
  - fetch: `domain:<host>`, the exact host;
  - shell delegate: `Bash(<two words>:*)`, or nothing.

  Never the user settings, and never a wider rule.
- **Allow-always is withheld when policy forbids it.**
- **No dialog may save a rule from input it could not read.** The old module breaks this for the skill dialog (Finding 1).

## Tests that pin it

- **`src/permissions/ui/FallbackPermissionRequest.characterization.test.tsx`**: 26 tests. The screen for MCP and non-MCP tools, the verbose render, description truncation (3 cases), styling, the badge, the rule explanation, managed policy, and 16 answers.
- **`src/permissions/ui/SkillPermissionRequest/SkillPermissionRequest.characterization.test.tsx`**: 30 tests. The screen, the description gate, option shapes for six skill names, styling, the badge and explanation, managed policy, 16 answers with their rules, and unreadable input (Yes only).
- **`src/permissions/ui/WebFetchPermissionRequest/WebFetchPermissionRequest.characterization.test.tsx`**: 25 tests. The screen, verbose, six host shapes in the label, styling, the badge and explanation, managed policy, and 14 answers including three rule shapes.
- **`src/permissions/ui/MonitorPermissionRequest/MonitorPermissionRequest.characterization.test.tsx`**: 30 tests under the plain runner, for the Wait route: the screen (four cases), styling, the badge, managed policy, 11 answers, 10 command shapes and their rule, `setup` left out, and the prompt count. One test runs the file again with `--feature=MONITOR_TOOL`, where the same 27 per-route cases also run for Monitor (56 tests).
- **The rig**: `src/permissions/ui/__testutils__/toolDialogRig.tsx`. It builds a request whose callbacks append to one ordered log, mounts `PermissionRequest` through the promptFrame rig (fake terminal, app state and key bindings, a fresh config home and managed-settings directory), and turns on managed rules-only policy on request.
- 111 tests in all (plus 56 in the flagged child). Three runs in a row passed. Coverage (lines, plain run): Fallback 90.9%, Skill 92.0%, WebFetch 91.0%, Monitor 100%. The uncovered lines are compiler cache hits.
- **`scripts/migrations/probes/rewrite-permissions-toolDialogs.json`**: 40 probes, 10 per file. Every allow path is mutated to fail open: Yes saving a rule, the allow-always rules widened or moved to `userSettings`, No and Esc turned into allows, and managed policy ignored. Each one turns the suites red.
- **Kept, this project's own:** `src/permissions/ui/PermissionRequest.test.ts` (it imports the skill and fetch dialogs, for name-keyed routing).

**Text pinned outside the unit.** None. The unit sends nothing to a model.
Notes travel in the callbacks.

**Inherited tests to fold in:** none listed for this unit.

**Not pinned, and why:**
- The skill dialog's allow-always for unreadable input (Finding 1) and the fetch dialog's `input:` rule and crash (Finding 4): the old behaviour is wrong.
- Misaligned option numbers at narrow widths (Finding 6): the old output is wrong. The layout is pinned at 120 columns, where every dialog renders aligned.
- MonitorTool's own route under the plain runner: it needs the build flag, so the child run pins it.

## Out of scope

- The frame, the prompt's keys and notes, the explanation and the counter (promptFrame).
- How saved rules are matched later (SkillTool's prefix matching, the WebFetch domain check, Bash prefix rules).
- The `Select` list widget.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Skill allow-always fails open on unreadable input.** When `SkillTool.inputSchema` rejects the input, `<skill>` is empty and the exact option writes `{ toolName: 'Skill', ruleContent: '' }`. An empty content is written as the bare `Skill` rule, which allows **every** skill. It is latent, since inputs are validated before the prompt. | **Fix** (hardening). On unreadable input, offer no allow-always option and save no rule. Not pinned. |
| 2 | **The shell-delegate rule is a Bash rule, wider than its label.** "Don't ask again for Wait/Monitor commands" saves `Bash(<two words>:*)`, which also lets the Bash tool run any command with that prefix without asking. A one-word command (`make`, `python`) grants the whole program, and `rm -rf x` grants `rm -rf:*`. The words are taken across line breaks and `&&`. | **Keep for parity** (pinned). Narrowing it would make users approve again. **Track:** the label should name the rule it saves. |
| 3 | **WaitFor's rule ignores `setup`**, while its permission check covers `setup && command`. The saved rule may not cover the next identical request. A blank command allows once and saves nothing, though the option says "don't ask again". | **Keep for parity** (pinned). **Track** with Finding 2. |
| 4 | **The fetch dialog trusts its input.** A URL that does not parse throws while rendering. An input the schema rejects saves `input:[object Object]`, a rule that matches nothing useful. Both are unreachable after validation. | **Fix.** Render the raw URL, and offer no allow-always option when the host cannot be read. Not pinned. |
| 5 | **The fetch dialog differs from the other three.** It is a plain list: no notes, no hint line, Esc is No and is not counted as an escape, and Yes passes no third argument. Its No label invites a note it cannot take. | **Keep for parity** (pinned). Aligning it with `PermissionPrompt` is a separate UX change. |
| 6 | **Option numbers lose their space when an allow-always label wraps** (`  2.Yes, and don't ask again…`). It happens in the tool-wide, skill and shell-delegate dialogs at widths where the rich label wraps: 40–60 and 90 columns for the tool-wide dialog, 40–50 and 85 for the skill dialog, 45–50 and 80 for Wait (a short cwd). This is promptFrame's Finding 8, which named only the skill dialog. | **Fix**, where the list lays out a rich label (`src/terminal/custom-select`), or by giving the label one `<Text>` per line. Not pinned. |
| 7 | **Mixed product names**: `Claude may use…`, `allow Claude to fetch…`, and the tool-wide dialog's notes default to `tell Claude…` (promptFrame Finding 4). | **Keep for parity** (pinned). Change it with the rest of the wording after the rewrite. |
| 8 | **The skill dialog builds its own rules from the raw input** and ignores the suggestions `SkillTool` puts in the permission result, which strip a leading slash. The two agree once matched, since matching strips the slash too. | **Keep for parity** (pinned: `/commit` → `/commit`). |
| 9 | **The skill dialog draws an empty indented box** (two blank lines) when there is no command description. | **Fix** (cosmetic). Not pinned beyond "no description line". |

## Target design

- **Hand-written components**, one per dialog, in this repo's Ink style, with no compiler cache slots, keeping the four export names and `PermissionRequestProps`.
- **The rule is data, computed by a pure function per dialog**: `(input) => PermissionRuleValue | null`. `null` means no allow-always option is offered (Findings 1 and 4). Unit-test each function on the tables above without Ink. The dialog only maps the chosen option to `onAllow(input, rule ? [addRules(rule)] : [])`.
- **One answer handler shared by the three `PermissionPrompt` dialogs**: Yes, allow-always, No and cancel are the same four calls with different rules. The fetch dialog keeps its plain list until Finding 5 is decided.
- **Labels render one `<Text>` per line** (Finding 6), and the shell-delegate label names the Bash rule it saves (Finding 2, once decided).
- **Tests**: the characterization suites, unchanged, plus unit tests for the rule functions and a narrow render asserting `N. ` stays whole.
