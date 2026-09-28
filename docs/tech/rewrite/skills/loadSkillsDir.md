# Spec: `skills/loadSkillsDir` and `skills/mcpSkillBuilders`

## Purpose

The loader for the skills and slash commands that users and projects keep on
disk as markdown. It reads `SKILL.md` directories from the managed, user,
project and `--add-dir` skills directories, plus the deprecated
`.claudin/commands` directories, and turns each file into a prompt `Command`.
The command registry (`src/commands/commands.ts`) lists them next to the
bundled and plugin skills.

It also keeps the session's **dynamic** skills. A skill whose frontmatter has
`paths:` stays out of the listing until the agent touches a matching file. A
`.claudin/skills` directory nested below the cwd is loaded the first time the
agent reads, edits or writes a file under it. The three file tools drive both,
and a signal tells the skill change detector to refresh the command caches.

`mcpSkillBuilders.ts` is a registry through which MCP skill discovery would
reach `createSkillCommand` and `parseSkillFrontmatterFields` without an import
cycle. This fork never received MCP skill discovery, so nothing reads the
registry today.

## Public contract

These must keep their names and types: the modules that have not been rewritten
yet import them.

| Export | Signature | Used by |
|---|---|---|
| `getSkillsPath` | `(source: SettingSource \| 'plugin', dir: 'skills' \| 'commands') => string` | `src/skills/skillChangeDetector.ts`, `src/skills/ui/SkillsMenu.tsx` |
| `estimateSkillFrontmatterTokens` | `(skill: Command) => number` | `src/skills/ui/SkillsMenu.tsx`, `src/agent/context/analyzeContext.ts` |
| `getSkillDirCommands` | `(cwd: string) => Promise<Command[]>` | `src/commands/commands.ts` |
| `clearSkillCaches` | `() => void` | `src/commands/commands.ts`, `src/skills/skillChangeDetector.ts` |
| `getDynamicSkills` | `() => Command[]` | `src/commands/commands.ts` |
| `clearDynamicSkills` | `() => void` | `src/commands/clear/caches.ts` |
| `onDynamicSkillsLoaded` | `(callback: () => void) => () => void`, returning the unsubscribe | `src/skills/skillChangeDetector.ts` |
| `discoverSkillDirsForPaths` | `(filePaths: string[], cwd: string) => Promise<string[]>` | `FileReadTool.ts`, `FileEditTool.ts` and `FileWriteTool.ts` in `src/tools/` |
| `addSkillDirectories` | `(dirs: string[]) => Promise<void>` | the same three |
| `activateConditionalSkillsForPaths` | `(filePaths: string[], cwd: string) => string[]` | the same three |
| `parseSkillFrontmatterFields` | `(frontmatter: FrontmatterData, markdownContent: string, resolvedName: string, descriptionFallbackLabel?: 'Skill' \| 'Custom command') => { …fields below }`; the label defaults to `'Skill'` | `mcpSkillBuilders.ts` (type only) |
| `createSkillCommand` | `(params: { …object below }) => Command` | `mcpSkillBuilders.ts` (type only) |
| `LoadedFrom` (type) | `'commands_DEPRECATED' \| 'skills' \| 'plugin' \| 'managed' \| 'bundled' \| 'mcp'` | the `loadedFrom` parameter of `createSkillCommand`; nothing imports it by name |
| `MCPSkillBuilders` (type, `mcpSkillBuilders.ts`) | `{ createSkillCommand: typeof createSkillCommand; parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields }` | `loadSkillsDir.ts` |
| `registerMCPSkillBuilders` (`mcpSkillBuilders.ts`) | `(b: MCPSkillBuilders) => void` | `loadSkillsDir.ts`, once, when it is loaded |

**The fields `parseSkillFrontmatterFields` returns.** They are
`displayName: string | undefined`, `description: string`,
`hasUserSpecifiedDescription: boolean`, `allowedTools: string[]`,
`argumentHint: string | undefined`, `argumentNames: string[]`,
`whenToUse: string | undefined`, `version: string | undefined`,
`model: string | undefined`, `disableModelInvocation: boolean`,
`userInvocable: boolean`, `hooks: HooksSettings | undefined`,
`executionContext: 'fork' | undefined`, `agent: string | undefined`,
`effort: EffortValue | undefined` and `shell: FrontmatterShell | undefined`.

