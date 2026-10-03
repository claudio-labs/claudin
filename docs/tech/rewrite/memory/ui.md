# Spec: `memory/ui`, the `/memory` picker and the "memory updated" notice

## Purpose

The first screen of `/memory`. It lists the instruction files the session
loaded (the user's, the project's, their imports, rules, local and managed
files), then the memory folders: private memory, team memory, the tidy
action, and the memory folder of each agent that has one. Above the list sit
two switches, auto-memory and auto-dream. The user picks a row, and the
picker hands its value to the caller; it opens and closes nothing itself.

The unit also owns how a memory path is shortened for the user
(`getRelativeMemoryPath`), and a one-line "memory updated" notice built on it.

`src/commands/memory/memory.tsx` is the only caller. It loads the memory files
first (`clearMemoryFileCaches()` and `await getMemoryFiles()`), counts the
memories in the two folders, and renders the picker inside the design-system
`Dialog` (title `Memory`) and a `React.Suspense` with no fallback. With the
value it gets back, it either runs `/memory tidy`, opens the folder browser
(`MemoryDirBrowser`) for a folder row, or creates the file if missing and opens
it in the editor, reporting `Opened memory file at <short path>` through
`getRelativeMemoryPath`.

**Wording.** `docs/tech/memory/project-local-team-memory.md` and
`src/agent/ui/messages/memoryIndexLine.ts` take their nouns from this picker:
the two memory folders are **private** and **team**, and "user memory" already
means `~/.claudin/CLAUDE.md`. The transcript lines (`Loaded private memories
index …`, `Loaded 4 team bug memories`) rely on that, so the rewrite keeps the
row names exactly: `User memory`, `Project memory`, `Private memory`,
`Team memory`.

**The team build flag.** `feature('TEAMMEM')` is `true` in the shipped build
(`scripts/build/build.ts`) and `false` under `bun test`. The team row exists
only with it on, so the picker suite runs under the flag (see Tests that pin
it). Everything below describes the shipped build.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `MemoryFileSelector` | a React function component taking `{ onSelect: (path: string) => void; onCancel: () => void; dirCounts?: { private: number; team: number } }` | `src/commands/memory/memory.tsx` |
| `getProjectMemoryPathForSelector` | `(existingMemoryFiles: MemoryFileInfo[], cwd: string) => string` (`memoryFileSelectorPaths.ts`) | `MemoryFileSelector` only |
| `getRelativeMemoryPath` | `(path: string) => string` (`MemoryUpdateNotification.tsx`) | `src/commands/memory/memory.tsx` |
| `MemoryUpdateNotification` | a React function component taking `{ memoryPath: string }` | nothing (see Findings) |

`MemoryFileInfo` comes from `src/memory/instructions/claudemd.ts`. The props
types are not exported. Two comments name `MemoryFileSelector.tsx`
(`src/memory/ui/memoryDirRows.ts`, `src/agent/ui/messages/memoryIndexLine.ts`);
they are prose, not imports.

The values the picker shows and hands back are defined by these exports of the
project's own code. The tests compute their expectations with them, so the
rewrite uses them rather than reimplementing them:

