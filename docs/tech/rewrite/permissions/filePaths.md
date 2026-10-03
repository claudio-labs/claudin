# Spec: `permissions/filePaths`

Five files:
- `src/permissions/pathValidation.ts`;
- `src/permissions/filePermissions/internalPaths.ts`;
- `src/permissions/filePermissions/dangerousPaths.ts`;
- `src/permissions/filePermissions/workingDirs.ts`;
- `src/permissions/filePermissions/pathCase.ts`.

The last four sit behind the `src/permissions/filePermissions.ts` barrel, which
is this project's own and keeps every name it exports. `pathValidation.ts` has
no barrel.

## Purpose

This unit decides, for a filesystem path, whether the agent may touch it
without asking the user. It holds four parts:
- **Shell path validation.** It turns a path named in a shell command into a
  verdict. This covers quotes, `~`, expansion syntax, globs and symlinks, then
  the rules, the protected paths, the working directories and the sandbox
  write allowlist.
- **The working directories.** The session's original cwd plus the
  directories added with `--add-dir` or `/add-dir`. Containment is checked
  lexically, or across every symlink form of the path.
- **The protected paths.** These are never auto-edited: version-control, IDE
  and agent config directories, shell startup files, the settings files, and
  paths shaped to defeat string checks on Windows.
- **The harness's own directories.** Plans, scratchpad, memory, session data,
  tasks, teams and bundled skill files. The agent may write or read them
  without a prompt.

The Bash and PowerShell tools call it for every path a command names. The file
tools reach the same predicates through `readWriteChecks.ts` (unit
`permissions/fileRules`). The `/cd` and `/add-dir` commands, the settings-edit
validator, the permission dialog and the memory attachments use the
containment and settings predicates.

## Public contract

Every export keeps its name and signature. Paths in "Used by" are under `src/`.
Names marked "barrel" are re-exported by `permissions/filePermissions.ts`, and
callers import them from there.

| Export | Signature | Used by |
|---|---|---|
| `FileOperationType` (type) | `'read' \| 'write' \| 'create'` | `tools/BashTool/pathValidation.ts` |
| `PathCheckResult` (type) | `{ allowed: boolean; decisionReason?: PermissionDecisionReason }` | this file |
| `ResolvedPathCheckResult` (type) | `PathCheckResult & { resolvedPath: string }` | this file |
| `formatDirectoryList` | `(directories: string[]) => string` | `tools/BashTool/pathValidation.ts`, `tools/PowerShellTool/pathValidation/statementConstraints.ts` |
| `getGlobBaseDirectory` | `(path: string) => string` | this file |
| `expandTilde` | `(path: string) => string` | `tools/BashTool/pathValidation.ts`, `tools/BashTool/toolRedirect.ts`, `plugins/zipCache.ts`, `plugins/pluginDirectories.ts` |
| `isPathInSandboxWriteAllowlist` | `(resolvedPath: string) => boolean` | `tools/PowerShellTool/pathValidation/pathAllowlist.ts` |
| `isPathAllowed` | `(resolvedPath: string, context: ToolPermissionContext, operationType: FileOperationType, precomputedPathsToCheck?: readonly string[]) => PathCheckResult` | this file |
| `validateGlobPattern` | `(cleanPath: string, cwd: string, toolPermissionContext: ToolPermissionContext, operationType: FileOperationType) => ResolvedPathCheckResult` | this file |
| `isDangerousRemovalPath` | `(resolvedPath: string) => boolean` | `tools/BashTool/pathValidation.ts`, `tools/PowerShellTool/pathValidation/{statementConstraints,dangerousRemoval}.ts` |
| `validatePath` | `(path: string, cwd: string, toolPermissionContext: ToolPermissionContext, operationType: FileOperationType) => ResolvedPathCheckResult` | `tools/BashTool/pathValidation.ts` |
| `getClaudeSkillScope` (`internalPaths.ts`) | `(filePath: string) => { skillName: string; pattern: string } \| null` | `permissions/filePermissions/readWriteChecks.ts` |
| `isClaudeSettingsPath` (barrel) | `(filePath: string) => boolean` | `platform/settings/validateEditTool.ts` |
| `isClaudeConfigFilePath` (`internalPaths.ts`) | `(filePath: string) => boolean` | `dangerousPaths.ts` |
| `checkEditableInternalPath` (barrel) | `(absolutePath: string, input: { [key: string]: unknown }) => PermissionResult` | `readWriteChecks.ts`, `tools/PowerShellTool/pathValidation/pathAllowlist.ts`, `permissions/planFilePermission.test.ts` |
| `checkReadableInternalPath` (barrel) | `(absolutePath: string, input: { [key: string]: unknown }) => PermissionResult` | `readWriteChecks.ts`, `pathAllowlist.ts` |
| `hasSuspiciousWindowsPathPattern` (`dangerousPaths.ts`) | `(path: string) => boolean` | `readWriteChecks.ts` |
| `checkPathSafetyForAutoEdit` (barrel) | `(path: string, precomputedPathsToCheck?: readonly string[]) => { safe: true } \| { safe: false; message: string; classifierApprovable: boolean }` | `readWriteChecks.ts`, `pathAllowlist.ts` |
| `allWorkingDirectories` (barrel) | `(context: ToolPermissionContext) => Set<string>` | `tools/BashTool/pathValidation.ts`, `statementConstraints.ts`, `commands/add-dir/validation.ts` |
| `pathInAllowedWorkingPath` (barrel) | `(path: string, toolPermissionContext: ToolPermissionContext, precomputedPathsToCheck?: readonly string[]) => boolean` | `readWriteChecks.ts`, `pathAllowlist.ts`, `tools/FileReadTool/FileReadTool.ts`, `tools/BashTool/utils.ts`, `tools/BashTool/creditShownFiles.ts`, `permissions/ui/FilePermissionDialog/permissionOptions.tsx`, `agent/attachments/memory.ts` |
| `pathInWorkingPath` (barrel) | `(path: string, workingPath: string) => boolean` | `commands/cd/cd.ts`, `commands/add-dir/validation.ts`, `memory/instructions/claudemd/parsing.ts` |
| `normalizeCaseForComparison` (barrel) | `(path: string) => string` | `permissions/ui/FilePermissionDialog/permissionOptions.tsx` |

