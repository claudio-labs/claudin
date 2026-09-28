# Spec: `memory/markdownConfigLoader`

The unit is two files: `src/memory/instructions/markdownConfigLoader.ts` and
`src/memory/instructions/ruleFrontmatter.ts`.

## Purpose

This is the reader of the markdown files that configure the CLI from
`.claudin/<subdir>` directories: agents, legacy commands, output styles, skills
and workflows. Given a subdirectory and a cwd, it returns every markdown file
of the managed, user and project sources, each parsed into frontmatter and
body. Each physical file comes back once, and results are cached per cwd.

Its callers:
- `src/tools/AgentTool/loadAgentsDir.ts` turns the files into agents.
- `src/skills/loading/legacyCommands.ts` turns them into legacy commands.
- `src/agent/outputStyles/loadOutputStylesDir.ts` turns them into output styles.
- `src/terminal/prompt-suggestion/fileSuggestions.ts` offers their paths as @-mention suggestions.
- The skills listing (`src/skills/loading/skillListing.ts`) uses only the upward directory walk.

The module also holds three frontmatter helpers shared by every loader of
markdown configuration, the plugin loaders included. One takes a description
from a body, and two read the tool lists of `tools:`, `allowed-tools:` and
`skills:`.

`ruleFrontmatter.ts` reads the frontmatter of a rule file (`.claudin/rules/*.md`,
and memory files that take the same key). It reports three things:
- the path patterns that scope the rule;
- which keys the loader ignores;
- whether `paths:` has the wrong shape.

Three modules use it: the rule loader, the rules linter and path-scoped
memories.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `CLAUDE_CONFIG_DIRECTORIES` | `readonly ['commands', 'agents', 'output-styles', 'skills', 'workflows']` (`as const`) | `src/terminal/prompt-suggestion/fileSuggestions.ts` |
| `ClaudeConfigDirectory` (type) | the union of those five strings | the parameter of the two functions below; nothing imports it by name |
| `MarkdownFile` (type) | `{ filePath: string; baseDir: string; frontmatter: FrontmatterData; content: string; source: SettingSource }` | `src/skills/loading/legacyCommands.ts` |
| `extractDescriptionFromMarkdown` | `(content: string, defaultDescription?: string) => string`; the default is `'Custom item'` | `src/skills/loading/frontmatterFields.ts`, `src/agent/outputStyles/loadOutputStylesDir.ts`, `src/plugins/loadPluginCommands.ts`, `src/plugins/loadPluginOutputStyles.ts` |
| `parseSlashCommandToolsFromFrontmatter` | `(toolsValue: unknown) => string[]` | `src/skills/loading/frontmatterFields.ts`, `src/commands/security-review.ts`, `src/plugins/loadPluginCommands.ts`, and the `skills:` key in `src/tools/AgentTool/loadAgentsDir.ts` and `src/plugins/loadPluginAgents.ts` |
| `parseAgentToolsFromFrontmatter` | `(toolsValue: unknown) => string[] \| undefined` | `src/tools/AgentTool/loadAgentsDir.ts`, `src/plugins/loadPluginAgents.ts` |
| `getProjectDirsUpToHome` | `(subdir: ClaudeConfigDirectory, cwd: string) => string[]` | `src/skills/loading/skillListing.ts` |
| `loadMarkdownFilesForSubdir` | `(subdir: ClaudeConfigDirectory, cwd: string) => Promise<MarkdownFile[]>`, carrying a `cache` with `clear()` | `loadAgentsDir.ts` (`agents`), `loadOutputStylesDir.ts` (`output-styles`), `legacyCommands.ts` (`commands`), `fileSuggestions.ts` (all five); `src/sessions/rerootSession.ts` only clears it |
| `RULE_FRONTMATTER_SUPPORTED_KEYS` (`ruleFrontmatter.ts`) | `readonly string[]`, equal to `['paths']` | no import; `src/platform/import/translate/rules.ts` cites it by name as the rule the import follows |
| `RuleFrontmatterInspection` (type) | `{ content: string; paths?: string[]; unsupportedKeys: string[]; malformedPaths: boolean }` | the return type below; nothing imports it by name |
| `inspectRuleFrontmatter` | `(rawContent: string) => RuleFrontmatterInspection` | `src/memory/instructions/claudemd/parsing.ts`, `src/memory/instructions/rulesLint.ts`, `src/memory/memdir/pathScopedMemories.ts`, and tests in `src/platform/import/` |