| Value | Defined by |
|---|---|
| the loaded files, in order | `getMemoryFiles` (`src/memory/instructions/claudemd.ts`), read with React's `use` |
| the user file | `join(getClaudinConfigHomeDir(), 'CLAUDE.md')` (`src/shared/envUtils.ts`) |
| the start directory | `getOriginalCwd()` (`src/platform/bootstrap/state.ts`) |
| a git repository or not | `projectIsInGitRepo(start directory)` (`src/memory/memdir/versions.ts`) |
| the two folders and their switches | `getAutoMemPath`, `isAutoMemoryEnabled` (`src/memory/memdir/paths.ts`); `getTeamMemPath`, `isTeamMemoryEnabled` (`src/memory/memdir/teamMemPaths.ts`) |
| an agent's folder | `getAgentMemoryDir(agentType, scope)` (`src/tools/AgentTool/agentMemory.ts`); the agents are `agentDefinitions.activeAgents` of the app state |
| a folder row's value, the tidy value | `encodeBrowseValue`, `TIDY_VALUE` (`src/memory/ui/memoryDirRows.ts`); the caller decodes with `parseBrowseValue` |
| a path as shown | `getDisplayPath` (`src/shared/fs/file.ts`) |
| auto-dream on, last run | `isAutoDreamEnabled` (`src/memory/autoDream/config.ts`), `readLastConsolidatedAt` (`src/memory/autoDream/consolidationLock.ts`), shown with `formatRelativeTimeAgo` (`src/shared/text/format.ts`) |
| a dream running | any task in the app state's `tasks` with `type: 'dream'` and `status: 'running'` |
| writing a switch | `updateSettingsForSource('userSettings', …)` (`src/platform/settings/settings.ts`) |
| the project file's names | `PRIMARY_PROJECT_INSTRUCTION_FILE` (`AGENTS.md`) and `findProjectInstructionFilePathInAncestors` (`src/memory/instructions/projectInstructions.ts`) |
| the list widget | `Select` (`src/terminal/custom-select`), and `ListItem` (`src/terminal/design-system/ListItem.tsx`) for the switches |

## Observable behaviour

### 1. The screen

Top to bottom:
- `Auto-memory: on` or `off`.
- When auto memory was on **when the picker opened**: `Auto-dream: on` or
  `off`, then its status (section 6). This line's presence is decided once, at
  open.
- A blank line.
- The list, through `Select`: numbered rows, five visible at a time with scroll
  arrows, the focused one marked `❯`, the label then the description in a
  second column. A chosen row gets the `Select`'s `✔`.

### 2. The rows, in order

1. **Every loaded file** except the private and the team index (the memory
   types `AutoMem` and `TeamMem`), in the order `getMemoryFiles` returns them:
   managed, user, user rules, then for each directory from the root down to the
   start directory the project file, its imports, `.claudin/CLAUDE.md`,
   `.claudin/rules/*.md`, `CLAUDE.local.md`.
2. **`User memory`**, when the user file is not among them.
3. **`Project memory`**, when the project file (section 4) is not among them.
4. Only while `isAutoMemoryEnabled()` is true, checked on every render:
   - `Private memory`, or `Private memory · N` when `dirCounts` is given (`N`
     is `dirCounts.private`, `0` included);
   - `Team memory`, or `Team memory · N` (`dirCounts.team`), when team memory
     is enabled. In the shipped build it follows auto memory;
   - `Tidy memories`;
   - one row per active agent that declares a memory scope, in the app state's
     order. Agents without one get no row.

### 3. Labels and descriptions

| Row | Label | Description |
|---|---|---|
| the user file | `User memory` | `Saved in ~/.claudin/CLAUDE.md`, fixed text |
| the project file | `Project memory` | `Checked in at ./<file name>` when the start directory is in a git repository, else `Saved in ./<file name>` |
| an import | `L ` and its display path, indented two spaces per import level past the first (`L docs/guide.md`, then `  L docs/deep.md`) | `@-imported` |
| any other loaded file (managed, rules, local) | its display path | none |
| private | as in section 2 | `Saved in ` and the display path of the private folder |
| team | as in section 2 | `Shared with the team, git-tracked at ` and the display path of the team folder |
| tidy | `Tidy memories` | `Merge duplicate memories and rebuild the index` |
| an agent | `<agentType> agent memory` (the type in bold) | `<scope> scope`: `user`, `project` or `local` |

A display path is the path relative to the working directory when inside it,
else `~/…` under the home directory, else absolute (`getDisplayPath`). A
folder's display path has no trailing separator. A missing user or project
file carries no "new" mark.

### 4. The project file

`getProjectMemoryPathForSelector(files, startDir)` decides which file is
`Project memory`. It looks only at `files`, never at the disk:
- a file counts when its type is `Project`, it was not reached through an
  import (`parent` unset), and its name is `AGENTS.md` or `CLAUDE.md`;
- from `startDir` up to the filesystem root, the first directory that holds a
  counted file wins, and in it `AGENTS.md` beats `CLAUDE.md`;
