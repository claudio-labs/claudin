# Spec: `memory/claudemd`

The unit is ten files:
- `src/memory/instructions/claudemd.ts`, the module callers import;
- `src/memory/instructions/claudemd/{exclusions,externalIncludes,includes,nestedDirectories,parsing,predicates,processing,types}.ts`;
- `src/memory/instructions/projectInstructions.ts`.

## Purpose

This is the loader of the instructions a session runs under. At startup it
gathers every instruction file that applies to the session's original cwd:
- the managed (policy) file and rules;
- the user's file and rules;
- the root instruction file (`AGENTS.md`, else `CLAUDE.md`), `.claudin/CLAUDE.md`, the `.claudin/rules/*.md` and `CLAUDE.local.md` of every directory above the cwd;
- the auto-memory index (`MEMORY.md`), and in the shipped build the team-memory index.

Each file can pull in others with `@path`. The result is cached for the
session, and `getClaudeMds` turns it into the instruction block of the system
prompt. The unit also loads, on demand, the instructions of a directory below
the cwd and the rules whose `paths:` match a file the model touches. It reports
each loaded file to the `InstructionsLoaded` hook, and it says whether a
project file includes something outside the cwd that the user has not yet
approved.

`projectInstructions.ts` names the root instruction files and picks the one a
directory uses.

Its callers:
- **The system prompt.** `src/agent/context.ts` builds the user context from `getClaudeMds(await getMemoryFiles())`. `src/agent/attachments/injections.ts` rebuilds the block for slim agents and reads the memory indexes, and `src/agent/compact/postCompactCleanup.ts` re-arms the load after a compaction.
- **On-demand instructions.** `src/agent/attachments/memory.ts` calls the three nested-directory loaders when the model reads a file. `src/memory/memdir/pathScopedMemories.ts` passes memory files through `processMemoryFile`.
- **Screens and checks.** `/memory` (`src/commands/memory/memory.tsx`, `src/memory/ui/MemoryFileSelector.tsx`), `/status` and its notices (`src/platform/status/`), `/doctor` (`src/platform/doctor/doctorContextWarnings.ts`), the settings screen (`src/platform/settings/ui/Config.tsx`), the context analysis (`src/agent/context/analyzeContext.ts`), the REPL, and the external-include dialog at startup (`src/terminal/interactiveHelpers.tsx`).
- **Cache resets.** `/clear` and resume (`src/commands/clear/caches.ts`), worktree entry and exit (`src/tools/EnterWorktreeTool`, `src/tools/ExitWorktreeTool`), rerooting (`src/sessions/rerootSession.ts`, `src/sessions/lifecycle/restore/directoryCaches.ts`) and setup (`src/platform/setup.ts`).

## Public contract

Through `src/memory/instructions/claudemd.ts`:

| Export | Signature | Used by |
|---|---|---|
| `MemoryFileInfo` (type) | `{ path: string; type: MemoryType; content: string; parent?: string; globs?: string[]; contentDiffersFromDisk?: boolean; rawContent?: string }` | `src/agent/attachments/`, `src/memory/ui/`, `src/memory/memdir/`, `src/platform/status/`, `src/agent/ui/ContextVisualization.tsx` |
| `ExternalClaudeMdInclude` (type) | `{ path: string; parent: string }` | `src/platform/ClaudeMdExternalIncludesDialog.tsx` |
| `getMemoryFiles` | `(forceIncludeExternal?: boolean) => Promise<MemoryFileInfo[]>`, memoized, with a `cache` | the callers above |
| `clearMemoryFileCaches` | `() => void` | worktree tools, rerooting, setup, `/memory` |
| `resetGetMemoryFilesCache` | `(reason?: InstructionsLoadReason) => void`; the default is `'session_start'` | `src/commands/clear/caches.ts` (`'session_start'`), `src/agent/compact/postCompactCleanup.ts` (`'compact'`) |
| `getClaudeMds` | `(memoryFiles: MemoryFileInfo[], filter?: (type: MemoryType) => boolean) => string` | `src/agent/context.ts`, `src/agent/attachments/injections.ts` |
| `shouldShowClaudeMdExternalIncludesWarning` | `() => Promise<boolean>` | `src/terminal/interactiveHelpers.tsx` |
| `getExternalClaudeMdIncludes` | `(files: MemoryFileInfo[]) => ExternalClaudeMdInclude[]` | `interactiveHelpers.tsx`, `Config.tsx` |
| `hasExternalClaudeMdIncludes` | `(files: MemoryFileInfo[]) => boolean` | `Config.tsx` |
| `processMemoryFile` | `(filePath: string, type: MemoryType, processedPaths: Set<string>, includeExternal: boolean, depth?: number, parent?: string) => Promise<MemoryFileInfo[]>`; `depth` defaults to 0 | `src/memory/memdir/pathScopedMemories.ts` |
| `processMdRules` | `(opts: { rulesDir: string; type: MemoryType; processedPaths: Set<string>; includeExternal: boolean; conditionalRule: boolean; visitedDirs?: Set<string> }) => Promise<MemoryFileInfo[]>` | no import outside the unit; the barrel keeps it |
| `processConditionedMdRules` | `(targetPath: string, rulesDir: string, type: MemoryType, processedPaths: Set<string>, includeExternal: boolean) => Promise<MemoryFileInfo[]>` | no import outside the unit; the barrel keeps it |
| `getManagedAndUserConditionalRules` | `(targetPath: string, processedPaths: Set<string>) => Promise<MemoryFileInfo[]>` | `src/agent/attachments/memory.ts` |
| `getMemoryFilesForNestedDirectory` | `(dir: string, targetPath: string, processedPaths: Set<string>) => Promise<MemoryFileInfo[]>` | `src/agent/attachments/memory.ts` |
| `getConditionalRulesForCwdLevelDirectory` | `(dir: string, targetPath: string, processedPaths: Set<string>) => Promise<MemoryFileInfo[]>` | `src/agent/attachments/memory.ts` |
| `isMemoryFilePath` | `(filePath: string) => boolean` | `src/agent/compact/postCompactAttachments.ts` |
| `getLargeMemoryFiles` | `(files: MemoryFileInfo[]) => MemoryFileInfo[]` | `/status`, its notices, `/doctor` |
| `MAX_MEMORY_CHARACTER_COUNT` | `40000` | the same three |

