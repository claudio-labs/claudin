# Spec: `permissions/ruleList`

## Purpose

The `/permissions` screen (alias `/allowed-tools`). It shows the permission
rules the session holds, tab by tab (allow, ask, deny), together with the
auto-mode denials of this session and the workspace directories. From it the
user can read where a rule comes from, delete a rule, add a rule, add or
remove a workspace directory, and approve or retry a denied command. When it
closes it reports what changed to the command that opened it.

Three components make up the unit:
- `PermissionRuleList`: the screen;
- `PermissionRuleDescription`: the one-line gloss under a rule;
- `PermissionRuleInput`: the field where a new rule is typed.

Its security weight is in two places:
- **deleting**, which removes a rule from the session and from one settings file. Removing a deny or ask rule is the fail-open direction;
- **the read-only guard**, which keeps managed (policy) rules from being deleted here.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `PermissionRuleList` | component, props `{ onExit(result?: string, options?: { display?: CommandResultDisplay; shouldQuery?: boolean; metaMessages?: string[] }): void; initialTab?: 'recent' \| 'allow' \| 'ask' \| 'deny' \| 'workspace'; onRetryDenials?(commands: string[]): void }` | `src/commands/permissions/permissions.tsx`, which passes the command's `onDone` as `onExit`, and turns `onRetryDenials` into a `permission_retry` system message (`createPermissionRetryMessage`). It passes no `initialTab` |
| `PermissionRuleDescription` | component, props `{ ruleValue: PermissionRuleValue }`; renders one line or nothing | `PermissionRuleList.tsx`, `src/permissions/ui/rules/AddPermissionRules.tsx` |
| `PermissionRuleInput` | component, props `PermissionRuleInputProps = { onCancel(): void; onSubmit(ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior): void; ruleBehavior: PermissionBehavior }` | `PermissionRuleList.tsx` |

The rewrite keeps using these collaborators rather than restating them:
- the rule reads and writes: `getAllowRules`, `getAskRules`, `getDenyRules`, `deletePermissionRule` and `permissionRuleSourceDisplayString` (`src/permissions/permissions.ts`);
- `applyPermissionUpdate` and `persistPermissionUpdate` (`src/permissions/PermissionUpdate.ts`);
- the parser: `permissionRuleValueFromString` and `permissionRuleValueToString`;
- `getAutoModeDenials` (`src/permissions/autoModeDenials.ts`);
- the app state's `toolPermissionContext`, through `useAppState` and `useSetAppState`;
- the five editors of the `permissions/ruleEditors` unit: `AddPermissionRules`, `AddWorkspaceDirectory`, `RemoveWorkspaceDirectory`, `WorkspaceTab` and `RecentDenialsTab`;
- the design system's `Pane`, `Tabs` and `Tab`, `SearchBox`, `Select`, `TextInput`, and the Ctrl-C/Ctrl-D double-press hook.

## Observable behaviour

### 1. The screen and its tabs (`PermissionRuleList`)

- A coloured pane titled `Permissions:`, then five tabs in this order: `Recently denied`, `Allow`, `Ask`, `Deny`, `Workspace`.
- **The opening tab** is `initialTab` when given. Otherwise it is `Recently denied` when the session has auto-mode denials, and `Allow` when it has none. The denials are read once, when the screen opens.
- **The opening focus.**
  - With no denials, the tab row has focus. ←/→ (and Tab / Shift+Tab) switch tabs, and ↓ moves into the tab's list.
  - With denials, the list has focus from the start, whatever the opening tab.
- **The rule tabs.** Each starts with a subtitle:

  | Tab | Subtitle |
  |---|---|
  | Allow | `Claudin won't ask before using allowed tools.` |
  | Ask | `Claudin will always ask for confirmation before using these tools.` |
  | Deny | `Claudin will always reject requests to use denied tools.` |

  Below it come a search box (`⌕ Search…`) and a numbered list: `Add a new rule…` first, then one row per rule of that kind.
