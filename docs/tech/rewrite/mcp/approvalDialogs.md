# Spec: `mcp/approvalDialogs`

Files: `mcp/mcpServerApproval.tsx`, `mcp/ui/MCPServerApprovalDialog.tsx`,
`mcp/ui/MCPServerMultiselectDialog.tsx`, `mcp/ui/MCPServerDialogCopy.tsx`,
`mcp/ui/MCPServerDesktopImportDialog.tsx`.

## Purpose

A project can ship a `.mcp.json`, and every server in it runs a command or
reaches a URL once it connects. This unit is where the user says yes or no to
those servers before an interactive session starts them, and where that answer
is written down so the next session does not ask again. The answer is read back
by the approval status in `mcp/core` (`getProjectMcpServerStatus`), which the
connection code consults: only an `approved` project server connects.

It also holds the checklist of `claudin mcp add-from-claude-desktop`, which
copies servers found in Claude Desktop's config into one of this project's
config scopes.

The security question for the unit: which servers the user is shown, what each
answer persists and where, and when nobody is asked at all.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `handleMcpjsonServerApprovals` | `(root: Root) => Promise<void>` | `terminal/interactiveHelpers.tsx` (interactive startup, after the trust dialog) |
| `MCPServerApprovalDialog` | component, props `{ serverName: string; onDone(): void }` | `mcpServerApproval.tsx` |
| `MCPServerMultiselectDialog` | component, props `{ serverNames: string[]; onDone(): void }` | `mcpServerApproval.tsx` |
| `MCPServerDialogCopy` | component, no props | both approval dialogs |
| `MCPServerDesktopImportDialog` | component, props `{ servers: Record<string, McpServerConfig>; scope: ConfigScope; onDone(): void }` | `platform/headless/handlers/mcp.tsx` (`mcp add-from-claude-desktop`) |

`Root` is the Ink root type (`render`, `unmount`, `waitUntilExit`). The two
approval dialogs and the import dialog expect to be rendered inside the app
state provider and the key-binding setup, as their callers do.

**What the startup caller adds.** `interactiveHelpers.tsx` calls
`handleMcpjsonServerApprovals` only when all of these hold. The conditions sit
outside this unit, and are listed because they decide whether the dialog
appears:
- the session is interactive;
- `CLAUBBIT` is not set;
- the Anthropic setup is in use (third-party providers skip it);
- no settings file has errors.

## Observable behaviour

### 1. Who is asked about (`handleMcpjsonServerApprovals`)

- **The candidates** are the servers of the `project` scope as `mcp/config`
  reads it: `.mcp.json` in the session's directory and in every directory above
  it, the nearer file winning a shared name. A file that does not parse, or an
  entry that fails the schema, contributes nothing. When `projectSettings` is
  not an enabled setting source, there are no candidates.
- **The ones asked about** are the candidates whose approval status is
  `pending`. A server already approved (listed, enable-all, bypass acceptance,
  a non-interactive session) or already rejected is never shown. The status
  rules are those of `mcp/core`.
- **The order** is that of the project scope: the farthest file's names first,
  and a name a nearer file redefines keeps its first place.
- **Policy is not applied.** A server the managed policy denies, and project
  servers while a `managed-mcp.json` has exclusive control, are still asked
  about (Findings, 4).

### 2. What happens next

- **None pending:** it returns without rendering anything, and writes nothing.
- **One pending:** it renders the single-server dialog (2) into the given root.
- **Two or more:** it renders the checklist (3) with exactly the pending names.
- In both cases the dialog is wrapped in the app state provider and the
  key-binding setup. The returned promise settles only once the dialog reports
  done. The root is not unmounted or cleared: the caller renders what comes
  next.

### 3. The single-server dialog (`MCPServerApprovalDialog`)

- **The frame.** Title `New MCP server found in .mcp.json: <name>`, the name as
  given, in the warning colour. The body is the shared copy (5), then three
  numbered answers, in this order, the first focused:
  1. `Use this and all future MCP servers in this project`
  2. `Use this MCP server`
  3. `Continue without using this MCP server`

  The hint line offers Enter to confirm and Esc to cancel.
- **Where answers go.** Every write goes to the **local** settings layer,
  `.claudin/settings.local.json` under the session's original directory. The
  user and project settings files are never written. A new file is created when
  needed. Its other keys are kept, and it is written as two-space JSON ending in
  a newline.