Through `src/memory/instructions/projectInstructions.ts`:

| Export | Signature | Used by |
|---|---|---|
| `PRIMARY_PROJECT_INSTRUCTION_FILE` | `'AGENTS.md'` | `src/platform/config/config/derived.ts`, `src/memory/ui/memoryFileSelectorPaths.ts` |
| `getProjectInstructionFilePaths` | `(dir: string) => string[]` | `src/agent/compact/postCompactAttachments.ts` |
| `getProjectInstructionFilePath` | `(dir: string, existsSync: (path: string) => boolean) => string` | the unit itself |
| `findProjectInstructionFilePathInAncestors` | `(startDir: string, existsSync: (path: string) => boolean) => string \| null` | `src/platform/projectOnboardingSteps.ts`, `memoryFileSelectorPaths.ts` |
| `isProjectInstructionFileName` | `(name: string) => boolean` | `memoryFileSelectorPaths.ts` |

**Contract constraints:**
- **The barrel's runtime names.** `claudemd.ts` exports exactly the sixteen runtime names above. `src/memory/instructions/claudemd.test.ts` and the new suite both pin the list.
- **Module paths other code imports.** These paths must keep existing, or the importers must change in the same commit:
  - `src/memory/instructions/claudemd/processing.ts` exports `processMemoryFile`, which `src/memory/memdir/pathScopedMemories.ts` imports from there;
  - `src/memory/instructions/claudemd/types.ts` exports `MemoryFileInfo`, which `pathScopedMemories.ts`, `src/memory/memdir/prompt/memoryPromptDispatch.ts`, `src/memory/memdir/directory/memoryDirectory.ts` and two tests import from there.
- **The memo handle.** `getMemoryFiles.cache` is a map-like object with `get`, `set`, `has` and `clear`. `src/commands/clear/caches.characterization.test.ts` seeds it with `set` and checks it with `has`, and `claudemd.test.ts` seeds it with `set` and reads it with `get`.
- **One home for the TEAMMEM switch.** `.claudin/rules/code-design.md` keeps the memoized `getMemoryFiles` and the `feature('TEAMMEM')` require in `claudemd.ts`. The build folds `feature()` with a regular expression over the source text, so the require has to stay in exactly one module.
- **No import of the permission layer's callers.** `src/agent/context.ts` and `src/permissions/yoloClassifier/prompts.ts` avoid importing this module because it imports `src/permissions/filePermissions`. The rewrite must not add an import that closes a cycle through `permissions/`.

## Observable behaviour

### 1. The session load: `getMemoryFiles(forceIncludeExternal = false)`

It returns the entries below, in this order. Each entry is the file, then the
files it includes (section 3).

