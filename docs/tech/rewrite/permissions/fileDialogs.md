# Spec: `permissions/fileDialogs`

## Purpose

The dialogs that ask before a tool changes or reads a file. `PermissionRequest`
(see [promptFrame.md](promptFrame.md)) picks one by the request's tool:

- **the edit dialog** (`FileEditPermissionRequest`): `FileEditTool`;
- **the write dialog** (`FileWritePermissionRequest`): `FileWriteTool`;
- **the notebook dialog** (`NotebookEditPermissionRequest`): `NotebookEditTool`;
- **the filesystem dialog** (`FilesystemPermissionRequest`): `FileReadTool`, `GlobTool` and `GrepTool`.

All four render inside one shared frame (`FilePermissionDialog`), which is
also used by the sed-edit dialog of `permissions/shellDialogs`. The frame
decides which options are offered for the path, and what each answer reports
through the request's callbacks: whether the change happens, and what
"allow for this session" grants (a mode, a directory, or a rule, always for
the session only). When an IDE is connected, the edit and write dialogs send
the proposed change to it as a diff tab and take the answer from there too.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `FileEditPermissionRequest` | `(props: PermissionRequestProps) => ReactNode` | `permissions/ui/PermissionRequest.tsx`, `PermissionRequest.test.ts` |
| `FileWritePermissionRequest` | same | same |
| `NotebookEditPermissionRequest` | same | same; `src/__tests__/lazyToolImports.test.ts` lists this file as an importer of `NotebookEditTool` |
| `FilesystemPermissionRequest` | same | same |
| `FilePermissionDialog` | `<T extends ToolInput>(props: FilePermissionDialogProps<T>) => ReactNode` | the four above, `permissions/ui/SedEditPermissionRequest/SedEditPermissionRequest.tsx` |
| `FilePermissionDialogProps<T>` | `{ toolUseConfirm; toolUseContext; onDone(); onReject(); title: string; subtitle?: ReactNode; question?: string \| ReactNode; content?: ReactNode; completionType?: CompletionType; languageName?: string; path: string \| null; parseInput(input: unknown): T; operationType?: FileOperationType; ideDiffSupport?: IDEDiffSupport<T>; workerBadge: WorkerBadgeProps \| undefined }` | the same |
| `PermissionOption` | `{ type: 'accept-once' } \| { type: 'accept-session'; scope?: 'claude-folder' \| 'global-claude-folder' } \| { type: 'reject' }` | `platform/ide/ShowInIDEPrompt.tsx`, `vcs/diff/hooks/useDiffInIDE.ts` (types) |
| `PermissionOptionWithLabel` | `OptionWithDescription<string> & { option: PermissionOption }` | `platform/ide/ShowInIDEPrompt.tsx` (type) |
| `FileOperationType` | `'read' \| 'write' \| 'create'` | the unit |
| `getFilePermissionOptions` | `({ filePath, toolPermissionContext, operationType?, onRejectFeedbackChange?, onAcceptFeedbackChange?, yesInputMode?, noInputMode? }) => PermissionOptionWithLabel[]` | the unit |
| `isInClaudeFolder`, `isInGlobalClaudeFolder` | `(filePath: string) => boolean` | the unit |
| `useFilePermissionDialog`, `UseFilePermissionDialogProps`, `UseFilePermissionDialogResult`, `ToolInput` | hook and its types | the unit (`ToolInput` also by `FilesystemPermissionRequest`) |
| `PERMISSION_HANDLERS`, `PermissionHandlerParams`, `PermissionHandlerOptions` | handler table by option type | the unit |
| `FileEdit`, `IDEDiffConfig`, `IDEDiffSupport<T>`, `createSingleEditDiffConfig(filePath, oldString, newString, replaceAll?)` | the IDE diff description | the unit |
| `FileWriteToolDiff` | `({ file_path, content, fileExists, oldContent }) => ReactNode` | the write dialog |
| `NotebookEditToolDiff` | `({ notebook_path, cell_id, new_source, cell_type?, edit_mode?, verbose, width }) => ReactNode` | the notebook dialog |

Only the four dialogs, `FilePermissionDialog`, its props and the two option
types leave the unit. The rest may be reshaped.

## Observable behaviour

### 1. The answers (all four dialogs)

`INPUT` below is the request's input **as the tool's schema reads it** (for
the edit dialog, `replace_all: "true"` is reported as `true`; the filesystem
dialog reports the input as sent). Each answer reports, in this order:

| Answer | Reports |
|---|---|
| Yes (Enter on it, or `1`) | `onDone()`, then `onAllow(INPUT, [], note)` |
| the session option (`2`, or **Shift+Tab** from anywhere in the list) | `onDone()`, then `onAllow(INPUT, <grant>)` with no third argument |
| No (`3`) | `onDone()`, the caller's `onReject()`, then `onReject(note)` |
| Esc | the same as No, always with no note |
| `y`, `n`, a digit past the list | nothing |

- **Notes.** Tab on Yes or No turns that option into a text field. Its label becomes `Yes, <text>` / `No, <text>`, or the placeholder `Yes, and tell Claude what to do next` / `No, and tell Claude what to do differently` while empty. The note is trimmed; a blank note is `undefined`. Tab again closes the field. Moving the focus off an empty field closes it; a field with text stays open. A Yes note never goes with No, the session option ignores any note, and Esc drops both.
- **The hint line** under the dialog reads `Esc to cancel · Tab to amend` while the focus is on a closed Yes or No, and `Esc to cancel` otherwise.
- The dialog counts one permission prompt in the app state. Esc is not counted as an escape.
- The grant is reported, never applied: the session's mode is unchanged by the dialog.

### 2. The options and the session grant

The list is always `Yes`, a session option, `No`. Managed policy that keeps
permission rules to itself does not remove the session option. Inside means
the path (and every spelling of it, symlinks resolved) is under the session's
original directory or an added working directory.

| Path | Operation | Session option label | Grant |
|---|---|---|---|
| under `<project>/.claudin/` (case ignored) | write, create | `Yes, and allow Claude to edit its own settings for this session` | `addRules` `Edit(/.claudin/**)`, allow, `session` |
| under the config home (`CLAUDIN_CONFIG_DIR`) | write, create | the same | `addRules` `Edit(~/.claudin/**)`, allow, `session` |
| inside | write, create | `Yes, allow all edits during this session (<cycle key>)` | mode default or plan: `setMode acceptEdits` (session); any other mode: nothing |
| outside | write, create | `Yes, allow all edits in <dir>/ during this session (<cycle key>)` | default or plan: `setMode acceptEdits`, then `addDirectories [<dir path>]` (session); other modes: the `addDirectories` alone |
| inside | read | `Yes, during this session` | default or plan: `setMode acceptEdits` (session) — Finding 1 |
| outside | read | `Yes, allow reading from <dir>/ during this session` | `addRules` `Read(/<dir path>/**)` (the `//` absolute form), allow, `session` |

- `<dir>` is the last segment of the folder: the path itself when it is an existing directory, else its parent; `this directory` when that is the filesystem root. `<cycle key>` is the display of the chat mode-cycle shortcut (`shift+tab` here), bold.
- The `.claudin` rows apply only to the project root's `.claudin` (not a nested one, not `.claudin-old`, not the folder itself) and never to reads; a read there gets the read rows.
- A file reached through a symlink is placed by its link: the label and the grant name the link's folder.
- The grant comes from `generateSuggestions` (`permissions/fileRules`, section 5), recomputed by the dialog; the suggestions on the request's permission result are not used (Finding 2).

### 3. The frame

Top to bottom: the frame's title row (`<title>`, with ` · @<worker>` when a
worker badge is given), the subtitle, a symlink warning, the content, the
question, the options; then the hint line outside the frame.

- **Symlink warning** (never for a read): when the path is a symlink, `This will modify <target> (outside working directory) via a symlink` if the target is outside the shell's current directory, else `Symlink target: <target>`.
- The default question is `Do you want to proceed?`.

### 4. Per dialog

| Dialog | Title | Subtitle | Content | Question |
|---|---|---|---|---|
| edit | `Edit file` | path relative to the shell's current directory | the edit's diff in the file, with line numbers | `Do you want to make this edit to <basename>?` |
| write, file exists | `Overwrite file` | as edit | diff of the whole old file to the new content; hunks far apart are separated by a dim `...` line | `Do you want to overwrite <basename>?` |
| write, new file | `Create file` | as edit | the content, numbered; `(No content)` when empty | `Do you want to create <basename>?` |
| notebook | `Edit notebook` | none | a rounded box: the path (relative; absolute when verbose), then `<kind> for cell <cell_id>[ (<cell_type>)]`, then the cell | `Do you want to make this edit to / insert this cell into / delete this cell from <basename>?` |
| filesystem | `Read file`, or `Edit file` for a tool that is not read-only | none | `<userFacingName>(<tool's own use message>)`, indented | the default |