- **What a rule tab lists:**
  - every rule of that kind the session holds, from every source (user, project, local, flag, policy, CLI argument, command, session);
  - one row per rule per source, so the same text held by two sources shows twice, in source order (user before project before local);
  - each row is the rule's text (`permissionRuleValueToString`);
  - rows are sorted by that text, ignoring case (`Agent`, `Bash(ls)`, `Glob`, `mcp__srv__tool`, `Read`). Texts that differ only in case (`Read`, `read`, `READ`) count as equal and keep the order the session holds them in;
  - an allow rule and a deny rule with the same text each appear on their own tab only.
- **At most ten rows show at once**, the add row included. When more follow, the tenth row is marked `↓`.
- **The Workspace tab** says `Claudin can read files in the workspace, and make edits when auto-accept edits is on.`, then lists the original working directory and the session's extra directories (the `WorkspaceTab` view).
- **The Recently denied tab** is the `RecentDenialsTab` view. With no denials it says `No recent denials.`; otherwise it lists them, newest first.

### 2. The footer

One dim line under the pane, chosen in this order:

| State | Footer |
|---|---|
| a first Ctrl-C or Ctrl-D was pressed | `Press Ctrl-C again to exit` / `Press Ctrl-D again to exit` |
| the tab row has focus | `←/→ tab switch · ↓ return · Esc cancel` |
| a search is being typed | `Type to filter · Enter/↓ select · ↑ tabs · Esc clear` |
| the screen opened on Recently denied with denials | `Enter approve · r retry · ↑↓ navigate · ←/→ switch · Esc cancel` |
| otherwise | `↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel` |

One Ctrl-C or Ctrl-D does not close the screen and reports nothing.

### 3. Searching a rule tab

- **Starting a search.** In the list, `/` starts a search with an empty query. Any other single printable key starts one with that key as the query, except `j`, `k`, `m`, `i`, `r` and Space. A key with Ctrl or Alt held never starts a search.
- **Matching.** The query keeps the rules whose text contains it, ignoring case. While the query is non-empty the add row is hidden, and a query nothing matches leaves the list empty.
- **The keys while searching.**
  - Enter or ↓ ends the typing and keeps the filter. The list then has focus on the filtered rows, and Enter opens one.
  - Esc with a query clears it and stays in search.
  - Esc with an empty query ends the search.
  - Esc outside a search closes the screen.
- The same query filters whichever rule tab is showing.

### 4. A rule opened from the list

Enter on a rule row opens it in place of the screen.

**A rule the session may delete** opens as a confirmation in an error-coloured
round box. The sources are user, project, local, session and CLI argument
(flag and command rules too, today: Finding 1). The box holds, in order:
- the title `Delete allowed tool?`, `Delete ask tool?` or `Delete denied tool?`, bold, in the box's colour;
- the rule text, bold, then the rule's gloss (section 7);
- `From <source>`, dim. `<source>` is `permissionRuleSourceDisplayString`: `user settings`, `shared project settings`, `project local settings`, `current session`, `CLI argument`, `command line arguments` (flag), `command configuration`, `enterprise managed settings`;
- `Are you sure you want to delete this permission rule?`;
- a list: `Yes`, `No`.

Under the box: `Esc to cancel`.

| Answer | Effect |
|---|---|
| Yes (Enter, `1`) | the rule is deleted (section 5) and the list comes back |
| No (`2`, ↓ then Enter), Esc, `n` | nothing is deleted; the list comes back |
| `y` | nothing; the question stays |

**A managed rule** (source `policySettings`) opens as read-only details, in a
permission-coloured round box (a different colour from the delete box). It
holds:
- `Rule details`;
- the rule, its gloss and `From enterprise managed settings`;
- `This rule is configured by managed settings and cannot be modified.` and `Contact your system administrator for more information.`