`src/__tests__/barrelSurface.test.ts` pins the barrel's export list.

**What the unit reads.** Nothing is cached by the unit except the resolved
forms of working directories and of sandbox allow/deny entries. Those are
cached per path string for the life of the process. Every other location is
read from its owner at each call:
- the session's original cwd, current cwd and session id (`platform/bootstrap/state`);
- the plans directory (`getPlansDirectory`) and the scratchpad (`getScratchpadDir`, `isScratchpadEnabled`);
- auto memory (`getAutoMemPath`, `hasAutoMemPathOverride`), agent memory (`isAgentMemoryPath`) and session memory (`getSessionMemoryDir`);
- the sessions project directory (`getProjectDir`), tool results (`getToolResultsDir`), the per-project temp dir (`getProjectTempDir`), the bundled skills root (`getBundledSkillsRoot`) and the config home (`getClaudinConfigHomeDir`);
- each settings source's file path (`getSettingsFilePathForSource`);
- the platform (`getPlatform`), UNC detection (`containsVulnerableUncPath`, which only fires on `windows`), symlink resolution (`getPathsForPermissionCheck`, `safeResolvePath`) and the OS sandbox (`SandboxManager`).

## Observable behaviour

### 1. Case folding: `normalizeCaseForComparison(path)`

It returns the path lower-cased, letters beyond ASCII included. The result is
the same on every platform, and separators are left alone.

### 2. Working directories

- **`allWorkingDirectories(context)`.** It returns the original cwd, then every
  key of `context.additionalWorkingDirectories`, in insertion order, without
  duplicates. The keys are taken as given (not resolved), and the map's values
  are ignored. A later change of the current cwd does not change the set.