- **1 (and Enter on the default):** the name is appended to
  `enabledMcpjsonServers`, unless the local list already has it, and
  `enableAllProjectMcpServers: true` is set. From then on, every project server
  is approved, one added later included.
- **2 (or down and Enter):** the name is appended to `enabledMcpjsonServers`,
  unless already there. The server becomes `approved`.
- **3, Esc, or `n`:** the name is appended to `disabledMcpjsonServers`, unless
  already there. The server becomes `rejected`, and is not asked about again.
- **No answer removes a name** from the other list.
- **`onDone()`** is called exactly once per answer, after the write.
- **Keys that do nothing:** `y`, the arrows, a digit with no option. A single
  Ctrl+C neither answers nor writes, and shows `Press Ctrl-C again to exit`. A
  second one ends the process; that is the frame's behaviour, outside this unit.

### 4. The checklist (`MCPServerMultiselectDialog`)

- **The frame.** Title `<n> new MCP servers found in .mcp.json`, subtitle
  `Select any you wish to enable.`, in the warning colour. The body is the
  shared copy, then one row per name in the order given, without numbers,
  **every row ticked**. The frame's own hint line is replaced by one below the
  frame: `Space to select · Enter to confirm · Esc to reject all`.
- **Space** toggles the focused row, and the arrows move. Nothing is written
  until an answer.
- **Enter:** the ticked names are appended to `enabledMcpjsonServers` and the
  unticked ones to `disabledMcpjsonServers`, each list without repeats, in the
  local layer as in (3). A list with nothing to add is not written.
- **Esc or `n`:** every listed name is appended to `disabledMcpjsonServers`,
  whatever was ticked.
- **`onDone()`** once per answer, after the write.

### 5. The shared copy (`MCPServerDialogCopy`)

One paragraph stating that MCP servers may execute code or access system
resources, and that all tool calls require approval, with a link labelled
`MCP documentation` (Findings, 8).

### 6. The Claude Desktop import (`MCPServerDesktopImportDialog`)

- **The frame.** Title `Import MCP Servers from Claude Desktop`, in the success
  colour, subtitle `Found <n> MCP server(s) in Claude Desktop.` (singular for
  one), the line `Please select the servers you want to import:`, and one
  unnumbered row per server in the order given. The hint line below the frame
  reads `Space to select · Enter to confirm · Esc to cancel`.
- **Clashes.** After mounting, it reads every configured server, as
  `getAllMcpConfigs()` reports them. A row whose name is among them gets the
  suffix ` (already exists)`, and a warning note appears: some servers already
  exist with the same name, and if selected they are imported with a numbered
  suffix. That list holds only servers that would start, so a project server
  nobody approved yet is not a clash (Findings, 5).
- **Enter** imports the ticked servers, one after another, with
  `addMcpConfig(name, config, scope)` into the scope given. A clashing name is
  imported as `<name>_<k>`, with the smallest `k` from 1 not already taken.
  The stored entry is what `addMcpConfig` stores.
- **Then, once:** it prints `\nSuccessfully imported <k> MCP server(s) to
  <scope> config.\n` on stdout, in the success colour, when at least one was
  imported, and `\nNo servers were imported.` otherwise. It calls `onDone()`,
  then ends the process gracefully.
- **Esc, `n`, or Enter with nothing ticked:** nothing is imported. It prints
  the "No servers" line, calls `onDone()`, and ends the process.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| No `.mcp.json`, an empty one, or one that does not parse | `handleMcpjsonServerApprovals` returns at once, nothing rendered |
| A broken `.mcp.json` in the session directory, a valid one above | the servers above are asked about |
| A name with spaces or dots | shown and stored as given |
| An approved name that folds to the pending one (`my.server` for `my_server`) | not asked: the status folds names |
| The local settings file is not JSON | the answer is not written, the file is left as it was, and `onDone()` is still called. Unreachable from startup, which skips approvals when a settings file has errors |
| The repository's settings reject a server the user approved | not asked: rejection wins |
| Enter in the import before the configured servers are read | no clash is detected (Findings, 9) |
| `addMcpConfig` refuses a server during the import | Findings, 6 |

## Security requirements

**Pinned by the tests:**
- **Only pending servers are shown,** and exactly those: an approved or rejected
  server never reappears, and a pending one is never skipped while the session
  is interactive and project settings are loaded.
- **Every answer is written only to the local layer.** The user file and the
  repository's own `.claudin/settings.json` are never written.
- **Rejection is the cancel path.** Esc and `n` reject, in both dialogs; in the
  checklist Esc rejects every listed server, ticked or not. No cancel path
  approves anything, or leaves a server pending.
