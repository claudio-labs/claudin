# Spec: `permissions/shellDialogs`

## Purpose

The dialogs that ask before a shell command runs. `PermissionRequest` (see
[promptFrame.md](promptFrame.md)) sends a `BashTool` request to
`BashPermissionRequest` and a `PowerShellTool` request to
`PowerShellPermissionRequest`. A Bash command that is an in-place `sed` edit
does not get the Bash dialog: `BashPermissionRequest` hands it to
`SedEditPermissionRequest`, which previews the edit as a diff of the real
file.

Each dialog shows the command, asks, and reports the answer through the
request's callbacks (`ToolUseConfirm.onAllow` / `onReject`) and the
caller's (`onDone`, `onReject`). The answers include an "allow, and don't
ask again", which carries the permission rule to save. **That rule is the
security weight of the unit.** The shell dialogs suggest it themselves, in an
editable field, from the command. A change in how the rule is guessed changes
what every later command may do without asking: the arity-table port showed
that `rm build:*` would become `rm:*` ([levers.md](../levers.md#replacements)).

Two helpers serve both shells: the option-list builders
(`bashToolUseOptions`, `powershellToolUseOptions`), with the label
(`generateShellSuggestionsLabel`) used when the rule cannot be a field, and
`useShellPermissionFeedback`, which holds the notes and the deny.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `BashPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx` (route for `BashTool`), `PermissionRequest.test.ts` |
| `PowerShellPermissionRequest` | component, props `PermissionRequestProps` | `PermissionRequest.tsx` (route for `PowerShellTool`), `PermissionRequest.test.ts` |
| `SedEditPermissionRequest` | component, props `PermissionRequestProps & { sedInfo: SedEditInfo }` | `BashPermissionRequest.tsx` |
| `bashToolUseOptions` | `(args) => OptionWithDescription<BashToolUseOption>[]` | `BashPermissionRequest.tsx` |
| `BashToolUseOption` | `'yes' \| 'yes-apply-suggestions' \| 'yes-prefix-edited' \| 'yes-classifier-reviewed' \| 'no'` | `bashToolUseOptions.tsx` |
| `powershellToolUseOptions` | `(args) => OptionWithDescription<PowerShellToolUseOption>[]` | `PowerShellPermissionRequest.tsx` |
| `PowerShellToolUseOption` | `'yes' \| 'yes-apply-suggestions' \| 'yes-prefix-edited' \| 'no'` | `powershellToolUseOptions.tsx` |
| `generateShellSuggestionsLabel` | `(suggestions: PermissionUpdate[], shellToolName: string, commandTransform?: (command: string) => string) => ReactNode \| null` | both option builders |
| `useShellPermissionFeedback` | `({ toolUseConfirm, onDone, onReject, explainerVisible }) => { yesInputMode, noInputMode, yesFeedbackModeEntered, noFeedbackModeEntered, acceptFeedback, rejectFeedback, setAcceptFeedback, setRejectFeedback, focusedOption, handleInputModeToggle, handleReject, handleFocus }` | both shell dialogs |

The builders' arguments: `suggestions?`, `onRejectFeedbackChange`,
`onAcceptFeedbackChange`, `yesInputMode?`, `noInputMode?`, `editablePrefix?`,
`onEditablePrefixChange?`. `bashToolUseOptions` also accepts `decisionReason`,
`onClassifierDescriptionChange`, `classifierDescription`,
`initialClassifierDescriptionEmpty` and `existingAllowDescriptions`, and
ignores all five (Finding 8).

The dialogs read `toolUseConfirm.tool`, `.input` (through the tool's
`inputSchema`, which rejects unknown keys), `.description`,
`.permissionResult` (`behavior`, `suggestions`, `decisionReason`),
`.onUserInteraction`, and in a `BASH_CLASSIFIER` build
`.classifierCheckInProgress`, `.classifierAutoApproved`,
`.classifierMatchedRule` and `.onDismissCheckmark`; and the props `onDone`,
`onReject`, `workerBadge` and `toolUseContext.options.debug`.

Collaborators the rewrite keeps using rather than restating:
`PermissionDialog`, `PermissionRuleExplanation`, `usePermissionRequestLogging`
(promptFrame); `PermissionDecisionDebugInfo`, `usePermissionExplainerUI` and
`PermissionExplainerContent` (decisionExplanation); `FilePermissionDialog` and
`FileEditToolDiff` (the sed dialog's frame and diff); the `Select` list;
`shouldShowAlwaysAllowOptions`; `getSimpleCommandPrefix` / `getFirstWordPrefix`
(`src/tools/BashTool/bashPermissions.ts`) and the two
`getCompoundCommandPrefixesStatic` (`src/platform/bash/prefix.ts`,
`src/platform/shell/powershell/staticPrefix.ts`), which compute the rule;
`parseSedEditCommand` / `applySedSubstitution`; `extractOutputRedirections`;
`permissionRuleExtractPrefix`; `SandboxManager` and `shouldUseSandbox`.

## Observable behaviour

Common to the two shell dialogs (Bash, PowerShell):
- The title is `Bash command` (or `Bash command (unsandboxed)`, below) / `PowerShell command`, with the worker badge, when given, after it (` · @<name>`).
- Under it, indented: the tool's own rendering of `{ command, description }` with `verbose: true`, which today is the command alone (the input's `description` is not shown); then the request's `description`, dim.
- The rule explanation (kind `command`) sits right above `Do you want to proceed?`.
- Then the options, and a hint line: `Esc to cancel`, then ` · Tab to amend` while the focused option is Yes or No with its note closed, then ` · ctrl+e to explain` while the explainer is enabled (`permissionExplainerEnabled` not `false` in the global config). With `--debug` (`options.debug`), `Ctrl+d to show debug info` sits at the right of the hint.
- **Ctrl+D** swaps the rule explanation, question, options and hint for the decision details (`PermissionDecisionDebugInfo`, tool name `Bash` / `PowerShell`), with `Ctrl-D to hide debug info` under them when `--debug` is on. Ctrl+D again brings the question back. While the details are shown there is no list, so Esc does nothing.
- **Options**, in order:
  1. `Yes`. Tab turns it into a note field (`Yes, <note>`, placeholder `and tell Claude what to do next`); Tab again closes it.
  2. The allow-always option, only when `shouldShowAlwaysAllowOptions()` is true and the permission result is an `ask` carrying suggestions (a `passthrough` result's suggestions are ignored). It is either:
     - **the field**: `Yes, and don’t ask again for: <rule>` (a curly apostrophe), editable in place, the cursor at the end. Offered when the dialog has a rule to seed it with and no suggestion is a directory or a rule for another tool;
     - **the label**: `generateShellSuggestionsLabel(suggestions, <shell>)`, below. Offered otherwise; when the label is `null` there is no allow-always option.
  3. `No`. Tab turns it into a note field (placeholder `and tell Claude what to do differently`).
- Moving focus away from an open note that is still blank closes it; one with text stays open. A note closed with Tab keeps its text, which still goes with the answer.
- `onUserInteraction` is called when focus moves to another option and when Tab toggles a note; never on the first paint.
- The dialog counts one permission prompt.

### The rule the field is seeded with

**Bash.** Given the command:
- When the decision reason is `subcommandResults` (a compound command the check split): the one Bash rule with content among the result's suggestions, if there is exactly one; otherwise no field (the label is used, and saves every suggestion).
- Otherwise, the dialog's own guess, ignoring what the check suggested: first the two-word guess `<word> <subcommand>:*` when the second word is lower-case letters, digits and dashes; else `<word>:*` when the first word is such a name and not a bare shell; else the command itself. Then a parse of the command refines it (skipping read-only parts of a compound command) to `<prefix>:*`, unless the user has edited the field.

What a user sees and saves today, by command (the check suggested the exact command):

| Command | Rule saved |
|---|---|
| `rm build` | `rm build:*` |
| `rm build/out` | `rm:*` |
| `rm -rf /tmp/x` | `rm:*` |
| `npm run test` | `npm run:*` |
| `git push origin main` | `git push:*` |
| `docker compose up -d` | `docker compose up:*` |
| `ls` | `ls:*` |
| `python3 script.py` | `python3:*` |
| `./run.sh` | `./run.sh:*` |
| `FOO=1 npm test` | `FOO=1 npm test:*` |
| `NODE_ENV=production npm run build` | `NODE_ENV=production npm run:*` |
| `sudo rm build` | `sudo rm:*` |
| `xargs rm` | `xargs rm:*` |
| `timeout 5 rm build` | `timeout 5 rm build:*` |
| `cd src && npm test` | `npm test:*` |
| `echo a` newline `rm b` | `rm b:*` |
| `echo hi > out.txt` | `echo hi:*` |
| `npm test \| tee log` | `npm test:*` |
| `git status && ls` (read-only throughout, so the parse offers nothing) | `git status:*` |
| `npm run "build` (an open quote) | `npm run:*` |
| `python3 "a b` | `python3 a:*` |
| `./run.sh "x` | `./run.sh x:*` |
| `cd src && npm run lint -- --fix`, split by the check with one rule `npm run lint:*` | `npm run lint:*` |

**PowerShell.** A single-line command seeds the field with the command as
typed; a parse by PowerShell's own parser (`pwsh`) then refines it to
`<prefix>:*`. Without a working `pwsh` the field keeps the command, so the
rule is exact (`Remove-Item build`). A multi-line command gets no field, so
its allow-always is the label, or nothing.

### The label (`generateShellSuggestionsLabel`)

It reads the `addRules` rules for the named shell (by `toolName`) and for
`Read`, and the `addDirectories` directories. A shell rule is named by its
command: the prefix of a `:*` rule, the content otherwise, passed through the
transform when one is given, duplicates merged. A Read path is its content
without `/**`. A path is shown as its last segment (the path itself when that
is empty, so `/` shows `//`) followed by the separator. Whole-tool rules
(no content), empty Read contents and other update types are ignored.
`<cwd>` is `getOriginalCwd()`. Command names, folder names and `<cwd>` are bold.

| Suggestions hold | Label |
|---|---|
| commands only | `Yes, and don't ask again for <commands> commands in <cwd>` |
| Read paths only | `Yes, allow reading from <paths> from this project` |
| directories only, or directories and Read paths | `Yes, and always allow access to <paths> from this project` |
| one path and one command | `Yes, and allow access to <path> and <commands> commands` |
| any other mix of paths and commands | `Yes, and allow <paths> access and <commands> commands` |
| nothing usable | `null` |

`<commands>`: `a`; `a and b`; `a, b, and c`; and `similar` when the names
joined by `, ` exceed 50 characters. `<paths>`: `x/`; `x/ and y/`; `x/, y/ and
<n> more`. The Bash dialog passes a transform that drops output redirections
(`cat a > out.txt` is named `cat a`; a `2>` redirection is kept); PowerShell
passes none.

### What each shell answer reports

`INPUT` is `toolUseConfirm.input`, unchanged.

| Answer | Calls, in order |
|---|---|
| Yes (Enter, `1`) | `onAllow(INPUT, [], undefined)` (three arguments), `onDone()` |
| Yes with a note | `onAllow(INPUT, [], '<note, trimmed>')`, `onDone()`. A blank note is `undefined` |
| The field (`2`, Down+Enter) | `onAllow(INPUT, [{ type: 'addRules', rules: [{ toolName: 'Bash' \| 'PowerShell', ruleContent: '<field, trimmed>' }], behavior: 'allow', destination: 'localSettings' }])` (two arguments), `onDone()` |
| The field emptied | `onAllow(INPUT, [])` (two arguments), `onDone()`: allows once, saves nothing |
| The label | `onAllow(INPUT, <the result's suggestions, unchanged>)`, `onDone()`. Destinations are whatever the check put there |
| No (`3`, Up from Yes) | `onReject()` with no argument, caller's `onReject()`, `onDone()`; one escape counted (`attribution.escapeCount`) |
| No with a note | `onReject('<note, trimmed>')`, caller's `onReject()`, `onDone()`; not counted. A blank note is a plain No |
| Esc (even with a Yes note written) | as a plain No: the note is dropped, one escape counted |
| `y`, `n`, a digit past the list | nothing |

With managed rules-only policy the list is Yes, No, and `2` is No.

### The sandbox in the Bash title

When sandboxing is enabled and the command would not run in it (for example,
it matches the user's `sandbox.excludedCommands`), the title is
`Bash command (unsandboxed)`; otherwise `Bash command`.

### The classifier build (`BASH_CLASSIFIER`)

The line under the title follows the Bash classifier:
- approved: `✔ Auto-approved` in the success colour, then ` · matched "<rule>"`, dim, when `classifierMatchedRule` is set. The question is dim, the list is locked (digits and Enter do nothing), and Esc calls `onDismissCheckmark()` without allowing, denying or counting an escape;
- still checking: `Attempting to auto-approve…`, shimmering;
- checked at mount and no longer checking, not approved: `Requires manual approval`, dim. The dialog answers as usual;
- never checked: no line.

Without an approval Esc is the usual deny and the checkmark is not touched.
The options and the saved rule are the same as in a plain build.

### The sed edit dialog

Routed from the Bash dialog when `parseSedEditCommand(command)` recognises an
in-place edit (`sed -i …`); any other sed is an ordinary Bash command. The
file is read (encoding detected, `\r\n` turned into `\n`); a missing file
reads as empty. `applySedSubstitution` gives the new content.

**Screen**, in the file frame (`FilePermissionDialog`, completion type
`str_replace_single`): the title `Edit file`, the path relative to the
session's working directory (`getCwd()`), the diff of old to new content (or,
when nothing changes, `File does not exist` for a missing file and `Pattern did
not match any content` otherwise, dim), the question `Do you want to make this
edit to <basename>?` (`<basename>` bold), and the frame's options:
`Yes`, the session option, `No`, with the hint `Esc to cancel · Tab to amend`.
The session option reads `Yes, allow all edits during this session
(shift+tab)` inside the working directory, `Yes, allow all edits in <dir>/
during this session (shift+tab)` outside it, and `Yes, and allow Claude to edit
its own settings for this session` inside the project's `.claudin` folder.

**Answers.** `EDIT` is the request's input plus `_simulatedSedEdit: {
filePath, newContent }`; the tool then writes `newContent` instead of running
sed. The caller hears **first**.

| Answer | Calls, in order |
|---|---|
| Yes (Enter, `1`) | `onDone()`, `onAllow(EDIT, [], undefined)` |
| Yes with a note | `onDone()`, `onAllow(EDIT, [], '<note, trimmed>')` |
| Session option (`2`, shift+tab), inside | `onDone()`, `onAllow(EDIT, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], undefined)` |
| Session option, outside | as inside, plus `{ type: 'addDirectories', directories: ['<dir>'], destination: 'session' }` |
| Session option, `.claudin` | `onDone()`, `onAllow(EDIT, [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: '/.claudin/**' }], behavior: 'allow', destination: 'session' }], undefined)` |
| No (`3`), Esc | `onDone()`, caller's `onReject()`, `onReject(undefined)` (one argument). No escape counted |
| No with a note | `onDone()`, caller's `onReject()`, `onReject('<note, trimmed>')` |

| File, command | `newContent` |
|---|---|
| `hello foo\nbar foo\n`, `s/foo/baz/` | `hello baz\nbar foo\n` (first match in the file; Finding 11) |
| `a a\na\n`, `s/a/b/g` | `b b\nb\n` |
| `foo\r\nfoo\r\n`, `s/foo/baz/g` | `baz\nbaz\n` |
| no match | the content unchanged |
| missing file | `''` |

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| No suggestions, or a `passthrough` result | Yes and No only | yes |
| Managed rules-only policy | Yes and No only; `2` is No | yes, both shells and both builders |
| Suggestions that make no label (an empty directory list) | Yes and No only | yes |
| The field emptied, or only spaces typed around it | allow once, nothing saved / saved trimmed | yes |
| A multi-line PowerShell command | the label, naming the whole script; saves it as an exact rule | yes (Finding 17) |
| `bash -c "…"` | the field offers `bash:*` | no (Finding 1) |
| A relative sed path | the preview reads it from the process directory | no (Finding 10) |
| A sed target that is a directory | the dialog fails while rendering | no (Finding 13) |
| A Bash input with unknown keys | the dialog fails while rendering (the schema is strict) | no |
| `pwsh` available | the PowerShell field is refined to `<prefix>:*` | no (needs `pwsh`) |

## Security requirements

- **Only an explicit choice allows.** Esc, `y`, `n` and an out-of-range digit never allow. No and Esc always reach the request's `onReject`. In a classifier build, Esc on an approved dialog neither allows nor denies.
- **Allow once saves nothing**: Yes reports an empty update list in all three dialogs.
- **The field saves exactly what it shows, trimmed, as one local allow rule for the dialog's own tool** (`destination: 'localSettings'`), never the user or project settings. An empty field saves nothing; it must never save a rule without content (a whole-tool rule).
- **The rule the field suggests must not widen** for the commands in the table above. In particular `rm build` → `rm build:*`, not `rm:*` (the known gap the arity port would change). Any change to the guess is a security change and needs its own decision.
- **The label saves the check's suggestions unchanged**, never more.
- **Allow-always is withheld** when policy forbids it, when the check suggested nothing, and when the field cannot represent a suggestion (a directory or another tool's rule).
- **A sed allow hands on the previewed content**, so what the user approved is what is written.

## Tests that pin it

- **`src/permissions/ui/BashPermissionRequest/BashPermissionRequest.characterization.test.tsx`**: 63 tests. The screen, hint and note behaviour, Ctrl+D with and without `--debug` (and Esc doing nothing over the details), the explainer hint, the sandbox title (sandbox availability spied, excluded commands from a real settings file), the badge and explanation, managed policy, 19 answers with their exact calls, arguments and escape counts, `onUserInteraction`, the 22-command rule table, and the compound / label / directory routes.
- **`src/permissions/ui/BashPermissionRequest/BashPermissionRequest.classifier.characterization.test.tsx`**: one test under the plain runner that runs the file again with `--feature=BASH_CLASSIFIER` (9 tests): the four subtitle states, the locked list, Esc dismissing the checkmark only after an approval (not over the decision details), and the options in that build. The model call for a rule description is stubbed, without assertions (Finding 9).
- **`src/permissions/ui/BashPermissionRequest/bashToolUseOptions.characterization.test.tsx`**: 20 tests, both builders called directly: every option shape (fields, placeholders, the field's flags, wired callbacks), the field-or-label choice, managed policy, the ignored classifier arguments, and each shell's label (redirections, own commands only).
- **`src/permissions/ui/PowerShellPermissionRequest/PowerShellPermissionRequest.characterization.test.tsx`**: 26 tests. The screen, Yes/No without suggestions or with a passthrough, managed policy, the badge and explanation, the hint, Ctrl+D, 12 answers, `onUserInteraction`, and the multi-line, directory, Read and no-label routes. A `pwsh` that always fails is put first on the `PATH`, so the suite does not depend on the machine.
- **`src/permissions/ui/SedEditPermissionRequest/SedEditPermissionRequest.characterization.test.tsx`**: 20 tests, through the Bash route with real files: the screen, the two notes, a non-in-place sed, outside the working directory and in `.claudin`, 8 answers with their order and arguments, four content cases, and the session updates outside and in `.claudin`.
- **`src/permissions/ui/shellPermissionHelpers.characterization.test.tsx`**: 27 tests: 18 label shapes, six `null` cases, per-shell filtering, the transform, and bold styling.
- **The rig**: `src/permissions/ui/__testutils__/toolDialogRig.tsx` (shared with toolDialogs), extended here with `debug`, extra request fields (`confirm`), and `update()` to hand the dialog a changed copy of its request.
- 157 tests in all under the plain runner (plus 9 in the flagged child). Three runs in a row passed (89 s each). Coverage (lines, plain run): `BashPermissionRequest.tsx` 81.0%, `bashToolUseOptions.tsx` 97.5%, `PowerShellPermissionRequest.tsx` 98.8%, `powershellToolUseOptions.tsx` 100%, `shellPermissionHelpers.tsx` 98.3%, `useShellPermissionFeedback.ts` 98.7%, `SedEditPermissionRequest.tsx` 91.7%. Uncovered: in the Bash dialog, the classifier code (the checking subtitle, the description request, the checkmark dismissal and the locked list, all run in the flagged child), the classifier-reviewed answer (unreachable, Finding 8), the parse-failure catch, and compiler cache hits; in the Bash builder, an unused helper (Finding 8); in the PowerShell dialog, applying a parsed prefix (needs `pwsh`); in the label, the empty-list case no caller reaches; in the sed dialog, the rethrow of a non-missing read error (Finding 13) and cache hits.
- **`scripts/migrations/probes/rewrite-permissions-shellDialogs.json`**: 40 probes over the seven files. Every allow path is mutated to fail open (Yes saving the suggestions, No and Esc allowing, an emptied field saving a whole-tool rule, the label saving a whole-tool rule, policy ignored, the field shown without suggestions or beside a directory), the saved rule is widened (`rm build:*` to `rm:*`, the two-word guess skipped, the refinement dropped, read-only parts no longer skipped) or moved to `userSettings`, and the deny path loses its note, its caller callback or its escape count.
- **Kept, this project's own:** `src/permissions/ui/PermissionRequest.test.ts` (name-keyed routing of both shell dialogs).

**Text pinned outside the unit.** None. The unit sends nothing to a model
itself; the description request of Finding 9 is `bashClassifier.ts`'s prompt.

**Inherited tests to fold in:** none named for this unit.

**Not pinned, and why:**
- `bash:*` from `bash -c` (Finding 1), the relative sed path (Finding 10) and the directory crash (Finding 13): the old behaviour is wrong.
- The PowerShell parsed prefix: it needs a working `pwsh`, which the test machines lack.
- A user edit racing the parsed refinement of the field: it depends on timing.
- `ctrl+e` (the explainer): it asks a model, and belongs to decisionExplanation.

## Out of scope

- The frame, the rule explanation, the prompt counter (promptFrame); the explainer and the debug details (decisionExplanation); the sed dialog's frame, options and session updates as a whole (fileDialogs); the diff.
- How the guess is computed (`bashPermissions`, the prefix walkers) and how saved rules are matched (shellRules).
- Parsing sed and applying the edit (`sedEditParser`, `applySedEdit`).

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Security: `bash -c "…"` offers `bash:*`.** The first guess refuses a bare shell, but the parsed refinement then offers `bash:*`, which lets any command run through `bash -c` without asking. | **Fix** (hardening): never offer a bare shell or a command-running wrapper as a prefix; keep the exact command. Not pinned. |
| 2 | **Security: wrapper and environment prefixes.** `sudo rm build` saves `sudo rm:*`, `xargs rm` saves `xargs rm:*`, `timeout 5 rm build` saves `timeout 5 rm build:*`, and `FOO=1 npm test` saves `FOO=1 npm test:*`. | **Keep for parity** (pinned): narrowing would make users approve again. **Track** with 1. |
| 3 | **Security: the two-word guess takes any lower-case second word for a subcommand.** `rm build` saves `rm build:*`, which also allows `rm build <anything>`; `rm build/out` saves `rm:*`, the whole program. This is the gap the arity port would turn into `rm:*` for both. | **Keep for parity** (pinned, the security net for the port). **Track**: the guess should know which programs take subcommands. |
| 4 | **The field ignores the check's suggestion** for a non-compound command: the check may suggest `Bash(rm:*)` or the exact command, and the field offers its own guess. | **Keep for parity** (pinned). |
| 5 | **Plain No counts as an escape** in the shell dialogs (`attribution.escapeCount`), the same as Esc; in the sed dialog neither does. | **Keep for parity** (pinned). **Track**: count Esc only, in all three. |
| 6 | **A note closed with Tab still goes** with the answer, though it is no longer shown. | **Keep for parity** (pinned). **Track.** |
| 7 | **An emptied field allows once** although the option says "don't ask again". | **Keep for parity** (pinned): it is the safe direction. |
| 8 | **Dead classifier-reviewed path.** The Bash answer handler has a "classifier-reviewed" branch that saves a session prompt rule, but the option is never offered; the builder's five classifier arguments, its duplicate-description helper and the hook's `explainerVisible` are unused. | **Fix**: drop them. Not pinnable. |
| 9 | **A model call nothing uses.** In a `BASH_CLASSIFIER` build every Bash dialog asks a model for a generic rule description, which no option shows any more. | **Fix**: drop the call. Not pinned (stubbed). |
| 10 | **Data loss: the sed preview resolves a relative path against the process directory**, while the tool writes against the session's working directory (`expandPath`). After a `cd`, the approved content can be computed from another file, or from nothing (empty), and written over the real one. | **Fix**: resolve the path against `getCwd()`, as the write does. Not pinned; the suite uses absolute paths. |
| 11 | **`s/x/y/` without `g` replaces the first match in the file**, where sed replaces the first per line. The preview and the write agree, but differ from sed. | **Track** (owned by `sedEditParser`). Pinned incidentally. |
| 12 | **A sed edit turns `\r\n` into `\n`** in the handed-on content. | **Track** (with `applySedEdit`). Pinned. |
| 13 | **A sed target that cannot be read (a directory) fails the dialog while rendering.** | **Fix**: show the read error as the note and offer No. Not pinned. |
| 14 | **Two apostrophes**: the field says `don’t` (U+2019), the label `don't`. | **Keep for parity** (pinned). Change with the wording pass. |
| 15 | **`2>` redirections stay in the label's command names** (`ls 2> err.log`). | **Keep for parity** (pinned). |
| 16 | **The sed session option switches the whole session to `acceptEdits`** (and adds the folder outside the project), wider than "this sed". | **Keep for parity** (pinned). Owned by fileDialogs. |
| 17 | **A multi-line PowerShell command shows the label naming the whole script** and saves it as an exact rule; the field was meant to hide the option for multi-line commands. | **Keep for parity** (pinned). **Track.** |
| 18 | **The PowerShell rule depends on the machine**: without `pwsh` it is the exact command, with it a `<prefix>:*`. | **Track.** Not pinnable here. |
| 19 | **The root directory is labelled `//`.** | **Keep for parity** (pinned, cosmetic). |
| 20 | **The three dialogs disagree on the deny**: Bash and PowerShell call `onReject()` with no argument and the request first; sed calls the caller first and `onReject(undefined)`. | **Keep for parity** (pinned). |
| 21 | **An open quote is dropped from the saved rule**: `./run.sh "x` saves `./run.sh x:*`, which does not match the command it was saved for. | **Keep for parity** (pinned). **Track** with 3. |

## Target design

- **Hand-written components**, without compiler cache slots, keeping the three component exports, both builders, the label and the hook with their signatures.
- **The rule is data, computed by one pure function per shell**: `(command, permissionResult) => { field?: string; suggestions?: PermissionUpdate[] } | null`. It owns the compound, field-or-label and multi-line choices, and Findings 1 and 2 are decided there. Unit-test it on the tables above without Ink; the dialog only maps the chosen option to `onAllow(input, rule ? [addRules(rule)] : [])`.
- **One answer handler for both shells**: Yes, field, label, No and cancel are the same calls with a different tool name. Drop the classifier-reviewed branch and the unused arguments (Finding 8).
- **The classifier subtitle stays its own small component**, so its 20 fps clock does not re-render the dialog.
- **The sed dialog resolves its path like the write does** (Finding 10) and turns a read error into a note (Finding 13).
- **Tests**: the characterization suites, unchanged, plus unit tests for the rule functions.
