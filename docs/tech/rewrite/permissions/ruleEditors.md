# Spec: `permissions/ruleEditors`

## Purpose

These are the editing steps of `/permissions` and `/add-dir`. When `/permissions`
has parsed a rule the user typed, `AddPermissionRules` asks which settings file
should hold it. It then writes the rule there, hands the caller a new session
context, and lists any of the new rules that can never take effect.
`AddWorkspaceDirectory` adds a working directory. It takes either a path the
user types, which it checks and completes, or a path `/add-dir` already
resolved, and then asks whether to remember it. `RemoveWorkspaceDirectory`
confirms that a directory should leave the workspace. `WorkspaceTab` lists the
working directories. `RecentDenialsTab` lists what the auto-mode classifier
denied and lets the user mark each denial approved or approved-and-retry.

Typing and parsing the rule text happens in `permissions/ruleList` (`PermissionRuleInput`).
These steps receive the parsed values. They are where a rule or a directory
gets saved, so the risk is a save the user did not choose: the wrong file, a
widened rule, a directory nobody typed, or an answer that cancels on screen
but saves anyway.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `AddPermissionRules` | component, props `{ onAddRules(rules: PermissionRule[], unreachable?: UnreachableRule[]): void; onCancel(): void; ruleValues: PermissionRuleValue[]; ruleBehavior: PermissionBehavior; initialContext: ToolPermissionContext; setToolPermissionContext(next: ToolPermissionContext): void }` | `src/permissions/ui/rules/PermissionRuleList.tsx` |
| `optionForPermissionSaveDestination` | `(destination: EditableSettingSource) => OptionWithDescription` | `AddPermissionRules`; `src/terminal/claudinUiSurfaces.test.ts` |
| `AddWorkspaceDirectory` | component, props `{ onAddDirectory(path: string, remember?: boolean): void; onCancel(): void; permissionContext: ToolPermissionContext; directoryPath?: string }` | `PermissionRuleList.tsx`, `src/commands/add-dir/add-dir.tsx` |
| `RemoveWorkspaceDirectory` | component, props `{ directoryPath: string; onRemove(): void; onCancel(): void; permissionContext: ToolPermissionContext; setPermissionContext(next: ToolPermissionContext): void }` | `PermissionRuleList.tsx` |
| `WorkspaceTab` | component, props `{ onExit(result?: string, options?: { display?: CommandResultDisplay }): void; toolPermissionContext: ToolPermissionContext; onRequestAddDirectory(): void; onRequestRemoveDirectory(path: string): void; onHeaderFocusChange?(focused: boolean): void }` | `PermissionRuleList.tsx` |
| `RecentDenialsTab` | component, props `{ onHeaderFocusChange?(focused: boolean): void; onStateChange(state: { approved: Set<number>; retry: Set<number>; denials: readonly AutoModeDenial[] }): void }` | `PermissionRuleList.tsx` |

The tests compute their expectations with these collaborators, and the
rewrite must use them rather than restate what they do:
- `permissionRuleValueToString` (`permissionRuleParser.ts`): how a rule is written.
- `applyPermissionUpdate` and `persistPermissionUpdate` (`PermissionUpdate.ts`): the session edit and the file edit.
- `detectUnreachableRules` (`shadowedRuleDetection.ts`): which rules are shadowed.
- `validateDirectoryForWorkspace` and `addDirHelpMessage` (`commands/add-dir/validation.ts`): the path checks and their messages.
- `getDirectoryCompletions` (`terminal/suggestions/directoryCompletion.ts`): the completions.
- `getAutoModeDenials` (`autoModeDenials.ts`): the denials.
- `SOURCES` (`platform/settings/constants.ts`): the destinations and their order.

## Observable behaviour

### 1. Saving a rule (`AddPermissionRules`)

- **The frame.** The dialog is titled `Add <behaviour> permission rule`, or
  `rules` when there are several. Each rule follows, in the order given, written
  in rule syntax in bold with its description under it. Then comes the question
  `Where should this rule be saved?` (`these rules` when there are several), and
  the hint `Enter to confirm · Esc to cancel`.
