# Spec: `memory/memdir`, the persistent memory directory and its prompts

## Purpose

The agent keeps notes across sessions as markdown files in a memory directory.
There is a private directory for this user and project, and inside it a `team/`
directory that is committed with the project. This unit owns:

- **The switches:** whether memory is on, and the background-extraction and prompt switches that sit under it.
- **The location:** where the directories are (inside the repository, in a legacy location under the config home, or an override), and moving legacy notes into the repository once.
- **Recognition:** which paths, directories, shell commands and glob patterns count as memory. The permission layer, the Read tool and the transcript's read/search collapsing ask it.
- **The index:** `MEMORY.md`, loaded into context every session. Its caps, how an oversized one is cut, and how its entries are counted.
- **The staleness note** the Read tool puts in front of an old memory.
- **Path-scoped memories:** a memory whose frontmatter has `paths:` is attached the first time a Read touches a matching file.
- **The taxonomy and the prompt text:** the four memory types, the three team categories, the memory section of the system prompt, and the fragments that the extraction, dream, `/memory sort` and `/memory tidy` prompts embed.

The design, and why team memory is git-tracked and project-local, is in
[docs/tech/memory/project-local-team-memory.md](../../memory/project-local-team-memory.md).

**Two files stay as they are.** `teamMemPrompts.ts` (the shipped team prompt)
and `pathScopedMemories.ts` are this project's own code: 9 of 170 and 17 of 258
lines match the inherited base, and those are signatures and one-line
declarations, not prose. They are out of the implementation, which keeps them
working as callers of the exports below; their few matching lines go to the
phase's residue sweep. Their behaviour stays described here, and pinned by the
suites, because the rest of the unit feeds it.

**The team build flag.** `feature('TEAMMEM')` is `true` in the shipped build
(`scripts/build/build.ts`) and `false` under `bun test`, where Bun resolves
`bun:bundle` natively. Several behaviours below differ by it, and each one says
so. The shipped memory prompt is the team one; the private-only prompt runs
under `bun test` and in a build without the flag.

## Public contract

Every export below keeps its name and signature, except `memoryAgeDays` (see
Out of scope): modules outside this unit, or the tests that stay beside it,
import it. Paths in "Used by" are under `src/` unless they start with
`scripts/`.

### `memdir.ts`

| Export | Signature | Used by |
|---|---|---|
| `ENTRYPOINT_NAME` | `'MEMORY.md'` | `commands/memory/memory.tsx`, `commands/memory/sortPrompt.ts`, `commands/memory/tidyPrompt.ts`, `memory/autoDream/consolidationPrompt.ts`, `memory/extract/extractMemories.ts`, `memory/ui/memoryDirRows.ts`, `teamMemPrompts.ts` |
| `MAX_ENTRYPOINT_LINES` | `200` | `sortPrompt.ts`, `tidyPrompt.ts` (and its test), `consolidationPrompt.ts`, `teamMemPrompts.ts` |
| `MAX_ENTRYPOINT_BYTES` | `25_000` | `sortPrompt.ts`, `tidyPrompt.ts` (and its test) |
| `countIndexEntries` | `(indexContent: string) => number` | `agent/attachments/injections.ts` |
| `EntrypointTruncation` (type) | `{ content: string; lineCount: number; byteCount: number; wasLineTruncated: boolean; wasByteTruncated: boolean }` | the result of `truncateEntrypointContent` |
| `truncateEntrypointContent` | `(raw: string) => EntrypointTruncation` | `memory/instructions/claudemd/parsing.ts`, for every `AutoMem` and `TeamMem` file it loads (the indexes and path-scoped memories) |
| `DIR_EXISTS_GUIDANCE` | `string` | `tidyPrompt.ts`, `consolidationPrompt.ts` |
| `DIRS_EXIST_GUIDANCE` | `string` | `teamMemPrompts.ts` |
| `ensureMemoryDirExists` | `(memoryDir: string) => Promise<void>` | `tools/AgentTool/agentMemory.ts` |
| `buildMemoryLines` | `(displayName: string, memoryDir: string, extraGuidelines?: string[]) => string[]` | `loadMemoryPrompt`, `buildMemoryPrompt`, `memoryPrompt.test.ts` |
| `hasExistingMemories` | `(memoryDir: string) => boolean` | `loadMemoryPrompt` |
| `areMemoryIndexesEmpty` | `(loaded: readonly Pick<MemoryFileInfo, 'type' \| 'content'>[]) => boolean` | `loadMemoryPrompt`, `teamMemPrompts.test.ts` |
| `buildMemoryStubLines` | same as `buildMemoryLines` | `loadMemoryPrompt`, `memoryPrompt.test.ts` |
| `buildMemoryPrompt` | `(params: { displayName: string; memoryDir: string; extraGuidelines?: string[] }) => string` | `agentMemory.ts` |
| `buildSearchingPastContextSection` | `(autoMemDir: string, lean?: boolean) => string[]`, `lean` defaulting to `false` | `teamMemPrompts.ts`, `extractionDefaults.test.ts` |
| `isLeanMemoryPromptEnabled` | `() => boolean` | `agent/prompts/prompts.ts` |
| `loadMemoryPrompt` | `(lean?: boolean) => Promise<string \| null>`, `lean` defaulting to `false` | `agent/prompts/prompts.ts`, `agent/QueryEngine.ts`, three benches in `scripts/bench/tokens/` |

`MemoryFileInfo` is the type of `memory/instructions/claudemd/types.ts`.

### `memoryTypes.ts`

| Export | Signature | Used by |
|---|---|---|
| `MEMORY_TYPES` | `readonly ['user', 'feedback', 'project', 'reference']` | `memoryDirRows.ts` (the width of its type tag) |
| `MemoryType` (type) | one of `MEMORY_TYPES` | `memory/memdir/memoryScan.ts` |
| `parseMemoryType` | `(raw: unknown) => MemoryType \| undefined` | `memoryScan.ts` |
| `TeamCategory` (type) | `{ dir: 'decisions' \| 'bugs' \| 'docs'; section: string; noun: string; type: MemoryType; compact: string; lean: string; description: string; whenToSave: string; whenNotToSave: string; bodyStructure: string; paths: string }` | through `TEAM_CATEGORIES` |
| `TEAM_CATEGORIES` | `readonly TeamCategory[]` | `agent/ui/collapseNestedMemory.ts` (order and nouns), `sortPrompt.ts`, `consolidationPrompt.ts`, `teamMemPrompts.ts` |
| `teamCategoryForPath` | `(filePath: string) => TeamCategory \| undefined` | `collapseNestedMemory.ts` |
| `renderTeamCategoriesCompact` | `(teamDir: string) => string[]` | `teamMemPrompts.ts` |
| `renderTeamCategoriesLean` | `(teamDir: string) => string[]` | `teamMemPrompts.ts` |
| `renderTeamCategoriesXml` | `() => string[]` | `sortPrompt.ts`, `consolidationPrompt.ts`, `memory/extract/prompts.ts` |
| `TYPES_SECTION_COMBINED` | `readonly string[]` | `extract/prompts.ts` |
| `TYPES_SECTION_INDIVIDUAL` | `readonly string[]` | `extract/prompts.ts` |
| `WHAT_NOT_TO_SAVE_SECTION` | `readonly string[]` | `extract/prompts.ts` |
| `MEMORY_FRONTMATTER_EXAMPLE` | `readonly string[]` | `extract/prompts.ts`, `memdir.ts`, `teamMemPrompts.ts` |

### `paths.ts`

| Export | Signature | Used by |
|---|---|---|
| `isAutoMemoryEnabled` | `() => boolean` | about seventeen modules: the memory commands, dream, extraction, the instruction loader, the agent wizard, the plugin and agent loaders, and this unit |
| `isExtractMemoriesEnabled` | `() => boolean` | `extractMemories.ts` |
| `isExtractModeActive` | `() => boolean` | `agent/query/stopHooks.ts`, `platform/headless/print/runHeadless.ts` |
| `getExtractionTurnInterval` | `() => number` | `extractMemories.ts` |
| `getMemoryBaseDir` | `() => string` | `memoryFileDetection.ts`, `agentMemory.ts` |
| `hasAutoMemPathOverride` | `() => boolean` | `QueryEngine.ts`, `permissions/filePermissions/internalPaths.ts` |
| `getAutoMemPath` | `() => string`, memoized with lodash `memoize`, so it carries `.cache` | thirteen modules and three tests; `sessions/rerootSession.ts` calls `getAutoMemPath.cache?.clear?.()` |
| `getAutoMemEntrypoint` | `() => string` | `memory/instructions/claudemd.ts`, `platform/config/config/derived.ts` |
| `isAutoMemPath` | `(absolutePath: string) => boolean` | `extractMemories.ts`, `memoryFileDetection.ts`, `internalPaths.ts` |

### `teamMemPaths.ts`

Several callers `require` it behind the team flag.

| Export | Signature | Used by |
|---|---|---|
| `isTeamMemoryEnabled` | `() => boolean` | `memdir.ts`, `claudemd.ts`, `extractMemories.ts`, `memoryFileDetection.ts`, `memory/ui/MemoryFileSelector.tsx`, `commands/dream/dream.ts`, `commands/memory/tidyTeam.ts`, `memory/autoDream/autoDream.ts` |
| `getTeamMemPath` | `() => string` | `memdir.ts`, `teamMemPrompts.ts`, `MemoryFileSelector.tsx`, `dream.ts`, `tidyTeam.ts`, `autoDream.ts` |
| `getTeamMemEntrypoint` | `() => string` | `claudemd.ts`, `derived.ts` |
| `isTeamMemLikelyGitIgnored` | `(gitRoot: string) => boolean`, memoized per root | `teamMemPrompts.ts` |
| `isTeamMemPath` | `(filePath: string) => boolean` | `pathScopedMemories.ts`, `memory/memdir/teamMemSecretGuard.ts`, `extractMemories.ts`, `memoryFileDetection.ts` |
| `isTeamMemFile` | `(filePath: string) => boolean` | `memory/memdir/teamMemoryOps.ts` (re-exported to `agent/tools/collapseReadSearch.ts`), `memoryFileDetection.ts` |