**The object `createSkillCommand` takes.** It has every field above, except that
`executionContext` widens to `'inline' | 'fork' | undefined`. It also takes
`skillName: string`, `markdownContent: string`,
`source: PromptCommand['source']`, `baseDir: string | undefined`,
`loadedFrom: LoadedFrom` and `paths: string[] | undefined`. MCP discovery would
build it by spreading the parsed fields and adding those six.

**Structure constraints:**
- `mcpSkillBuilders.ts` must stay a leaf that imports nothing but types.
- `transformSkillFiles` is exported too, but nothing imports it. See Out of scope.

## Observable behaviour

### 1. The listing: `getSkillDirCommands(cwd)`

It resolves to the skills of every enabled source that are not path-scoped
(section 5), in this order:

1. **Managed:** `<getManagedFilePath()>/.claudin/skills`, source
   `policySettings`. It is skipped when `CLAUDIN_DISABLE_POLICY_SKILLS` is
   truthy (`1`, `true`, `yes` or `on`, in any case).
2. **User:** `<getClaudinConfigHomeDir()>/skills`, which is
   `CLAUDIN_CONFIG_DIR` or `~/.claudin`. Source `userSettings`.
3. **Project:** `.claudin/skills` in each directory that
   `getProjectDirsUpToHome('skills', cwd)` returns. Source `projectSettings`.
   - Inside a git repository, that is the cwd and each parent up to and including the git root, nearest first.
   - Outside one, it goes up to but not including the home directory.
4. **`--add-dir`:** `<dir>/.claudin/skills` for each entry of
   `getAdditionalDirectoriesForClaudeMd()`, in that order. Source
   `projectSettings`. Only that one directory is read; there is no upward walk.
5. **Legacy commands**, as described in section 3.

**Every skill from sources 1 to 4** has `loadedFrom: 'skills'`. Section 7 lists
the switches that remove sources.

**De-duplication.** When two entries resolve, through symlinks, to the same
file, only the first one in the order above is kept, whatever its name. An
entry whose real path cannot be resolved is kept (not pinned). Two different
files with the same name are both listed, in source order.

**Caching.** The result is cached per `cwd`. A second call with the same `cwd`
returns the same list even when the disk has changed, and another `cwd` loads on
its own. `clearSkillCaches` drops the cache (section 9).

**Errors.** A problem with a single file never rejects the listing.

### 2. What a skills directory holds

- **What a skill is.** A directory that contains a file named `SKILL.md`, matched case-insensitively (`skill.md` and `Skill.MD` count).
- **Name.** The skill directory's path relative to the skills directory, with every separator replaced by `:`. `git/commit/SKILL.md` is `git:commit`.
- **`skillRoot`.** The skill directory, as it was reached. Under a symlinked directory it is the path through the link, not the link's target.
- **Depth.** Directories are searched at any depth.
  - A directory without a `SKILL.md` contributes only through its subdirectories.
  - A skill directory may hold further skills: `outer/SKILL.md` and `outer/inner/SKILL.md` are `outer` and `outer:inner`.
- **Ignored files.** Files directly in the skills directory are ignored, a `SKILL.md` there included. So is any other markdown file inside a skill directory.
- **Symlinks.**
  - Symlinked directories are followed at every level.
  - A symlink loop ends the search and adds no duplicate.
  - A dangling link is ignored.
- **Order.** Within one skills directory, the skills come in the order of their `SKILL.md` paths, compared as plain strings.
- **Frontmatter.** It is parsed with `parseFrontmatter` from `src/shared/frontmatterParser.ts`. When it is not valid YAML, the skill still loads with every default, and its body is whatever follows the closing `---`.

### 3. Legacy commands directories (deprecated)

The files are exactly those that `loadMarkdownFilesForSubdir('commands', cwd)`
returns (`src/memory/instructions/markdownConfigLoader.ts`):
- `<managed>/.claudin/commands`, always, with source `policySettings`;
- `<config home>/commands`, when user settings are enabled;
- `.claudin/commands` in the project directories of section 1, when project settings are enabled.