1. **Managed file:** `<getManagedFilePath()>/CLAUDE.md`, type `Managed`. The managed directory is `/etc/claude-code` on Linux. It is always read.
2. **Managed rules:** the unconditional rules of `<managed>/.claudin/rules`, type `Managed`. Always read.
3. **User file:** `<config home>/CLAUDE.md`, type `User`. The config home is `CLAUDIN_CONFIG_DIR` when set, otherwise `~/.claudin`. Read only when `userSettings` is an enabled setting source.
4. **User rules:** the unconditional rules of `<config home>/rules`, type `User`, under the same gate.
5. **The walk.** For every directory D from the top down to the original cwd, in this order:
   - **The root instruction file** (section 6), type `Project`;
   - `D/.claudin/CLAUDE.md`, type `Project`;
   - the unconditional rules of `D/.claudin/rules`, type `Project`.

     These three are read only when `projectSettings` is enabled.
   - `D/CLAUDE.local.md`, type `Local`, read only when `localSettings` is enabled.

   **Which directories.** Every ancestor of the original cwd, the cwd included. The walk does not stop at the repository root or at the home directory. The filesystem root itself is not read (Findings, 1).
6. **Added directories.** When `CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is truthy, each directory of `getAdditionalDirectoriesForClaudeMd()` (`--add-dir`) contributes its root instruction file, its `.claudin/CLAUDE.md` and its unconditional rules, as type `Project`.
   - This happens whatever the setting sources say.
   - It is not a walk: no `CLAUDE.local.md`, nothing above or below the directory.
   - With the variable unset or falsy, nothing is read from them.
7. **Auto-memory index.** When `isAutoMemoryEnabled()`, the file `getAutoMemEntrypoint()` (`MEMORY.md`), type `AutoMem`.
   - An index that exists but is empty still gives an entry, with `''` as content. A missing index gives none.
   - The index's `@path` lines are not followed.
   - Its content goes through the index truncation of `src/memory/memdir/entrypoint/truncation.ts`: trimmed, then cut at 200 lines or 25,000 bytes with a warning line naming the cap.
   - When an earlier entry already has that path, no second entry is added.
8. **Team-memory index (shipped build only).** In the shipped build `feature('TEAMMEM')` is on. Then, when team memory is enabled (it follows auto memory), `<auto-memory dir>/team/MEMORY.md` comes last, type `TeamMem`, with the same rules as the auto-memory index. Under `bun test` the flag is off and nothing is loaded here.

**Each file once.** Every path is compared after `normalizePathForComparison`. A path already loaded or already visited, by any earlier step or include, is not loaded again. That includes a file that was missing.

**Entries.**
- **`path`:** the path as reached. A root instruction file or include reached through a link keeps the link's path; a rule reached through a link reports its target's path (section 4).
- **`type`:** as above. An included file takes its includer's type.
- **`content`:** see section 2.
- **`parent`:** set only on an included file, to its includer's path.
- **`globs`:** the file's `paths:` (section 2).

**External includes.** `forceIncludeExternal`, or the project config's `hasClaudeMdExternalIncludesApproved`, lets managed, project and local files include files outside the original cwd. User files may always include anything. "Outside" is judged against the original cwd, not the repository: a session started in `repo/pkg/app` treats `repo/docs/x.md` as external.

**Nested worktree.** When the original cwd is in a git worktree whose root lies inside its main checkout (for example `.claudin/worktrees/<name>`), checked-in files are skipped in every walked directory that is inside the main checkout but outside the worktree. Those are the root instruction file, `.claudin/CLAUDE.md` and the rules. Local files there are still read, and so is everything above the main checkout and inside the worktree. A separate repository nested in a checkout (a vendored clone, a submodule with its own git directory) skips nothing.

**Exclusions.** The `claudeMdExcludes` setting, from the merged settings, lists patterns that drop `User`, `Project` and `Local` files, includes included.
- **What can be excluded.** `Managed`, `AutoMem` and `TeamMem` files never are. Excluding `AGENTS.md` does not bring the directory's `CLAUDE.md` back.
- **Matching.** Patterns are picomatch globs matched against the absolute path, with forward slashes and with dot segments matched by wildcards (`**/rules/*.md` matches `.../.claudin/rules/x.md`). Empty patterns are ignored.
- **Linked prefixes.** An absolute pattern written through a linked directory also matches the real path, when the link is above the last directory before the glob or file name (Findings, 4).

### 2. One file: `processMemoryFile(filePath, type, processedPaths, includeExternal, depth = 0, parent?)`

It returns `[file, ...its includes]`, or `[]`.
- **When it returns `[]`.** The path is already in `processedPaths`, `depth` is 5 or more, the path is excluded, the file is missing, unreadable or a directory, its content is blank after the steps below, or its extension is not a text one (section 3).
- **What it records.** Before reading, the normalized path goes into `processedPaths`, and for a link the target's normalized path too. A file that turns out missing is recorded as well.
- **The parent.** `parent`, when given, is set on the returned entry.

**Content.**
- **Frontmatter.** It is read with `inspectRuleFrontmatter` (`src/memory/instructions/ruleFrontmatter.ts`). The entry's `content` is the body and `globs` the derived `paths:` patterns. `globs` is absent when there are none or when the only pattern is `**`. Frontmatter that never closes is ordinary text.
- **HTML comments.** A comment that starts a block is removed, and text after its closing `-->` on the same line is kept. A comment inside a paragraph, a comment that never closes, and a comment inside a code fence or inline code stay (Findings, 6). How many blank lines a removed block leaves is not specified.
- **Line ends.** A file with no comment removed keeps its bytes, CRLF included. A file that had a comment removed comes back with LF line ends (Findings, 7).
- **Indexes.** `AutoMem` and `TeamMem` content is truncated as in section 1.
- **The disk bytes.** `contentDiffersFromDisk` is `true` exactly when `content` differs from the file's text, and `rawContent` then holds that text. Otherwise `contentDiffersFromDisk` is `false` and `rawContent` is absent. Callers cache a partial-view read from these two.

### 3. Includes: `@path`

- **Where they are found.** In the text of the file after frontmatter, as `@` followed by a run of non-space characters, where `\ ` is an escaped space.
  - The `@` must start the text or follow whitespace, so `me@x.md` is not an include.
  - They are found in paragraphs, headings, list items and block quotes, and in the text after a comment's closing `-->`.
  - They are not found in fenced code, inline code, or inside a comment.
- **Accepted forms.**
  - `@./rel`, `@~/from-home`, `@/absolute`;
  - a bare `@name` that starts with a letter, digit, `.`, `_` or `-`, read as relative.
  - Refused: `@/` alone, `@@x`, and a reference starting with `#%^&*()`.
- **Resolution.**
  - A `#fragment` is dropped.
  - A relative reference resolves against the directory of the including file's real path, so a linked file's includes resolve next to its target.
  - `~` is the home directory.
  - Each target is listed once per file, in document order.
- **Loading.** The includes come after their includer, depth-first, each with `parent` set to the includer's path.
  - Only four levels below the first file load: a chain of seven gives five files.
  - Cycles end because each file loads once.
  - A target outside the original cwd is skipped unless includes may be external (section 1); the check uses the reference's own path, not a link's target.
- **Text extensions.** A target whose extension, lower-cased, is not one of these is not read. A target without an extension is read.

  `.adoc .asciidoc .astro .bash .bat .c .cc .cfg .cjs .clj .cljc .cljs .cmake .cmd .conf .config .cpp .cs .css .csv .cts .cxx .dart .diff .edn .ejs .elm .env .erb .erl .ex .exs .f .f90 .f95 .fish .for .go .gql .gradle .graphql .h .hbs .hpp .hrl .hs .htm .html .ini .jade .java .js .json .jsx .kt .kts .latex .less .lhs .lock .log .lua .make .makefile .md .mjs .ml .mli .mts .org .patch .php .pl .pm .properties .proto .ps1 .pug .py .pyi .pyw .r .rake .rb .rs .rst .sass .sbt .scala .scss .sh .sql .svelte .swift .tex .text .toml .ts .tsx .txt .vue .xml .yaml .yml .zsh`

### 4. A rules directory: `processMdRules({ rulesDir, type, processedPaths, includeExternal, conditionalRule })`

- **Which files.** Every file whose name ends in `.md`, at any depth, hidden ones included; `.MD` and other extensions do not count. A directory whose name ends in `.md` is searched like any other.
- **Which pass.** With `conditionalRule: false` it keeps the files without `globs`; with `true`, those with. Either way every rule file read goes into `processedPaths`, so the second pass over the same set returns nothing.
- **Includes.** Each rule is loaded as in section 2, includes included. Included files are kept when their own `globs` pass the same filter.
- **Links.**
  - Linked files and directories are followed, and their files are reported at the target's path.
  - For a linked file the link's name decides whether it counts: `named.md` pointing at a `.txt` counts, and `named.txt` pointing at a `.md` does not.
  - A dangling link is skipped, and a link loop ends.
- **Failures.** A missing directory, a file in its place, or an unreadable directory or subdirectory gives nothing for that directory, and the rest still load. It never throws.
- **Order.** The order inside one directory is not specified.

### 5. Instructions below the cwd, for one target file

These three serve the Read tool's attachments. `processedPaths` is one set per
target, shared across the calls, and each call adds to it.

- **The anchor of a rule's globs.**
  - For `Project` rules, globs are relative to the directory that holds `.claudin`. For `Managed` and `User` rules, they are relative to the original cwd.
  - An absolute target is made relative to that anchor, and a relative target is used as written.
  - A target outside the anchor, or equal to it, matches nothing.
  - Patterns follow `.gitignore` semantics (the `ignore` package): `src/api` matches everything below it, and `*.test.ts` matches at any depth.
- **`processConditionedMdRules(targetPath, rulesDir, type, processedPaths, includeExternal)`:** the conditional rules of `rulesDir` (section 4) whose globs match the target.
- **`getConditionalRulesForCwdLevelDirectory(dir, targetPath, processedPaths)`:** the matching conditional rules of `dir/.claudin/rules`, as `Project`, with no external includes.
- **`getManagedAndUserConditionalRules(targetPath, processedPaths)`:** the matching conditional rules of the managed rules directory, then of the user's, the latter only when `userSettings` is enabled. External includes are allowed for the user's rules only.
- **`getMemoryFilesForNestedDirectory(dir, targetPath, processedPaths)`:** in this order:
  1. the root instruction file and `dir/.claudin/CLAUDE.md`, as `Project`, when `projectSettings` is enabled;
  2. `dir/CLAUDE.local.md`, as `Local`, when `localSettings` is enabled;
  3. the unconditional rules of `dir/.claudin/rules`;
  4. its conditional rules that match the target.

  Rules come whatever the setting sources say. No external include is followed. Afterwards every rule file of the directory is in `processedPaths`, matched or not, and a second call with the same set returns nothing.

### 6. The root instruction file

- **The two names.** `getProjectInstructionFilePaths(dir)` is `[dir/AGENTS.md, dir/CLAUDE.md]`, and `PRIMARY_PROJECT_INSTRUCTION_FILE` is `'AGENTS.md'`.
- **The choice.** `getProjectInstructionFilePath(dir, existsSync)` is `dir/AGENTS.md` when the check says it exists, otherwise `dir/CLAUDE.md`, whether that exists or not.
  - So a directory with an `AGENTS.md`, even an empty one or a directory of that name, never has its `CLAUDE.md` read.
- **`findProjectInstructionFilePathInAncestors(startDir, existsSync)`:**
  - **The search.** It looks in `startDir`, then each parent up to and including the filesystem root. The first directory with either name gives that directory's choice, as above.
  - **No file anywhere** gives `null`.
- **`isProjectInstructionFileName(name)`:** `true` for exactly `AGENTS.md` and `CLAUDE.md`, case-sensitive.

### 7. The instruction block: `getClaudeMds(memoryFiles, filter?)`

- **Which entries.** Those whose type passes `filter` (all when it is absent) and whose `content` is not empty.
- **No entries left** gives `''`.
- **The shape.** Otherwise a preamble, then each file as a block, all separated by blank lines (`\n\n`). Each block is `Contents of <path> (<label>):`, a blank line, and the trimmed content.
- **The team index.** In the shipped build, a `TeamMem` entry's content is fenced as `<team-memory-content source="shared">\n<content>\n</team-memory-content>`.

The preamble and the labels are text for the model. Described by intent:

- **The preamble** says that what follows are the codebase's and the user's instructions. They override the default behaviour and must be followed exactly as written.
- **The labels** state these facts:
  - `Project`: project instructions, checked into the codebase;
  - `Local`: the user's private project instructions, not checked in;
  - `User`: the user's private global instructions, for all projects;
  - `AutoMem`: the user's auto-memory, which persists across conversations;
  - `TeamMem`: shared team memory, git-tracked in the project.
  - `Managed`: today it gets the `User` label (Findings, 3).

### 8. The cache and the `InstructionsLoaded` reports

- **The cache.**
  - `getMemoryFiles()` caches its result: a second call returns the same array even after the disk changed.
  - `getMemoryFiles(true)` is a separate entry.
  - `clearMemoryFileCaches()` and `resetGetMemoryFilesCache(reason)` both drop every entry.
- **One pending report.** At startup, and after each `resetGetMemoryFilesCache(reason)`, one report is pending with that reason; the default is `'session_start'`.
  - **When it is used.** The next load that is not forced uses it.
  - **What it reports.** Every loaded `Managed`, `User`, `Project` and `Local` entry goes to `executeInstructionsLoadedHooks`, fire-and-forget. A top-level file goes with the pending reason, and an included file with `'include'` and its parent as `parent_file_path`. The file's `globs` go along.
  - **What is never reported.** `AutoMem` and `TeamMem` entries.
  - **Without a listener.** The pending report is used up even when no hook is configured, so a hook registered later does not get a stale `session_start`.
  - **After it is used.** A load after `clearMemoryFileCaches()` reports nothing.
  - **Forced loads.** `getMemoryFiles(true)` neither reports nor uses up the pending report.

### 9. External includes and the warning

- **`getExternalClaudeMdIncludes(files)`:** the `{ path, parent }` of every entry that has a `parent`, is not of type `User`, and lies outside the original cwd, in order. Managed includes count. `hasExternalClaudeMdIncludes(files)` says whether there is any.
- **`shouldShowClaudeMdExternalIncludesWarning()`:**
  - `false` when the project config has `hasClaudeMdExternalIncludesApproved` or `hasClaudeMdExternalIncludesWarningShown`;
  - otherwise whether `getMemoryFiles(true)` has an external include.

### 10. The small predicates

- **`isMemoryFilePath(path)`** is `true` for:
  - a file named `AGENTS.md`, `CLAUDE.md` or `CLAUDE.local.md`, anywhere;
  - a `.md` file anywhere below a `.claudin/rules/` segment, using the platform separator.

  Names are case-sensitive.
- **`getLargeMemoryFiles(files)`** keeps the entries whose content is longer than `MAX_MEMORY_CHARACTER_COUNT` (40,000) characters, strictly.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A missing, unreadable or blank file | no entry, no error |
| A directory where a file is expected | no entry; for `AGENTS.md` it still hides `CLAUDE.md` |
| An empty memory index | an `AutoMem` (or `TeamMem`) entry with `''` |
| A rule with only frontmatter | no entry |
| A rules directory with a dangling link, a loop, or an unreadable subdirectory | the other rules load |
| An include cycle, or a file reached twice | each file once |
| An include chain longer than five files | the first five |
| An include of a binary extension | skipped |
| A reference with trailing punctuation (`@./a.md,`) | the punctuation is part of the path, so usually nothing loads. Not pinned |
| A worktree inside its main checkout | the checkout's checked-in files are skipped; local ones load |
| `@~/` | expands to the home directory (pinned in a child process with its own `HOME`) |
| A file at the filesystem root (`/AGENTS.md`) | not read by the session load; found by `findProjectInstructionFilePathInAncestors`. Not pinned for the session load |
| Windows paths: drive-letter case | compared through `normalizePathForComparison`. Not pinned |

## Security requirements

**Pinned by the tests:**
- **External includes need approval.** A managed, project or local file includes a file outside the original cwd only when the user approved it, or for the approval dialog itself (`forceIncludeExternal`). The warning is offered once.
- **Binary includes are refused** by the text-extension list.
- **The include depth is bounded,** and cycles end.
- **Managed files cannot be excluded.**
- **The setting sources gate** the user, project and local files. Managed files and `--add-dir` directories are not gated.
- **`--add-dir` directories are read only with `CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD`.**

**Described, kept for parity (Findings, 1 and 2):**
- **The walk reaches every ancestor of the cwd.** A session in `/tmp/work` reads `/tmp/AGENTS.md`, `/tmp/CLAUDE.local.md` and `/tmp/.claudin/rules/*.md` into its system prompt.
- **Links are followed wherever they point,** and the approval check looks at the link, not its target.

## Tests that pin it

- **`src/memory/instructions/claudemd.characterization.test.ts`:** 63 tests on `getMemoryFiles`, the cache, the hook reports, `getClaudeMds`, the external-include warning, exclusions, `--add-dir` and worktrees.
  - **Its world.** Every test builds a fresh tree in the system temp directory:
    - a git repository inside a plain directory, with git's global and system configuration shut out;
    - the cwd two levels inside the repository;
    - `CLAUDIN_CONFIG_DIR`, the auto-memory directory (`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`), and the managed directory, by seeding the memo of `getManagedFilePath`.
  - **State it sets.** The original cwd, project root, setting sources, `--add-dir` list and interactivity go through `src/platform/bootstrap/state.ts`. The approval flags go through `saveCurrentProjectConfig`, which under `bun test` writes the in-memory test project config. All of it is put back afterwards.
  - **Hooks.** They are observed by registering a real callback hook with `registerHookCallbacks`; nothing is mocked.
  - **Scope of the assertions.** The walk also reaches the temp directory and `/`, so only entries inside the tree are asserted on.
- **`src/memory/instructions/claudemd.files.characterization.test.ts`:** 54 tests on `processMemoryFile`, includes, comments, `processMdRules`, the nested-directory loaders and the predicates.
- **`src/memory/instructions/projectInstructions.characterization.test.ts`:** 12 tests on `projectInstructions.ts`.
- **`src/memory/instructions/claudemd.teamMemory.characterization.test.ts`:** one test under the plain runner.
  - **The child run.** It runs the file again in a child `bun test --feature=TEAMMEM` with its own `HOME`. The 7 tests there pin the team-memory index, its truncation, its fence in `getClaudeMds` and its label, and the `@~/` include.
  - **Coverage.** The child's coverage does not count toward the figures below.
- **Coverage of the four suites together:**

  | File | Lines |
  |---|---|
  | `claudemd.ts` | 95.29% (only the TEAMMEM lines are left uncovered) |
  | `exclusions.ts`, `externalIncludes.ts`, `includes.ts`, `parsing.ts`, `predicates.ts`, `projectInstructions.ts` | 100% |
  | `nestedDirectories.ts` | 99.30% |
  | `processing.ts` | 96.72% |
  | `types.ts` | types only, no runtime lines |

  Every function is covered.
- **Fixtures in `src/memory/instructions/__fixtures__/rewrite/`:**
  - `path-scoped-rule.md`, a rule in the shape of this repository's own `.claudin/rules/*.md` (a quoted list of globs, with braces);
  - `instructions-with-includes.md`, an instruction file with every include form that is followed and every one that is not. The suite substitutes `@ABSOLUTE` with a real absolute path.
- **`scripts/migrations/probes/rewrite-memory-claudemd.json`:** 40 probes, every one red against the four suites.
  - **Spread.** 13 on `claudemd.ts`, 6 on `processing.ts`, 5 on `includes.ts`, 4 each on `parsing.ts` and `nestedDirectories.ts`, 3 on `exclusions.ts`, 2 each on `predicates.ts` and `projectInstructions.ts`, and 1 on `externalIncludes.ts`. `types.ts` holds only types, so no probe can turn a test red there.
  - **A replaced probe.** One probe in `nestedDirectories.ts` changed a line whose effect no caller can observe: after `getMemoryFilesForNestedDirectory`, every rule file of the directory counts as seen with or without it (section 5). It turned nothing red and cannot, so it was replaced by a probe on the `projectSettings` gate of the same function.
- **Existing tests that reach the unit:**
  - `src/memory/instructions/claudemd.test.ts`, this project's own (0 inherited lines), stays.
  - `src/commands/clear/caches.characterization.test.ts` pins the memo handle.
  - `src/agent/attachments/memory.dedup.test.ts`, `memory.injectedView.test.ts`, `injections.memoryIndex.test.ts`, `attachments.orchestrator.test.ts` and `src/agent/queryHelpers.nestedMemory.test.ts` build `MemoryFileInfo` values or mock the barrel.
  - `src/memory/memdir/teamMemPrompts.test.ts` relies on section 1's empty-index entry.
- **The inherited test this unit was to fold in.** `docs/tech/rewrite/phase-2.md` names `src/memory/instructions/projectInstructions.test.ts` (77 lines). It does not exist in the tree at `6e89dbbb`, so there was nothing to fold in or delete. The new `projectInstructions.characterization.test.ts` covers the module on its own.
- **Prompt text.** The preamble, the labels and the team-memory fence are text for the model. No test, snapshot or generated file outside the unit pins any of it byte for byte. The system-prompt dump (`scripts/bench/tokens/dump-system-prompt.ts`) lists the unit's files among its prompt sources by glob, so a rewrite that moves files must keep that glob pointing at them.
- **Not pinned, and why:**
  - **The filesystem root itself** in the session load. The test would have to write to `/`.
  - **The `Managed` label,** which Findings 3 changes.
  - **`getMemoryFiles(false)` as its own cache entry,** which Findings 5 changes.
  - **A glob directly under a linked directory in `claudeMdExcludes`,** which Findings 4 changes.
  - **Windows drive letters and separators.**
  - **The order of rules inside one directory.**
  - **Trailing punctuation in a reference.**
- **Outside the unit, naming the old code:**
  - `src/memory/memdir/pathScopedMemories.ts` names `claudemd/nestedDirectories.ts` in a comment.
  - `.claudin/memory/team/rule-files-four-silent-failure-modes.md` names a private helper of `claudemd.ts`.
  - `src/agent/compact/postCompactAttachments.ts` has a TODO pointing at `isMemoryFilePath`, which stays.

  Reword the first two when the implementation lands.

## Out of scope

- **`.R` in the text-extension list.** Extensions are lower-cased before the check, so an upper-case entry can never match. `.r` covers those files.
- **The diagnostics events** around a load (start, completion, counts) are logging without a reader in the tests; keep or drop them.

## Findings

1. **Security: the walk reaches every ancestor of the cwd.** This is the first defect in the team bug memory `instruction-loader-walk-to-root-and-links`, for this loader.
   - **What happens.** Unlike the `.claudin/<subdir>` walk, this one stops neither at the repository root nor at home. A session in `/tmp/work` reads `/tmp/AGENTS.md`, `/tmp/CLAUDE.local.md` and `/tmp/.claudin/rules/*.md`.
   - **The risk.** On a shared machine, anyone who can write such a directory puts instructions into another user's system prompt.
   - **Decision: keep for parity, and track it.** Instructions above a repository are a relied-on workflow: a monorepo's parent, a workspace directory, `~/AGENTS.md` for every project under home. Stopping at the repository root or at home would drop them. An ownership check would be noticed by shared setups an administrator owns, so it is not pure hardening. A narrower check that skips world-writable sticky directories such as `/tmp` is a candidate follow-up.
   - Pinned by "the walk does not stop at the repository root".
2. **Security: links are followed wherever they point.** This is the second defect in the same team bug memory.
   - **Where it applies.** A cloned repository can ship any of these as a link to a file the user can read, such as `~/.ssh/id_rsa`:
     - an `AGENTS.md`;
     - a rule (`.claudin/rules/x.md`);
     - an include target (`@./notes`).
   - **Why nothing stops it.** The approval for external includes looks at the link's own path, which is inside the cwd. An extensionless target passes the text-extension check.
   - **The effect.** The target's text goes into the system prompt and to the provider.
   - **Decision: keep for parity, and track it.** `CLAUDE.md` linked to `AGENTS.md`, and rule libraries linked from `~/dotfiles`, are common. Gating link targets outside the project behind the approval dialog would be noticed by those users, so it is not pure hardening.
   - Pinned by "a link is followed wherever it points, and an extensionless target is read".
3. **The managed file is labelled as the user's own.** In the instruction block, a `Managed` entry gets the label of the user's private global instructions, so the model is told an organization's policy is the user's preference.
   - **Decision: fix.** Give `Managed` its own label, stating that these are instructions set by the organization's managed policy. No caller, stored data or workflow depends on the label.
   - The suite does not pin the `Managed` label.
4. **`claudeMdExcludes` misses a glob directly under a linked directory.**
   - **What works.** `/alias/repo/AGENTS.md` and `/alias/repo/**/X.md` match a file under the link's target.
   - **What does not.** `/alias/**/X.md` does not: a wildcard right after the link's name defeats the resolution.
   - **Decision: fix.** Resolve every literal directory before the first wildcard. A pattern the user wrote to exclude a file is not something anyone relies on failing.
   - The working forms are pinned.
5. **`getMemoryFiles()` and `getMemoryFiles(false)` are two cache entries.**
   - **The effect.** A caller passing `false` reads the disk again, and can use up the pending hook report.
   - **Decision: fix.** An absent argument and `false` share one entry. No caller passes `false`.
   - Not pinned.
6. **A comment inside a paragraph reaches the model.** Only comments that start a block are removed.
   - **Decision: keep for parity.** An instruction can name HTML comment markers in prose, for example "wrap generated sections in `<!-- BEGIN -->` and `<!-- END -->`". Stripping them would change the instruction.
   - Pinned.
7. **Removing a comment turns CRLF into LF.**
   - **Decision: keep for parity.** The model sees the same text, and `rawContent` keeps the disk bytes for the edit tools.
   - Pinned loosely: no CR is left, and the lines survive.
8. **A rule reached through a link reports its target's path,** while an `AGENTS.md` or include reached through a link reports the link's path. The `.claudin/<subdir>` loader always reports the link's path.
   - **Decision: keep for parity.** The reported path is what the model sees in `Contents of …`, what the hook reports, and what the attachment dedupe keys on.
   - Pinned.
9. **"External" means outside the cwd, not outside the repository.** A session started in a subdirectory needs approval for an include in the repository's own `docs/`.
   - **Decision: keep for parity.** It errs toward asking. Widening the boundary to the repository would load more without approval, which is a loosening, not hardening.
   - Pinned.

## Target design

- **The facade.** `claudemd.ts` stays the module callers import, with the sixteen runtime names.
  - It keeps the memoized `getMemoryFiles`, with a map-like `cache`, and the one `feature('TEAMMEM')` require.
  - `claudemd/processing.ts` keeps exporting `processMemoryFile` and `claudemd/types.ts` keeps `MemoryFileInfo`, unless their importers move in the same commit.
- **Sources as data.** A table of `{ type, paths(dir), gate }` rows holds the managed, user, walk, local, `--add-dir` and index sources and their setting-source gates, rather than a chain of conditions.
- **The walk.** The list of directories, and the nested-worktree skip rule, come from one function. It takes the cwd, the git root and the canonical root as plain inputs, so it can be tested without a repository.
- **One file reader.** It reads a file, applies the frontmatter, comment and index-truncation steps, and returns the entry or nothing. A failure is logged with `logForDebugging` and gives nothing.
- **Includes** are a pure extraction from the markdown tokens, followed by a loader that owns the seen-set, the depth limit and the approval check.
- **Rules.** One directory reader with a cycle guard on real paths, and one glob matcher that takes the anchor explicitly.
- **The hook latch** is a small object with `arm(reason)` and `take()`.
- **The instruction block** is a pure function over the entries, with the labels in one table keyed by type, `Managed` included (Findings, 3).
- **Types.** Explicit, with no `any`, and regular expressions at module level.
- **Call-time reads.** The environment, the settings, the setting sources, the managed path and the config home are read when a load runs, because the tests change them between calls.
