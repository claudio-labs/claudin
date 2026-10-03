# Spec: `permissions/fileRules`

Files today: `src/permissions/filePermissions/readWriteChecks.ts` and
`src/permissions/filePermissions/rulePatterns.ts`, re-exported (all but one
name) by the barrel `src/permissions/filePermissions.ts`.

## Purpose

The file half of the permission system. It answers two questions for every
tool that reads or writes files:

- **May this tool read, or write, this path?** The answer is a
  `PermissionDecision`: allow, deny, or ask the user. It weighs the user's
  `Read(...)` and `Edit(...)` rules, the session's working directories, the
  permission mode, symbolic links, protected files (`.git/`, `.claudin/`,
  shell profiles) and paths the harness owns.
- **Which paths does a rule cover?** A rule's text, such as `Edit(src/**)` or
  `Read(~/.ssh/**)`, is a gitignore-style pattern. Its anchor directory depends
  on how it starts and on where the rule came from.

The single-file checks are called from each file tool's `checkPermissions`.
Their verdict then goes to the decision core (`permissions/decision`), which
applies the mode on top (bypassPermissions, auto, plan). Batch tools
(ApplyPatch, Rename, a multi-file Read) get one verdict for the whole set. The
search tools (Grep, Glob) use the pattern exports to hide files a Read deny rule
covers.

## Public contract

All of these names, signatures and import paths must keep working.
`checkBatchReadPermission` is not in the barrel, and `FileReadTool` imports it
from `src/permissions/filePermissions/readWriteChecks.js`.

| Export | Signature | Used by |
|---|---|---|
| `checkReadPermissionForTool` | `(tool: Tool, input: { [key: string]: unknown }, toolPermissionContext: ToolPermissionContext) => PermissionDecision` | `tools/FileReadTool/FileReadTool.ts`, `tools/GlobTool/GlobTool.ts`, `tools/GrepTool/GrepTool.ts`, `tools/LSPTool/LSPTool.ts` |
| `checkWritePermissionForTool` | `<Input extends AnyObject>(tool: Tool<Input>, input: z.infer<Input>, toolPermissionContext: ToolPermissionContext, precomputedPathsToCheck?: readonly string[]) => PermissionDecision` | `tools/FileEditTool/FileEditTool.ts`, `tools/FileWriteTool/FileWriteTool.ts`, `tools/NotebookEditTool/NotebookEditTool.ts`, `tools/PowerShellTool/pathValidation/pathAllowlist.ts`, `permissions/pathValidation.ts` |
| `checkBatchWritePermission` | `(toolName: string, paths: readonly string[], toolPermissionContext: ToolPermissionContext, options?: { confirmThreshold?: number }) => PermissionDecision` | `tools/ApplyPatchTool/applyPatch.ts`, `tools/RenameTool/rename.ts` |
| `checkBatchReadPermission` | `(toolName: string, paths: readonly string[], input: { [key: string]: unknown }, toolPermissionContext: ToolPermissionContext) => PermissionDecision` | `tools/FileReadTool/FileReadTool.ts` (batch `file_paths`) |
| `generateSuggestions` | `(filePath: string, operationType: 'read' \| 'write' \| 'create', toolPermissionContext: ToolPermissionContext, precomputedPathsToCheck?: readonly string[]) => PermissionUpdate[]` | `permissions/ui/FilePermissionDialog/usePermissionHandler.ts` |
| `matchingRuleForInput` | `(path: string, toolPermissionContext: ToolPermissionContext, toolType: 'edit' \| 'read', behavior: 'allow' \| 'deny' \| 'ask') => PermissionRule \| null` | `tools/FileReadTool`, `tools/FileEditTool`, `tools/FileWriteTool`, `tools/PowerShellTool/pathValidation/pathAllowlist.ts`, `permissions/pathValidation.ts`, `agent/attachments/shared.ts` |
| `getFileReadIgnorePatterns` | `(toolPermissionContext: ToolPermissionContext) => Map<string \| null, string[]>` | `tools/GrepTool/GrepTool.ts`, `shared/fs/glob.ts` |
| `normalizePatternsToPath` | `(patternsByRoot: Map<string \| null, string[]>, root: string) => string[]` | `tools/GrepTool/GrepTool.ts`, `shared/fs/glob.ts` |