- **The destinations**, in this order, each with a line saying where its file is:
  `Project settings (local)` (`Saved in .claudin/settings.local.json`),
  `Project settings` (`Checked in at .claudin/settings.json`) and
  `User settings` (`Saved in ~/.claudin/settings.json`). The pointer starts on
  the first one. Up from the first wraps round to the last.
- **Choosing one**, for each behaviour (`allow`, `deny`, `ask`) and each
  destination:
  1. The rules are appended to that file's `permissions.<behaviour>` list, in
     canonical form and in order. The project files are under the original
     working directory, and the user file is under the config home. No other
     file is created or touched.
  2. The caller gets a new context through `setToolPermissionContext`. The rules
     are appended to that destination's slot for that behaviour, and everything
     else in the context is kept. The context passed in is not changed.
  3. Then `onAddRules` is called with one `{ ruleValue, ruleBehavior, source }`
     per rule, `source` being the destination.
- **Written as shown.** The file holds what the dialog showed. Content with
  parentheses or backslashes is escaped and parses back to the same value.
  `Bash(*)` and `Edit(*)` are written as the whole-tool rules they already are,
  and a rule with content is never written as its whole tool.
- **The file keeps what it had.** Other keys and other lists are kept. A rule
  already in the list, however it is spelled, is not added a second time.
- **Unreachable rules.** After saving, the second argument of `onAddRules` lists
  the new allow rules that a tool-wide deny or ask rule for the same tool
  shadows, from any source. Each entry has the new rule (with the chosen
  source), `shadowedBy`, `shadowType` (`deny` before `ask`), and a `reason` and
  a `fix` that name the shadowing rule and both sources. If no new rule is
  shadowed, the argument is `undefined`. Deny and ask rules are never listed,
  and neither is an older unreachable rule. A narrower deny such as
  `Bash(rm:*)`, or a deny of another tool, shadows nothing. A personal
  tool-wide Bash ask counts when the sandbox is off. Sandbox auto-allow is not
  on in this fork's tests (see "Not pinned").
- **Esc** reports only `onCancel`, and no file is created. Moving the pointer
  reports nothing.

### 2. Adding a directory (`AddWorkspaceDirectory`)

**With `directoryPath`**, as `/add-dir <path>` uses it after validating the path:
- The screen shows `Add directory to workspace`, the path as given, the line
  `Claudin will be able to read files in this directory and make edits when
  auto-accept edits is on.`, and the answers `Yes, for this session`,
  `Yes, and remember this directory` and `No`. The hint is
  `Enter to confirm · Esc to cancel`.
- The first answer reports `onAddDirectory(path, false)`. The second reports
  `onAddDirectory(path, true)`. `No` and Esc report `onCancel()` only. The path is
  passed on exactly as given: this face does not check or resolve it.

**Without it**, as `/permissions` and a bare `/add-dir` use it:
- The screen shows the same title and description, `Enter the path to the
  directory:`, an input box with the placeholder `Directory path…`, and the hint
  `Tab to complete · Enter to add · Esc to cancel`.
- **Enter on what was typed** checks the path. An existing directory outside every
  working directory is reported as `onAddDirectory(absolutePath, false)`: dot
  segments and a trailing slash are resolved away, and the second argument is
  never `true`. Any other path is refused. Its message appears in the error
  colour under the input, and nothing is reported:

  | Typed | Message |
  |---|---|
  | nothing | `Please provide a directory path.` |
  | a path that does not exist | `Path <absolute> was not found.` |
  | a file | `<typed> is not a directory. Did you mean to add the parent directory <parent>?` |
  | the original working directory, a directory inside it, or inside an added one | `<typed> is already accessible within the existing working directory <dir>.` |

- **Completions.** About 100 ms after the input changes, the subdirectories
  that match it are listed under the input, each as `<name>/` with
  `directory`. A trailing slash lists the subdirectories of that directory,
  and a partial name lists those it starts, ignoring case. Hidden directories
  and files are left out. The pointer starts on the first one.
  - Down or Ctrl+N moves the pointer to the next completion, Up or Ctrl+P to the
    previous one, and both wrap round.
  - Tab puts the pointed completion in the input with a trailing slash. That
    clears any earlier message and lists the new directory's own
    subdirectories.
  - Clearing the input clears the list.
  - With no completions listed, the arrows and Tab do nothing.