- **The "all future servers" switch is set only by the first answer** of the
  single dialog.
- **The step blocks startup** until the user answers.
- **A non-interactive session is never asked,** and its project servers are
  approved by `mcp/core`'s rules, not by this unit.

**Described, kept for parity:** Findings 1, 3 and 4.

## Tests that pin it

- **The characterization suite, four files, 75 tests.**
  - `src/mcp/mcpServerApproval.characterization.test.tsx`: who is asked, when nobody is, single against checklist, the ancestor walk, the policy cases, and the next startup after each answer. It drives the exported step with a real Ink root on `src/terminal/__testutils__/fakeTerminal.ts`.
  - `src/mcp/ui/MCPServerApprovalDialog.characterization.test.tsx`: the frame, every answer and its file, merging into an existing local file, the other layers, and the keys that do nothing.
  - `src/mcp/ui/MCPServerMultiselectDialog.characterization.test.tsx`: the checklist, every answer, Esc after unticking, and repeats.
  - `src/mcp/ui/MCPServerDesktopImportDialog.characterization.test.tsx`: the frame, clashes per scope, the three target scopes, numbered suffixes, the printed lines and the process end.
- **Harnesses reused:** `src/mcp/__testutils__/mcpConfigWorld.ts` (a temp tree for the settings layers, `.mcp.json` files and the managed directory) and `src/permissions/ui/__testutils__/promptFrameRig.tsx` (mounting and keys).
- **The one boundary replaced:** the graceful shutdown in the import suite, which would end the test process. Stdout is captured, not replaced.
- **Coverage** (unit-scoped run): every file at 100% of lines. Branch gaps are the memo cache hits of the compiled components.
- **No `feature()` flag** is read in the unit, so no flag-on run is needed.
- **`scripts/migrations/probes/rewrite-mcp-approvalDialogs.json`:** 40 probes over all five files. Every accept path is also mutated to fail open: a rejection that approves, a cancel that approves or leaves the server pending, a filter that lets decided servers through, a default that enables all.
- **Prompt text.** The unit sends no text to a model. No test, snapshot or generated file outside the unit pins its strings.
- **Not pinned, and why:**
  - the second Ctrl+C, which ends the process from the frame, outside the unit;
  - whether a clashing import row starts ticked, and what an import does when `addMcpConfig` refuses a server (Findings, 6 and 7: fixes);
  - which entries of the other layers are copied into the local lists (Findings, 2: a fix);
  - the documentation link's URL (Findings, 8: a fix);
  - the race of Findings, 9, which needs a timing the exports cannot produce reliably.

## Out of scope

- **The approval status** and name folding: `mcp/core`.
- **Reading `.mcp.json`,** the policy and `addMcpConfig`: `mcp/config`.
- **The startup conditions** in `interactiveHelpers.tsx`, and the trust dialog in front of this step: `permissions/sessionDialogs`.
- **Reading Claude Desktop's config** (`platform/ide/claudeDesktop.ts`), and `mcp reset-project-choices`.
- **The frame, the select and checklist components** and the key bindings: `src/terminal`.
- **Ignoring the local settings file in git,** which the settings writer does.

## Findings

1. **Security: the repository can answer for its own servers.**
   - `enabledMcpjsonServers` or `enableAllProjectMcpServers` in the checkout's `.claudin/settings.json` makes its servers `approved`, so this unit never asks about them.
   - **Decision: keep for parity**, as in `mcp/core` (finding 3) and `mcp/config` (finding 9). Teams commit the setting on purpose, and the trust dialog for the folder comes first. Pinned.
2. **Security: an answer copies the other layers' lists into the local file.**
   - The list written is the merged list of every layer plus the new name. So approving one server writes the entries of the user file, and of the repository's own settings file, into the user's untracked local file. The same goes for rejections.
   - A repository's self-approval (1) thus outlives the repository: if a later commit takes the entry out, the local copy keeps the server approved.
   - **Decision: fix.** Append to the local layer's own list only. The status after the answer is the same, since the other layers still apply. Nothing reads the copies as such. Not pinned. The suite pins what holds either way: the new name ends the list, the other files are untouched, and their entries stay in force.
3. **Security: the default answer is the broadest.**
   - In the single dialog, Enter on the focused first answer enables this server **and every future one**. In the checklist, every row starts ticked, so Enter approves everything.
   - **Decision: keep for parity, and track.** It is how users answer these dialogs today, and changing the default changes what Enter means to them. Pinned. Worth revisiting with `permissions/sessionDialogs`.