**Contract constraints:**
- **The cache handle.** `loadMarkdownFilesForSubdir.cache.clear()` drops every cached load.
  - Callers write `loadMarkdownFilesForSubdir.cache.clear?.()` (`legacyCommands.ts`) and `loadMarkdownFilesForSubdir.cache?.clear?.()` (`rerootSession.ts`), so the type must declare `cache` with a `clear`.
  - Today the export is typed as lodash's `MemoizedFunction`. A narrower `{ cache: { clear(): void } }` also satisfies both callers.
- **`CLAUDE_CONFIG_DIRECTORIES` keeps its name.** `src/__tests__/envNaming.test.ts` allowlists it as an identifier that merely looks like an old environment name.
- **`ruleFrontmatter.ts` stays a leaf.** It imports the shared frontmatter parser and `zod`, and nothing that pulls in settings or the file system. The linter and scripts load it cheaply because of that.

## Observable behaviour

### 1. The project directories: `getProjectDirsUpToHome(subdir, cwd)`

It returns the `.claudin/<subdir>` directories found from `cwd` upward, nearest
first, as absolute paths.

- **The start.** `cwd` is resolved first. Dot segments and a trailing separator change nothing, and a relative cwd resolves against the process's own.
- **At each directory D on the way:**
  - **D is the home directory** (`os.homedir()`): the walk ends, and D is not looked at. Home's own `.claudin` is the user source, which the loader reads separately, so a cwd equal to home yields `[]`.
  - **`D/.claudin/<subdir>` exists,** following links: it is listed.
  - **It is missing,** a dangling link, a looping link, below a `.claudin` that is a file, or out of reach for permissions: D contributes nothing.
  - **Any other error** (a name too long, an I/O error): it is thrown to the caller.
  - **D is the stop directory:** the walk ends after D.
- **The stop directory:**
  - **Inside a git repository:** the repository's root, which is the nearest directory at or above the cwd that holds a `.git` directory or file. A worktree and a submodule each count as a repository of their own.
  - **A repository nested inside the session's project.** The session's project repository is the one that holds `getProjectRoot()`. When the cwd's repository is nested inside it and is a different repository, the stop is the session's repository root instead. A worktree of the session's repository counts as the same repository, as `findCanonicalGitRoot` resolves it. So a submodule or a vendored clone does not hide the project's `.claudin`, while a worktree still stops at its own root.
  - **What "nested inside" means.** It is judged by whole path segments: `<root>-tools` is not inside `<root>`. A sibling repository stops at its own root.
  - **Outside any repository:** there is no stop directory. The walk ends below home, or runs to the filesystem root and includes it.
- **Path comparisons** normalize the path first, and are case-insensitive on Windows.
- **An existing path that is not a directory** is listed today (Findings, 1).

### 2. The sources: `loadMarkdownFilesForSubdir(subdir, cwd)`

The result lists the files of these sources, in this order:

1. **Managed:** `<getManagedFilePath()>/.claudin/<subdir>`, source `policySettings`. It is always read.
2. **User:** `<getClaudinConfigHomeDir()>/<subdir>`, source `userSettings`. That directory is `CLAUDIN_CONFIG_DIR` when the variable is set, otherwise `~/.claudin`.
3. **Project:** each directory from `getProjectDirsUpToHome(subdir, cwd)`, in its order, then the worktree fallback below. Source `projectSettings`.

**The worktree fallback.**
- **When it applies.** The cwd is in a linked worktree: its repository root differs from the root `findCanonicalGitRoot(cwd)` gives. The worktree root's own `.claudin/<subdir>` must also not be among the walked directories.
- **What it adds.** The main checkout's `<canonical root>/.claudin/<subdir>` is read after the walk.
- **Only the worktree root counts.** A `.claudin/<subdir>` deeper in the worktree does not prevent it.
- **Why it exists.** A worktree created from a commit that tracks `.claudin/<subdir>` has its own copy, and that copy is the one read. The fallback covers directories the checkout lacks, such as untracked ones or a sparse checkout.