- **Esc** reports `onCancel()`, whether or not anything was typed.

### 3. Removing a directory (`RemoveWorkspaceDirectory`)

- The screen shows `Remove directory from workspace?`, the path in bold,
  `Claudin will no longer have access to files in this directory.`, then
  `Yes` and `No`, and `Enter to confirm · Esc to cancel`.
- **Yes** first hands `setPermissionContext` a context without that directory,
  with everything else kept, and then calls `onRemove()`. The same happens for a
  path that is not in the workspace: the context comes back with the same
  directories.
- **No** and Esc report `onCancel()` only. Moving the pointer reports nothing.

### 4. The Workspace tab (`WorkspaceTab`)

- The first line is `-  <original working directory>` followed by
  `(Original working directory)`. It cannot be chosen. After it come the added
  directories in the context's order, then `Add directory…`. At most ten rows
  show at a time, and the rest scroll into view.
- Enter on a directory reports `onRequestRemoveDirectory(path)`. Enter on
  `Add directory…` reports `onRequestAddDirectory()`. Esc reports
  `onExit('Workspace dialog dismissed', { display: 'system' })`.
- **Header focus.** `onHeaderFocusChange` gets the tab row's focus on mount and
  every time it changes. Outside a `Tabs` the content has the focus (`false`).
  Inside one, the header starts focused and the list ignores Enter. Down gives
  the list the focus, and Up from the first row gives it back. The listener is
  optional.

### 5. The Recently denied tab (`RecentDenialsTab`)

- **Nothing denied.** The tab shows `No recent denials. Commands denied by the
  auto mode classifier will appear here.` The keys do nothing, and
  `onStateChange` is called once, with empty sets and an empty list. Denials are
  only recorded in a build with `TRANSCRIPT_CLASSIFIER` (the shipped build).
- **Some denied.** The tab shows `Commands recently denied by the auto mode
  classifier.`, then one row per denial, newest first. Each row shows the
  denial's `display` text after a status mark: a cross while it is denied, a tick
  once it is approved. A row marked for retry ends in ` (retry)`. At most ten
  rows show at a time. The list is read once, when the tab mounts.
- Enter toggles the pointed row's approval. `r` toggles its retry mark, and
  setting the mark also approves the row. Clearing it with a second `r` keeps
  the approval, and `r` on an approved row leaves it approved. Other keys do
  nothing.
- `onStateChange` gets the `approved` and `retry` index sets and the list the
  tab shows, on mount and after every change. The indexes are positions in that
  list. The tab saves nothing: the caller acts on the sets when `/permissions`
  closes. Esc reports nothing new.
- Header focus works as in the Workspace tab.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Managed settings keep rules to the policy (`allowManagedPermissionRulesOnly`) | no file is written, for any destination | the file side, yes. The session side is Finding 1 |
| The destination file is not valid JSON | the file is left byte for byte as it was | yes. The session side is Finding 1 |
| A rule already in the destination's file | not written a second time | yes |
| The same rule already in the session slot | added to the session slot again | no (Finding 7) |
| An allow rule already shadowed in another file, added again | reported once per file that holds it | no (Finding 7) |
| `directoryPath` that does not exist | passed on as given | yes |
| Enter in the input while completions are listed | **Broken**: both the typed path and the pointed completion are reported | no (Finding 2) |
| Spaces only in the input | the session's current directory is added | no (Finding 8) |
| Removing a path not in the workspace | reported as removed, directories unchanged | yes |
| Removing a directory that is remembered in a settings file | the file keeps it | no (Finding 3) |
| `r` then Enter on a denial | **Broken**: it is left marked for retry but not approved | no (Finding 6) |
| A denial recorded while the tab is open | not shown until it opens again | yes |

## Security requirements

- **Only an explicit choice saves.** A rule reaches a settings file only when
  a destination is confirmed with Enter. Esc and pointer moves write nothing
  and report only a cancel, or nothing at all.
- **The file chosen is the file written.** The rule goes to that destination,
  with that behaviour, in the list for that behaviour. A deny or ask rule is
  never saved, or put in the session, as an allow.
- **No widening.** What is written is exactly what was shown. A rule with
  content never becomes its whole tool, and the new rules join the existing ones
  rather than replacing them.