### The other files

| Export | Signature | Used by |
|---|---|---|
| `isAutoMemFile` (`memoryFileDetection.ts`) | `(filePath: string) => boolean` | `tools/FileReadTool/readDispatch.ts` |
| `isAutoManagedMemoryFile` (same) | `(filePath: string) => boolean` | `agent/tools/collapseReadSearch.ts` |
| `isMemoryDirectory` (same) | `(dirPath: string) => boolean` | `collapseReadSearch.ts` |
| `isShellCommandTargetingMemory` (same) | `(command: string) => boolean` | `collapseReadSearch.ts` |
| `isAutoManagedMemoryPattern` (same) | `(pattern: string) => boolean` | `collapseReadSearch.ts` |
| `buildCombinedMemoryPrompt` (`teamMemPrompts.ts`) | `(extraGuidelines?: string[], indexesEmpty?: boolean) => string`, `indexesEmpty` defaulting to `false` | `loadMemoryPrompt` |
| `buildLeanCombinedMemoryPrompt` (same) | same | `loadMemoryPrompt` |
| `PathScopedEntry` (type, `pathScopedMemories.ts`) | `{ path: string; globs: string[] }` | the index |
| `PathScopedScanFs` (type, same) | `{ readdir(dir: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>; readHead(filePath: string): Promise<string>; dirMtimeMs(dir: string): Promise<number> }` | the injectable filesystem of the index |
| `defaultPathScopedScanFs` (same) | `PathScopedScanFs` | `pathScopedMemories.test.ts` |
| `resetPathScopedMemoryCache` (same) | `() => void` | `agent/attachments/memory.pathScoped.test.ts`, `pathScopedMemories.test.ts` |
| `resolveGlobBaseDir` (same) | `(memoryDir: string, originalCwd: string) => string` | `pathScopedMemories.test.ts` |
| `matchesPathScope` (same) | `(globs: string[], baseDir: string, targetPath: string) => boolean` | `pathScopedMemories.test.ts` |
| `getPathScopedIndex` (same) | `(memoryDir: string, fs?: PathScopedScanFs) => Promise<PathScopedEntry[]>` | `pathScopedMemories.test.ts` |
| `findPathScopedMemoryFiles` (same) | `(options: { targetPath: string; memoryDir: string; originalCwd: string; processedPaths: Set<string>; fs?: PathScopedScanFs }) => Promise<MemoryFileInfo[]>` | `pathScopedMemories.test.ts` |
| `getPathScopedMemoryFiles` (same) | `(targetPath: string, processedPaths: Set<string>) => Promise<MemoryFileInfo[]>` | `agent/attachments/memory.ts` |
| `memoryFreshnessNote` (`memoryAge.ts`) | `(mtimeMs: number) => string` | `tools/FileReadTool/resultContent.ts` |
| `memoryAgeDays` (same) | `(mtimeMs: number) => number` | nothing (see Out of scope) |
| `projectIsInGitRepo` (`versions.ts`) | `(cwd: string) => boolean` | `MemoryFileSelector.tsx` |
| `MEMORY_TYPE_VALUES` (`types.ts`) | `readonly ['User', 'Project', 'Local', 'Managed', 'AutoMem']`, plus `'TeamMem'` last when the team flag is on | `agent/compact/postCompactAttachments.ts` |
| `MemoryType` (type, `types.ts`) | one of `MEMORY_TYPE_VALUES` | the instruction loader (`claudemd.ts` and six files under `claudemd/`), `injections.ts`, `pathScopedMemories.ts`, `derived.ts` |

**Two types share the name `MemoryType`.** The one in `memoryTypes.ts` is the four-value
taxonomy of a memory file. The one in `types.ts` is the kind of an instruction
file the loader produces. Callers import each by its path, so both stay.

## Observable behaviour

### 1. The switches

Every switch is read when it is called, never cached by this unit. A
**truthy** value is `1`, `true`, `yes` or `on`, and an **off value** is `0`,
`false`, `no` or `off`. Both ignore case and surrounding spaces
(`src/shared/envUtils.ts`).

**`isAutoMemoryEnabled()`.** The first rule that applies decides:
1. `CLAUDIN_DISABLE_AUTO_MEMORY`: a truthy value turns memory off, and an off value turns it on over every rule below. Any other value decides nothing.
2. Bare mode, `CLAUDIN_SIMPLE` truthy: off.
3. A remote session, `CLAUDE_CODE_REMOTE` truthy, with `CLAUDE_CODE_REMOTE_MEMORY_DIR` unset or empty: off.
4. `autoMemoryEnabled` in the merged settings (`getInitialSettings()`), from any layer, the project's checked-in settings included, so a project can opt out.
5. Otherwise on.

**The others:**
- **`isExtractMemoriesEnabled()`:** on unless `CLAUDIN_EXTRACT_MEMORIES` is an off value.
- **`isExtractModeActive()`:** that, and an interactive session. Callers also check the `EXTRACT_MEMORIES` build flag and `isAutoMemoryEnabled()`.
- **`getExtractionTurnInterval()`:** `CLAUDIN_EXTRACT_MEMORIES_EVERY` read as a leading integer, so `7.9` gives 7 and `12 turns` gives 12. Unset, empty, zero, negative or non-numeric gives 15; above 1000 gives 1000. It goes through `validateBoundedIntEnvVar` (`src/shared/envValidation.ts`).
- **`isLeanMemoryPromptEnabled()`:** on unless `CLAUDIN_LEAN_MEMORY_PROMPT` is an off value. `prompts.ts` applies the lean text to the Anthropic model family only.
- **The past-context search:** `CLAUDIN_MEMORY_PAST_CONTEXT` set to an off value removes the section of 10.4 in both its forms. Any other value keeps it.

### 2. Where memory lives

**`getMemoryBaseDir()`:** `CLAUDE_CODE_REMOTE_MEMORY_DIR` when it is not empty, else
the config home (`CLAUDIN_CONFIG_DIR`, or `~/.claudin`).

**`getAutoMemPath()`, the private directory.** It always ends in exactly one
path separator and is NFC-normalized. The first step that applies gives it:
1. **The environment override,** `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, if it passes validation. `~` is not expanded here.
2. **The `autoMemoryDirectory` setting,** if it passes validation. The layers are read in this order, and the first one that defines the key decides: policy (managed settings), flag (`--settings`), local (`.claudin/settings.local.json`), user (`<config home>/settings.json`). "Defines" includes an invalid or empty string, which then makes this step not apply instead of falling to a lower layer. The project's `.claudin/settings.json` is never read for it. `~/` and `~\` expand to the home directory.
3. **The project-local directory,** `<repository root>/.claudin/memory/`. It applies when the project root is inside a git repository, and `autoMemoryProjectLocal` is not `false`. That key is read from the same four layers in the same order, the project file never, and defaults to on. Before it is used:
   - it is created with its parents, mode 0700;
   - its real path must lie inside the repository's real root. When it does not (a symlinked `.claudin` or `.claudin/memory` leading out), or when it cannot be created or resolved, step 4 applies instead;
   - its mode is set to 0700 even if it existed (best effort);
   - legacy memory is copied in (below).
4. **The legacy location,** `<memory base>/projects/<slug>/memory/`. The slug is `sanitizePath` (`src/sessions/sessionStoragePortable.ts`) of the repository root, or of the project root outside a repository: every character but ASCII letters and digits becomes `-`, and a slug over 200 characters is cut and suffixed with a hash. The same slug names the session transcripts directory. The lookup does not create this directory.

**The repository root** is `findCanonicalGitRoot(getProjectRoot())` (`src/vcs/git/git.ts`):
- every worktree of a repository resolves to the main checkout, so all of them share one memory directory;
- a project root below the repository root resolves to that root.

**Validating an override.** The value is normalized (dot segments resolved), and
trailing separators are removed. It is rejected when it is:
- relative;
- shorter than 3 characters (`/`, `/a`);
- a bare drive (`C:`);
- a UNC path (starting with `\\` or `//` after normalization);
- a path containing a NUL byte.

On POSIX, normalization turns a leading `//` into `/`, so such a value is
accepted as an ordinary absolute path. For the setting, `~`, `~/`, `~/.`,
`~/..` and any `~/…` that normalizes back to the home directory or above are
rejected too.

**The memo.** The answer is memoized per `getProjectRoot()`:
- a different project root computes afresh;
- changes to the environment, the settings or the config home are not seen until `getAutoMemPath.cache.clear()`;
- `rerootSession.ts` clears it when the session moves to another directory.

**`getAutoMemEntrypoint()`:** the private directory joined with `MEMORY.md`.

**`hasAutoMemPathOverride()`:** true exactly when the environment override is set
and valid. The setting does not count.
- The query engine injects the memory prompt into an SDK custom system prompt only when it is true.
- The permission layer withholds its write carve-out for the memory directory when it is true.

**`isAutoMemPath(path)`:** the path, with its dot segments resolved, starts with the
private directory including its trailing separator. So:
- the directory itself is inside only when written with its separator;
- a sibling sharing the prefix (`memory-old/`) is outside;
- a relative path is outside;
- symlinks are not resolved.

**Moving legacy memory in.** The first time step 3 applies for a project root in a process:
- if the project-local directory holds no memory, and the legacy directory for the same root holds some, the legacy directory is copied into it recursively;
- nothing that already exists is overwritten, and the legacy copy stays where it was;
- "holds memory" means a `MEMORY.md` with non-blank content, or any other `.md` file directly in the directory;
- a failure is logged and never thrown.