**`--add-dir` directories are not read here.** The skills listing adds them itself.

**Errors.**
- A source directory that is missing contributes nothing.
- A file that cannot be read is left out, with a debug line.
- The load rejects only when the directory walk throws (section 1).

### 3. Which files count

- **Names.** Every file whose name ends in `.md`, lower case only, at any depth. `SHOUT.MD`, `.markdown`, `.mdx` and `.txt` do not count, and `.md` alone does. A directory named `notes.md` is searched like any other.
- **Hidden entries.** Hidden files and directories count.
- **Ignore files.** No ignore file is honoured: `.gitignore`, `.ignore` and `.rgignore` inside the directory, and the repository's own `.gitignore`, hide nothing. That goes for ignored directories as well as files.
- **Symlinks.**
  - Links to directories and to files are followed. The reported path runs through the link, not to its target.
  - For a link, the link's name decides: `alias.md` pointing at a `.txt` counts, and `named.txt` pointing at a `.md` does not.
  - Dangling links are left out, and a symlink loop ends the search without repeating any file.
- **Unreadable entries.** A file or subdirectory that cannot be read is left out, and the rest still load.
- **Order.** Sources come in the order of section 2. Inside one directory the order is not specified.
- **The search mechanism.**
  - The result does not depend on how the files are found. `CLAUDIN_USE_NATIVE_FILE_SEARCH` (truthy) selects the in-process search, and it must give the same list.
  - The files must still load when the ripgrep binary that the shared search would use cannot be started. The pinned case chooses the system ripgrep (`USE_BUILTIN_RIPGREP=0`), which is present on `PATH` but cannot be executed.

### 4. What an entry carries

- **`filePath`:** absolute, through any links, as reached.
- **`baseDir`:** the source directory that was searched, whatever the file's depth under it.
- **`source`:** as in section 2.
- **`frontmatter` and `content`:** from `parseFrontmatter(text, filePath)` in `src/shared/frontmatterParser.ts`, read as UTF-8.
  - Without frontmatter, they are `{}` and the whole text. Frontmatter must open on the first line.
  - YAML that fails to parse gives `{}` and the text after the closing `---`, and the file still loads.
  - Values that strict YAML rejects but that read as text come back as strings: `argument-hint: [pr-number] [--with-comments]`, or a value that starts with `*`.
  - A CRLF file parses the same, and its body keeps the CRLF.
  - Blank lines between the closing `---` and the first text are not part of the body.
  - An empty file gives `{}` and `''`.

### 5. Each file once

- **Two entries are the same file** when they share device and inode, taken from the directory entry itself without following a final symlink. That covers:
  - a path through a linked directory, for example a config directory that is a link into the project;
  - a hard link.
- **Which one stays.** Only the first, in the order of section 2, is kept, whatever its name. So the managed copy beats the user copy, which beats the project copy.
- **The same file twice inside one source** gives one entry. Which of its paths is reported is not specified.
- **A symlink to a file is an entry of its own,** beside its target (Findings, 3).
- **Distinct files are all kept,** even with the same name or the same content.
- **Identity limits.**
  - Inode numbers must be compared exactly: large inodes, as on ExFAT, must never fold two files into one.
  - A file whose identity cannot be read is kept.
  - On a file system that reports device 0 and inode 0 for every file, nothing is folded.

### 6. The cache

- **The key.** Results are cached per subdirectory and cwd, as given. A second call with the same pair returns the earlier result even when the disk has changed.
- **What is not in the key.** The environment, the setting sources and the policy are read when a load runs, not when a cached one is returned.
- **Different keys.** Another cwd, or another subdirectory, is a load of its own.
- **Clearing.** `loadMarkdownFilesForSubdir.cache.clear()` drops every cached load, so the next call reads again. Two callers clear it: the legacy commands cache (through the skills `clearSkillCaches`) and `rerootSession`.
- **Failures.** A load that rejected stays cached today (Findings, 2).

### 7. Settings and policy switches