- when none does, `<startDir>/AGENTS.md`.

So `.claudin/CLAUDE.md`, `CLAUDE.local.md`, a user-level `CLAUDE.md`, a file in
a sibling directory and an imported `AGENTS.md` never count. Started below the
project file, the picker offers the ancestor's file and no second row.

### 5. What a row hands back

Enter on a row calls `onSelect(value)` once:

| Row | Value |
|---|---|
| a file, `User memory`, `Project memory` | the absolute path |
| private | `encodeBrowseValue({ dir: getAutoMemPath(), title: 'Private memory', isTeamDir: false })` |
| team | `encodeBrowseValue({ dir: getTeamMemPath(), title: 'Team memory', isTeamDir: true })` |
| tidy | `TIDY_VALUE` |
| an agent | `encodeBrowseValue({ dir: getAgentMemoryDir(agentType, scope), title: '<agentType> agent memory', isTeamDir: false })` |

The count is never part of a title. The picker stays mounted after a choice.

**The last choice.** The value chosen last is remembered for the life of the
process. The next picker opens focused on that row when it is still in the
list, else on the first row. Choosing `Tidy memories` is not remembered.

### 6. The auto-dream status

After `Auto-dream: on|off`, in order:
- ` · running` while a dream task is running; else ` · never` when no
  consolidation was ever recorded; else ` · last ran <time ago>`. Before the
  last run is read, nothing.
- ` · /dream to run` when auto-dream is on and no dream is running.

So `Auto-dream: off · never`, `Auto-dream: on · never · /dream to run`,
`Auto-dream: on · last ran 3 hours ago · /dream to run`, `Auto-dream: on ·
running`. A completed dream task is not running.

### 7. Keys

- **List:** the `Select`'s keys. Up and Down move (Down on the last row wraps
  to the first), Enter chooses (section 5).
- **Esc and `n`** call `onCancel()` once and choose nothing.
- **Up on the first row** moves the focus to the last switch: `Auto-dream` when
  its line is shown, else `Auto-memory`. While a switch is focused the list has
  no pointer and ignores keys.
- **On the switches:** Up moves from `Auto-dream` to `Auto-memory` and stops
  there. Down moves from `Auto-memory` to `Auto-dream`, and from the last switch
  back to the list, on the row it left.
- **Enter or `y` on a switch** flips it. The screen shows the new value at once,
  and `{ autoMemoryEnabled: <new> }` or `{ autoDreamEnabled: <new> }` is
  written to the **user** settings (`<config home>/settings.json`). Neither
  key calls `onSelect`.
- Turning auto memory off drops the folder, tidy and agent rows at once, and
  turning it on brings them back. The auto-dream line stays as it was at open.
- Ctrl+C and Ctrl+D go through `useExitOnCtrlCDWithKeybindings`, as in every
  dialog.

### 8. `getRelativeMemoryPath(path)`

Reads the working directory (`getCwd()`) and the home directory on every call.
- inside the working directory: `./` and the path relative to it;
- inside the home directory: `~` and the rest;
- inside both: the shorter of the two, the `~` form on a tie;
- inside neither: the path unchanged. A parent of the working directory is not
  inside it.

### 9. `MemoryUpdateNotification`

One line in a column box that grows: `Memory updated in <getRelativeMemoryPath(memoryPath)> · /memory to edit`.

## Security requirements

- **Settings.** The switches write only the user settings. They never write a
  project, local or policy file: those can be checked in or managed, and a
  picker toggle must not change what a teammate's checkout does.
- **Paths are data.** Row labels show paths from the loader, and imports come
  from repository content. They are shown as text and handed back unchanged;
  the picker resolves, opens and creates nothing. What may be imported, and
  whether external imports need approval, is the loader's concern.
- **No disk reads of its own** beyond what its collaborators do: the last-run
  stamp and the git check. `getProjectMemoryPathForSelector` reads nothing.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Nothing loaded, fresh repository | `User memory`, `Project memory`, then the folders | yes |