That is every `*.md` at any depth, with symlinks followed and each physical file
once.

- **A directory with a `SKILL.md`** (case-insensitive) contributes that file only.
  - It is named after the directory's path relative to the commands directory, joined with `:`.
  - Its `skillRoot` is that directory.
  - Other markdown files in the same directory are ignored. Its subdirectories are not.
- **Any other `.md` file** is a command named after its path relative to the commands directory, without `.md` and joined with `:`. `ops/eu/rollback.md` is `ops:eu:rollback`. It has no `skillRoot`.
- **Other properties:**
  - Non-markdown files are ignored.
  - The command has `loadedFrom: 'commands_DEPRECATED'`.
  - `name:` never changes how the command is shown: `userFacingName()` returns the command name.
  - `paths:` is ignored, so a legacy command is never path-scoped.
  - The description falls back to `'Custom command'`. Every other key is read as for a skill (section 4).

### 4. Frontmatter to `Command`

`parseSkillFrontmatterFields` reads the keys below, and `createSkillCommand` maps
them onto the `Command`. The listing uses both.

| Key | Command field | Rule | When absent |
|---|---|---|---|
| `name` | `userFacingName()` | any non-null value, as a string; an empty one falls back | the command name |
| `description` | `description` | strings are trimmed; numbers and booleans become strings; a blank, list or object value falls back | the first non-blank body line, with a leading `#` heading marker removed and cut to 97 characters plus `...` when longer than 100 (`extractDescriptionFromMarkdown`). When the body is blank, the label: `'Skill'` by default, `'Custom command'` for legacy commands |
| (same) | `hasUserSpecifiedDescription` | true when the frontmatter supplied the description | false |
| `allowed-tools` | `allowedTools` | a list, or a string split on commas and spaces outside parentheses (`parseSlashCommandToolsFromFrontmatter`), so `Bash(git status:*)` stays whole | `[]` |
| `argument-hint` | `argumentHint` | as a string | undefined |
| `arguments` | `argNames` | a space-separated string or a list; blank and all-digit names are dropped (`parseArgumentNames`) | undefined, also when nothing is left |
| `when_to_use` | `whenToUse` | as parsed | undefined |
| `version` | `version` | as parsed | undefined |
| `model` | `model` | `inherit` means no override. Anything else goes through `parseUserSpecifiedModel`: aliases resolve, and custom names pass through with their case | undefined |
| `disable-model-invocation` | `disableModelInvocation` | true only for `true` or `'true'` | false |
| `user-invocable` | `userInvocable` | true only for `true` or `'true'`, so `yes` hides the skill | true |
| `hooks` | `hooks` | kept when `HooksSchema` accepts it, otherwise dropped with a debug log | undefined |
| `context` | `context` | only `fork` is kept | undefined |
| `agent` | `agent` | as parsed | undefined |
| `effort` | `effort` | a level name in any case, or an integer given as a number or a numeric string (`parseEffortValue`); anything else is dropped with a debug log | undefined |
| `shell` | not on the Command | `bash` or `powershell`, trimmed, in any case (`parseShellFrontmatter`); anything else falls back to bash with a debug log. It picks the shell for embedded commands (section 6) | bash |
| `paths` | `paths` | skills directories only; see section 5 | undefined |

**Fixed and derived fields:**
- `type: 'prompt'` and `progressMessage: 'running'`;
- `isHidden: !userInvocable`;
- `contentLength`: the length of the body after the frontmatter;
- `source`, from the directory;
- `loadedFrom` and `skillRoot`, as in sections 1 to 3.

**How `createSkillCommand` maps its parameters:**
- `argNames` is left out when `argumentNames` is empty;
- `context` is `executionContext`, and `'inline'` is kept as given;
- `skillRoot` is `baseDir`;
- `userFacingName()` returns `displayName`, or `skillName` when that is empty.

The Command has no other defined fields.

### 5. Path-scoped skills