| Switch | Effect |
|---|---|
| `userSettings` not in the allowed setting sources | the user directory is not read |
| `projectSettings` not in the allowed setting sources | no project directory is read, the worktree fallback included |
| both off | the managed directory is still read |
| managed `strictPluginOnlyCustomization` locking `agents` (`true`, or a list that names `agents`) | for `agents` only, the user and project directories are not read; the managed agents still load |
| a lock that names other surfaces only (`skills`, `hooks`, `mcp`) | nothing changes for agents |
| any lock, for `commands`, `output-styles`, `skills` or `workflows` | nothing changes here; the skills listing applies its own lock to legacy commands |
| `CLAUDIN_CONFIG_DIR` | where the user directory is |
| `CLAUDIN_USE_NATIVE_FILE_SEARCH` | how the files are searched; the result is the same |

All of these are read when a load runs.

### 8. The frontmatter helpers

**`extractDescriptionFromMarkdown(content, defaultDescription = 'Custom item')`:**
- **The line.** It takes the first line that has text, splitting on `\n`, and trims it, which also drops a CR.
- **Heading markers.** One or more `#` followed by whitespace is removed, once: `## # x` gives `# x`. A lone `#` and `#tag` are kept as they are.
- **Length.** Past 100 characters, counted after the marker is removed, the text becomes its first 97 characters and `...`. At 100 or fewer it is whole.
- **No text.** When no line has text, the result is `defaultDescription`.
- **Frontmatter.** It is not skipped: callers pass the body.

**The tool lists.** Both readers share one parse of a present, non-empty value:
- **Input forms.** A string is one entry. A list keeps its strings and drops everything else. `true`, a non-zero number and a mapping give no entries.
- **Splitting.** Each entry is split on commas and spaces outside parentheses, as `parseToolListFromCLI` (`src/permissions/permissionSetup/cliToolParsing.ts`) splits them. `Bash(git add, git commit)` stays whole. Parts are trimmed, empty ones dropped, and order and repeats kept.
- **The wildcard.** If any part is exactly `*`, the list is `['*']`. `Bash(*)` is not the wildcard.

| Value | `parseSlashCommandToolsFromFrontmatter` | `parseAgentToolsFromFrontmatter` |
|---|---|---|
| absent (`undefined`) | `[]` | `undefined`: every tool |
| `null` (a bare `tools:`), `''`, `false`, `0`, `[]` | `[]` | `[]`: no tool |
| a wildcard among the parts | `['*']` | `undefined` |
| anything else | the parts | the parts (`[]` when none is left) |

### 9. Rule frontmatter: `inspectRuleFrontmatter(rawContent)`

It parses with `parseFrontmatter` and returns the following fields.
- **`content`:** the body, as in section 4. For a file without frontmatter it is the whole text.
- **`unsupportedKeys`:** every frontmatter key except `paths`, in the order written.
  - A key without a value counts.
  - Names are case-sensitive, so `Paths:` is an unsupported key and leaves the rule unconditional.
  - YAML that fails to parse yields no keys.
- **`malformedPaths`:**
  - It is `true` when `paths` is present with a value other than a string, a list of strings or null. That means a number (`0` included), a boolean, a mapping, or a list that holds a non-string.
  - An absent key, `null`, `''` and `[]` are well formed.
- **`paths`:** the patterns. It is absent (the rule applies everywhere) in these cases:
  - `paths` is missing, `''`, `null` or `[]`;
  - it is not a string or a list, as for `0`, `false`, `true`, numbers and mappings;
  - nothing is left after the rules below;
  - every pattern left is `**`.
- **How the patterns are derived:**
  - The value is a comma-separated string or a list, and each list entry is split the same way. Commas inside braces do not split, as in `splitPathInFrontmatter` (`src/shared/frontmatterParser.ts`).
  - Parts are trimmed and empty ones dropped.
  - Braces expand, every group: `{api,web}/{a,b}.md` gives four patterns.
  - One trailing `/**` is removed from each pattern: `src/**` gives `src`, and `a/**/**` gives `a/**`. A pattern that was only `/**` disappears.
  - A `**` next to a narrower pattern is kept: `src/**, **` gives `['src', '**']`.
  - A list that holds a non-string still gives the patterns of its strings, while `malformedPaths` is `true` (Findings, 8).