- **`pathInWorkingPath(path, workingPath)`.** This is lexical containment, and
  symlinks are never followed.
  - Both sides are made absolute first. `~` and `~/…` become the home
    directory, a relative path is taken from the current cwd, and `.`, `..`
    and repeated separators are applied.
  - On both sides, `/private/tmp` (alone or followed by `/`) is read as
    `/tmp`, and `/private/var/` as `/var/`. `/private/var` with no slash after
    it, `/private/tmpx` and `/private/varx` are not mapped.
  - The comparison ignores case on every platform.
  - It is true for the directory itself (with or without a trailing slash) and
    for anything below it. It is false for a sibling, a parent, a name that only
    shares the prefix (`/srv/repo-evil` against `/srv/repo`), and anything a
    `..` carries out. The working path `/` contains every absolute path.
  - `~user` is not expanded: it is an ordinary relative name under the cwd.
- **`pathInAllowedWorkingPath(path, context, forms?)`.** It is true only when
  **every form** of the path lies inside **some form** of some working directory.
  - **The path's forms.** By default these are the path as given (with `~`
    expanded), every hop of a symlink chain, and its final target. For a path
    that does not exist yet, the forms add the real location of its deepest
    existing ancestor, with the rest appended, and a dangling symlink's
    target. A caller may pass `forms` instead, and then the path itself is not
    resolved at all.
  - **A working directory's forms.** Its path and its symlink-resolved
    targets.
  - So it is refused when the path is outside every working directory, when a
    `..` carries it out, when it is a file or directory symlink (live,
    dangling, relative or chained) whose target is outside, and when it is a
    link outside pointing in. A symlink that stays inside is allowed.
  - A working directory given as a symlink covers both spellings. A working
    directory given by its real path does not cover a path spelled through a
    link to it.
  - A spelling of a working directory in another case is allowed when nothing
    exists there (finding 2).

### 3. Protected paths

- **`hasSuspiciousWindowsPathPattern(path)`** is true when the string has any of
  these shapes, on every platform unless noted:
  - **an alternate data stream**: a `:` at index 2 or later. This is checked on
    `windows` and `wsl` only, so `C:\…` itself passes;
  - **an 8.3 short name**: `~` followed by a digit;
  - **a long-path or device prefix**: `\\?\`, `\\.\`, `//?/` or `//./`;
  - **a trailing dot or whitespace** at the end of the string;
  - **a DOS device suffix**: `.CON`, `.PRN`, `.AUX`, `.NUL`, `.COM1`–`.COM9` or
    `.LPT1`–`.LPT9` at the end, in any case (`.COM0` and `.CONX` pass, as does a
    bare `CON`);
  - **a whole path component of three or more dots**, between separators or at
    either end. Dots inside a name pass (`[...slug]`, `...b`);
  - **a UNC path**, on `windows` only.
- **`isClaudeSettingsPath(path)`.** The path is made absolute as in §2, so `./`,
  `..` and a relative path are applied first, and it is compared in any case.
  It is true for:
  - any path ending in `/.claudin/settings.json` or
    `/.claudin/settings.local.json`, in any project;
  - the user settings file in the config home: `settings.json`, or
    `cowork_settings.json` while cowork plugins are on (`--cowork` or
    `CLAUDE_CODE_USE_COWORK_PLUGINS`);
  - the managed settings file;
  - the file given with `--settings`.

  It is false for `.claudin/settings.json.bak`, a `settings.json` elsewhere, and
  the legacy `.claude/settings.json`, which the protected-directory rule covers
  instead.
- **`isClaudeConfigFilePath(path)`.** True for a settings path, and for the
  original cwd's `.claudin/commands`, `.claudin/agents` and `.claudin/skills`
  (each directory itself and anything below it, compared as in §2). Other
  `.claudin` entries (hooks, rules) and other projects' directories are false.