- **Held.** A skill from a skills directory whose `paths:` survives the rules below is *held*: it does not appear in the listing.
- **The patterns.**
  - `paths:` is a comma-separated string, in which commas inside braces do not split, or a list.
  - Braces expand, so `lib/*.{ts,tsx}` gives two patterns.
  - A trailing `/**` is removed from each pattern, and empty patterns are dropped.
  - When nothing is left, or every pattern left is `**`, the skill is not path-scoped: it is listed normally, with `paths` undefined.
  - This is the same treatment a rule's `paths:` gets in `src/memory/instructions/ruleFrontmatter.ts`.
- **The `paths` field** holds the processed patterns. `src/**, docs/*.md` becomes `['src', 'docs/*.md']`.
- **Activation.** `activateConditionalSkillsForPaths(filePaths, cwd)` matches every held skill against the file paths with gitignore semantics (the `ignore` package).
  - Absolute paths are first made relative to `cwd`. Relative paths are used as given.
  - A skill that matches any of the paths moves into the dynamic skills and stops being held, and its name is returned.
  - A second matching file activates nothing new.
- **What never matches:**
  - a path outside `cwd`, whose relative form starts with `..` or is still absolute (as happens across Windows drives);
  - the cwd itself;
  - an empty string.
- **The signal** (section 9) fires once per call that activated at least one skill, after the skills are visible. It never fires when nothing was activated.
- **With nothing held,** the call returns `[]` and does nothing else.
- **Activation memory.**
  - Once activated, a skill of that name is listed normally by any later load, for another `cwd`, since the same `cwd` is served from the cache.
  - This holds until `clearSkillCaches` or `clearDynamicSkills`.

### 6. Invoking a skill: `getPromptForCommand(args, context)`

The result is always a single text block, built in this order. The order is
observable (see Security requirements).

1. **The body.** When the skill has a base directory, it is prefixed with `Base directory for this skill: <skillRoot>` and one blank line.
2. **The arguments,** through `substituteArguments(text, args, true, argNames)`:
   - `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n` and the named arguments are filled;
   - arguments that fill no placeholder are appended as `\n\nARGUMENTS: <args>`;
   - an empty `args` changes nothing.