The copy itself is `migrateGlobalMemoryIfNeeded` in `memoryMigration.ts`, which
is outside this unit.

### 3. The team directory

- **`isTeamMemoryEnabled()`** equals `isAutoMemoryEnabled()`.
- **`getTeamMemPath()`** is `<private directory>team/`, with its trailing separator.
- **`getTeamMemEntrypoint()`** is `<private directory>team/MEMORY.md`.
- **`isTeamMemPath(path)`** resolves the path to an absolute one first, against the process working directory. That removes dot segments and any trailing separator. It then tests the prefix `getTeamMemPath()`. So files below `team/` are inside, and `team/` itself is not. Symlinks are not resolved.
- **`isTeamMemFile(path)`** is `isTeamMemoryEnabled() && isTeamMemPath(path)`.
- **`isTeamMemLikelyGitIgnored(gitRoot)`** answers whether the repository's root `.gitignore` swallows `.claudin/`. It is a best-effort heuristic:
  - each line is trimmed (CRLF files work), and blank lines and `#` comments are skipped;
  - a line that is exactly `.claudin`, `/.claudin`, `.claudin/` or `/.claudin/` marks the directory ignored;
  - a line starting `!.claudin/memory/team` or `!/.claudin/memory/team` marks it not ignored;
  - the last such line wins, and every other shape (`.claudin/*`, `.claudin/**`, `src/.claudin`, nested ignore files) is not recognized;
  - a missing or unreadable file gives `false`;
  - the answer is memoized per root for the process.
- **`projectIsInGitRepo(cwd)`:** true when `cwd` or an ancestor has a `.git` directory or file (worktrees count). It walks the filesystem and runs no git.

### 4. The index, `MEMORY.md`

**The constants:** `ENTRYPOINT_NAME` is `MEMORY.md`, `MAX_ENTRYPOINT_LINES` is 200, and
`MAX_ENTRYPOINT_BYTES` is 25,000.

**`truncateEntrypointContent(raw)`.** It measures the input with its leading and trailing whitespace trimmed:
- **The counts.** `lineCount` is the number of `\n`-separated lines, and `byteCount` the UTF-8 byte length.
- **The flags.** `wasLineTruncated` is `lineCount > 200`, and `wasByteTruncated` is `byteCount > 25000`. The byte flag reads the original size, even when the line cut alone brings the text under the cap.
- **Under both caps.** `content` is the trimmed text.
- **Over a cap,** `content` is:
  1. the first 200 lines when over the line cap, else the whole text;
  2. if that is still over 25,000 bytes, cut at the last newline at or before byte 25,000, which is dropped. With no such newline, cut at byte 25,000, moved back to the first byte of the character it falls in. So the cut never splits a character and never exceeds 25,000 bytes;
  3. then an empty line and the warning line.
- **The warning line** is one line starting `> WARNING: MEMORY.md is `, then the reason:
  - line cap only: `<lineCount> lines (limit: 200)`;
  - byte cap only: `<size> (limit: <size of 25,000>)`, then a note that the index entries are too long;
  - both: `<lineCount> lines and <size>`.

  Sizes are as `formatFileSize` (`src/shared/text/format.ts`) renders them, for example `29.4KB` and `24.4KB`. After the reason, the line has to state that the model got only part of the index, and advise keeping each entry to one line of about 200 characters at most, with the details moved to topic files. It starts with `> ` so it is never counted as an entry.

**`countIndexEntries(text)`.** It counts the lines that start, at column 0, with `-`,
then one or more spaces or tabs, then a non-space character:
- **An entry:** a link entry, or prose after the dash (one line grouping several memories).
- **Not an entry:** a heading, a blank line, an indented sub-bullet, a `*` or `+` item, `-x`, or a bare `-`.
- **Line endings:** CRLF works.

`injections.ts` counts both the loaded content and the raw file. The gap between
the two is how the transcript line (`… index (N of M entries) — index truncated`)
knows the index was cut.

### 5. Directory helpers

- **`ensureMemoryDirExists(dir)`** creates the directory and its parents. When it already exists, nothing happens. It never rejects: a failure (a parent that is a file, a permission) is logged at debug level, and the directory is not there.
- **`hasExistingMemories(dir)`** expects `dir` to end with a separator. It is true when `<dir>MEMORY.md` has non-blank content, or when `dir` directly holds a regular file whose name ends in `.md`, other than `MEMORY.md`. It is false for:
  - a missing or empty directory;
  - a blank index;
  - other files;
  - a directory named `*.md`;
  - files in subdirectories.
- **`areMemoryIndexesEmpty(loaded)`** is false exactly when an entry of type `AutoMem` or `TeamMem` has non-whitespace content. Entries of other kinds never count. `loaded` is what `getMemoryFiles()` loaded, where an absent index has no entry.

### 6. What counts as memory

**`isAutoMemFile(path)`:** auto memory is on and `isAutoMemPath(path)`.

**`isAutoManagedMemoryFile(path)`** is true when any of these holds:
- `isAutoMemFile(path)`;
- with the team flag on, `isTeamMemFile(path)`;
- **a session file under the config home.** The path starts with the config home, and either contains `/session-memory/` and ends in `.md` (a session summary, `<config>/projects/<slug>/<session id>/session-memory/summary.md`), or contains `/projects/` and ends in `.jsonl` (a transcript). This case does not depend on auto memory being on;
- **agent memory,** while auto memory is on: `isAgentMemoryPath(path)` (`src/tools/AgentTool/agentMemory.ts`). That covers `<memory base>/agent-memory/…`, `<cwd>/.claudin/agent-memory/…` and `<cwd>/.claudin/agent-memory-local/…`.

User-managed instruction files are not memory: `CLAUDE.md`, `AGENTS.md`,
`CLAUDE.local.md`, `.claudin/rules/*.md` and the settings files.

**`isMemoryDirectory(dir)`.** The path is normalized first. It is true when any of these holds:
- auto memory is on and the path contains `/agent-memory/` or `/agent-memory-local/`, anywhere;
- the team flag is on, team memory is on, and `isTeamMemPath(dir)`;
- auto memory is on and the path is the private directory, with or without its separator, or lies below it;
- the path lies under the config home or the memory base, and one of these holds:
  - it contains `/session-memory/`;
  - it lies under the config home and contains `/projects/`;
  - auto memory is on and it contains `/memory/`.

Anything else is not memory, the config home itself included.

**`isShellCommandTargetingMemory(command)`.** It is false unless the command's text
contains one of these: the config home, the memory base, or (while auto memory
is on) the private directory without its trailing separator. Then:
- **The tokens.** Every absolute-path-like token is taken: one starting with `/` or with a drive letter and a separator, and running until whitespace or a quote.
- **The punctuation.** Trailing `,`, `;`, `|`, `&` and `>` characters are dropped from each token.
- **The answer.** The command targets memory when a token satisfies `isAutoManagedMemoryFile` or `isMemoryDirectory`.

Quoted paths work. Punctuation inside a token, as in `/dir|wc`, is not stripped.

**`isAutoManagedMemoryPattern(glob)`** is true when one of these holds:
- the glob contains `session-memory` and either contains `.md` or ends in `*`;
- it contains `.jsonl` (see finding 2);
- auto memory is on and it contains `agent-memory/` or `agent-memory-local/`, with backslashes read as slashes.

Other globs are false, including one for `MEMORY.md`.

**On Windows** these comparisons fold case and normalize separators, and a MinGW
`/c/…` token is converted to its native form. That is not reachable on the
platforms the suite runs on.

### 7. The staleness note

**`memoryFreshnessNote(mtimeMs)`.** The age is whole days, rounded down, from the
mtime to now, and a future mtime counts as today.
- **Up to one day old,** the note is the empty string.
- **Older,** it is one `<system-reminder>…</system-reminder>` block followed by a newline, and it has to:
  - give the age, in the form `<N> days old`;
  - make clear the memory records what held when it was written, and is not a live view;
  - warn that what it says about how code behaves, and any `file:line` it cites, may no longer hold;
  - ask the model to check the current code before it states any of it as fact (the word "verify" appears).

The Read tool prefixes it to the content of a file for which `isAutoMemFile` is
true, using that file's mtime.

### 8. Path-scoped memories

A memory file whose frontmatter has `paths:` is attached the first time a Read
touches a matching file. It uses the same key, syntax and semantics as a rule in
`.claudin/rules/` (`inspectRuleFrontmatter` in
`src/memory/instructions/ruleFrontmatter.ts`), and the same `nested_memory`
lane. The one difference: a memory without `paths:` is index-only, where such a
rule is always on. A `paths:` that normalizes to nothing leaves the memory
index-only too, for example `**` alone or a value of the wrong shape.

**`resolveGlobBaseDir(memoryDir, originalCwd)`.** Trailing separators are ignored.
When the directory's parent is named `.claudin`, the globs anchor at the
directory holding that `.claudin`. That is the repository root for the
project-local location, like the project's own rules. Anywhere else they anchor
at the original cwd, like managed and user rules. The test is on the name only
(see finding 6).

**`matchesPathScope(globs, baseDir, targetPath)`.** An absolute target is made
relative to the base, and a relative one is taken as already relative to it.
- **Never a match:** an empty result (the base itself), one starting with `..`, or one that stays absolute.
- **Otherwise,** the globs match with gitignore semantics (the `ignore` package), and any one glob is enough:
  - a directory pattern matches everything under it;
  - a pattern without a slash matches at any depth;
  - `*` does not cross `/`.