There is no `Delete` and no Yes/No list, and Enter, `1`, `y` and ↓ do
nothing. Esc (or `n`) goes back to the list with the rule untouched.

**Where the list comes back.** After the details, the add-rule flow or a
workspace editor closes, the screen is rebuilt on its opening tab with the tab
row focused (Finding 2). After a delete, ↓ from the tab row lands on the rule
that followed the deleted one in that list. When the deleted rule was the
last, it lands on the one before it, and when it was the only rule, on
`Add a new rule…`.

### 5. Deleting

Yes on a deletable rule:
- **The session.** The rule's text is removed from the session's list for that kind and that source only. The same text held by another source, or as another kind, stays.
- **The settings file.** For a user, project or local rule, the rule is also removed from that one file:

  | Source | File |
  |---|---|
  | user | `$CLAUDIN_CONFIG_DIR/settings.json` |
  | project | `<project>/.claudin/settings.json` |
  | local | `<project>/.claudin/settings.local.json` |

  The other files are not touched. Other rules and other kinds in the file stay, and the kind's list may be left empty.
- **No file.** A session or CLI-argument rule leaves every file untouched, and no file is created.
- **A file that no longer holds the rule** is left as it is, and the session still drops the rule.
- **The report.** One line is added to the screen's change report: `Deleted <kind> rule <rule>`. `<kind>` is `allow`, `ask` or `deny`, and `<rule>` is the text, bold.

### 6. Adding a rule

- **The rule input.** `Add a new rule…` on a rule tab opens `PermissionRuleInput` for that tab's kind (section 8). Esc there goes back to the list with nothing added.
- **The destination.** A submitted rule goes to `AddPermissionRules` (the `ruleEditors` unit) with the same kind. It asks where to save: `Project settings (local)`, `Project settings`, `User settings`. Esc there goes back to the list with nothing added.
- **What a destination does.** The rule enters the session under that source and is written to that file (`AddPermissionRules`).
- **The report** gains `Added <kind> rule <rule>`, with `<rule>` bold.
- **Unreachable rules.** When the new rule is made unreachable by a wider rule, three more lines follow for each such rule:
  - `⚠ Warning: <rule> is blocked`, in yellow, when a deny rule makes it unreachable, or `… is shadowed` for an ask rule;
  - two spaces and the reason, dim;
  - two spaces, `Fix: ` and the fix, dim.

  The reason and the fix come from `detectUnreachableRules`. A rule nothing shadows gets no warning.

### 7. The gloss (`PermissionRuleDescription`)

One dim line, with the named part bold, or nothing:

| Rule value | Gloss |
|---|---|
| `Bash`, or Bash with empty content | `Any Bash command` |
| Bash, content ends in `:*` | `Any Bash command starting with <content without :*>` (`npm test:*` → `… starting with npm test`; a bare `:*` leaves nothing after "with") |
| Bash, any other content (`git status`, `docker *`, `echo a:* b`) | `The Bash command <content>` |
| any other tool, no content | `Any use of the <tool> tool` (MCP names too) |
| any other tool, with content (`Read(/etc/**)`, `WebFetch(domain:…)`) | nothing |

### 8. The rule input (`PermissionRuleInput`)

**Screen**, in a permission-coloured round box:
- `Add <kind> permission rule`, bold, in the box's colour;
- `Permission rules are a tool name, optionally followed by a specifier in parentheses.`;
- `e.g., WebFetch or Bash(ls:*)`, with both examples bold and ` or ` plain;
- a bordered text field whose placeholder is `Enter permission rule…`.

Under the box: `Enter to submit · Esc to cancel`. After one Ctrl-C or Ctrl-D it
reads `Press Ctrl-C again to exit` (or Ctrl-D) instead, when the input is
mounted on its own.

**Answers**:
- **Enter** trims what was typed. Empty or blank text does nothing, and the field stays open. Otherwise it calls `onSubmit(permissionRuleValueFromString(text), ruleBehavior)` once, with the kind it was opened for.
- **Esc** calls `onCancel()`, even with text typed. `n` is just text.