- **Notebook kinds**: replace (or no mode) `Replace cell contents`, with a diff of the cell's old source to the new one (`...` between far hunks); insert `Insert new cell`, the new source; delete `Delete cell`, the old source. The cell is found by id, or by `cell-N` as a zero-based index. An unknown cell, a missing notebook or one that is not JSON give an empty old source: replace then shows the new source as all-added lines, or the plain new source when the notebook could not be read.
- **Filesystem without a path**: when the tool has no path lookup or it throws, the tool-wide dialog of `permissions/toolDialogs` is shown instead.

### 5. The IDE diff (edit and write only)

When the request carries a connected MCP server named `ide`, the global
`diffTool` setting is `auto` (the default) and the path is not a notebook:

- The IDE is asked to open a diff of the path, with the whole proposed file: for an edit, the file with the edit applied (every match when `replace_all`); for a write, the content.
- The terminal shows `Opened changes in <ideName> ⧉`, the question `Do you want to make this edit to <basename>?` and the same options, with the symlink warning when there is one. The title and content are not shown.
- **IDE answers**: saved with changes, or tab closed: Yes, with the input rebuilt from the IDE's text. An edit becomes one whole-file edit (`old_string` the whole current file, `new_string` the saved text, `replace_all: false`); a write takes the saved text as `content`. Rejected: No, no note.
- **Terminal answers** report the request's own input, and the IDE tab is closed (Yes, No, Esc at once; Shift+Tab only when the dialog goes away, Finding 6).
- Notebook and filesystem requests never use the IDE.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Notebook input the schema rejects | the dialog opens with an empty path; No and Esc deny; an error is logged | open and deny: yes; allow: no (Finding 7) |
| Edit input the schema rejects | the dialog throws while rendering | no (unreachable after validation) |
| Write over a path that cannot be read for another reason than "missing" (a directory, no permission) | the dialog throws while rendering | no |
| A file at the filesystem root | the session option names `this directory/` | yes |
| The shell has moved into a subfolder | the subtitle and the symlink "outside" test follow it | yes |
| A case variant of `.claudin` | offered the own-settings option; the grant names `/.claudin/**` | yes (Finding 4) |
| The config home is not `~/.claudin` | the own-settings grant still names `~/.claudin/**` | yes (Finding 3) |

## Security requirements

- **Only an explicit choice allows.** Esc, `y`, `n`, Tab and a digit past the list never report an allow; No and Esc always reach the request's `onReject`, after the caller's `onDone` and `onReject`.
- **Yes grants nothing.** Its update list is empty in every dialog and on every IDE answer.
- **The session option grants exactly the row of section 2, and only for the session**: never a settings destination, never a mode beyond `acceptEdits`, never a rule wider than the project's `.claudin/**`, the config home pattern or the read folder.
- **The own-settings grant is offered only for writes under the project root's `.claudin` or the config home.**
- **What is allowed is what was shown**: the reported input is the parsed request input, or, from the IDE, exactly the saved text.
- Session options are offered under managed rules-only policy (pinned): they are not persisted.

## Tests that pin it