| Not a git repository | `Saved in ./AGENTS.md` | yes |
| Only `CLAUDE.md` in the project | it is `Project memory`, `Checked in at ./CLAUDE.md` | yes |
| `AGENTS.md` and `CLAUDE.md` side by side | `AGENTS.md` (the loader reads only that one) | yes |
| Auto memory off at open | one switch, no folder rows | yes |
| `dirCounts` absent | no ` · N` | yes |
| Ten rows or more | the `Select` pads one-digit numbers | read by the suite, not asserted |
| A user rule or a user-level import | listed by its display path | label yes, description no (Findings) |
| Project file in an ancestor of the start directory | `Project memory` is that file | value yes, description no (Findings) |
| `CLAUDIN_DISABLE_AUTO_MEMORY` set, or a higher settings layer, while the switch is flipped | the switch shows the flipped value; the folders follow the effective value | no (Findings) |
| A path that only shares a string prefix with the home or working directory | see Findings | no |
| `path` equal to the working directory or the home directory | `./` or `~` | no |

## Tests that pin it

- **`src/memory/ui/MemoryFileSelector.characterization.test.tsx`.** 24 cases.
  Under the plain runner the file holds one test, which runs the file again in
  a child `bun test --feature=TEAMMEM` and fails with its output. Coverage is
  measured under the flag: 100% of functions, 98.9% of lines. The one
  uncovered line is the unreachable "dynamically loaded" description.
- **`src/memory/ui/memoryFileSelectorPaths.characterization.test.ts`.** 21
  cases, 100% of lines: nine from real trees through `getMemoryFiles`, one
  real import, the rest hand-made lists.
- **`src/memory/ui/MemoryUpdateNotification.characterization.test.tsx`.** 10
  cases, 100% of functions, 94.3% of lines.
- **How the picker suite observes it.** The rewrite has to keep working under this harness:
  - each case has its own `useMemdirWorld()` (`src/memory/memdir/__testutils__/memdirWorld.ts`):
    `CLAUDIN_CONFIG_DIR`, the managed directory, the project and the git home
    are temp directories, and git is isolated from the user's configuration;
  - it mounts the picker with `createRoot` on `createFakeTerminal({ columns: 220 })`
    (`src/terminal/__testutils__/fakeTerminal.ts`), inside `AppStateProvider`
    (an `initialState` carrying the agents and dream tasks), `KeybindingSetup`
    and `React.Suspense`, after priming `getMemoryFiles` as the caller does;
  - it reads the last painted frame: a row is `<n>. <label>`, then two or more
    spaces and the description; the focus is the line with `❯`; a switch line
    is `Auto-memory: …` or `Auto-dream: …`. It reads the whole list by
    pressing Down until the focus comes back to where it started;
  - it records the last-run stamp through `recordConsolidation` and
    `rollbackConsolidationLock`, and reads the switches back from
    `<config home>/settings.json`;
  - keys are raw sequences on stdin, re-sent when the screen did not change
    within 1.5 s.
- **`scripts/migrations/probes/rewrite-memory-ui.json`.** 40 probes over the
  three files (31 on the picker, 3 on the project path, 6 on the short path
  and the notice), and every one turns at least one test red.
- **No other test** renders the picker or the notice. Nothing outside the unit
  pins its text byte for byte, and the unit sends nothing to a model.
- The phase-2 plan names an inherited `memoryFileSelectorPaths.test.ts`. It is
  not in the tree; the paths suite covers its subject.

**Not pinned, and why:** the descriptions marked "no" above, which are wrong
today (Findings); styling (bold agent type, dim status), which depends on the
colour level; Ctrl+C and Ctrl+D, since a second press exits the test process;
the `Select`'s scrolling and padding.

## Out of scope

- **The "dynamically loaded" description.** It belongs to a kind of file no
  loader produces, so no row can show it. The rewrite drops it.

## Findings