What the parser makes of typed text (pinned through the input):

| Typed | Rule value |
|---|---|
| `Read` | `{ toolName: 'Read' }` |
| `  Bash(ls:*)  ` | `{ toolName: 'Bash', ruleContent: 'ls:*' }` |
| `Bash(npm run build)` | `{ toolName: 'Bash', ruleContent: 'npm run build' }` |
| `WebFetch(domain:example.com)`, `Read(/etc/**)` | the tool with that content |
| `mcp__github` | `{ toolName: 'mcp__github' }` |
| `Bash()`, `Bash(*)` | `{ toolName: 'Bash' }`, the whole tool (Finding 7) |
| `Bash(echo \(hi\))` | `{ toolName: 'Bash', ruleContent: 'echo (hi)' }` |
| `Task` | `{ toolName: 'Agent' }` (the legacy name) |

### 9. Recently denied (shipped build only)

Denials exist only in a build with `TRANSCRIPT_CLASSIFIER`.
- **The list.** The tab lists each denial's display text, newest first, under `Commands recently denied by the auto mode classifier.`
- **Approving.** Enter toggles a denial's approval.
- **Retrying.** `r` toggles its retry mark (shown as ` (retry)`) and approves it. A second `r` takes the retry back but leaves the approval.
- **Marks and tabs.** A mark survives switching tabs. It does not survive opening any sub-view (Finding 3).
- **Neither saves anything.** No rule is written, the session's rules do not change, and no file is touched.

### 10. Closing (Esc), and the report

Esc on the screen (outside a search and any sub-view) calls `onExit` once:

| State | Call |
|---|---|
| at least one denial marked for retry | `onRetryDenials(<their display texts>)` first, then `onExit(undefined, { shouldQuery: true, metaMessages: [<one message>] })` |
| approvals or changes | `onExit(<lines joined by "\n">)`, no options. The first line is `Approved <d1>, <d2>` (each bold, comma-separated) when there are approvals, then each change line in the order it happened |
| nothing | `onExit('Permissions dialog dismissed', { display: 'system' })` |

**The retry message.** It is the text the model receives. It must:
- list the retried commands, comma-separated, in list order;
- tell the model it may now retry them;
- say "this command" for one and "these commands" for more.

Today it reads `Permission granted for: <commands>. You may now retry this command if you would like.`
The suite pins the command list, the `this command` / `these commands`
choice and, for the one-command case, the whole line. Without a retry
handler, the same `onExit` call still happens. With a retry, the change lines
are left out of the report (Finding 4).

**The workspace lines.**
- An added directory reports `Added directory <path> to workspace for this session`, with `<path>` bold, and enters the session under the `session` source only. Nothing is written to a file.
- A removed directory reports `Removed directory <path> from workspace`, with `<path>` bold, and leaves the session.
- Backing out of either editor changes nothing.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| A tab with no rules | only `Add a new rule…` | yes |
| More than nine rules | ten rows, the last marked `↓` | yes |
| The same rule text in two sources | two identical rows, in source order | yes |
| Deleting a rule its file no longer holds | session drops it, file unchanged | yes |
| Deleting a flag or command rule | today: the delete box, and Yes reports a deletion that did not happen (Finding 1) | the source line and Esc only |
| Blank rule text | nothing submitted | yes |
| Malformed rule text (`Bash(a`) | accepted as a tool named `Bash(a` (Finding 6) | no |
| Typing a letter on Workspace or Recently denied | an invisible search starts (Finding 8) | no |
| Opening a sub-view with denials marked | the marks are lost (Finding 3) | no |
| One Ctrl-C in the details or the input opened from the list | the hint does not appear there (Finding 9) | no |

## Security requirements