3. **`${CLAUDIN_SKILL_DIR}`.** Every occurrence becomes the base directory. On Windows, its backslashes become forward slashes. Without a base directory, the variable is left as written.
4. **`${CLAUDIN_SESSION_ID}`.** Every occurrence becomes `getSessionId()`.
5. **Embedded shell,** unless `loadedFrom` is `'mcp'`:
   - That is the inline `` !`cmd` `` form, after whitespace or at the start of a line, and fenced ```` ```! ```` blocks.
   - They run through `executeShellCommandsInPrompt` with the frontmatter `shell`.
   - For that call, the permission check sees the skill's `allowedTools` as the always-allow rules of the `command` source.
   - A command that is not permitted, or that fails, rejects the invocation.
   - A body with no embedded shell never consults `context`.

**An MCP skill** returns the result of steps 1 to 4 verbatim, with any shell
syntax left as text, and never touches `context`.

### 7. Settings, policy and switches

| Switch | Effect |
|---|---|
| user settings source disabled | no user skills and no user legacy commands |
| project settings source disabled | no project or `--add-dir` skills and no project legacy commands; `addSkillDirectories` does nothing |
| a managed `strictPluginOnlyCustomization` that locks `skills` (`true`, or a list that contains it) | only the managed skills load. No legacy commands load at all, the managed ones included, and `addSkillDirectories` does nothing |
| a lock on other surfaces only | nothing changes |
| `CLAUDIN_DISABLE_POLICY_SKILLS` truthy | the managed skills directory is skipped; nothing else changes |
| bare mode (`isBareMode()`: `CLAUDIN_SIMPLE` or `--bare`) | only the `--add-dir` skills load, as `projectSettings`. Nothing loads at all when there is no `--add-dir`, when project settings are disabled, or when skills are locked: bare mode is not a way around the policy |

All of these are read at call time.

### 8. Skill directories under a touched file

`discoverSkillDirsForPaths(filePaths, cwd)` walks up from each file's parent
directory, and stops before it reaches `cwd`.

- **Below `cwd`** means the path starts with `cwd` followed by a separator. A trailing separator on `cwd` is ignored, and `<cwd>-backup` is not below `cwd`.
- **Candidates.** Each directory on the way contributes `<dir>/.claudin/skills` when that path exists.
  - The cwd's own `.claudin/skills` is never returned, because the listing loads it.
  - A file outside `cwd` yields nothing.
- **Each candidate is checked once per session,** until `clearDynamicSkills`, whether it existed or not. A hit is not returned again. A miss is not retried, even when the directory appears later.
- **Gitignored candidates.** A candidate whose containing directory git ignores is skipped with a debug log, and is not retried either.
  - The check is `isPathGitignored(dir, cwd)`, which covers nested `.gitignore` files, `info/exclude` and the global excludes.
  - Outside a git repository, nothing counts as ignored.
- **Order.** Deepest first, by number of path segments. Ties keep the order of discovery.

### 9. Dynamic skills, the signal and the caches

**`addSkillDirectories(dirs)`:**
- It reads each directory as a skills directory (section 2), with source `projectSettings` and `loadedFrom: 'skills'`.
- The skills join the dynamic skills by name.
  - Within one call, the directory that comes first in the list wins; callers pass them deepest first.
  - A later call replaces a skill of the same name.
- The signal fires once, after the skills are visible, even when the directories held no skills.
- It resolves even when a directory is missing.
- It does nothing, and fires no signal, for an empty list, when project settings are disabled, or when skills are locked.

**`getDynamicSkills()`** returns the discovered and activated skills, as a new
array on every call. Their order is not part of the contract.

**`onDynamicSkillsLoaded(callback)`** subscribes to the signal and returns the
unsubscribe. A listener that throws is logged with `logError`; the other
listeners still run, and the call that fired the signal still succeeds.

**`clearSkillCaches()`:**
- drops the per-`cwd` listing cache and the legacy commands file cache (the one in `loadMarkdownFilesForSubdir`);
- drops the held skills and the activation memory;
- keeps the dynamic skills and the memory of checked directories.

**`clearDynamicSkills()`:**
- drops the dynamic skills and the memory of checked directories;
- drops the held skills and the activation memory;
- keeps the listing cache (not pinned).

### 10. The small helpers

**`getSkillsPath(source, dir)`:**
- `policySettings`: `join(getManagedFilePath(), '.claudin', dir)`;
- `userSettings`: `join(getClaudinConfigHomeDir(), dir)`;
- `projectSettings`: the relative string `.claudin/<dir>`, with a forward slash on every platform;
- `'plugin'`: the literal `'plugin'`;
- any other source: `''`.

**`estimateSkillFrontmatterTokens(skill)`** is the `roughTokenCountEstimation`
of the name, the description and `whenToUse`, joined by single spaces, with the
empty ones skipped. The body does not count: it is loaded only when the skill
runs.

**`registerMCPSkillBuilders(b)`** stores the pair and returns nothing. Nothing
reads it back.

## Security requirements

**Pinned by the tests:**
- **MCP skills never execute embedded shell.** Their markdown is remote and untrusted.
- **Gitignored skill directories.** A skill directory found under a touched file is skipped when git ignores the directory that contains it, so a package under `node_modules/` cannot bring skills in. The check fails open outside a repository; the trust dialog at invocation is the boundary that counts.
- **The plugin-only lock.** It covers every source that a user or a project controls: legacy commands, the managed ones included, and dynamically discovered directories. Bare mode does not get around it.
- **Shell embedded in a skill from disk runs through the permission check.** The suite pins that the check is reached.

**Not pinned:**
- **The `allowedTools` grant during that check.** Observing it needs a real run of the shell tool.

**Finding, not fixed here: arguments reach the shell pass.** Arguments are
substituted before the variables and before the shell pass, so text in `args`
is treated like the author's text:
- `${CLAUDIN_SKILL_DIR}` and `${CLAUDIN_SESSION_ID}` in it expand.
- An inline `` !`cmd` `` or a ```` ```! ```` block in it runs through the permission check with the skill's `allowedTools` granted.
- A skill without a placeholder is exposed too. Arguments that fill no placeholder are appended after `ARGUMENTS: `, and the inline form only needs whitespace before the `!`.
- The model writes the arguments when it invokes a skill through the Skill tool. A skill that grants `Bash(npm:*)`, for example, lets the model run any `npm` command it puts in the arguments.