**`getPathScopedIndex(memoryDir, fs?)`** gives `{ path, globs }` for each memory file that declares `paths:`. `globs` is the normalized list, with a trailing `/**` removed.
- **Which files:**
  - the walk goes to files in the directory, in its subdirectories, and in their subdirectories, and no deeper;
  - only regular files ending in `.md`;
  - never a `MEMORY.md`, at any level, whatever its frontmatter;
  - only the head of each file is read (the first 30 lines through `defaultPathScopedScanFs`), which is where the frontmatter is;
  - symlinked files and symlinked directories are skipped;
  - an unreadable directory or file is skipped, and nothing is thrown.
- **The memo:**
  - the result is memoized per process for one directory at a time;
  - before reuse, the mtime of every directory the last scan walked is compared, and any difference, or a directory that has gone, makes it rescan. Writing, removing or moving a file in a walked directory bumps its mtime, so no hook is needed. Editing the `paths:` of an existing file in place does not, and is picked up by the next change in that directory or by a new process;
  - a different directory rescans;
  - a directory that does not exist gives `[]` and is not memoized, so it is found once it appears;
  - `resetPathScopedMemoryCache()` forgets the memo.
- **`defaultPathScopedScanFs`** reads directories with their entry types, a file's first 30 lines, and a directory's mtime.

**`findPathScopedMemoryFiles({ targetPath, memoryDir, originalCwd, processedPaths, fs? })`.**
- **Nothing to match.** With no index entries it returns `[]`, and `processedPaths` is untouched.
- **A match.** For every entry whose globs match the target (anchored as above), it returns what `processMemoryFile` (`src/memory/instructions/claudemd/processing.ts`) returns for that path. That brings the frontmatter strip, `globs`, the `AutoMem` index caps of section 4 as a bound, `contentDiffersFromDisk` and `rawContent`, and the `claudeMdExcludes` setting.
  - The type is `TeamMem` for a file under the team directory when the team flag is on, else `AutoMem`.
  - `processedPaths` is the caller's dedupe set for one trigger: a file already in it is skipped, and a returned file is added to it.
  - Several matches are all returned, in no pinned order.

**`getPathScopedMemoryFiles(targetPath, processedPaths)`** returns `[]` while auto memory is off. Otherwise it is
`findPathScopedMemoryFiles` over `getAutoMemPath()` and `getOriginalCwd()`.

### 9. The taxonomy and the formats on disk

**The memory types.** They are `user`, `feedback`, `project` and `reference`, in that order.
`parseMemoryType` accepts exactly those strings (case matters) and gives
`undefined` for anything else, non-strings included. A file without a valid
`type:` still loads.

**A memory file.** One fact per `.md` file:
- **The frontmatter** has the top-level keys `name` (a short kebab-case slug), `description` (one specific line, used to judge relevance at recall) and `type`. `memoryScan.ts` reads `type` at the top level, so it must never be nested (under `metadata:`, say).
- **The body** gives the fact. For `feedback` and `project` it adds a `**Why:**` line and a `**How to apply:**` line. It links other memories with `[[name]]`, where `name` is the other memory's `name:` slug.
- **`paths:`** is optional (section 8).
- **Team decisions** add `scope:` and `impact:`.

**`MEMORY_FRONTMATTER_EXAMPLE`** is a fenced example of that shape:
- it opens with a ```` ```markdown ```` line and closes with a ```` ``` ```` line;
- then `---`, the three keys in the order `name`, `description`, `type`, and `---`;
- then an empty line and a body placeholder;
- the type line is exactly `type: {{user | feedback | project | reference}}`, the four types joined by ` | `;
- the placeholders ask for a kebab-case slug, a description specific enough to judge relevance, and a body with the `**Why:**`, `**How to apply:**` and `[[…]]` cues;
- no line is indented, and nothing mentions `metadata`.

**An index line.** `- [Title](file.md) — hook`: one line per memory, under about 150
characters, with no frontmatter in the index and never memory content. A
categorized team memory goes under its section heading of the team index
(`## Decisions`, `## Bugs` or `## Docs`), with the subdirectory in the link:
`- [Title](bugs/file.md) — hook`.

**The directories.**

| Directory | Holds |
|---|---|
| `<memory dir>` | private memories and the private `MEMORY.md` |
| `<memory dir>team/` | team memories that are not categorized (a convention, a process finding), and the team `MEMORY.md` |
| `<memory dir>team/decisions/` | team decisions |
| `<memory dir>team/bugs/` | known defects |
| `<memory dir>team/docs/` | pointers to documentation |