- **Managed rules cannot be deleted here.** A `policySettings` rule opens read-only. No key on that view changes the session or any file.
- **Only an explicit Yes deletes.** No, Esc, `n` and `y` leave the rule in the session and in its file.
- **A delete removes exactly one rule from exactly one place.** That is the chosen kind, the chosen source's list, and that source's file. The same text in another source or another kind stays in force. A deny rule held by both user and project settings stays denied after one of them is deleted.
- **A source with no file writes no file.**
- **An added rule keeps the kind of the tab it was added from**, through the input and the destination question. A deny-tab rule can never be saved as an allow rule.
- **Approving or retrying a denial grants nothing by itself.** No rule is added. What the model is told is Finding 5.
- **Hardening, on top of parity:**
  - a rule the session cannot delete (flag, command) must not be offered for deletion, nor reported as deleted (Finding 1);
  - malformed rule text must not be saved (Finding 6).

## Tests that pin it

- **`src/permissions/ui/rules/PermissionRuleList.characterization.test.tsx`**, 70 tests:
  - the tabs and subtitles, from initialTab and from ←/→;
  - sorting, case-only differences keeping their held order, duplicate rows, ten rows, an empty tab, Workspace, and an empty Recently denied;
  - the footers, and Ctrl-C/Ctrl-D;
  - the details for five deletable sources, three kinds, styling and the whole-tool gloss;
  - the read-only guard: policy allow and deny, the box colour, flag and command;
  - deleting from each settings file, from session and CLI argument, and from a file that lost the rule;
  - No, ↓+Enter, Esc, `y` and `n`, and where the cursor lands;
  - the exit report;
  - adding on each tab, with Esc at both steps, and the blocked, shadowed and clean warnings;
  - searching (seven cases);
  - the workspace: add, remove, back out of each, and a mixed report.
- **`src/permissions/ui/rules/PermissionRuleList.denials.characterization.test.tsx`**: under the plain runner, one test that runs the file again with `--feature=TRANSCRIPT_CLASSIFIER` (12 tests there). It covers:
  - the opening tab, focus and footer;
  - dismiss, approve, two approvals, and toggling an approval off;
  - retry with one and two commands, toggling a retry off, and a retry without a handler;
  - a mark across a tab switch;
  - an approval combined with a delete;
  - initialTab with denials present.
- **`src/permissions/ui/rules/PermissionRuleDescription.characterization.test.tsx`**, 14 tests: the gloss table, the empty `:*` case, and the shared dim style.
- **`src/permissions/ui/rules/PermissionRuleInput.characterization.test.tsx`**, 24 tests:
  - the screen for each kind, and its styling;
  - Ctrl-C/Ctrl-D;
  - ten parse cases, the kind for each tab, blank input, the typed text;
  - Esc, and `n`.
- **The rig**: `src/permissions/ui/__testutils__/ruleListRig.tsx`. It builds a session holding rules per kind and source, writes and reads the three settings files, mounts the screen through the promptFrame rig (fake terminal, app state, key bindings, an isolated config home and project), and logs `onExit` and `onRetryDenials`. The flagged child reuses `src/permissions/permissionSetup/__testutils__/shippedFlag.ts`.
- **The runs.** 109 tests under the plain runner (plus the 12 in the child), three runs in a row green.
- **Line coverage, plain run:**

  | File | Lines | Uncovered |
  |---|---|---|
  | `PermissionRuleList.tsx` | 93.6% | the retry/approve report, which the flagged child covers; the "remember" branch of adding a directory, unreachable from this screen; option building for the workspace and recent tabs, a missing-rule sort fallback, a delete with no rule selected, and a key handler that runs while a sub-view is open, none of which can be reached; compiler cache hits |
  | `PermissionRuleDescription.tsx` | 89.8% | cache hits only |
  | `PermissionRuleInput.tsx` | 99.2% | — |

  The flagged child alone reads 77.5% on `PermissionRuleList.tsx` and covers the retry and approve lines.