- **`checkPathSafetyForAutoEdit(path, forms?)`** returns `{ safe: true }` or a
  refusal. It checks every form of the path (as in §2, or `forms` instead), and
  the first matching kind below wins. The message always names `path` as
  given.

  | Kind | When any form… | `classifierApprovable` | The message states |
  |---|---|---|---|
  | Windows pattern | has a suspicious Windows pattern | `false` | the agent asked to write to the path; it holds a suspicious Windows path pattern; manual approval is required |
  | config | is a settings path or a config file of this project | `true` | the agent asked to write to the path; it has not been granted yet |
  | sensitive | has a protected directory as a component, has a protected file name, or starts with `\\` or `//` | `true` | the agent asked to edit the path; it is a sensitive file |

  - **Protected directories**: `.git`, `.vscode`, `.idea`, `.claude` and
    `.claudin`, as any component, at any depth, in any case. There is one
    exemption: a `.claudin` component directly followed by `worktrees` (in any
    case) is skipped. Every later component of the same path is still checked,
    so a `.claudin`, `.git` or protected file inside a worktree is still caught.
    `.claude/worktrees` gets no such exemption.
  - **Protected file names** (the last component, in any case): `.gitconfig`,
    `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
    `.profile`, `.ripgreprc`, `.mcp.json` and `.claude.json`. Look-alikes pass
    (finding 3).
  - `~` is expanded, so `~/.bashrc` is sensitive and `~/.claudin/settings.json`
    is config.
  - A UNC path is sensitive off Windows and a Windows pattern on Windows.

### 4. The harness's own directories

Both checks take an absolute path, apply `.` and `..` to it, and compare it as
text. They never resolve symlinks (finding 1). On a match they return
`{ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason } }`,
where `updatedInput` is the very object passed in. Otherwise they return
`{ behavior: 'passthrough', message: '' }`. Each reason names the kind of file
and the operation ("writing" or "reading"). The suite pins those two facts, not
the sentences.

- **`checkEditableInternalPath(path, input)`.** It opens these for writing, in
  this order:

  | Opens | Exactly | Reason names |
  |---|---|---|
  | plan files | a `.md` file directly in `getPlansDirectory()`: not a subdirectory, not another extension, not the directory itself | plan files |
  | the scratchpad | `getScratchpadDir()` and anything below it, unless `CLAUDIN_SCRATCHPAD` is `0`, `false`, `no` or `off` | scratchpad |
  | agent memory | anything `isAgentMemoryPath` accepts: `<memory base>/agent-memory/`, `<cwd>/.claudin/agent-memory/`, and `<cwd>/.claudin/agent-memory-local/` (or, under `CLAUDE_CODE_REMOTE_MEMORY_DIR`, `<mount>/projects/…/agent-memory-local/`) | agent memory |
  | auto memory | anything below `getAutoMemPath()`, case-sensitively, **only when no valid `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is set** (an invalid one, such as a relative path, does not count) | auto memory |
  | the preview launch config | exactly `<original cwd>/.claudin/launch.json`, in any case | the preview launch config |

  Session memory, the project directory, tool results, the temp dir, tasks,
  teams and bundled skills are read-only: they pass through here.
- **`checkReadableInternalPath(path, input)`.** It opens these for reading, in
  this order. The first match gives the reason.

  | Opens | Exactly |
  |---|---|
  | session memory | below `getSessionMemoryDir()` (keyed on the **current** cwd) |
  | the project directory | `getProjectDir(current cwd)` itself and anything below it, but not a sibling sharing its prefix |
  | plan files | as for writing |
  | tool results | `getToolResultsDir()` (keyed on the **original** cwd) itself and anything below it |
  | the scratchpad | as for writing, killswitch included |
  | the project temp dir | anything below `getProjectTempDir()`, whichever session wrote it |
  | agent memory | as for writing |
  | auto memory | below `getAutoMemPath()`, override or not |
  | tasks | `<config home>/tasks` itself and anything below it |
  | teams | `<config home>/teams` itself and anything below it |
  | bundled skill files | anything below `getBundledSkillsRoot()` (not the root itself) |

  Outside a repository, auto memory lives under the project directory, so it
  is read with the project-directory reason. A `..` that leaves one of these
  directories is judged by where it lands.
- **`getClaudeSkillScope(path)`.** The path is made absolute as in §2. It returns
  a scope when the path lies **inside** a skill directory of
  `<original cwd>/.claudin/skills/` or of `<config home>/skills/`:
  - `skillName` is the first component below `skills/`. The directory is
    matched in any case, and the name keeps its own case;
  - `pattern` is `/.claudin/skills/<name>/**` for the project, and
    `~/.claudin/skills/<name>/**` for the config home, whatever the config home
    is (finding 4).

  It returns `null` for:
  - a file directly under `skills/`, the skill directory itself, or `skills/`;
  - a name containing `..`, `*`, `?`, `[` or `]`;
  - anything outside those two directories.