**`TEAM_CATEGORIES`**, in this order. Its order is the order of the transcript's
count line (`collapseNestedMemory.ts`), and each `noun` is its unit ("4 team bug
memories").

| `dir` | `section` | `noun` | `type` |
|---|---|---|---|
| `decisions` | `Decisions` | `decision` | `project` |
| `bugs` | `Bugs` | `bug` | `project` |
| `docs` | `Docs` | `doc` | `reference` |

Each category has seven texts: `compact`, the one line the full system prompt
shows; `lean`, the shorter one line of the v2 prompt, always shorter than
`compact`; and `description`, `whenToSave`, `whenNotToSave`, `bodyStructure` and
`paths`, which the verbose tagged rendering shows. They carry these facts:

- **`decisions`.** A product, business or architecture decision that changes what the project does or how it is structured.
  - **The bar.** Only an impactful one qualifies: **structural** (where things live, how the system is organized), **functional** (what a feature does for its users: a capability, a default, a policy) or **rejected** (an alternative that was discarded, with the reason).
  - **The why.** It must lie outside the diff: a measurement, a cost, a user preference, a compliance or incident reason. The decision must also be one a reader of the code would be surprised by or tempted to undo.
  - **The frontmatter** adds `scope:` (the feature or slice) and exactly `impact: structural | functional | rejected`.
  - **The body** leads with `**Decision:**`, `**Why:**`, `**What changes for a teammate:**`, `**Rejected:**` and `**Evidence:**`. When "what changes for a teammate" would be empty, it is not a team decision. `compact`, `lean` and `bodyStructure` all state the frontmatter and these headings. `compact` and `whenToSave` name the three classes and the diff test.
  - **It does not qualify:** a choice inside one function or file, a name, test scaffolding, anything reversible without consequence, anything the commit and diff explain, a decision whose scope cannot be named. Most decisions in a plan are implementation choices.
  - **`paths`** is given only when the decision is tied to specific files.
- **`bugs`.** A known or latent defect deliberately left in place, or a failure mode invisible from the code.
  - **What to record:** the symptom, where it lives, how to reproduce it, and its status with an absolute date. `compact` and `lean` name all four.
  - **When:** confirmed but left in place (pinned by a test, out of scope, waiting on a decision), or real but invisible (an environment, a timing, a provider quirk).
  - **Not:** a bug fixed in the same session, or a hunch not reproduced.
  - **The body:** `**Symptom:**`, `**Where:**`, `**Repro:**`, `**Status:**` and `**Why not fixed:**`.
  - **`paths`** lists the files the defect lives in.
- **`docs`.** Where a subsystem's documentation lives (a design doc, a living spec, a dashboard, a wiki page) and what it holds, so work starts there.
  - **The type.** `compact` and `lean` state `type: reference`.
  - **When:** the document explains the subsystem better than the code does.
  - **Not:** a pointer to something the code already names, such as a README beside the module or a comment.
  - **The body:** `**Doc:**`, `**Covers:**`, `**Start here when:**` and `**Kept in sync by:**`.
  - **`paths`** gives the subsystem's directory.

Every `paths` text names `` `paths:` ``.

**`teamCategoryForPath(path)`.** It reads the category off the name of the file's
parent directory, without touching the disk:
- `team/bugs/x.md` is a bug, and so is `…/bugs/x.md` outside the team directory (callers check the file's `TeamMem` type first);
- a file at the team root, a file one level deeper (`bugs/archive/x.md`) and the directory itself (`…/bugs` or `…/bugs/`) have no category.

### 10. The prompt texts

Every text below is a prompt: the rewrite writes its own prose. For each one,
this section says what it has to get the model to do and the facts it has to
state exactly. Backticks in the facts are part of the text.

#### 10.1 The directory guidance constants

- **`DIR_EXISTS_GUIDANCE`** tells the model the directory is there already: it puts files into it with the Write tool, and neither creates it with `mkdir` nor checks for it first. The text names `Write tool` and `mkdir`, and says the directory already exists.
- **`DIRS_EXIST_GUIDANCE`** says the same of two directories, and uses the word "both".

Other prompts embed them verbatim.

#### 10.2 The full private text, `buildMemoryLines(displayName, memoryDir, extraGuidelines?)`

It returns an array of lines. The first line is `# <displayName>`. It has to:

1. **Name the memory.** The model has memory that lasts across sessions, kept as files in `` `<memoryDir>` ``. That line also carries `DIR_EXISTS_GUIDANCE` verbatim.
2. **Show the format.** Each file holds a single fact under a frontmatter header, as in `MEMORY_FRONTMATTER_EXAMPLE`, reproduced whole on consecutive lines.
3. **Explain the links.** A body may point at another memory as `` `[[name]]` ``, using that memory's `` `name:` `` slug. Linking to a memory that nobody has written yet is allowed: it flags a gap, not a mistake.
4. **Name the four types** in backticks, each with its gist:
   - `user`: the person the model works with;
   - `feedback`: the user's steer on how to work, taken from corrections and from approaches they approved, with the reason;
   - `project`: work under way, and constraints the code and the git history do not show, with every date made absolute;
   - `reference`: where outside resources live.
5. **Teach the index.**
   - Every saved memory also gets a pointer line in `` `MEMORY.md` ``, written `` `- [Title](file.md) — hook` ``.
   - The index is what enters context at each session start: one pointer per memory, no frontmatter, no memory content.
   - Anything past line 200 (`MAX_ENTRYPOINT_LINES`) is truncated.
6. **Explain `paths:`.** The model opens a memory file by following its pointer. A memory with `` `paths:` `` in its frontmatter is, in addition, attached by itself the first time a Read hits a matching file. The key works exactly like a rule's in `` `.claudin/rules/` ``, with globs relative to the project root.
7. **Give the saving rules.**
   - Look for a file that already covers the fact, and update it rather than adding a duplicate. Delete what turns out wrong.
   - Leave out what the repository already records (code structure, past fixes, git history, `CLAUDE.md`), and what only this conversation needs. Asked to remember such a thing, the model asks what about it was non-obvious, and keeps that part.
   - An explicit "remember this" is saved at once, under whichever type fits. An explicit "forget this" means finding the memory and removing it.
8. **Frame recall.** Recall delivers memories wrapped in `` `<system-reminder>` `` blocks. The model treats them as background, not as instructions from the user, and as true at the time of writing only. Before recommending a file, function or flag a memory names, it confirms the thing still exists (the text says "verify").
9. **Keep the current conversation out.** Memory serves future conversations. The approach for this one goes in a Plan, and its steps in tasks.
10. **Carry the extra guidelines,** one line each, after the rules above.
11. **End with the search section:** the lines of `buildSearchingPastContextSection(memoryDir)`, exactly. They are absent when the switch is off.

#### 10.3 The empty-directory text, `buildMemoryStubLines(displayName, memoryDir, extraGuidelines?)`

The first line is `# <displayName>`. It has to:
- **Name the directory,** with `DIR_EXISTS_GUIDANCE` verbatim on the same line.
- **Say there is nothing in it yet** (the word "empty" appears), and that the point is to gather, over time, what later sessions need: who the user is, how they like to work, and the background of their tasks.
- **Save at once** when the user explicitly asks to remember something.
- **Give the file format.** A memory is a `` `.md` `` file of its own, with `` `name` ``, `` `description` ``, and a `` `type` `` that is one of `` `user` ``, `` `feedback` ``, `` `project` `` or `` `reference` ``, each glossed in a few words. The `type` key sits at the top level: `metadata` does not appear.
- **Leave out the derivable:** what the code, the git history or this conversation alone already give.
- **Add the pointer.** Afterwards, one line goes into `` `MEMORY.md` ``, written `` `- [Title](file.md) — hook` ``. The index takes no frontmatter and no memory content.
- **Carry the extra guidelines,** then end with the search section, exactly as in 10.2.

It has no fenced frontmatter example and no recall guidance. It is less than half the length of 10.2.

#### 10.4 The past-context search, `buildSearchingPastContextSection(autoMemDir, lean = false)`

It returns `[]` when `CLAUDIN_MEMORY_PAST_CONTEXT` is an off value. The
transcripts directory is `<config home>/projects/<slug of the original cwd>`,
which is `getProjectDir(getOriginalCwd())`, and the commands name it with a
trailing `/`.

**The two commands.** `hasEmbeddedSearchTools()` (`src/agent/tools/embeddedTools.ts`)
decides the form. It is true when `EMBEDDED_SEARCH_TOOLS` is truthy, unless
`CLAUDE_CODE_ENTRYPOINT` is `sdk-ts`, `sdk-py`, `sdk-cli` or `local-agent`.
- **The tool form**, `GREP_TOOL_NAME` being `Grep`:
  - memory: `Grep with pattern="<search term>" path="<autoMemDir>" glob="*.md"`;
  - transcripts: `Grep with pattern="<search term>" path="<transcripts dir>/" glob="*.jsonl"`.
- **The embedded form:**
  - memory: `grep -rn "<search term>" <autoMemDir> --include="*.md"`;
  - transcripts: `grep -rn "<search term>" <transcripts dir>/ --include="*.jsonl"`.

**The full form** has these lines, in order:
1. The heading `## Searching past context`.
2. The memory's topic files, searched first. The memory command stands alone between two ```` ``` ```` lines.
3. The transcripts, as a last resort because they are large and slow. The transcript command stands alone between two ```` ``` ```` lines.
4. Advice to prefer narrow terms, such as an error message, a file path or a function name, over broad words.
5. An empty last line.

**The lean form** is one line with both commands, the memory's first and the
transcripts as a slow last resort, and the same advice about narrow terms.

#### 10.5 The agent-memory prompt, `buildMemoryPrompt({ displayName, memoryDir, extraGuidelines })`

It is `buildMemoryLines(displayName, memoryDir, extraGuidelines)`, then `## MEMORY.md`,
then an empty line, then:
- **with an index:** `truncateEntrypointContent` of `<memoryDir>MEMORY.md`, which trims it and, over a cap, cuts it and adds the warning;
- **with a missing or blank index:** one line telling the model its `MEMORY.md` has nothing in it yet (the word "empty" appears), and that the memories it saves will show up in this place.

The lines are joined with `\n`. It reads the file synchronously, and it creates nothing.

#### 10.6 The full team prompt, `buildCombinedMemoryPrompt(extraGuidelines?, indexesEmpty = false)`

Shipped when `CLAUDIN_LEAN_MEMORY_PROMPT` is off, or for a model outside the
Anthropic family. It reads its directories at call time: `getAutoMemPath()` and
`getTeamMemPath()`. The first line is `# Memory`. It has to:

1. **Name both directories.** Memory lives in two places: a private directory at `` `<auto dir>` ``, between the model and this user (the word "private" appears), and a team directory at `` `<team dir>` ``, which everyone on the project adds to. The team one is `git-tracked`: what the model writes there appears in `` `git status` `` and travels to teammates with normal commits. Then `DIRS_EXIST_GUIDANCE`, verbatim.
2. **Say what it is for.** It accumulates what later sessions need: who the user is, how they like to collaborate, and the background of their work. An explicit "remember this" is saved at once; an explicit "forget this" means finding the memory and removing it.
3. **Show the format.** Each file holds a single fact under a frontmatter header, as in `MEMORY_FRONTMATTER_EXAMPLE`, reproduced whole on consecutive lines.
4. **Explain the links.** `` `[[name]]` `` points at another memory by its `` `name:` `` slug, in either directory, and may point at one not written yet.
5. **Give each type its scope,** each type named in backticks:
   - `user` is `always private`: role, expertise, goals, preferences, and no judgments against the person;
   - `feedback` is private unless it is a convention the whole project must follow, such as a testing policy or a build invariant (a matter of personal style stays private). It comes from corrections and from approaches the user confirmed, and states the rule first, then `**Why:**` and `**How to apply:**` lines;
   - `project` leans to team: work in progress, decisions, defects and constraints that neither the code nor the git history shows, dated absolutely, with the reason;
   - `reference` is mostly team: where outside systems keep information, and what each holds.
6. **Lay out the team directory.** It is arranged around what a teammate will look for. Then `renderTeamCategoriesCompact(<team dir>)`, verbatim and consecutive, then a line saying that team-scoped notes of any other kind stay at the team root.
7. **Say what is in context.** Of all the memory, only the two `` `MEMORY.md` `` indexes enter context, and the model opens a memory file by following its pointer (the word "indexes" appears). When `indexesEmpty` is set, the empty-index note (10.8) comes right here, in the same line. Then the `` `paths:` `` clause of 10.2, item 6, with the hint that a bug or doc memory tied to particular files should carry one.
8. **Teach the index.**
   - Each new memory gets a pointer line in the index of the directory it went to, written `` `- [Title](file.md) — one-line hook` ``: at most about 150 characters, no frontmatter, no memory content.
   - For a categorized team memory, the pointer belongs in the team index under the heading of its category, and the text names the headings as `## Decisions / ## Bugs / ## Docs`. The model adds the heading when it is missing, and the link includes the category directory, as in `` `- [Title](bugs/file.md) — hook` ``.
   - One index per directory, both loaded at every session start; past line 200 each is truncated.
   - The frontmatter stays truthful, and files are organized by topic rather than by date.
9. **Give the saving rules.** Look for an existing memory to update before adding one, so there is no duplicate, and correct or delete memories that turn out wrong. Leave out what the code, the git history or this conversation already hold, and what only the task at hand needs. Secrets (API keys, credentials) never go into team memory.
10. **Give the recall rules.**
    - Relevant memories are applied, private or team.
    - A request to recall or remember obliges the model to look in memory; a request to ignore memory means acting as though it held nothing.
    - Recall delivers memories wrapped in `` `<system-reminder>` `` blocks, to be taken as background and not as instructions from the user. That includes team memories, which any contributor can write.
    - Anything a memory claims (a file, a function, a flag) is checked against the present before the model relies on it (the text says "verify"). When they disagree, the present wins, and the memory is corrected or removed.
11. **Keep plans and tasks out.** Memory serves future conversations. The approach for this one goes in a Plan, and its steps in tasks.
12. **Carry the extra guidelines,** one line each.
13. **Add the `.gitignore` advice** (10.9), when it applies.
14. **End** with an empty line and the full search section for the private directory, exactly `buildSearchingPastContextSection(<auto dir>)`.

#### 10.7 The lean team prompt, `buildLeanCombinedMemoryPrompt(extraGuidelines?, indexesEmpty = false)`

This is the v2 text, which `prompts.ts` ships by default to the Anthropic family.
It names every mechanism 10.6 teaches, in under two thirds of its length. The
first line is `# Memory`. In order, it has to cover:

1. **The two directories,** each in backticks, and the team one `git-tracked` (`` `git status` ``, commits). Then `DIRS_EXIST_GUIDANCE` verbatim, what is worth keeping, saving at once on "remember", and removing on "forget".
2. **The format:** a single fact per file, and `MEMORY_FRONTMATTER_EXAMPLE`, whole.
3. **The links:** `` `[[name]]` `` names another memory by its `` `name:` ``, and may name one that does not exist yet.
4. **The types, in one paragraph,** with the same scope facts as 10.6, item 5: `user` is `always private`; `feedback` carries `**Why:**` and `**How to apply:**`, and is team only as a project-wide convention; `project` leans to team, with absolute dates; `reference` is mostly team.
5. **The categories:** `renderTeamCategoriesLean(<team dir>)`, verbatim and consecutive, then the team-root line.
6. **One paragraph on the indexes.**
   - The two `` `MEMORY.md` `` indexes are all of memory that enters context (the word "indexes" appears), and the empty-index note (10.8) follows that statement directly.
   - The pointer `` `- [Title](file.md) — hook` `` (about 150 characters at most) goes into the directory's own index. A categorized team memory goes under its heading of `## Decisions / ## Bugs / ## Docs`, with the category directory as part of the link (the words "subdirectory" and "link" appear).
   - Past line 200 an index is truncated.
   - The `` `paths:` `` clause, in rule syntax, relative to the project root, on the first matching Read.
   - Updating beats duplicating; what the code, the git history or the conversation hold is skipped; secrets never go into team memory.
7. **The recall paragraph:** the `` `<system-reminder>` `` wrapping, background and not instructions from the user; looking in memory when asked to recall or remember; acting as if it were empty when told to ignore it; checking a memory against the present before acting on it; and a Plan and task lists are not memory.
8. **The extra guidelines,** preceded by one empty line, only when there are any.
9. **The `.gitignore` advice** (10.9), when it applies.
10. **The end:** an empty line, then the lean search line of 10.4 as the last line.

#### 10.8 The empty-index note

When `indexesEmpty` is `true`, both team prompts add one short statement: the
two indexes are empty, and nothing has been saved (the words "empty" and
"nothing" appear). It sits in the same line, directly after the statement that
only the indexes are in context, and it is the only change: with `false`, the
text is byte for byte the text without the argument. Its purpose is to keep
the model from searching `.claudin/` for memories that do not exist.

#### 10.9 The `.gitignore` advice

Both team prompts add it when all three of these hold:
1. the project root is inside a repository (`findCanonicalGitRoot(getProjectRoot())`);
2. the team directory lies inside that repository root;
3. `isTeamMemLikelyGitIgnored(root)` is true.

Anywhere else, including a legacy or overridden directory and a project outside
a repository, it is absent.

It is an empty line, then a paragraph, then a fenced block:
- **The paragraph** explains that the root `` `.gitignore` `` ignores all of `` `.claudin/` ``, so `` `<team dir>` ``, though it sits inside the project, never gets committed and never reaches teammates. The model is to put the change below in front of the user, make it with the edit tool only once they approve, and never touch `.gitignore` without asking.
- **The block** is a ```` ``` ```` line, then exactly `/.claudin/*`, `!/.claudin/memory/`, `/.claudin/memory/*` and `!/.claudin/memory/team/`, one per line, then a ```` ``` ```` line.

It comes after the extra guidelines and before the search section.

#### 10.10 The category renderings

- **`renderTeamCategoriesCompact(teamDir)`:** one line per category, in table order. Each line is a dash and a space, the directory with a trailing `/` in backticks, a space, an em dash, a space, then the category's `compact` text. Only the first line puts `teamDir` in front of the directory, which shows the absolute location once: `` - `<teamDir>decisions/` — … ``, then `` - `bugs/` — … `` and `` - `docs/` — … ``.
- **`renderTeamCategoriesLean(teamDir)`:** the same lines, with `lean` in place of `compact`.
- **`renderTeamCategoriesXml()`,** the verbose section for the extraction, dream and sort prompts:
  1. The heading `## Team categories`, then an empty line.
  2. An introduction: the team directory is arranged around what a teammate will look for; three subdirectories hold the product-facing memory, and team-scoped notes of any other kind stay at the team root. Then an empty line.
  3. A `<categories>` line.
  4. Per category, in order, a `<category>` line, then one line per field wrapping the table's text verbatim: `<dir>` (the directory with a trailing `/`), `<type>`, `<description>`, `<when_to_save>`, `<when_not_to_save>`, `<body_structure>` and `<paths>`. Then a `</category>` line.
  5. A `</categories>` line, then an empty line.
  6. The closing rule: the pointer of a categorized memory goes in the team `MEMORY.md`, under the heading of its category, added when missing. The three headings are each written in backticks: `` `## Decisions` ``, `` `## Bugs` ``, `` `## Docs` ``. The link carries the category directory, as in `` `- [Title](bugs/file.md) — hook` ``.
  7. An empty last line.

  `sortPrompt.test.ts` and `consolidationPrompt.test.ts` depend on the `<dir>…/</dir>` form, on `whenToSave` and `whenNotToSave` appearing verbatim, and on each `## Section` appearing in backticks.

#### 10.11 The types sections, `TYPES_SECTION_COMBINED` and `TYPES_SECTION_INDIVIDUAL`

The extraction prompts embed them.
- **The shape.** Each is an array of lines: the heading `## Types of memory`, an introduction, a `<types>` block holding four `<type>` blocks in the order `user`, `feedback`, `project`, `reference`, then an empty last line, so the next section follows a blank line.
- **Each `<type>` block** has `<name>`, `<description>`, `<when_to_save>`, `<how_to_use>` and `<examples>`, each with its closing tag.
- **`feedback` and `project`** also have a `<body_structure>`: lead with the rule or the fact, then a `**Why:**` line and a `**How to apply:**` line.
- **The examples** are worked pairs of a user line and an assistant line, whose bracketed action says what is saved.

They have to state:
- **`user`:** the person's role, goals, responsibilities and knowledge, so the work can fit them; nothing judgmental, and nothing beside the point.
- **`feedback`:** the user's steer on working, covering things to stop and things to continue. It is saved after a correction and after a quiet confirmation alike (the word "confirm" appears), with the reason.
- **`project`:** the state of ongoing work (owners, motives, deadlines) that the code does not show. Dates are converted to absolute dates.
- **`reference`:** which external systems hold which information.

**`TYPES_SECTION_COMBINED`** adds:
- **Scopes.** The introduction says each type declares a scope, and each `<type>` has a `<scope>`:
  - `user`: always private;
  - `feedback`: private unless it is a project-wide convention. Team feedback sits at the team root, never in a category directory;
  - `project`: either, with a strong lean to team. Within team, a decision that clears its bar goes in `` `decisions/` ``, a known defect in `` `bugs/` ``, and the rest at the team root;
  - `reference`: mostly team: `` `docs/` `` for a pointer to a subsystem's documentation, the team root otherwise.
- **The override check.** A private feedback memory that would contradict a team one is either dropped or saved with the override stated.
- **Scoped examples.** The examples' actions name the scope: "saves private … memory", "saves team … memory".

**`TYPES_SECTION_INDIVIDUAL`** has no `<scope>`, no scope in the examples, and no
wording that assumes two directories.

#### 10.12 What not to save, `WHAT_NOT_TO_SAVE_SECTION`

A `##` heading about what not to save, then a bulleted list of exclusions. Each
item names its category with the term given here:
- **code pattern**s and conventions, the architecture, file paths, the project structure: the current tree already says them;
- the repository's history, its recent changes and who made them: `` `git log` `` and `` `git blame` `` answer that;
- **debugging** results and the recipe of a fix: the code holds the fix, and the commit explains it;
- whatever `CLAUDE.md` files already document;
- **ephemeral** or **in-progress** state of the task at hand: temporary state, the conversation itself;
- **routine** work whose result surprised no one: a command that simply succeeded, a search that found nothing, moving around the tree. A session that yields nothing worth keeping is a valid outcome.

The last line is not a bullet. It says an **explicit** request to save does not
lift the exclusions: asked to keep a list of PRs or a summary of activity, the
model asks which part was **surprising** or **non-obvious**, and keeps only that.

### 11. `loadMemoryPrompt(lean = false)`

- **The extra guideline.** `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES`, when it has non-whitespace content, is passed verbatim as the single extra guideline. Otherwise there is none.
- **Team flag on and team memory on** (in the shipped build, whenever auto memory is on):
  - the team directory is created, and the private directory with it;
  - whether the indexes are empty is `areMemoryIndexesEmpty` applied to what `getMemoryFiles()` returns. That is the same memoized instruction load through which the indexes reach context, so the note agrees with what the model was given. `getMemoryFiles` is in `src/memory/instructions/claudemd.ts`, whose parser imports this module, so reaching it must not create a cycle at load time. If it fails, the failure is logged at warn level and the indexes count as not empty;
  - the result is the lean team prompt when `lean`, else the full one, with the guideline and the flag.
- **Auto memory on, otherwise:** the private directory is created. The result is `buildMemoryLines('auto memory', dir, extra)` joined with `\n` when `hasExistingMemories(dir)`, else `buildMemoryStubLines('auto memory', dir, extra)` joined the same way. `lean` changes nothing here.
- **Auto memory off:** `null`, and nothing is created.
- **The callers.** The system prompt caches the result for the session, in a section named `memory` or `memory:lean`. The query engine calls it without `lean` when an SDK caller passes a custom system prompt and `hasAutoMemPathOverride()` is true.

## Security requirements

**Pinned by the tests:**
- **A cloned repository cannot move the memory directory.** Its checked-in `.claudin/settings.json` can neither set `autoMemoryDirectory` nor switch `autoMemoryProjectLocal`. The memory directory is auto-approved for reads and writes, so a repository choosing it (`~/.ssh`, say) would be a write primitive.
- **Overrides cannot widen the directory by accident.** A value is rejected when it is relative, the filesystem root or a drive root, a UNC share, or a path with a NUL byte, and a `~/` value is rejected when it folds back to the home directory or above.
- **The project-local directory stays in the repository.** It is used only when its real path is inside the repository's real root. A symlinked `.claudin` or `.claudin/memory` that leads out falls back to the legacy location, and so does a path that cannot be verified: the answer is memoized for the process, so an unverifiable path must not be kept.
- **The project-local directory is private.** On POSIX it has mode 0700, tightened when it already existed.
- **The path predicates are hard to trick.** `isAutoMemPath` and `isTeamMemPath` resolve `..` before testing the prefix, and the prefix ends with a separator, so a sibling directory never matches.
- **The path-scoped index never follows a symlink,** file or directory, and reads only the head of each file.
- **The team prompts forbid secrets in team memory.** They propose the `.gitignore` change to the user and never ask the model to apply it unasked.

**Not pinned: symlinks inside the memory directory (finding 1).** The two path
predicates are lexical: they never resolve symlinks. The permission layer
auto-approves a Read of any path `isAutoMemPath` accepts, and a Write too when
there is no environment override. It does so before its symlink-aware
working-directory checks (`checkReadableInternalPath` and
`checkEditableInternalPath` in `src/permissions/filePermissions/internalPaths.ts`,
called from `readWriteChecks.ts`).

The project-local directory lives in the repository, and a cloned repository
controls what is in it. A committed symlink under `.claudin/memory/team/`, such
as `docs/notes.md` pointing to `~/.ssh/id_rsa`, would therefore be read or
written without a prompt. The containment check above covers `.claudin` and
`.claudin/memory` themselves, not the entries inside them.

The instruction loader reads both indexes at session start through their
symlinks as well, so a committed `team/MEMORY.md` that is a symlink puts its
target into the context. These come from reading the permission layer and the
loader; the suite does not exercise them. Decision: see finding 1.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A project root inside a subdirectory of a repository, or in a worktree | the main checkout's `.claudin/memory/`. Pinned |
| `.claudin` is a regular file | the legacy location. Pinned |
| A project-local directory that cannot be created (a read-only checkout) | the legacy location; the error is logged. Not pinned |
| An empty `autoMemoryDirectory` in the local settings over a valid user one | the default location: the empty value switches the override off for this project. Pinned, for parity |
| `CLAUDIN_EXTRACT_MEMORIES_EVERY=1e3` | 1: the leading integer. Not pinned |
| Two project paths that differ only in punctuation (`/a/b-c`, `/a/b/c`) | the same legacy slug, so the same legacy directory. That is the shared slug rule. Not pinned |
| `truncateEntrypointContent('')` | `lineCount` 1, `byteCount` 0. Callers check for a blank index first. Not pinned |
| An index of `*` items | counted as zero entries. Pinned |
| `hasExistingMemories` given a path without its trailing separator | old: it reads `<path>MEMORY.md`, a sibling file. Not pinned. Decision: fix (finding 4) |
| A memory directory that holds only `team/` files, in the private-only path | the empty-directory text. Not pinned |
| A shell command with punctuation inside a path token (`ls /mem|wc`) | not recognized as memory. Not pinned |
| `isAutoManagedMemoryPattern('**/*.jsonl')` in any project | old: memory. Not pinned. Decision: fix (finding 2) |
| A directory named `agent-memory` anywhere, or a `…/memory/` directory under the config home | memory, while auto memory is on. Pinned for the first |
| A `paths:` frontmatter longer than the first 30 lines of the file | not seen, so the memory stays index-only. Not pinned |
| Editing a memory's `paths:` in place | seen after the next change in its directory or in a new process. Not pinned |
| A path-scoped memory with an empty body | not attached (the loader drops empty files). Not pinned |
| A `.gitignore` with `/.claudin/*` and no carve-out | no advice, although the team directory is ignored. Pinned, for parity (finding 7) |
| `.gitignore` edited during the session | the advice does not change until a new process. Not pinned |
| A clone or checkout that resets file mtimes | the staleness note counts from the new mtime. Not pinned |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` with surrounding blanks | passed verbatim, not trimmed. Not pinned |
| `getAutoMemPath()` for a non-repository project | the legacy path, not created until `loadMemoryPrompt` or a write creates it. Not pinned |
| `autoMemoryDirectory` set to the home directory's absolute path | accepted: an explicit absolute path is the user's choice, and only trusted layers can set it. Not pinned |
| Windows paths, drive letters and MinGW forms | not reachable in the suite. Not pinned |

## Tests that pin it

**The characterization suites** are in `src/memory/memdir/`, 268 tests in six
files. Each test runs in a fresh temp world built by
`__testutils__/memdirWorld.ts`:
- `CLAUDIN_CONFIG_DIR`, the managed-settings directory (by seeding the memo of `getManagedFilePath`, as the skills suites do) and a HOME for git all point into the world;
- the project root, the original cwd and the cwd are set through `src/platform/bootstrap/state.ts`;
- every environment variable the unit reads is cleared before and restored after each test;
- settings are real files in the layer the loader reads;
- repositories are real `git init`s, with a worktree where needed, and git is isolated from the user's configuration.

Nothing is mocked. The implementation must therefore read the environment, the
settings and the session's directories at call time, and keep
`getAutoMemPath.cache.clear()` working.

| Suite | Covers |
|---|---|
| `memdir.characterization.test.ts` | sections 4, 5, 10.1–10.5 and 11 |
| `memdir.paths.characterization.test.ts` | sections 1–3 |
| `memdir.taxonomy.characterization.test.ts` | sections 7 and 9, 10.10–10.12, and `MEMORY_TYPE_VALUES` |
| `memdir.teamPrompts.characterization.test.ts` | 10.6–10.9 |
| `memdir.detection.characterization.test.ts` | section 6 |
| `memdir.pathScoped.characterization.test.ts` | section 8 |

**The fixtures** are under `src/memory/memdir/__fixtures__/rewrite/`:
- `memory/`: a private index and topic file, and a team directory with a categorized memory in each category, written as the prompts prescribe (list and comma forms of `paths:`);
- `gitignore/`: six root `.gitignore` shapes.

**Line coverage of the old files** by the suites alone:

| File | Lines |
|---|---|
| `memdir.ts` | 93.5% (the rest is the team branch of `loadMemoryPrompt`) |
| `memoryFileDetection.ts` | 96.9% (team and Windows branches) |
| `pathScopedMemories.ts` | 99.3% |
| `paths.ts` | 99.4% |
| the six other files | 100% |

**The probe spec**, `scripts/migrations/probes/rewrite-memory-memdir.json`, has 40 probes over all ten files. Every one turns the suites red.

**The existing tests beside the unit are this project's own, and stay.** Some of
them pin the old text or the old module layout, so the rewrite updates them in
the same change:
- **`teamMemPrompts.test.ts`:**
  - it pins the index line of both team prompts verbatim, as two whole lines, and anchors the empty-index note on sentences of them;
  - its last test reads the source text of `memdir.ts` and expects four specific call expressions in `loadMemoryPrompt`. Replace it with a behavioural test (see Target design);
  - it mocks `./paths.js`, `./teamMemPaths.js`, `src/platform/bootstrap/state.js` and `src/vcs/git/git.js`, and re-imports `./teamMemPrompts.js` with a cache-busting query. So the team prompts have to take their directories from `getAutoMemPath()` and `getTeamMemPath()`, the repository root from `findCanonicalGitRoot(getProjectRoot())`, and the ignore check from `isTeamMemLikelyGitIgnored`, all imported from those modules and read at call time.
- **`paths.test.ts`:**
  - it mocks `src/platform/settings/settings.js` (`getInitialSettings` and `getSettingsForSource`) and `getProjectRoot`, and re-imports `./paths.js` with a query to get a fresh memo;
  - so `paths.ts` must read settings and the project root through those functions, and the memo of `getAutoMemPath` must start empty on a fresh import of `paths.ts`;
  - a few of its lines are inherited. It stays as it is.
- **`memoryPrompt.test.ts`:** it pins about thirty phrases of the old prose in the private, stub and team prompts (the wikilink sentence, the remember and forget clauses, the recall framing, the `paths:` clause, the decisions bar). It also pins the first compact category line's prefix and the backticked section list of the tagged rendering. Restate each phrase as the fact it checks.
- **`memdir.entrypointBytes.test.ts`:** it splits on `\n\n> WARNING:` and expects `lines and` in the warning of both caps.
- **`extractionDefaults.test.ts`:** it expects the heading `Searching past context`.
- **`pathScopedMemories.test.ts` and `teamMemPaths.test.ts`:** behaviour only.

**Outside the unit, these pin the prompt text byte for byte** and are regenerated
or updated with the rewrite:
- **The system-prompt snapshots.**
  - `src/agent/prompts/__tests__/__snapshots__/systemPrompt.main.txt` holds the lean team prompt, and `systemPrompt.legacy.txt` the full one (`CLAUDIN_LEAN_MEMORY_PROMPT=0`).
  - Both are dumped from the built bundle, with the flags on, by `systemPrompt.characterization.test.ts`. Regenerate them with `UPDATE_PROMPT_SNAPSHOT=1 bun test src/agent/prompts/__tests__/systemPrompt.characterization.test.ts` after `bun run build`.
- **`src/agent/prompts/__tests__/promptFeatureCoverage.test.ts`** reads those snapshots and requires the markers `.claudin/memory/`, `.claudin/memory/team/`, `decisions/`, `bugs/`, `docs/`, `impact:`, `paths:`, `MEMORY.md` and `[[name]]`, the word `feedback`, and the words remember, forget and verify, in any case. The rewrite keeps them.
- **The consumers of the category texts:**
  - `src/commands/memory/sortPrompt.test.ts` and `src/memory/autoDream/consolidationPrompt.test.ts` (10.10);
  - `src/commands/memory/tidyPrompt.test.ts` (the caps it renders);
  - `src/agent/ui/collapseNestedMemory.test.ts` and `src/agent/ui/messages/AttachmentMessage.nestedMemoryBatch.test.tsx` (the nouns and the order of `TEAM_CATEGORIES`).
- **`src/agent/attachments/injections.memoryIndex.test.ts`** feeds warning lines of the old wording as input. It only needs the `> WARNING:` line not to count as an entry.
- **`docs/tech/memory/project-local-team-memory.md`** quotes the empty-index note and the four `.gitignore` lines. Update the quote if the wording changes.

**The older probe specs quote the old code** of these files. Take them out of the
implementer's sandbox; `land.ts` prunes them:

| Spec | Probes on this unit |
|---|---|
| `catAsRead.json` | `memdir.ts` ×3, `teamMemPrompts.ts` ×5 |
| `forkDefaults.json` | `paths.ts` ×5, `memdir.ts` ×2 |
| `memoryIndex.json` | `memdir.ts` ×1 |
| `nestedMemoryBatch.json` | `memoryTypes.ts` ×1 |
| `pathScopedMemories.json` | `pathScopedMemories.ts` ×6 |
| `promptsV2.json` | `teamMemPrompts.ts` ×3, `memoryTypes.ts` ×1 |
| `teamMemSecretGuard.json` | `teamMemPaths.ts` ×2 |

**Not a test, but it quotes the old text.** `docs/tech/prompts/claude-code-2.1.280-reference.md`
quotes another product's memory prompt, including the sentence that
`DIR_EXISTS_GUIDANCE` carries. Keep it out of the implementer's sandbox.

**Not pinned, and why:**
- **The team branch of `loadMemoryPrompt`.** The build flag reads false under `bun test`. Only the source-text test above reaches it today.
- **The wording, the order of sentences and paragraphs, and the prompt sizes,** beyond what is stated above.
- **Remote managed settings and MDM policy sources.** The managed file is covered.
- **Windows behaviour,** and the root-user skip of the unreadable-directory case.
- **What is logged, and at which level.**
- **The rows marked "Not pinned" above.**

## Out of scope

- **The `memoryAgeDays` export.** Nothing imports it (`knip-baseline.json` lists it as unused). The age rule lives on in `memoryFreshnessNote`. Drop the export, and remove its entry from the knip baseline in the same change.
- **The copy itself** (`memoryMigration.ts`), and the team-memory safety files (`secretScanner.ts`, `teamMemSecretGuard.ts`, `teamMemoryOps.ts`, `memoryScan.ts`), which are the unit `memory/teamMemSafety`.
- **The prompts that embed these fragments:** extraction, dream, tidy and sort.
- **`processMemoryFile`** and the instruction loader (unit `memory/claudemd`).
- **The permission layer's carve-out** (see finding 1).

## Findings

The old modules had each of these. None is fixed by the characterization: the
suites pass on the old code, and a finding decided "fix" is left unpinned so the
rewrite can apply it.

1. **Security: the memory carve-out follows symlinks inside the project-local directory.** See Security requirements. Decision: keep for parity in this unit.
   - The predicates' contract is lexical, and the fix belongs to the permission layer and the instruction loader.
   - It is not pure hardening either: a user who keeps a symlinked memory file would start seeing prompts.
   - Track it: resolve the target's real path before the carve-out applies and require it to stay inside the real memory directory, and make the loader refuse an index whose real path leaves it.
2. **Any `.jsonl` glob counts as a transcript search.** `isAutoManagedMemoryPattern` returns true for `data/**/*.jsonl` in any project, so an ordinary search is labelled as memory in the transcript; its own second clause shows the intent to require `projects`. Only that label depends on it. Decision: fix, requiring a `projects` segment. The suite pins only the `projects/…` forms.
3. **The private-only prompt is unreachable in the shipped build.** With the team flag on, team memory is on exactly when auto memory is, so `loadMemoryPrompt` always returns a team prompt. The empty-directory text and the switch between the private texts run only under test, or in a build without the flag, and `lean` is ignored there. Decision: keep for parity: the flag can be switched off, and this path is the one `bun test` exercises. Track: remove the branch when the flag goes.
4. **Index paths built by concatenation.** `hasExistingMemories` and `buildMemoryPrompt` read `<dir>MEMORY.md` by joining strings, so a directory passed without its separator reads a sibling file. Every caller passes the separator today. Decision: fix, joining the path.
5. **A rejected override in a higher settings layer hides a valid one below it.** Decision: keep for parity, pinned. An empty `autoMemoryDirectory` in a project's local settings is a working way to switch a user-level override off for that project.
6. **Globs anchor by a directory name.** Any memory directory whose parent is named `.claudin` anchors at the directory above it, so `autoMemoryDirectory: ~/.claudin/memory` anchors globs at the home directory, and project-relative globs never match. Decision: keep for parity, pinned: a configured directory's globs may be written against it. Track: anchor at the repository only for the project-local location.
7. **The `.gitignore` heuristic misses `.claudin/*` and `.claudin/**`,** which swallow the team directory just the same. Decision: keep for parity, pinned: the heuristic is best-effort by design, and a fix changes the prompt of those projects. Track: evaluate the file properly (for example with `git check-ignore`).
8. **Two exported types named `MemoryType`.** Decision: keep both, since they are contract. Rename one when every consumer has been rewritten.
9. **Tests that pin the old text and the old source.** See `teamMemPrompts.test.ts` and `memoryPrompt.test.ts` above. Decision: fix, in the rewrite's change. Replace the source-text assertion with a test of the dispatch, and restate phrase pins as facts.
10. **Outside this unit:** the settings schema's descriptions of `autoMemoryDirectory` and `autoMemoryProjectLocal` (`src/platform/settings/types.ts`) name another product's directories (`~/.claude/…`, `.claude/settings.json`). For the settings unit.

## Target design

- **One slice, ten files kept as the surface.** Callers and the tests that stay import the ten files by path, so each keeps its exports. The logic behind them is split by responsibility:
  - **Location.**
    - A pure resolver goes from explicit inputs (the environment values, the four trusted settings layers, the project root and the repository root) to a discriminated result: the environment override, the setting, project-local or legacy, with the directory.
    - Override validation is a pure function that returns a typed rejection reason.
    - A thin memoized shell in `paths.ts` does the filesystem steps (create, check containment, tighten, copy legacy memory in) and the fallback, and keeps `getAutoMemPath` a lodash memo keyed by the project root.
  - **Switches:** small predicates over the environment and the settings, read at call time.
  - **The index:** the caps, a pure byte-aware truncation, the warning rendered from its result, and entry counting.
  - **Taxonomy:** the types and the category table as data, and pure renderers; the prose is kept apart from the logic.
  - **Prompts.**
    - The pieces both team texts share are each written once: the type-and-scope list, the index rules, the `paths:` clause, the recall framing, the empty-index note and the `.gitignore` advice. The full and lean texts then cannot drift apart.
    - Tool and file names come from their constants: `GREP_TOOL_NAME`, `ENTRYPOINT_NAME` and `MAX_ENTRYPOINT_LINES`.
  - **Dispatch.**
    - `loadMemoryPrompt` decides through a pure function of the team flag, the team switch, the auto switch, `lean`, "has memories" and "indexes empty".
    - That makes the team branch testable without the build flag, and replaces the source-text test.
    - The `feature('TEAMMEM')` gates stay where they are observable: that dispatch, the team checks of section 6, the `TeamMem` type of a path-scoped file, and `MEMORY_TYPE_VALUES`.
  - **Detection:** predicates over one normalized, comparable path, with the platform as a parameter, so the Windows rules can be tested anywhere.
  - **Path-scoped memories:** an index object that owns its memo, with the scan filesystem injected through `PathScopedScanFs`, and pure matching.
  - **Age:** a pure function of the mtime and now.
- **Narrow dependencies with production defaults** (`code-design.md`), so the parts are testable without module mocks. The characterization suites still drive the defaults.
- **Types.**
  - Explicit, with no `any`.
  - A directory type that carries its trailing separator.
  - Readonly tables, and regexes at module level.
- **Errors.**
  - Failures go to `logError` or `logForDebugging`, and none is swallowed silently. The fail-open cases (an unreadable `.gitignore`, a directory that cannot be created, an unreadable memory file) log at debug level.
  - None of these throws to a caller.
- **The load-time cycle.** `claudemd/parsing.ts` imports `memdir.ts`, so the dispatch must reach `getMemoryFiles` without a load-time cycle.

## Outcome

- **The gate.** It flagged 5 lines of `src/memory/memdir/entrypoint/truncation.ts`. One was a generic line that splits the index into lines. It matched only because it came right after the exported signature, and the two made a run. The byte count is now taken first. That ends the run, and the signature alone is a single line, which the gate does not count. The other 3 lines are listed below.
- **Residue, reviewed.** These lines of Claude Code stay. Each one is contract:
  - **`src/memory/memdir/entrypoint/limits.ts`, 2 lines.** `ENTRYPOINT_NAME` and `MAX_ENTRYPOINT_LINES`, which callers outside the unit import. `MEMORY.md` is also the index's name on disk.
  - **`src/memory/memdir/entrypoint/truncation.ts`, 3 lines.** The first line of the exported `EntrypointTruncation` type, and its `wasLineTruncated` and `wasByteTruncated` fields, which the suites beside the unit read.
  - **`src/memory/memdir/prompt/agentMemoryPrompt.ts`, 2 lines.** The signature of `buildMemoryPrompt`: its first line, and the optional `extraGuidelines` field of its parameter object, which `agentMemory.ts` passes.
  - **`src/memory/memdir/prompt/privateMemoryPrompt.ts`, 2 lines.** The signature of `buildMemoryLines`: its first line and its optional `extraGuidelines` parameter.
  - **`src/memory/memdir/teamMemPaths.ts`, 2 lines.** The exported `isTeamMemFile` and its one-line body, which joins two exported checks.
  - **`src/memory/memdir/versions.ts`, 2 lines.** The exported `projectIsInGitRepo` and its body, which asks `findGitRoot`.

  The last two files were rewritten at their old paths, so the baseline did not flag them; they were reviewed by hand.

  They go when the contract is redesigned, after every consumer has been rewritten.