No test pins this in either direction.

**Decision (2026-09-28): the rewrite keeps the order of section 6 exactly.** It
is a rewrite, not a behaviour change. Skills in the wild may use `$ARGUMENTS`
inside an embedded command (`` !`gh issue view $ARGUMENTS` ``), and simply
reordering would break them. The fix needs a design of its own: substitute
shell-quoted values inside command spans, and never scan argument text for
shell syntax. It is tracked in the team bug memory
`skill-arguments-reach-shell-pass`.

**Minor finding, fixed in the rewrite.** The base directory was put in as a
replacement string, so a path that contained `$&`, `` $` ``, `$'` or `$$` came
out altered in the prompt. The rewrite inserts the path literally, as the
argument pass already did for arguments.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A skills or commands directory that is missing or unreadable | no skills from it, and no error |
| An entry named `SKILL.md` that is not a readable file | that skill is skipped and the rest load; a debug warning, unless the error is "not found" |
| Frontmatter that is not valid YAML | the skill loads with every default |
| A symlink loop | the search ends, and no duplicate appears |
| A dangling symlink | ignored |
| The same file reached twice | listed once, as its first source |
| Two files with the same name | both listed |
| A legacy directory with both `SKILL.md` and `skill.md`, on a case-sensitive file system | one of them is used, which one is unspecified, and a debug line is logged. Not pinned |
| `activateConditionalSkillsForPaths` given a relative path starting with `./` while a skill is held | a `RangeError` from the `ignore` package. Callers pass absolute paths today. Not pinned |
| YAML numbers under `version`, `when_to_use` or `agent` | passed through as numbers, despite the string types. Not pinned |
| `effort: 1.5` | becomes `1`. Not pinned |
| A legacy `SKILL.md` directly inside a commands directory | becomes a command named after the commands directory (`commands`) and hides every other file at that level. Not pinned |
| A path-scoped skill in bare mode | listed at once: bare mode does no path scoping and no de-duplication. Not pinned |
| A path-scoped skill in a discovered directory (`addSkillDirectories`) | active at once, with `paths` carried but not applied. Not pinned |
| Two held skills with the same name | the one loaded last replaces the other. Not pinned |
| The pattern `src/**` | with the `/**` removed, `src` matches a `src` directory at any depth, `packages/a/src/x.ts` included. Rules behave the same way. Not pinned |

## Tests that pin it

- **`src/skills/loadSkillsDir.characterization.test.ts`.** 103 tests. They cover 100% of the functions and 96.5% of the lines of `loadSkillsDir.ts`, and 100% of `mcpSkillBuilders.ts`.
  - Every test runs in a fresh temp tree, with `CLAUDIN_CONFIG_DIR` pointing into it.
  - The managed directory is redirected by seeding the memo of `getManagedFilePath`, because the platform path is not writable. The implementation must therefore read it through `getManagedFilePath()` at call time.
  - The plugin-only lock is that directory's `managed-settings.json`.
  - The setting sources and the `--add-dir` list are set through `src/platform/bootstrap/state.ts`.
  - The gitignore case builds a real repository, with git's global configuration shut out.
- **`scripts/migrations/probes/rewrite-loadSkillsDir.json`.** 40 probes. Replayed against an out-of-tree copy of the old module, every one turned the suite red. The break-probe run itself is the confirmation.
- **`src/skills/loadSkillsDir.test.ts`** is removed with the rewrite: this project did not write it. The suite above covers what it checked:
  - flat and nested names;
  - the `skillRoot` of nested skills;
  - skills found in a parent directory's `.claudin/skills`.
- **Not pinned, and why:**
  - **The `allowedTools` grant during the shell pass.** Observing it needs a real run of the shell tool.
  - **The project walk outside a git repository.** Bun fixes the home directory at process start, and the test would read `/tmp/.claudin` and `/.claudin`.
  - **The symlink cycle guard.** Removing it changes nothing a caller can see: the operating system's symlink limit ends the search, and de-duplication by file drops the copies. It is still required, for time.
  - **Windows path handling.**
  - **The order of `getDynamicSkills()` and of the activated names.**
  - **The rows marked "Not pinned" above.**