- **`RULE_FRONTMATTER_SUPPORTED_KEYS`** is `['paths']`.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A source directory that is missing | nothing from it, and no error |
| An unreadable file or subdirectory | left out, while the rest load |
| An error other than missing or out of reach during the walk (a name too long) | `getProjectDirsUpToHome` throws, and the load rejects |
| Frontmatter that is not YAML | `{}`, and the body after the closing `---` |
| A regular file at `.claudin/<subdir>` | the walk lists it. The default search returns the file itself as one entry, whatever its name; the in-process search returns nothing. Findings, 1. Not pinned |
| A search slower than about three seconds for one directory | the files found so far, or a rejection when none had been found. Either one is cached. Not pinned |
| A file saved with a UTF-8 byte-order mark | the frontmatter is not recognized, and the whole text, mark included, is the body. Findings, 5. Not pinned |
| The first line of the body indented, right after the closing `---` | the indentation is lost (shared parser). Not pinned |
| A description cut through an emoji or another astral character | a lone surrogate before `...`. Findings, 4. Not pinned |
| A cwd equal to home | no project directory |
| Home inside a repository whose root lies above it | the walk still ends below home; outside home, the same repository stops at its root |
| A linked worktree | its own walk, then the main checkout's directory when the worktree root lacks one |
| Windows paths: drive-letter case and separators | compared case-insensitively. Not pinned |
| A home path in a Unicode normal form other than NFC | compared as NFC. Not pinned |

## Security requirements

**Pinned by the tests:**
- **The repository root ends the walk,** so a `.claudin` above a repository never leaks into it.
- **Home ends the walk,** so `~/.claudin` is read only as the user source, even when home sits inside a repository.
- **A nested repository walks up to the session's repository only when it lies inside it.** A sibling, even one whose path shares the prefix, stops at its own root.
- **The plugin-only lock on agents** removes user and project agents, and managed agents always load. The other surfaces are locked by the callers.
- **A disabled setting source removes all of its directories,** the worktree fallback included.

**Described, kept for parity (Findings, 6 and 7):**
- **The walk can reach the filesystem root.** Outside any repository and outside home, a `.claudin/<subdir>` in an ancestor such as `/tmp` is read as project configuration.
- **Links are followed wherever they point.** A repository can ship `.claudin/commands/x.md` as a link to any file the user can read. That file's first line becomes the command's description, which is listed to the model, and its whole text becomes the command's prompt.

## Tests that pin it

- **`src/memory/instructions/markdownConfigLoader.characterization.test.ts`:** 75 tests, covering 100% of the functions and 92.98% of the lines of `markdownConfigLoader.ts`.
  - **Its world.** Every test builds a fresh tree in the system temp directory:
    - the project is a real git repository, with git's global and system configuration shut out;
    - `CLAUDIN_CONFIG_DIR` points into the tree;
    - the managed directory is the tree's, by seeding the memo of `getManagedFilePath`. The implementation must therefore read the managed path through `getManagedFilePath()` when a load runs.
  - **Switches.** The plugin-only lock is the managed directory's `managed-settings.json`. The setting sources, the project root and the `--add-dir` list are set through `src/platform/bootstrap/state.ts`.
  - **Child processes.** Three tests run the loader in a child `bun` with its own environment:
    - two with their own `HOME`, because Bun fixes the home directory at startup;
    - one with a `PATH` whose `rg` cannot be executed.

    The child imports `markdownConfigLoader.ts` by path, so the module must stay there.
  - **Both search mechanisms.** The file-selection tests run twice, with the default search and with `CLAUDIN_USE_NATIVE_FILE_SEARCH=1`.
- **`src/memory/instructions/ruleFrontmatter.characterization.test.ts`:** 25 tests, covering 100% of `ruleFrontmatter.ts`.
- **Fixtures in `src/memory/instructions/__fixtures__/rewrite/`.** Each is a real input:
  - `agent.md`, written by `formatAgentAsMarkdown` (the `/agents` editor);
  - `scoped-rule.md`, written by `translateCursorRule` (the Cursor import);
  - `cursor-rule.md`, a Cursor rule copied in unconverted;
  - `command.md`, a hand-written legacy command whose values need the quoting retry.

  The CRLF variants are derived in the tests, so a checkout's line-ending settings cannot change them.