- **`scripts/migrations/probes/rewrite-permissions-ruleList.json`**: 40 probes, spread over the files (List 28, Description 6, Input 6). Every delete and read-only path is mutated to fail open:
  - a policy rule offered for deletion;
  - No, Esc or `n` deleting;
  - the wrong source deleted;
  - the session left holding a deleted rule;
  - deny and ask tabs showing other kinds;
  - a deny-tab rule saved as allow, in the list and in the input;
  - an approval turned into a retry;
  - a session directory filed under local settings.

  Each one turns the suites red.

  One first draft lowercased only one side of the sort comparison. Under a stable sort that is an equivalent mutant: 20,000 random lists sorted the same with and without it. It was replaced by the real case-sensitive sort, which drops the lowercasing on both sides.

**Text sent to a model.** The retry `metaMessages` line, through
`onExit(…, { shouldQuery: true })`. No snapshot or file outside this unit
pins it. `src/agent/messages/factories.ts` builds the separate
`permission_retry` message (`Allowed <commands>`) from `onRetryDenials`.

**Pinned outside the unit.** `src/__tests__/lazyToolImports.test.ts` lists
`PermissionRuleInput.tsx` among the value importers of `WebFetchTool`. If the
rewrite names the examples through `WEB_FETCH_TOOL_NAME` and `BASH_TOOL_NAME`,
which it should, drop it from that list's `current` entry.

**Inherited tests to fold in:** none listed for this unit.

**Not pinned, and why:**
- **Old behaviour that is wrong:**
  - flag and command rules being offered for deletion, and Yes on them (Finding 1). Yes also rejects a promise nobody handles, which fails a `bun test` run;
  - the screen jumping back to its opening tab (Finding 2);
  - marks lost when a sub-view opens (Finding 3);
  - change lines dropped by a retry (Finding 4);
  - malformed text accepted (Finding 6);
  - the invisible search (Finding 8).
- **Ctrl-C/Ctrl-D in the details and in an input opened from the list**: the hint never shows there today (Finding 9). The input's own hint is pinned standalone.

## Out of scope