### 5. Shell path validation (`pathValidation.ts`)

- **`formatDirectoryList(dirs)`.** Each directory is wrapped in single quotes and
  joined with `, `. Past five entries it lists the first five, then
  `, and N more`. An empty list gives `''`.
- **`getGlobBaseDirectory(path)`.** A path without `*`, `?`, `[`, `]`, `{` or `}`
  is returned unchanged. Otherwise it returns the text before the last
  separator that precedes the first such character:
  - `/` when that separator is the leading one;
  - `.` when there is no separator.

  Only `/` counts as a separator, except on `windows`, where `\` counts too.
- **`expandTilde(path)`.** `~` and `~/…` become the home directory (and `~\…`
  too, when the process runs on win32). Anything else (`~user`, `~+`, `~-`,
  `~1`, a `~` inside the path) is returned unchanged.
- **`isDangerousRemovalPath(path)`** (the `rm`/`Remove-Item` guard). Runs of
  `/` and `\` are collapsed to one `/` first. It is true for:
  - `*` and anything ending in `/*`;
  - `/`;
  - a drive root (`C:`, `C:\`, `c:/`);
  - the home directory, with or without a trailing slash;
  - a direct child of `/` (`/usr`, `/tmp/`, `/etc//`);
  - a direct child of a drive root (`C:\Windows`, `C:\\Windows`, `D:/Users/`).

  Deeper paths, relative names, `.` and `''` are false.
- **`isPathInSandboxWriteAllowlist(path)`.** False while the OS sandbox is off.
  Otherwise it is true only when every form of the path (as in §2) lies inside
  a form of some `allowOnly` entry and inside no form of any `denyWithinAllow`
  entry. Entries that are symlinks cover their targets. An empty allow list
  allows nothing.
- **`isPathAllowed(path, context, op, forms?)`.** `op` `read` checks `Read` rules.
  `write` and `create` check `Edit` rules and behave the same. The verdicts,
  by precedence:
  1. **A deny rule matches**: `{ allowed: false, decisionReason: { type: 'rule', rule } }`.
     This wins over everything below, the harness directories included.
  2. **(write/create) A harness directory opens it** (§4, editable):
     `{ allowed: true, decisionReason }` with the carve-out's reason, in any
     mode. This comes before the protected-path check, so the session's plan
     file is writable although `.claudin` is protected.
  3. **(write/create) The path is protected** (§3):
     `{ allowed: false, decisionReason: { type: 'safetyCheck', reason: message, classifierApprovable } }`.
     This holds in `acceptEdits` and against an allow rule.
  4. **Inside a working directory** (§2, with `forms`):
     - a read gives `{ allowed: true }` with no reason;
     - a write or create gives `{ allowed: true }` only in `acceptEdits` mode.
       In `default`, `plan`, `dontAsk` and `bypassPermissions` it falls through.
  5. **(read) A harness directory opens it** (§4, readable): allowed with that
     reason.
  6. **(write/create, outside every working directory) The sandbox write
     allowlist holds it**: `{ allowed: true, decisionReason: { type: 'other', reason } }`.
     The reason names the sandbox write allowlist. Inside a working directory
     the allowlist is ignored, so it never lifts the `acceptEdits` gate. It
     never opens reads, and never lifts step 3.
  7. **An allow rule matches**: `{ allowed: true, decisionReason: { type: 'rule', rule } }`.
  8. **Otherwise**: `{ allowed: false }`, with no reason.

  `forms` replaces the resolution of the path in steps 3, 4 and 6.
- **`validateGlobPattern(glob, cwd, context, op)`.**
  - **A glob containing a `..` component** is resolved whole: `resolve(cwd, glob)`,
    glob characters kept, then symlink-resolved when it exists.
  - **Any other glob** is judged at its base directory (`getGlobBaseDirectory`),
    resolved against `cwd` and then through symlinks.

  It returns `isPathAllowed`'s verdict with `resolvedPath` set to the path it
  judged. So a base directory that links out is refused at its real target.
- **`validatePath(path, cwd, context, op)`.** The steps, in order:
  1. One `'` or `"` is stripped from the start and one from the end,
     independently. Then `~` and `~/` are expanded. The result is the
     *clean path*.
  2. **Refusals that need a human** return
     `{ allowed: false, resolvedPath: <clean path>, decisionReason: { type: 'other', reason } }`.
     The first that applies wins:

     | Refused | Reason names |
     |---|---|
     | a UNC path (on `windows` only) | UNC network paths need manual approval |
     | a clean path still starting with `~` (`~user`, `~+`, `~-`, `~N`) | tilde expansion variants need manual approval |
     | any `$` or `%` anywhere, or a leading `=` (zsh) | shell expansion syntax needs manual approval |
     | a glob character, for `write` or `create` | globs are not allowed in writes; give an exact file path |

     An `=` that is not leading is fine. A lone `%` in a file name is refused
     too.
  3. **A glob for `read`** goes to `validateGlobPattern`.
  4. **Anything else** is resolved against `cwd` (the argument, not the session
     cwd), then through symlinks when the path exists. Special files (FIFOs,
     sockets, devices) and UNC paths are not resolved. The verdict is
     `isPathAllowed`'s. When resolution succeeded, the canonical path is its
     only form. The result carries `resolvedPath`, so a symlink is reported,
     and judged, at its target. A dangling symlink, or a new file under a
     linked directory, is judged at the link with all its forms.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `pathInWorkingPath` with a relative path or relative working path | resolved against the current cwd |
| a working directory that is later re-pointed (a symlink retargeted mid-session) | the first resolution of that path string is kept for the process. Not pinned |
| `pathInAllowedWorkingPath` with `forms` that omits the escape | allowed: the caller's list is trusted |
| `pathInAllowedWorkingPath` with an empty `forms` | allowed (finding 5). Not pinned |
| `checkPathSafetyForAutoEdit` with `forms` | the forms replace the path for every check, and the message still names the path |
| `validatePath('""q.txt""')` | only the outer quotes go, so the quoted name `"q.txt"` is resolved under `cwd` |
| `validatePath` off Windows on `//server/share/x` | an ordinary path outside the working dirs: `{ allowed: false }`, no reason |
| session memory and the project directory after a `cd` in Bash | they follow the current cwd. Tool results and the temp dir stay on the original cwd |
| auto memory outside a repository | read with the project-directory reason, written with the auto-memory reason |
| a planted `.claudin` symlink that would carry the plans directory out of the project | the plans owner falls back to `<config home>/plans`. Only that directory is writable as plans |
| `getBundledSkillsRoot()` under `bun test` | needs `MACRO.VERSION`, which only the build inlines. Any read that misses every earlier carve-out reaches it. The suites define it |
| Windows path semantics (drive letters, `\` separators) on a POSIX host | handled only where the code inspects strings: §3 patterns, removal paths, glob bases, UNC. Containment of `C:\…` paths is not reachable on POSIX. Not pinned |
| `expandTilde('~\\x')` | expanded only when the process runs on win32. Not reachable in the suite |

## Security requirements

- **Fail toward asking.** Every refusal in §3 and §5 stays a refusal: the four
  human-approval refusals of `validatePath`, deny rules, protected paths, the
  `acceptEdits` gate, and "outside every working directory". The suite and the
  probes cover each. A new check may add refusals. It must not turn one into an
  allow.
- **Deny before allow.** A deny rule beats the harness directories, the working
  directories, the sandbox allowlist and allow rules.
- **Symlinks are followed for containment and protection.** Every form of a
  path must be inside a working directory, and none may be protected, for live,
  dangling, chained, relative and parent-directory links alike. The one
  documented exception is the harness carve-outs (finding 1).
- **Windows patterns are never classifier-approvable.** The other two refusal
  kinds are.
- **Case-insensitive protection.** Protected directories, files, settings paths
  and config directories match in any case, on every platform.
- **No expansion the shell would do differently.** `~user`, `~+`, `~-`, `$…`,
  `%…%` and a leading `=` are never resolved by the validator. They go to a
  human.
- **No filesystem access for UNC paths.** UNC-shaped paths are never passed to
  `lstat` or `realpath`, so validation cannot trigger a network request.
- **The auto memory write carve-out is withheld** under a valid memory override.

## Tests that pin it

- `src/permissions/filePaths.workingDirs.characterization.test.ts`: case
  folding, the working-directory set, lexical containment and symlink-aware
  containment (55 tests).
- `src/permissions/filePaths.dangerous.characterization.test.ts`: Windows
  patterns per platform, settings and config predicates, and the auto-edit
  safety check, through symlinks too (103 tests).
- `src/permissions/filePaths.internal.characterization.test.ts`: the editable
  and readable carve-outs and their boundaries, the overrides and killswitch,
  the symlink parity cases and the skill scope (92 tests).
- `src/permissions/filePaths.validation.characterization.test.ts`: everything
  in `pathValidation.ts`, the sandbox allowlist included (133 tests).
- `src/permissions/__testutils__/filePathsLab.ts`: the temp-root harness the
  four suites share.
- `scripts/migrations/probes/rewrite-permissions-filePaths.json`: 40 probes
  across the five files (16 in `pathValidation.ts`, 10 in `dangerousPaths.ts`,
  9 in `internalPaths.ts`, 4 in `workingDirs.ts`, 1 in `pathCase.ts`). 33 of
  them sit on a refusal or a carve-out boundary. Each turns the suites red.
- **Exercising the unit through its callers:**
  - `src/permissions/filePermissions.test.ts` (the `fileRules` half, kept);
  - `planFilePermission.test.ts`, `checkBatchReadPermission.test.ts` and `checkBatchWritePermission.test.ts`;
  - `tools/BashTool/pathValidation.test.ts` and `tools/PowerShellTool/pathValidation.test.ts`;
  - `src/__tests__/barrelSurface.test.ts`.

**The inherited test, folded in.** `phase-3.md` names
`src/permissions/filePermissions.test.ts`. `provenance --file` found 2 Claude
Code lines (its context helper) and 22 openclaude lines (its `pathInWorkingPath`
block). The block is covered by the working-dirs suite and was deleted, and the
helper was rewritten. The rest is this project's own and stays: it pins the
`fileRules` exports, and it pins `allWorkingDirectories`,
`pathInAllowedWorkingPath` and `checkPathSafetyForAutoEdit`, which the new
suites also cover. The file now reads 0 inherited lines.

**Mocks.** Only the OS sandbox: `SandboxManager.isSandboxingEnabled` and
`getFsWriteConfig` are spied in the sandbox-allowlist tests. Everything else
runs against real directories and symlinks under a fresh temp root. The
platform is switched through `getPlatform`'s memo. `~` is checked against the
real home, read-only, because Bun's `os.homedir()` ignores a runtime `HOME`.

**Text pinned outside the unit.** None. No test, snapshot or generated file
outside the unit pins the unit's messages byte for byte.
`tools/PowerShellTool/pathValidation.test.ts` matches the "Glob patterns are
not allowed in write" message, but that is PowerShell's own copy, in
`pathAllowlist.ts`.

## Out of scope

- **The rule patterns and the read/write decisions of the file tools.**
  `matchingRuleForInput` and `checkWritePermissionForTool` belong to
  `permissions/fileRules`.
- **Where each harness directory lives.** That is decided by its owner (plans,
  scratchpad, memory, sessions, temp dir, bundled skills). This unit only
  decides which of them are open, for which operation, and how tightly.
- **Changing the carve-outs to follow symlinks** (finding 1). It is a
  behaviour change, tracked separately.
- Nothing is dropped.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **The harness carve-outs compare text and follow symlinks.** This is the team bug memory `memory-carveout-follows-symlinks`, and **this unit is where it lives**. `checkEditableInternalPath` and `checkReadableInternalPath` open a path by its spelling. A symlink placed inside an open directory lets the agent read or write its target with no prompt, in any mode. Several of those directories can come from a cloned repository: project-local auto memory (`<repo>/.claudin/memory/`), project and local agent memory, the default plans directory (`.claudin/plans/`) and `.claudin/launch.json`. Through the file tools (`readWriteChecks.ts`, unit `fileRules`) every link qualifies. Through the shell route, `validatePath` canonicalizes a link to an existing file first, so the carve-out does not apply there. A **dangling** link cannot be canonicalized, though, so a Bash redirect through it is allowed and creates the target outside the project (for example a link to an absent `~/.ssh/authorized_keys`). The suites pin both routes. | **Keep for parity**, pinned. The fix is not pure hardening. It must compare real paths on both sides, because `/tmp`, macOS `/var` and symlinked homes resolve elsewhere, and a user who keeps a symlinked memory file would start seeing prompts (`memory/memdir.md`, finding 1). Track it as the first behaviour change after this unit lands: a carve-out applies only when every form of the path lies inside the real carve-out directory. Apply that to the shell route and the file tools together. |
| 2 | **Containment ignores case on case-sensitive filesystems.** On Linux, `/home/u/PROJ` is treated as inside the working directory `/home/u/proj`, a different directory. Reads there need no prompt, and writes need none in `acceptEdits`. | **Keep for parity**, pinned. The same folding is what makes the protected-path checks safe on macOS and Windows. Splitting it (strict on the allow side, folded on the deny side) needs a design, and the exposure needs a sibling directory that differs only in case. Route it to the permissions follow-up. |
| 3 | **The protected file list misses files that run code.** `.zshenv`, `.bash_login`, `.zlogin`, `.envrc` (direnv) and `.npmrc` (lifecycle scripts) are auto-edited in `acceptEdits` inside the working directory. | **Keep for parity**, pinned. Adding entries makes `acceptEdits` prompt, which users notice. Decide the list separately. |
| 4 | **The skill scope names `~/.claudin/skills/…` for the config home, whatever the config home is.** Under a custom `CLAUDIN_CONFIG_DIR` the suggested session rule may never match the file it was offered for. | **Keep for parity**, pinned. The spelling follows the global `~/.claudin/**` rule convention, which `fileRules` interprets. Route it there. |
| 5 | **An empty `forms` list makes `pathInAllowedWorkingPath` true.** No caller passes one today: each passes the canonical path or nothing. | **Fix** (hardening): treat an empty list as "not inside". Legitimate use never notices. Not pinned. |

## Target design

- **`pathCase.ts`** stays a one-function module. Name the policy in its doc:
  fold on every platform, for comparison only.
- **`workingDirs.ts`** has two layers:
  - a pure lexical predicate (absolutize, map the macOS `/private` aliases, fold
    case, compare by path segments, not by string prefix);
  - a symlink-aware predicate over a `PathForms` value (the path and every form
    it reaches), with the working directories' forms cached per path string.

  `allWorkingDirectories` stays trivial.
- **`dangerousPaths.ts`** holds the two lists (protected directories, protected
  file names) and the Windows-pattern table as data. Each pattern entry gets a
  name and a platform scope. The safety check returns a discriminated result
  with an explicit `kind` (`'windowsPattern' | 'config' | 'sensitive'`)
  alongside the current fields, so callers stop reading
  `classifierApprovable` to tell the kinds apart. The message wording lives in
  one table beside it.
- **`internalPaths.ts`** holds the carve-outs as a table of
  `{ kind, operations, contains(path) }`. Each `contains` is built from its
  owner's location and a boundary rule (directory and descendants, or direct
  `.md` children, or one exact file). Every entry gets the same `..` handling.
  That gives finding 1 one place to change later. The settings and config
  predicates and the skill scope are separate functions in the same module.
- **`pathValidation.ts`** separates the parse step (quotes, `~`, the
  human-approval refusals, glob or plain) from the decision (`isPathAllowed`).
  The decision becomes a short ordered list of named checks that each return a
  verdict or "no opinion", mirroring the precedence in §5. Keep
  `FileOperationType`, `PathCheckResult` and `ResolvedPathCheckResult` as they
  are.
- **Types.** Explicit throughout, with no `any`. The `forms` parameters stay
  `readonly string[]`.