- `src/permissions/ui/FilePermissionDialog/FilePermissionDialog.characterization.test.tsx`: the option table, the grant table (by `2` and by Shift+Tab, all modes), notes and keys, symlinks, the exported helpers.
- `src/permissions/ui/FileEditPermissionRequest/FileEditPermissionRequest.characterization.test.tsx`, `.../FileWritePermissionRequest/FileWritePermissionRequest.characterization.test.tsx`, `.../NotebookEditPermissionRequest/NotebookEditPermissionRequest.characterization.test.tsx`, `.../FilesystemPermissionRequest/FilesystemPermissionRequest.characterization.test.tsx`: each dialog's screen, every answer, and the IDE path (edit, write) or its absence (notebook, filesystem).
- Rig: `src/permissions/ui/__testutils__/fileDialogsRig.tsx` (a stand-in IDE as a real MCP server over the SDK's in-memory transport; nothing else is faked).
- Routing: `src/permissions/ui/PermissionRequest.test.ts`. IDE diff hook: `src/vcs/diff/hooks/useDiffInIDE.characterization.test.tsx`.
- Break-probe: `scripts/migrations/probes/rewrite-permissions-fileDialogs.json` (40 probes over the 11 files, every allow path also mutated to fail open).
- Line coverage: 100% for the five `FilePermissionDialog/` files; 86–95% for the six dialog and diff files. The lines left are the compiler cache's "props unchanged" branches, which run only on a re-render with equal props, and the edit and write IDE adapters' "no edit came back" return, which the IDE answer never reaches (it always carries one edit).

## Out of scope

- `completionType` and `languageName` are accepted and have no observable effect: the logging they fed is gone. The rewrite may keep the props for `SedEditPermissionRequest` and ignore them.
- The IDE prompt's own layout belongs to `platform/ide/ShowInIDEPrompt.tsx`; the IDE protocol to `vcs/diff/hooks/useDiffInIDE.ts`.
- What the grants then allow is `permissions/fileRules`.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Security: a read's "Yes, during this session" inside the working directories turns on accept-edits for the session.** The label says nothing about edits. It comes from the read row of `generateSuggestions`. | **Track** with `permissions/fileRules` (the grant is computed there). Pinned until decided: a read should grant at most a read rule, or nothing inside the working directories. |
| 2 | **Security: the dialog recomputes the grant and ignores the permission result's suggestions.** Asks that deliberately carry none (an `Edit`/`Read` ask rule, a protected path such as `.git/`) still offer a session option that turns on accept-edits. Those asks still fire afterwards (fileRules), so nothing is bypassed, but the session is widened. | **Keep for parity** (pinned). Revisit with Finding 1. |
| 3 | **Security: the config-home grant names `~/.claudin/**` whatever the config home is.** With `CLAUDIN_CONFIG_DIR` elsewhere, the user approves a file there and grants edits under the home's `.claudin` instead. | **Track** with `permissions/fileRules` (whether that rule reaches the config home is decided there). Pinned. |
| 4 | **Security: the `.claudin` test ignores case.** On a case-sensitive filesystem an edit to `.CLAUDIN/x` offers the own-settings option and grants `/.claudin/**`, a different folder. On a case-insensitive one they are the same folder. | **Keep for parity** (pinned). A filesystem-aware test is a design change. |
| 5 | **The dialog writes over the request's `onAllow`** with a wrapper that reports its parsed input, on every answer. Anyone calling `onAllow` on that request later gets the dialog's input. | **Fix**: pass the input to the answer directly. Not pinned beyond the reported input. |
| 6 | **Shift+Tab with an IDE diff open leaves the tab open** until the dialog goes away; the other answers close it at once. | **Fix**: close it on every answer. Not pinned (the test accepts either). |
| 7 | **A notebook input the schema rejects** opens a dialog for an empty path (`…edit to ?`, the box showing the process directory), and Yes reports a blank input instead of the one sent. The tool then refuses the empty path, so it fails closed. | **Fix**: show the raw input and report it unchanged, or offer only No. Not pinned beyond "No and Esc deny". |
| 8 | **The symlink warning's "outside" is measured from the shell's current directory**, not the working directories: after a `cd` into a subfolder, a link to a project file reads as outside. | **Keep for parity** (pinned). Change with the wording pass. |
| 9 | **The IDE prompt asks `make this edit to` for creates and overwrites**, and drops the dialog's title. | **Keep for parity** (pinned for the edit; cosmetic). |
| 10 | **Mixed product names**: `allow Claude to edit its own settings`, `tell Claude what to do…` (promptFrame Finding 4). | **Keep for parity** (pinned). |
| 11 | **Esc drops a written note**, Yes or No. | **Keep for parity** (pinned), as in the other dialogs. |

## Target design

- **One frame component and a pure option model.** `fileOptions(path, operation, context) => { label, grant }[]` computes the three options and their grants in one place, unit-tested on the tables of section 2 without Ink. The frame only renders them and maps the chosen one to `onAllow(input, grant, note)` / `onReject(note)`.
- **No mutation of the request** (Finding 5): the answer handler receives the input to report.
- **Per-dialog parts are data**: title, subtitle, question and content per tool, plus an optional `IdeDiff` adapter (`toProposal(input)`, `fromSaved(input, text)`) for edit and write. Notebook and filesystem have none.
- **Hand-written components** in this repo's Ink style, without compiler cache slots, keeping the export names above.
- **Tests**: the characterization suites unchanged, plus unit tests of the option model.