The checks read only `tool.name` and `tool.getPath(input)` from the tool.

## Observable behaviour

### 1. Rule patterns (`matchingRuleForInput`)

1. **Which rules are consulted.**
   - `toolType: 'read'` consults rules for the tool name `Read`, and `'edit'` consults rules for `Edit`. Rules for `Write`, `Glob` or any other tool never answer.
   - A rule with no content (a bare `Read`) never answers here.
   - `behavior` selects the allow, deny or ask list of the context. Rules from every source count: `userSettings`, `projectSettings`, `localSettings`, `flagSettings`, `policySettings`, `cliArg`, `command`, `session`.
2. **Anchoring.** The pattern is the rule's content. How it starts decides the directory it is matched from:

   | Pattern starts with | Anchored at |
   |---|---|
   | `//` | the filesystem root (`//etc/**` is `/etc/**`) |
   | `~/` | the home directory |
   | `/` | the rule's source root: the starting directory (`getOriginalCwd()`) for `cliArg`, `command`, `session`, `projectSettings`, `localSettings` and `policySettings`; the config home (`CLAUDIN_CONFIG_DIR`) for `userSettings`; for `flagSettings`, the directory of the `--settings` file, or the starting directory when there is none |
   | anything else | the **current** directory (`getCwd()`), not the starting one. A leading `./` is dropped first. |

3. **Matching** follows gitignore rules, relative to the anchor:
   - `*`, `?`, `[...]` and `**` work as in gitignore. A pattern with no slash (`*.pem`) matches at any depth. A slash at the start or in the middle anchors the pattern (`src/*.ts` covers `src/a.ts`, not `pkg/src/a.ts` or `src/inner/a.ts`). A trailing slash (`secrets/`) covers the directory's contents.
   - A trailing `/**` covers the directory itself as well as everything below it. Unanchored, it also matches a directory of that name at any depth: `src/**` covers `pkg/src/a.ts` (finding F7).
   - Matching ignores case, for anchored and unanchored patterns alike.
   - A later `!pattern` with the same anchor exempts the paths it matches.
4. **Never covered.** A path outside the anchor, and the anchor directory itself.
5. **The path argument.** A relative path is resolved against the current directory, and `~/` is expanded to home. Matching is on the path text, so the path need not exist.
6. **The result** is the whole rule (`{ source, ruleBehavior, ruleValue: { toolName, ruleContent } }`), with the content as written: a match through `dir/**` reports `dir/**`. When several rules match, which one is reported is not part of the contract, except that it is a matching rule of the requested tool and behaviour.
7. **Identical text in two sources** counts once, for the later source in the order above. The earlier source's anchor is lost (finding F2).

### 2. Patterns for the search tools

1. `getFileReadIgnorePatterns` returns the `Read` **deny** patterns only, grouped by anchor directory. Allow and ask rules are ignored, and so are `Edit` rules.
   - The key is the anchor: the home directory for `~/`, `/` for `//`, the source root for `/`, and `null` for unanchored patterns.
   - Each pattern drops its anchor prefix. `~/.ssh/**` becomes `/.ssh/**` under home, `//var/x/**` becomes `/var/x/**` under `/`, and `./.env` becomes `.env` under `null`. A `/` pattern keeps its text.
   - Keys come in the order of first appearance. Within a key, repeated text collapses.