4. **The list ignores the policy.** Servers the managed policy denies, and project servers while `managed-mcp.json` has exclusive control, are asked about though they never start. The answer is stored all the same.
   - **Decision: keep for parity.** It only asks too much, never too little. Pinned.
5. **The import's clash check sees only servers that would start, in every scope.**
   - A project server nobody approved yet is not a clash. Importing the same name into the project scope then fails in `addMcpConfig` (6).
   - A name taken in another scope is renamed even when the target scope has no such name.
   - **Decision: keep for parity.** The rename avoids two scopes shadowing each other. Pinned both ways.
6. **The import stops half-way when a server is refused.**
   - When `addMcpConfig` throws (a name with a space, a policy deny, a name already in `.mcp.json`), the servers before it are kept, and the rest are skipped. Nothing is printed, `onDone` is not called, the process does not end, and the error surfaces as an unhandled rejection. A Claude Desktop server whose name has a space is enough to trigger it, unless the reader of Desktop's config renames it first.
   - **Decision: fix.** Report each refused server with its reason, import the others, print the count, and end the process. Nothing can depend on a hung dialog. Not pinned.
7. **A clashing import row starts ticked.**
   - The note says a clashing server is imported only "if selected", but its row stays ticked once the clash is shown: the clash is found after the checklist has painted with every row ticked. So Enter imports a duplicate under a numbered name.
   - **Decision: fix.** A clashing row starts unticked once the clash is known, as the note implies ("If selected"). Not pinned.
8. **The copy links to another product's documentation** (`code.claude.com`), and "all tool calls require approval" is not true under allow rules or bypass mode.
   - **Decision, link: fix.** Link to this project's MCP documentation, or drop the link. Not pinned.
   - **Decision, wording: keep for parity, and track.** The suite pins only the facts: servers may execute code or access system resources, and tool calls go through approval.
9. **Enter before the configured servers are read detects no clash.** **Decision: track.** The read is local and fast. Not pinned.

## Target design

- **A pure decision, a thin step.**
  - `pendingProjectServers()` returns the pending names in project-scope order.
  - The step renders one of two views and resolves on done. The answer writers are plain functions over a small settings port (`readLocalLists`, `writeLocalLists`), testable without Ink.
- **One answer model** for both dialogs: `{ approve: string[]; reject: string[]; enableAll: boolean }`, applied by a single writer. Each list is de-duplicated, and each layer's own list is used (Findings, 2).
- **The import** is a pure planner (names, existing names, selection → `{ name, finalName }[]`) and an executor. The executor collects per-server failures, and the view prints one summary and ends the process once (Findings, 6). Clashing rows are deselected once the existing names arrive (Findings, 7).
- **The copy** is one component with the project's own link.
- **Types.** An explicit answer union, no `any`, and props types exported for the callers.

## Outcome

Rewritten per method on 2026-10-05.

- **Code.** The five files are plain hand-written React over three modules in `src/mcp/approval/`:
  - `answer.ts`, the one answer model and its writer over a `readLocalLists`/`writeLocalLists` port;
  - `pending.ts`, `pendingProjectServers` with its dependencies injected;
  - `desktopImport.ts`, the import planner and executor.

  The four characterization suites pass unchanged.
- **Fixes, each with a test** (`approval/approval.fixes.test.ts`, `ui/approvalDialogs.fixes.test.tsx`).
  - **2.** An answer appends to the local file's own list only, so a repository's self-approval stops counting once a later commit removes it.
  - **6.** A refused server is reported on stderr with its reason, the others are imported, the count is printed, and the process ends with code 1.
  - **7.** Clashing rows are unticked once the clashes are known; the user's other ticks are kept.
  - **8 (link).** The copy links to `https://www.claudiolabs.ai/docs/mcp`.
- **Also.** Each dialog answers once: a second key after the answer does nothing (three tests). An import that repeats a name renames each repeat (`github_1`, then `github_1_1`).
- **Kept.** Findings 1, 3, 4, 5, the wording of 8, and 9; 3 and 9 stay tracked.
- **Probes.** 67 in `rewrite-mcp-approvalDialogs.json`, every reject, cancel and default path mutated to fail open; proved in a worktree of the branch.
- **Residue, reviewed.** 4 lines of Claude Code remain: two settings field names in `answer.ts` (`enabledMcpjsonServers`, `disabledMcpjsonServers`), and two key-hint lines in the import dialog's byline.