- **The editors and their screens** (`permissions/ruleEditors`): `AddPermissionRules`, `AddWorkspaceDirectory`, `RemoveWorkspaceDirectory`, `WorkspaceTab`, `RecentDenialsTab`. Only what this screen does with their answers is in scope.
- **The rule model:** how rules are parsed, displayed and read from or written to files (`permissions/ruleModel`, `permissions/decision`). That includes leaving an empty list behind in a file, and the source names, such as `flagSettings` being shown as "command line arguments".
- **Unreachable-rule detection** (`shadowedRuleDetection`): its reason and fix text.
- **The design-system widgets.**

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Flag and command rules look deletable, and the delete lies.** The guard covers `policySettings` only. A `flagSettings` (`--settings`) or `command` rule opens the delete box. `deletePermissionRule` refuses those sources by rejecting its promise, but the screen does not wait for it: it reports `Deleted allow rule …` and returns to the list. The rule stays in force, and the rejection is only logged by the process-wide handler. The failure is closed (nothing is removed), but the user is told otherwise. | **Fix.** Show the read-only view for every source the session cannot delete (policy, flag, command), with wording that names the source. Report a delete only once it has happened. Not pinned beyond the source line and Esc. |
| 2 | **Every sub-view sends the screen back to its opening tab.** The details, the add-rule flow and the workspace editors replace the tabs, which are rebuilt afterwards on the opening tab with the tab row focused. Deleting a deny rule lands on Allow. The cursor key then points into the wrong tab's list. | **Fix** (UX). Return to the tab and row the user left. Not pinned; the deny and ask tests open on their tab. |
| 3 | **Approve and retry marks are lost when any sub-view opens**, for the same reason: the denials view is rebuilt empty. A user who marks a retry, then deletes a rule, closes with no retry. | **Fix.** Keep the marks in the screen's own state. Not pinned. |
| 4 | **A retry drops the rest of the report.** With a retry marked, `onExit` carries only the retry message, so rules deleted or added in the same visit are not reported, though they took effect. | **Fix.** Report both. Not pinned. |
| 5 | **"Approve" and "retry" grant nothing, but say they do.** They save no rule. The retry tells the model "Permission granted for: …", and the report says "Approved …". The classifier decides again when the command is retried. No bypass, but the wording overstates. | **Keep for parity** (pinned). **Track:** say what happens ("you may retry; the classifier will check it again"), or make approval add a session rule. Either is a product decision. |
| 6 | **Malformed rule text is accepted.** `Bash(a` becomes a rule for a tool named `Bash(a`. It enters the session and is written to the file, and the loader drops it on the next start. Nothing is widened, but the user believes a rule is in force. | **Fix** (hardening). Reject text the parser cannot read as a rule, keep the field open, and say why. Not pinned. |
| 7 | **`Bash()` and `Bash(*)` mean the whole tool.** Typed into the input they become the bare `Bash` rule: in the allow tab, every command. This is the parser's contract. | **Keep for parity** (pinned through the input). **Track:** a confirmation for a whole-tool allow rule. |
| 8 | **Letters on the Workspace and Recently denied tabs start a search those tabs do not show.** The footer switches to `Type to filter…`, and Esc then reaches the workspace list's own cancel, which closes with `Workspace dialog dismissed` and drops the change report. | **Fix.** Start a search only on a rule tab. Not pinned. |
| 9 | **The double-press hint never shows in the details or in the rule input opened from the list.** The screen's own Ctrl-C handler takes the key, and its footer is hidden behind the sub-view. The second press still exits. | **Fix** (cosmetic). One handler, one hint, where the user is looking. Not pinned. |
| 10 | **Adding a directory from this screen is always session-only.** The "remember" path (save to local settings) exists, but this screen never offers it. Pressing Enter on a completion reports the directory twice (an `AddWorkspaceDirectory` defect, `ruleEditors`). | **Keep for parity**: session-only is pinned. Drop the unreachable remember path, or wire it to the editor's question. The double report goes to `ruleEditors`. |
| 11 | **`y` does nothing in the delete box while `n` backs out**, because the confirmation bindings have no "yes" handler here. | **Keep for parity** (pinned). Harmless: the safe key works. |
| 12 | **Two rows with the same text cannot be told apart in the list.** The source shows only in the details. | **Track** (UX): show the source on the row. |

## Target design

- **Hand-written components**, in this repo's Ink style, with no compiler cache slots. The three export names and props stay as they are.
- **The screen as a small state machine**, the view being one of: the tabs, the details, the input, the destination, add directory, remove directory. The current tab, the cursor key and the denial marks are owned by the screen, so a sub-view returns the user to where they were (Findings 2 and 3).
- **Pure helpers, unit-tested without Ink:**
  - `rulesForTab(context, kind, query)`: the sorted, filtered rows (the add row is the view's business);
  - `deletability(source)`: `'deletable'` or `'read-only'`, read-only for policy, flag and command (Finding 1);
  - `exitReport(changes, denials, marks)`: the `onExit` arguments. Retry and changes both reported (Finding 4).
- **The delete awaits `deletePermissionRule`.** It reports only on success, and shows the error otherwise.
- **Search is a rule-tab concern** (Finding 8). The key filter (`/`, the navigation letters, no Ctrl/Alt) is one function.
- **`PermissionRuleDescription` is a pure mapping** from a rule value to `{ text, bold } | null`, rendered by one tiny component.
- **`PermissionRuleInput` validates before submitting** (Finding 6). It names its examples through `WEB_FETCH_TOOL_NAME` and `BASH_TOOL_NAME`, not the tool modules, and `lazyToolImports.test.ts` is updated to match.
- **Tests**: the characterization suites unchanged, plus unit tests for the helpers and a test for each fixed finding.