- **Not a test, but it reads the old source.** `scripts/bench/ab/delegation-steer-ab.ts`, in question `m4-command`, quotes four lines of the old module and names three of its private functions as the expected answer. Take it out of the sandbox before the brief, and reword it against the new module in the same change.

## Out of scope

- **The `transformSkillFiles` export.** Nothing imports it (`knip-baseline.json` lists it as unused), and its behaviour survives in section 3. Drop the export and refresh the knip baseline in the same change.
- **A reader for the MCP registry.** It is write-only. Keep `MCPSkillBuilders` and `registerMCPSkillBuilders` so the contract holds; nothing needs to read them until MCP skill discovery exists. When it lands, it needs a getter, and its skills must keep `loadedFrom: 'mcp'`.

## Outcome (2026-09-28)

**The implementation.** `loadSkillsDir.ts` is now a 38-line facade over ten
modules in `src/skills/loading/`. It was written in a sandbox that had no
history, no old module and no probe spec.
- **Characterization suite:** passes unchanged.
- **`skillPrompt.test.ts`:** new. It pins two things the old suite could not reach: the literal base-directory insertion, and the `allowedTools` grant during the shell pass.
- **Probe spec:** re-authored against the new code. It now has 59 probes, the 40 old behaviours plus 19 new ones, and every probe turns the two suites red.
- **Provenance:** every new file measures zero inherited lines. `loadSkillsDir.test.ts`, which openclaude wrote, is gone.

**Deliberate differences.** All of them are in behaviour no test pinned.
- **Bare mode de-duplicates.** Bare mode drops a file reached twice, as the normal listing does. Path-scoped skills are still listed at once there, because the file tools never activate them in bare mode.
- **The prompt-command subtype.** `createSkillCommand` is typed to return it, which every `Command` consumer accepts.
- **Validated hooks.** They are returned as the schema's parsed copy, which is identical for valid input.
- **An empty `model:`** counts as absent instead of resolving to a default.
- **Failed listings.** A listing that fails is not cached, so the next call retries.
- **Symlink loops.** The walk stops when a directory's real path is already one of its ancestors. That keeps the result deterministic now that directories are read in parallel.

**Kept on purpose:**
- **Section 6's order.** See the decision under Security requirements.
- **`transformSkillFiles`.** Dropped, as planned. The knip baseline is one finding lower.

**Process note.** The implementer ran the census inside the sandbox. It found
36 lines of contract-dictated declarations and cleared them by reshaping the
field types. That produced no logic change and no hidden copy, but it made the
gate part of the implementer's loop instead of an independent check. From here
on the sandbox leaves `fingerprints.bin` out (see the README).

## Target design

- **Pure core, thin shell.**
  - Frontmatter to fields, and fields to `Command`, are pure functions.
  - The prompt is built by a small pipeline that keeps the order of section 6 in one visible place, so the finding above can be decided there.
  - The session id and the shell executor are passed in, so the prompt can be tested without module mocks.
- **A skills-directory reader.** It takes a directory and a source and returns the skills with their file paths. It has one walk (depth, symlinks, cycle guard, sort) and one naming rule.
- **A legacy commands adapter** over `loadMarkdownFilesForSubdir`.
- **The listing.** It combines:
  - the gates of section 7, kept as a table of sources rather than a chain of conditions;
  - the order of the sources;
  - de-duplication by real path;
  - the split between held and listed skills;
  - the per-`cwd` cache.
- **Session state** has one module-private owner. It holds the held skills, the activation memory, the dynamic skills and the checked directories. Its two clear operations have exactly the scopes of section 9.
- **Discovery** takes the gitignore check through a narrow `…Deps` parameter.
- **The signal** wraps each listener, so that one failure stays contained.
- **Types.** Explicit, with no `any`, a named parameter type for `createSkillCommand`, and regexes at module level. Errors go to `logForDebugging` or `logError`; none is swallowed silently.
- **Call-time reads.** Environment, settings and paths are read at call time, because the tests change them between calls.
- **`mcpSkillBuilders.ts`** stays a leaf, with type-only imports.