| Finding | Decision |
|---|---|
| **Every user-level file is described as `Saved in ~/.claudin/CLAUDE.md`**: user rules and imports of the user file too, not only the user file. | Fix. Only the user file gets that description; an import says `@-imported`, a rule none. Pin it in the new module's tests. |
| **The project file in an ancestor directory** is still described as `./<file name>`, as if it were in the start directory. | Fix. Show its path relative to the start directory. |
| **Prefix tests without a separator.** `getRelativeMemoryPath` treats `/home/u` as containing `/home/user2/x` (shown `~ser2/x`), and a working directory `/a/pro` as containing `/a/project/x` (shown `./../project/x`). | Fix. A directory contains a path only up to a separator. Display text only: `/memory`'s confirmation is the one caller. |
| **The switch can say "on" while memory stays off.** It shows the value it wrote, but `CLAUDIN_DISABLE_AUTO_MEMORY`, bare mode or a higher settings layer can override the user settings. The folder rows follow the effective value, so the two disagree. | Fix: show the effective value after the write, and say when something overrides it. |
| **The user file's description is fixed text** and ignores `CLAUDIN_CONFIG_DIR`, while the row's value follows it. | Keep for parity, since it is pinned. |
| **No "new" mark.** A missing user or project file looks like an existing one; the caller creates it on choice. | Keep for parity, since it is pinned. |
| **The auto-dream line is decided at open.** Turning auto memory on does not show it, and off does not hide it. | Keep for parity, since it is pinned. |
| **The last choice outlives the dialog** for the whole process, across `/clear` and resumed sessions. | Keep for parity. It is what makes reopening land on the same folder. |
| **`MemoryUpdateNotification` has no caller.** Only `getRelativeMemoryPath`, from the same file, is used. | Keep for parity in this rewrite, since it is pinned. Cutting it belongs to the dead-code pass, with its own proof. |
| **The name check in `getProjectMemoryPathForSelector` changes nothing observable**: the ancestor walk only ever asks about `AGENTS.md` and `CLAUDE.md`. | Not a defect. The rewrite need not reproduce the check. |

## Target design

- **A hand-written function component** in this repo's Ink style, with typed
  props and no React Compiler output. It keeps the export names and props.
- **A pure row model beside it** in `src/memory/ui/`, testable without Ink:
  - input: the loaded files, the start directory, the user file path, whether
    the project is a repository, the folder paths, the counts, the agents, and
    whether auto memory and team memory are on, all through a narrow `…Deps`
    or input object (`.claudin/rules/code-design.md`, I and D);
  - output: `{ label, value, description }[]` in display order;
  - the file kinds (user, project, import, other) as a discriminated union,
    one row per kind in a table, so a new kind is a new entry (Open/closed).
- **A small status model** for the auto-dream line: `(on, running, lastRunAt | null | 0) → string`.
- **The switches** as a separate component taking their values and an
  `onToggle(key)`, so the focus walk between switches and list is testable on
  its own.
- **`getRelativeMemoryPath`** and **`getProjectMemoryPathForSelector`** as pure
  functions over explicit inputs (path, working directory, home directory),
  with the separator fix above.
- **Types.** Explicit throughout, no `any`. Regexes at module level.
- **Tests.** The characterization suites, unchanged, plus unit tests for the
  row model and the status model, and one each for the Fix decisions.

## Outcome

Rewritten per method on 2026-10-03.

**The rewrite.** The picker is now a plain hand-written function component. It sits on a pure row model in
`memoryFileSelector/` (`rows`, `dreamStatus`, `focus`, `choiceMemory`, `switchNote`, `MemorySwitches`).
Path shortening moved to `shortMemoryPath.ts`. The three characterization suites pass unchanged.

**Fixes**, each with a test:
- Only the user file is described as saved in `~/.claudin/CLAUDE.md`.
- An ancestor project file is shown from the start directory.
- A directory contains a path only up to a separator.
- A switch shows the value in effect.

**Deviations**
- The override note appears after a flip that did not take, not at open. A note at open would break the
  pinned `Auto-memory: off` under `CLAUDIN_DISABLE_AUTO_MEMORY`.
- The team row imports `teamMemPaths` statically and gates the call with `feature('TEAMMEM') ? … : false`.
  TEAMMEM ships true, and build and smoke pass.

**Probes.** `rewrite-memory-ui.json` holds 72 probes.

**Residue.** None: all three files measure 0 inherited lines.