- **A refused save is not a save.** While the managed policy keeps rules to
  itself, no file is written. The rewrite must also keep the rule out of the
  session (Finding 1).
- **Only the directory the user names is added.** A path that is missing, is a
  file, or is already reachable is refused. A typed directory is never
  remembered. `No` and Esc never add. One Enter adds at most one directory
  (Finding 2).
- **Removal is confirmed.** `No` and Esc never remove.

## Tests that pin it

- **`src/permissions/ui/rules/AddPermissionRules.characterization.test.tsx`**:
  30 tests. The destination options, the frame for one and for several rules,
  each behaviour saved to each destination (9 cases, each checked on disk and
  in the context), the wrap of the pointer, escaping and wildcards written as
  shown, a file that already has rules, the rest of the context kept, Esc and
  pointer moves, eight shadowing cases, the managed lock, and a broken file.
- **`.../AddWorkspaceDirectory.characterization.test.tsx`**: 30 tests. Both
  faces of the dialog, six answers of the given-path face, success and
  dot-segment resolution, six refusals with their messages, Esc, and the
  completions: listing, partial names, Tab, six pointer moves, a cleared
  message, an emptied input, and no completions.
- **`.../RemoveWorkspaceDirectory.characterization.test.tsx`**: 9 tests.
- **`.../WorkspaceTab.characterization.test.tsx`**: 12 tests, including the
  header focus inside a real `Tabs`.
- **`.../RecentDenialsTab.characterization.test.tsx`**: 3 tests under the plain
  runner: two for the empty tab, and one that runs the file again with
  `--feature=TRANSCRIPT_CLASSIFIER`. The child runs 16 tests: the two empty
  ones again, and 14 that pin the listed tab (the rows, nine key sequences,
  Esc, a late denial, ten visible rows and the header focus).
- **The rig**: `src/permissions/ui/__testutils__/promptFrameRig.tsx` (mount,
  keys, isolated config home and project) and `toolDialogRig.managedRulesOnly`.
- 84 tests under the plain runner (plus 16 in the flagged child). Three runs in
  a row passed. Line coverage: `AddPermissionRules` 92.7%,
  `AddWorkspaceDirectory` 96.6%, `RemoveWorkspaceDirectory` 92.1%,
  `WorkspaceTab` 99.2%, `RecentDenialsTab` 52.9% under the plain run and 98.8%
  in the flagged child. The gaps:
  - compiler cache hits;
  - the unreachable `cancel` answer (Finding 4);
  - the Enter-with-completions branch (Finding 2);
  - the empty-state cache line of `RecentDenialsTab`.
- **`scripts/migrations/probes/rewrite-permissions-ruleEditors.json`**: 40
  probes over the five files: 13 on `AddPermissionRules`, 12 on
  `AddWorkspaceDirectory`, 4 on `RemoveWorkspaceDirectory`, 5 on
  `WorkspaceTab` and 6 on `RecentDenialsTab`. Twelve of them make a save, add
  or remove path fail open:
  - every answer saving to the user file, or nothing saved;
  - a deny or ask rule saved, or put in the session, as an allow;
  - sandbox auto-allow forced on;
  - a typed directory remembered, or a missing path accepted;
  - `No` or Esc adding a directory;
  - `No` or Esc removing one.

  Two more let a list answer when it should not: with the header focused, or
  with no denials listed.
- **Outside the unit:** `src/terminal/claudinUiSurfaces.test.ts` pins the three
  destination options byte for byte. It is an inherited test of
  `terminal`, and it must keep passing.

**Text sent to a model.** None. The unit only reports to its callers.

**Not pinned, and why:**
- The session context after a refused save: the old behaviour is Finding 1.
- Enter while completions are listed (Finding 2), and spaces only (Finding 8).
- `r` then Enter on a denial (Finding 6), and duplicate shadow reports (Finding 7).
- Sandbox auto-allow on. `@anthropic-ai/sandbox-runtime` is aliased to a stub
  in `bunfig.toml`, so sandboxing is never enabled under the test runner. The
  sandbox-off side is pinned, and a probe that forces auto-allow on turns it
  red.
- Colours (the permission and error frames, the status marks): cosmetic, and
  owned by the design system.
- Ctrl+C in the input: `TextInput` owns it (it clears the input).