2. `normalizePatternsToPath(patternsByRoot, root)` rewrites the patterns for a search rooted at `root`:
   - Unanchored (`null`) patterns come first, unchanged.
   - A pattern anchored at `root` keeps its text.
   - A pattern anchored below `root` is prefixed with the way down: under `/repo/pkg`, `/src/a.ts` becomes `/pkg/src/a.ts`.
   - A pattern anchored above `root` that reaches into it is cut down to the part inside: `/` with `/repo/src/**` gives `/src/**` for root `/repo`, and `~/.ssh/**` searched from `~/.ssh` gives `/**`.
   - A pattern anchored above `root` that stays outside it, or anchored beside it, is dropped.
   - Duplicates collapse, and the first occurrence keeps its position.

### 3. The read check (`checkReadPermissionForTool`)

1. A tool without `getPath` gets an ask whose message names the tool. It has no reason and no suggestions, whatever the mode and rules.
2. The path is `getPath(input)`, resolved against the **current** directory when it is relative. Surrounding whitespace is trimmed first, so `notes.txt ` is checked as `notes.txt`.
3. **Resolved paths.** The check considers the path itself and every hop of its symbolic-link chain, as well as the final real path. For a path that does not exist yet (a dangling link, a new file), it considers where the path would land, by resolving the deepest existing ancestor.
4. **Precedence.** The first rule that applies decides:
   1. Any resolved path that is a UNC path (starts with `//` or `\\`): **ask**. Reason `other`, and the message names the path and says it is a UNC path.
   2. Any resolved path with a suspicious Windows shape: **ask**. Reason `other`, and the message names the path and says the shape is a Windows path pattern. The shapes are 8.3 short names (`GIT~1`), trailing dots or spaces, DOS device suffixes (`.CON`), a component of three or more dots, long-path prefixes and UNC forms; on Windows and WSL, also `:` after the drive (alternate data streams). Neither of these asks carries suggestions.
   3. A `Read` deny rule covering any resolved path: **deny**, reason `rule` with that rule. The message names the (resolved) path, and says reading it was denied.
   4. A `Read` ask rule covering any resolved path: **ask**, reason `rule`, with no suggestions. The message names the path and the read.
   5. **Edit implies read.** If the write check (section 4) on the same input would allow, its decision is returned as it is: an `Edit` allow rule (reason `rule` citing the `Edit` rule), acceptEdits in a working directory (reason `mode`, `acceptEdits`), or an editable harness path. A write check that denies or asks has no effect on the read.
   6. Every resolved path inside a working directory (the starting directory, or an additional working directory): **allow**, reason `mode` with mode `'default'`, whatever the context's mode is.
   7. A harness-owned readable path (session memory, the project's transcript directory, plan files, tool results, the scratchpad, the project temp directory, agent and auto memory, `<config home>/tasks/` and `teams/`, bundled skill files): **allow** with the reason that `permissions/filePaths` gives (type `other`).
   8. A `Read` allow rule covering the **requested path** (links are not followed here, finding F6): **allow**, reason `rule`.
   9. Otherwise: **ask**, reason `workingDir` ("outside allowed working directories"). The message names the path and the read. The suggestions are those of `generateSuggestions(path, 'read', …)`.
5. Every allow hands back the caller's input object as `updatedInput`.
6. The mode is not applied here except through the write check's acceptEdits. Under bypassPermissions, a path outside still asks; the decision core applies the bypass.

### 4. The write check (`checkWritePermissionForTool`)

1. A tool without `getPath` gets an ask whose message names the tool.
2. The resolved paths are as in 3.3, or the caller's `precomputedPathsToCheck` when given. When given, they are the only paths the deny rules, the ask rules and the working-directory test look at. The messages still name `getPath(input)`.
3. **Precedence:**
   1. An `Edit` deny rule covering any resolved path: **deny**, reason `rule`. The message names the path and says editing it was denied.
   2. A harness-owned editable path: **allow**, reason `other`. These are a `.md` file directly in the session plans directory (not in a subdirectory of it), the scratchpad, agent memory, auto memory, and `<starting directory>/.claudin/launch.json`. They are allowed although `.claudin` is protected.
   3. **The `.claudin` session grant.** A `session`-source `Edit` allow rule covering the requested path whose text starts with `/.claudin/` or `~/.claudin/`, contains no `..` anywhere, and ends with `/**`: **allow**, reason `rule`. This is the only way an allow rule opens a protected `.claudin` path. The same rule from any other source does not. A grant on one file (`/.claudin/settings.json`) does not, nor does a broad rule such as `**`.
   4. **Protected paths** (`permissions/filePaths`: suspicious shapes, Claudin's own settings, commands, agents and skills, dangerous files and directories such as `.git/`, `.vscode/`, `.idea/`, `.claudin/`, `.bashrc`, `.gitconfig`, `.mcp.json`, and UNC paths), checked on every resolved path: **ask**. The reason is `{ type: 'safetyCheck', reason: <the message>, classifierApprovable }`. `classifierApprovable` is false for a suspicious Windows shape and true otherwise. This beats acceptEdits and every `Edit` allow rule. The suggestions:
      - a path inside a skill directory, `<starting directory>/.claudin/skills/<name>/…` or `<config home>/skills/<name>/…`, gets exactly one: a session `Edit` allow rule for `/.claudin/skills/<name>/**` or `~/.claudin/skills/<name>/**`, the grant that 4.3.3 then honours;
      - any other protected path gets `generateSuggestions(path, 'write', …)`.
   5. An `Edit` ask rule covering any resolved path: **ask**, reason `rule`, with no suggestions. The message names the path and the write.
   6. Mode `acceptEdits`, with every resolved path inside a working directory: **allow**, reason `mode` `acceptEdits`. No other mode allows here.
   7. An `Edit` allow rule covering the **requested path** (links not followed, F6): **allow**, reason `rule`.
   8. Otherwise: **ask**. The message names the path and the write, and the suggestions are `generateSuggestions(path, 'write', …)`. The reason is `workingDir` when the path is outside the working directories, and absent when it is inside.
4. Every allow hands back the caller's input object.

### 5. Suggestions (`generateSuggestions`)

"Outside" means some resolved path of `filePath` (or of the caller's list) is
outside every working directory. The directory is `filePath` itself when it is
an existing directory, and its parent otherwise. That directory is then
expanded to its resolved paths: a symlinked directory yields both spellings,
link first.

| Operation | Where | Mode default or plan | Any other mode |
|---|---|---|---|
| read | outside | one session `Read` allow rule `/<dir>/**` (the `//` absolute form) per directory spelling | same |
| read | inside | `setMode` acceptEdits (session) | none |
| write, create | inside | `setMode` acceptEdits (session) | none |
| write, create | outside | `setMode` acceptEdits, then `addDirectories` (session) with the directory spellings | `addDirectories` only |

The filesystem root `/` is never suggested as a read rule, so the result for it is empty.

### 6. Batch writes (`checkBatchWritePermission`)

1. Mode bypassPermissions: **allow** at once, with `updatedInput: {}` and reason `{ type: 'mode', mode: 'bypassPermissions' }`. No path is checked, and the threshold is not applied (finding F5).
2. Otherwise each path goes through the write check, under a tool named `toolName` whose path is that entry.
3. Any path denied: **deny**, reason `{ type: 'other', reason: 'batch deny' }`. The message's first line says writing was denied. Each following line is `  - <path>`, for the denied paths only, in input order. Deny beats ask.
4. Else any path asked: **ask**, reason `{ type: 'other', reason: 'batch ask' }`. The first line names the write and the count of asking paths (`1 file`, `N files`). The asking paths follow, one `  - <path>` line each.
5. Else, when `options.confirmThreshold` is above 0 and the batch has at least that many paths: **ask**, reason `{ type: 'other', reason: 'batch threshold' }`. The first line gives the path count and `threshold <n>`, and every path follows, one per line.
6. Else **allow**, with `updatedInput: {}` and reason `{ type: 'other', reason: 'batch allow' }`. An empty batch is allowed. The callers replace `updatedInput` with their real input.

### 7. Batch reads (`checkBatchReadPermission`)

1. There is no mode shortcut: under bypassPermissions too, every path goes through the read check, under a tool named `toolName`.
2. Any path denied: **deny**. The first line says reading was denied, and the denied paths follow, one `  - <path>` line each. The reason is the first denied path's own reason, so the rule that denied it.
3. Else any path asked: **ask**. The first line names the read and the count of asking paths (`1 file`, `N files`), and the asking paths follow, one per line. The reason is that of the first asking path whose reason is a rule, or else that of the first asking path. The decision core honours an ask rule even under bypass, so the rule must not be lost.
4. Else **allow**, with `updatedInput` set to the caller's `input` object (not `{}`), and reason `{ type: 'other', reason: 'batch allow' }`.

### Messages

The deny and ask messages reach the user, and through the tool result the model.
They are described by intent: each must name the path or paths and the
operation (read, edit, write), the tool for a pathless tool, the count and
threshold for batches, and the kind of problem for UNC and Windows-shape asks.
The suite checks these facts with targeted matches. One test outside the unit
pins a message byte for byte: `src/permissions/checkBatchReadPermission.test.ts`
line 103 (the batch-read deny header and list). It has to be regenerated if the
wording changes.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A dangling link, or a new file under a symlinked directory | checked where it would land: a deny on the target denies, and a target outside the working directories asks |
| A link to a `//host/share` target | read: ask (UNC); write: ask (protected path) |
| A link chain | every hop is checked against deny and ask rules |
| A relative path | resolved against the current directory, which may differ from the starting directory |
| A path written with `~/` | expanded to home before matching |
| A path that does not exist | matched by its text |
| The exact parent directory of a rule's anchor | **throws** today (finding F3) |
| An anchored root-wide pattern (`/**`, `//**`, `~/**`) | covers nothing (finding F1) |
| Windows | `//c/...` patterns are anchored at drive `C:\`, and backslash paths are converted to POSIX form before matching. Not exercised by the suite, which runs on Linux. |

## Security requirements

- **Deny beats everything** in both checks: allow rules, working directories, acceptEdits, harness-owned paths and the `.claudin` session grant. In the read check, today the UNC and Windows-shape asks still come first (F4).
- **Deny and ask rules follow links.** They are checked on the path, every link hop, and the resolved destination of a path that does not exist yet. A link inside the project never launders a denied target.
- **Read and edit rules are separate.** An `Edit` deny does not deny reading. A `Read` deny does not deny writing, and it beats the edit-implies-read allowance.
- **Working directories need every resolved path inside.** A link inside the project that leaves it is outside.
- **Protected files** ask even under acceptEdits and broad `Edit` allow rules. Only the `session`-scoped `.claudin` grant (4.3.3) opens a protected `.claudin` path, and only one written under `.claudin/`, without `..`, ending in `/**`. A suspicious Windows shape must never be classifier-approvable.
- **Matching ignores case**, so `.SSH/ID_RSA` is covered by `~/.ssh/**`.
- **Batch reads have no bypass shortcut.** Deny and ask rules hold per file.

## Tests that pin it

- `src/permissions/filePermissions/rulePatterns.characterization.test.ts`: anchoring per source, gitignore semantics, the parity cases, and the search-tool patterns.
- `src/permissions/filePermissions/readWriteChecks.characterization.test.ts`: precedence tables for both checks, symlinks, the shapes that need a person, suggestions, and both batch checks.
- `src/permissions/filePermissions/homeAnchored.characterization.test.ts`: runs `__fixtures__/rewrite/homeAnchored.child.ts` in a child `bun test` whose `HOME` is a temp dir. That covers `~/.ssh` keys, `~/` expansion, links into home, the `~/.claudin` session grant and the config-home skill suggestion, all with real files. The OS reads `HOME` once per process, so these cases cannot run in-process.
- Together: 170 tests in-process plus 9 in the child. Coverage: `readWriteChecks.ts` 100% of lines and `rulePatterns.ts` 93% (only the Windows drive branch and one unreachable guard are left).
- `scripts/migrations/probes/rewrite-permissions-fileRules.json`: 40 probes over both files, each turning the suite red, with at least one on every deny and ask branch.
- Also exercising the contract: `src/permissions/checkBatchReadPermission.test.ts`, `checkBatchWritePermission.test.ts`, `planFilePermission.test.ts`, `permissions.test.ts`, and the `filePaths` cases left in `src/permissions/filePermissions.test.ts` (this unit's cases moved into the suites above).

## Out of scope

- What counts as a protected path, a harness-owned path, a working directory, or a suspicious shape: `permissions/filePaths`. This unit only fixes where those answers sit in the precedence.
- Parsing a rule string into tool name and content (`Read(*)` and escaping): `permissions/ruleModel`.
- Applying the mode (bypassPermissions, auto, plan) and the auto-mode classifier: `permissions/decision`.

## Findings

"Fix" means the rewrite changes the behaviour and no test pins the old one.
"Keep for parity" means a test pins it.

1. **F1. Root-wide anchored patterns cover nothing.** `Read(~/**)`, `Read(//**)` and `Edit(/**)` (any source) match no path. A user's "deny reading my whole home" is silently inert in the read and write checks. `getFileReadIgnorePatterns` still passes it to the search tools.
   - **Decision: fix for deny and ask rules** (cover everything under the anchor). This is pure hardening: the user wrote the rule to be enforced.
   - **Keep for parity for allow rules** (pinned: an anchored `/**` allow grants nothing). Making them work would widen what existing allow rules grant. Revisit when the contract is redesigned.
2. **F2. Identical text in two sources counts once.** Only the later source's rule is kept, so the earlier source's anchor is lost. A user-settings `Read(/secrets/**)` (config home) stops protecting `<config home>/secrets` when the project or the session has the same text.
   - **Decision: fix for deny and ask** (each source's rule counts with its own anchor).
   - **Keep for parity for allow** (pinned), for the same reason as F1.
3. **F3. The parent of an anchor throws.** Checking the exact parent directory of a rule's anchor throws a `RangeError` from the matcher, instead of answering. For example, reading the parent of the current directory throws while any unanchored `Read` rule exists. The same happens for the parent of the starting directory with `/` rules, and for the parent of home with `~/` rules. The tool's permission check fails with an exception.
   - **Decision: fix.** Treat it as outside the anchor (no match). Nothing depends on an exception. Not pinned.
4. **F4. The read check asks before it denies.** The UNC and Windows-shape asks come before `Read` deny rules. So a denied path with such a shape (`secrets/GIT~1`) gets an ask a person can approve, instead of a deny. The write check denies first.
   - **Decision: fix.** Deny rules first, as in the write check. This is pure hardening. The suite pins those shapes only without deny rules.
5. **F5. Batch writes skip every rule under bypassPermissions.** `checkBatchWritePermission` allows at once, so ApplyPatch and Rename in bypass mode write paths an `Edit` deny rule covers, and protected paths. The single-file tools honour both, through the decision core, even in bypass.
   - **Decision: fix for deny rules.** A deny holds in every mode, and no legitimate workflow writes a denied file.
   - **Keep for parity for ask rules and protected paths.** Fixing them adds prompts to bypass sessions. Flagged to `permissions/decision`.
   - Pinned: bypass with no rules allows, which holds either way.
6. **F6. Allow rules do not follow links.** An allow rule is matched on the requested path only. A link under an allowed directory reaches any target that no deny or ask rule covers. Deny and ask rules, and the working-directory test, do follow links.
   - **Decision: keep for parity** (pinned). Following links for allow rules would add prompts in symlinked layouts, and deny rules on the targets still apply.
7. **F7. Unanchored `dir/**` matches at any depth.** `src/**` also covers `pkg/src/a.ts`, while gitignore would anchor it at the current directory.
   - **Decision: keep for parity** (pinned). Narrowing it would weaken deny rules and add prompts under allow rules.
8. **F8. Unanchored patterns follow the current directory.** Working directories and `/` patterns use the starting directory. After the session changes directory, `Read(*.pem)` no longer covers `.pem` files outside the new current directory, the project root included.
   - **Decision: keep for parity** (pinned). It is the documented meaning of an unanchored pattern. Changing it is a semantic redesign for `permissions/ruleModel`.
9. **F9. Write messages name the path as given.** A relative input stays relative in the write deny and ask messages, while read messages name the resolved path.
   - **Decision: fix.** Name the resolved path in both. No caller parses the message, and the suite checks containment only.
10. **F10. A permission check creates a directory.** The first write check in a process creates `<starting directory>/.claudin/plans` (mode 0700). It does so through the plan-file allowance from `permissions/filePaths`. As a result, running `src/permissions/checkBatchReadPermission.test.ts`, `checkBatchWritePermission.test.ts` or `permissions.test.ts` from the repository root leaves `.claudin/plans` in the checkout.
    - **Decision: fix in `permissions/filePaths`.** The plan-file test should compare paths without creating anything. Those three tests should also set their own starting directory. Not pinned here.

## Target design

- **A pure matcher.** Rule matching takes the rules and an explicit set of anchors (current directory, starting directory, home, config home, `--settings` directory, platform), and returns the matching rule. It does no I/O and reads no global state. Each rule keeps its own source and anchor, which fixes F2, and the gitignore engine is wrapped so that no query can throw (F3). The search-tool exports are views of the same anchoring.
- **Path resolution as an input.** The link chain and the resolved paths are computed once by the caller-facing check and passed down, as today's `precomputedPathsToCheck` does, behind a named type (`ResolvedPaths`) instead of a bare string array.
- **The checks as ordered steps.** Each check is a short list of named steps, each returning a decision or "continue". The read and write precedences are then readable, and can be tested step by step: deny first in both (F4).
- **Batches built on a path-level check.** The batch functions call a `(path) => decision` form of the checks, not a synthetic `Tool` cast through `unknown`. The bypass rule for batch writes becomes "deny rules still apply" (F5).
- **Explicit types:**
  - `FileAccess = 'read' | 'edit'`;
  - the reason kinds as a union;
  - `SuggestionOperation = 'read' | 'write' | 'create'`.

  No `any`, and no casts at the boundary.

## Outcome

Rewritten per method on 2026-10-03.
- **The rewrite.** All 11 inherited bodies were rewritten. `rulePatterns.ts`
  and `readWriteChecks.ts` are now thin facades over `fileRules/` (anchors, a
  pure matcher that cannot throw, rule selection, search patterns) and
  `fileChecks/` (an ordered read check and write check, suggestions,
  messages). The batch checks now sit on the path-level checks, and their
  messages are unchanged. The three characterization suites pass unchanged, the
  home-anchored child included.
- **Fixes, each with a test:**
  - **F1:** whole-anchor deny and ask patterns cover everything under their
    anchor. Allow stays inert.
  - **F2:** deny and ask keep every source's anchor.
  - **F3:** a path at or above an anchor no longer throws.
  - **F4:** the read check applies denies first.
  - **F5:** batch writes under bypass honour Edit denies.
  - **F9:** write messages name the resolved path.

  F6, F7 and F8 are kept as they were.
- **Probes:**
  - `rewrite-permissions-fileRules.json` holds 103 probes.
  - `readMulti.json`'s five B4 probes on the batch read check were re-pointed
    at the new code with the same mutations, and re-proved.
- **Open, routed to `filePaths`:** the harness-path allowances check only the
  requested path. A link inside the scratchpad that points at a protected file
  would be allowed for writing. This is the same family as
  `bugs/permission-carveouts-compare-paths-as-text.md`.
- **Residue, reviewed:** 24 lines of Claude Code remain, all signatures of the
  exported checks and of the pattern helpers.