- **`scripts/migrations/probes/rewrite-memory-markdownConfigLoader.json`:** 40 probes, 32 on `markdownConfigLoader.ts` and 8 on `ruleFrontmatter.ts`. Every one turns the two suites red.
- **Existing tests that reach the unit through its callers.** They pass against the old module:
  - `src/skills/loadSkillsDir.characterization.test.ts`, for legacy commands and the walk for skills;
  - `src/memory/instructions/claudemd.test.ts` and `src/memory/instructions/rulesLint.test.ts`, for `paths:` through the rule loader and the linter;
  - `src/memory/memdir/pathScopedMemories.test.ts`;
  - `src/platform/import/translate/rules.test.ts`, `src/platform/import/adapters/cursor.test.ts` and `src/platform/import/importPipeline.test.ts`, which call `inspectRuleFrontmatter` directly.
- **Prompt text.** This unit writes no text for a model: descriptions come from the user's files. No test, snapshot or generated file outside the unit pins text of this unit.
- **Not pinned, and why:**
  - **The time limit of a directory search.** It needs a file system slower than the limit.
  - **Identity limits:** device and inode 0, large inodes, and an identity that cannot be read. They need such a file system.
  - **Windows paths and Unicode normalization of the home path.**
  - **Which path a file reached twice inside one source reports,** and the order of files inside one directory.
  - **The rows marked "Not pinned" above,** including the three that Findings 1, 4 and 5 describe.
  - **The ripgrep fallback is proven only in a child process,** so its lines do not count toward the coverage figure.
- **Outside the unit, quoting or naming the old code:**
  - `scripts/bench/ab/delegation-steer-ab.ts`, question `m4-command`, quotes a line of the old walk. Take it out of the implementation sandbox, and reword it against the new module when the implementation lands.
  - `src/plugins/zipCache.ts` (line 240) names a private helper of the old module in a comment. Reword it in the same change.
  - `src/platform/import/translate/rules.ts` cites `ruleFrontmatter.ts:20` by line number. Keep the name and drop the line number.
- **Landing note.** The rule suite imports `RULE_FRONTMATTER_SUPPORTED_KEYS`, which `knip-baseline.json` lists as unused. `deadcode:exports` then reports one finding fewer, so refresh the baseline in the same change.

## Out of scope

- **The ripgrep search.** Nothing observable depends on it.
  - The files are few and the directories shallow, so one in-process walk meets the whole contract and saves a process start per directory.
  - If the rewrite does that, `CLAUDIN_USE_NATIVE_FILE_SEARCH` has nothing left to choose. Nothing else reads it, so it can go with the ripgrep path. The suite passes either way.
- **Keep `RULE_FRONTMATTER_SUPPORTED_KEYS`.** Knip calls it unused, but the Cursor import cites it as the rule it follows, and the suite pins it.

## Findings

1. **A regular file at `.claudin/<subdir>`.**
   - The walk lists it, since only existence is checked.
   - The default search then returns the file itself as a markdown entry whatever its name, with `baseDir` equal to `filePath`. The in-process search returns nothing.
   - **Decision: fix.** Only a directory is a source: the walk skips anything else, and the load reads nothing from it. No caller, stored data or workflow can depend on a stray file being loaded as configuration.
2. **A failed load stays cached.**
   - When the walk throws, or a search is cut short with nothing found, the rejection is cached for that subdirectory and cwd until `cache.clear()`.
   - **Decision: fix.** A load that failed is not cached, so the next call retries, as the rewritten skills listing already does. A search that returns a partial list at the time limit keeps today's behaviour: it is returned and cached.
3. **A symlinked file is not folded into its target.**
   - Identity is taken without following a final link, so `~/.claudin/agents/reviewer.md`, a link to the project's `reviewer.md`, gives two entries: a user one and a project one. A linked directory or a hard link gives one.
   - **Decision: keep for parity.** A link under another name is a way to alias an agent or an output style, and folding it would silently drop an entry that a user set up. The skills listing already folds legacy commands by real path on its own.
   - Pinned by "a symlinked file is an entry of its own".
4. **The description cut can split a surrogate pair.**
   - The 97-character cut counts UTF-16 code units, so an emoji across the cut leaves a lone surrogate before `...`.
   - **Decision: fix.** Never cut inside a pair; cut before it. Nothing can depend on a broken character.