## Out of scope

- Typing and parsing the rule, the rule list, its search and the exit
  messages built from the denial sets: `permissions/ruleList`.
- What `/add-dir` does with a chosen directory (the session, the local
  settings, the sandbox and the CLAUDE.md directories): `commands/add-dir`.
- The path checks themselves (`validation.ts`), the completion scan, the
  shadow analysis and the settings-file edits. These units are used as they
  are.
- Dropped on purpose: the `cancel` answer nothing can produce (Finding 4).

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **A refused save still takes effect.** While managed settings keep rules to the policy, or when the destination file is unreadable JSON, no file is written. The dialog still puts the rule in the session context and reports it added, so `/permissions` prints `Added allow rule …` and the rule applies until the next reload from disk. Under the managed lock this goes around the policy for the rest of the session. The tool dialogs, by contrast, do not offer allow-always under that policy. | **Fix** (security). Apply the update to the session and report it only when the file save succeeded. Otherwise say why it was refused. The only workflow that notices is one the policy forbids. The file side is pinned. |
| 2 | **One Enter can add two directories.** With completions listed, Enter adds the typed path and then the pointed completion. That completion can be a subdirectory or a sibling the user never typed (`…/proj` → `…/proj-old/`). Completions are listed for nearly every real path, its own name included. | **Fix** (security). Enter adds exactly what is typed, once, and Tab takes a completion. Not pinned. |
| 3 | **Removing does not unremember.** The confirmation says Claudin will no longer have access, but only the session context changes. A directory saved with "remember", or listed in any settings file, comes back at the next start. | **Fix.** Remove it from the settings file its `source` names when that file is editable. When it is not (policy, flag), say so instead of claiming removal. Not pinned. |
| 4 | **A dead answer.** The destination step handles a `cancel` value that is not one of its options. Esc cancels through the frame. | **Fix:** drop it. |
| 5 | **The user destination always says `~/.claudin/settings.json`**, even when `CLAUDIN_CONFIG_DIR` puts the file elsewhere. | **Keep for parity** (pinned here and in `claudinUiSurfaces.test.ts`). Revisit together with the other places that print the config home. |
| 6 | **Retry without approval.** `r` then Enter leaves a denial marked for retry but no longer approved. On exit, `/permissions` still tells the model `Permission granted for: …`. No rule is granted either way, because the classifier judges the retry again. | **Fix:** taking an approval back also clears the retry mark. Not pinned. |
| 7 | **Duplicates.** Adding a rule already in the session slot appends it again, though the file dedupes. A new allow that matches an already-shadowed allow in another file reports a warning for every file that holds it. | **Fix** the report: list only the rule just added. The session duplicate comes from `applyPermissionUpdate`. **Track** it in `permissions/ruleModel`. |
| 8 | **Spaces only add the current directory.** The path check treats a whitespace-only path as the current directory. | **Track** in `commands/add-dir` (`validation.ts`). The new dialog trims before checking, so it shows `Please provide a directory path.` |

## Target design

- **Hand-written components** in this repo's Ink style, with typed props and
  no React Compiler cache slots. They keep every export name and props shape
  above, including `optionForPermissionSaveDestination`.
- **Save, then report.** A small function returns `saved | refused(reason)`.
  It takes the rule values, the behaviour and the destination, and goes through
  `persistPermissionUpdate`'s file layer. The dialog builds the next context
  with `applyPermissionUpdate` only on `saved`, then reports the unreachable
  rules restricted to exactly the new rules in that destination (Findings 1
  and 7).
- **Directory input as a reducer.** Keep `{ text, completions, pointer, error }`
  in a pure reducer over key events, with Enter → submit(text) and Tab → take
  the completion (Finding 2). Unit-test the reducer without Ink. The debounced
  completion fetch stays an effect.
- **Removal by source.** It applies `removeDirectories` to the session and to
  the directory's own settings file when that file is editable (Finding 3).
- **Denial marks as a reducer** over `{ approved, retry }`. Clearing approval
  clears retry (Finding 6).
- **Tests.**
  - The five characterization suites, unchanged.
  - Unit tests for the two reducers.
  - New tests for the fixes: no session rule after a refused save, one
    directory per Enter, removal from the file, retry cleared with approval.