5. **A byte-order mark hides the frontmatter.**
   - A file saved with a UTF-8 BOM does not start with `---`, so its keys are lost, and the frontmatter text becomes part of the body.
   - **Decision: keep for parity here.** The fix belongs to `parseFrontmatter` in `src/shared/frontmatterParser.ts` (phase 4), so that every reader of frontmatter gains it at once.
6. **Security: the walk can reach the filesystem root.**
   - Outside any repository and outside home, the walk reads `.claudin/<subdir>` in every ancestor: a session in `/tmp/work` reads `/tmp/.claudin/agents`.
   - On a shared machine, anyone who can write there can plant an agent (hooks, tools) or a command in another user's session.
   - **Decision: keep for parity, and track it.** Shared workspace configuration above a project that is not a repository depends on this walk, and the `CLAUDE.md` loader walks the same way. An ownership check would be noticed by legitimate shared setups, such as one owned by an administrator, so it is not pure hardening.
7. **Security: links are followed wherever they point.**
   - A cloned repository can ship `.claudin/commands/x.md` as a relative link to a file in the user's home.
   - Through the skills listing, that file's first line is listed to the model as the command's description, and its text becomes the prompt when the command runs.
   - **Decision: keep for parity, and track it.** Linked command and agent libraries, such as `~/dotfiles`, rely on links. The trust the user grants the project is the boundary.
8. **`paths:` as a list that holds a non-string.** The rule is reported malformed, yet its string entries still scope it.
   - **Decision: keep for parity.** The rule works for the patterns that are valid, and the linter flags the rest.
   - Pinned.
9. **Outside this unit: the Cursor import splits braces.** `translateCursorRule` splits a string-form `globs:` on every comma, so `server/**/*.{ts,tsx}` becomes the two broken patterns `server/**/*.{ts` and `tsx}`. It belongs to the import's own module, and the list form translates correctly.

## Target design

- **The facade.** `markdownConfigLoader.ts` stays the module that callers import. It keeps every export above, `loadMarkdownFilesForSubdir.cache.clear()` included. The work lives in small modules beside it, each with one responsibility.
- **Pure helpers.** The description and the two tool-list readers are pure functions, and so is the pattern derivation for rules.
- **The upward walk** takes the home directory, the git lookups and the session root through a narrow `…Deps` parameter. The stop rules of section 1 are then one testable decision, with no module mocks.
- **One directory reader.** It takes a directory and returns its markdown files, following section 3:
  - links followed, with a cycle guard on the real identity of each directory;
  - names by the entry, hidden entries included, ignore files not read;
  - each failure logged with `logForDebugging` and skipped;
  - a time budget.

  Each file is parsed with `parseFrontmatter`.
- **Sources as data.** A table of `{ source, directories, isOn }` rows holds the managed, user, project and worktree sources and the gates of section 7, rather than a chain of conditions.
- **De-duplication** by the identity of section 5: exact, failing open, and first source wins.
- **The cache** is keyed on subdirectory and cwd. It does not keep failures (Findings, 2), and it exposes `cache.clear()`.
- **`ruleFrontmatter.ts`** stays a leaf, with the `paths` shape check as a named schema.
- **Types.** Explicit, with no `any`, and regular expressions at module level.
- **Call-time reads.** The environment, the settings, the managed path and the home directory are read when a load runs, because the tests change them between calls.

## Outcome

- **The gate.** `src/memory/instructions/markdownConfig/fileIdentity.test.ts` matched 8 lines of openclaude: a run of look-alike entries that matched by shape. The entries are now built from a table of path and identity pairs, and every case and expectation is kept. The file measures zero.
- **Residue, reviewed.** These lines of Claude Code stay. Each one is contract:
  - **`src/memory/instructions/markdownConfig/configDirectories.ts`, 2 lines.** The declarations of `CLAUDE_CONFIG_DIRECTORIES` and of `ClaudeConfigDirectory`, the type derived from it. The contract keeps both names: `fileSuggestions.ts` imports the list, `envNaming.test.ts` allowlists it, and the type is the parameter of the public functions.
  - **`src/memory/instructions/markdownConfig/loadMarkdownFiles.ts`, 2 lines.** The signature of the load that the cache wraps, unchanged, as `loadMarkdownFilesForSubdir`. Its `subdir` parameter and its return type are the ones the contract table gives.

  They go when the contract is redesigned, after every consumer has been rewritten.
