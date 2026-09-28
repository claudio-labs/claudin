# Spec: `vcs/git`

Files: `src/vcs/git/git.ts`, `detectRepository.ts`, `githubRepoPathMapping.ts`,
`gitignore.ts`, `getWorktreePaths.ts`, `getWorktreePathsPortable.ts` and
`worktreeModeEnabled.ts`.

## Purpose

The general git layer the whole CLI leans on. It finds the repository that
contains a path, and the canonical repository behind a linked worktree, which
is the identity that project config, memory and trust are keyed by. It answers
questions about the session's repository: branch, commit, remote, default
branch, cleanliness, upstream and worktrees. It turns remote URLs into
`owner/name`, and it remembers where the user keeps local clones of GitHub
repositories. It asks git whether a path is ignored, and adds rules to the
user's global ignore file. It lists a repository's worktrees and reports
whether worktree mode is on. It also has the synchronous check that the shell
tools' permission code uses to spot a directory that git would treat as a bare
repository.

The unit sends no text to a model.

## Public contract

These must keep their names and types, because modules that are not rewritten
yet import them. Two sibling suites also `mock.module` two of these paths by
name (see Tests that pin it), so the module paths stay too.

### `git.ts`

| Export | Signature | Used by |
|---|---|---|
| `findGitRoot` | `(startPath: string) => string \| null`, plus a `cache` property with `clear`, `size`, `delete(key)`, `get(key)` and `has(key)` | 15 modules: memory, containers, setup, teleport, file suggestions, `gitFilesystem.ts`, `gitDiff.ts`, worktree creation and lifecycle, the branch segment hook, `githubRepoPathMapping.ts` |
| `findCanonicalGitRoot` | same shape as `findGitRoot` | 13 modules: `projectConfig.ts`, `setup.ts`, the memory paths and instructions, `agentMemory.ts`, `EnterWorktreeTool`, the worktree modules, `plugins/reconciler.ts`, the branch segment hook |
| `dedupeCanonicalRoots` | `(roots: Array<string \| null>) => string[]` | `vcs/diff/hooks/useWorkspaceDiff.ts` |
| `resolveWorkspaceRoots` | `(cwd: string, additionalDirs: string[]) => string[]` | `vcs/diff/ui/DiffDialog.tsx` |
| `findNestedGitRoots` | `(baseDir: string, opts?: { maxDepth?: number; maxDirs?: number }) => Promise<string[]>` | `useWorkspaceDiff.ts` |
| `gitExe` | `() => string` | 16 modules that spawn git |
| `getIsGit` | `() => Promise<boolean>`, plus `cache.clear` | 13 modules and one test. `sessions/rerootSession.ts` calls `getIsGit.cache?.clear?.()` after a reroot |
| `getGitDir` | `(cwd: string) => Promise<string \| null>` | `gitDiff.ts` |
| `dirIsInGitRepo` | `(cwd: string) => Promise<boolean>` | `gitignore.ts` |
| `getHead` | `() => Promise<string>` | `gitDiff.ts` |
| `getBranch` | `(cwd?: string) => Promise<string>` | 13 modules, and `platform/bridge/bridgeMain.ts` through a dynamic import |
| `getDefaultBranch` | `() => Promise<string>` | 6 modules, and `platform/bridge/createSession.ts` dynamically |
| `getRemoteUrl` | `() => Promise<string \| null>` | `initReplBridge.ts`, `ghPrStatus.ts`, `detectRepository.ts`, `bridgeMain.ts` dynamically |
| `getIsHeadOnRemote` | `() => Promise<boolean>` | only `getGitState` |
| `getAheadBehind` | `(cwd?: string) => Promise<{ ahead: number; behind: number }>` | `DiffDialog.tsx`, `vcs/hooks/useCwdBranchSegment.ts` |
| `getIsClean` | `(options?: { ignoreUntracked?: boolean }) => Promise<boolean>` | `agent/background/remote/preconditions.ts`, `platform/teleport/teleport.tsx` |
| `getChangedFiles` | `() => Promise<string[]>` | nothing (see Out of scope) |
| `GitFileStatus` (type) | `{ tracked: string[]; untracked: string[] }` | `platform/teleport/TeleportStash.tsx` |
| `getFileStatus` | `(cwd?: string) => Promise<GitFileStatus>` | `TeleportStash.tsx`, `DiffDialog.tsx` |
| `getWorktreeCount` | `() => Promise<number>` | `terminal/tips/tipRegistry.ts` |
| `stashToCleanState` | `(message?: string) => Promise<boolean>` | `TeleportStash.tsx` |
| `GitRepoState` (type) | `{ commitHash: string; branchName: string; remoteUrl: string \| null; isHeadOnRemote: boolean; isClean: boolean; worktreeCount: number }` | `platform/Feedback.tsx` |
| `getGitState` | `() => Promise<GitRepoState \| null>` | `Feedback.tsx` |
| `getGithubRepo` | `() => Promise<string \| null>` | `commands/install-github-app/install-github-app.tsx` |
| `findRemoteBase` | `() => Promise<string \| null>` | `skills/bundled/codeReviewScope.ts` |
| `isCurrentDirectoryBareGitRepo` | `() => boolean` | `tools/BashTool/readOnlyValidation.ts`, `tools/PowerShellTool/powershellPermissions.ts` |

### `detectRepository.ts`

| Export | Signature | Used by |
|---|---|---|
| `ParsedRepository` (type) | `{ host: string; owner: string; name: string }` | the return type below |
| `clearRepositoryCaches` | `() => void` | `commands/clear/caches.ts` |
| `detectCurrentRepository` | `() => Promise<string \| null>` | `agent/ui/ResumeTask.tsx`, `platform/entrypoints/init.ts`, `githubRepoPathMapping.ts` |
| `detectCurrentRepositoryWithHost` | `() => Promise<ParsedRepository \| null>` | `agent/background/remote/remoteSession.ts`, `teleport.tsx` |
| `parseGitRemote` | `(input: string) => ParsedRepository \| null` | `teleport.tsx`, `ghPrStatus.ts`, `git.ts`, `createSession.ts` dynamically |
| `parseGitHubRepository` | `(input: string) => string \| null` | `teleport.tsx`, `teleport/api.ts`, `githubRepoPathMapping.ts`, `createSession.ts` and `bridgeMain.ts` dynamically |

### `githubRepoPathMapping.ts`

| Export | Signature | Used by |
|---|---|---|
| `updateGithubRepoPathMapping` | `() => Promise<void>` | `terminal/interactiveHelpers.tsx`, fire-and-forget at startup |
| `getKnownPathsForRepo` | `(repo: string) => string[]` | `platform/main/defaultAction/resume.ts` |
| `filterExistingPaths` | `(paths: string[]) => Promise<string[]>` | `defaultAction/resume.ts` |
| `validateRepoAtPath` | `(path: string, expectedRepo: string) => Promise<boolean>` | `platform/teleport/TeleportRepoMismatchDialog.tsx` |
| `removePathFromRepo` | `(repo: string, pathToRemove: string) => void` | `TeleportRepoMismatchDialog.tsx` |

### `gitignore.ts`, the worktree listings and the mode switch

| Export | Signature | Used by |
|---|---|---|
| `isPathGitignored` | `(filePath: string, cwd: string) => Promise<boolean>` | `skills/loading/skillDirDiscovery.ts` |
| `getGlobalGitignorePath` | `() => string` | nothing outside the module; the suite reads it |
| `addFileGlobRuleToGitignore` | `(filename: string, cwd?: string) => Promise<void>`; `cwd` defaults to `getCwd()` at call time | `agent/plans/plans.ts`, `platform/settings/settings.ts`, `tools/AgentWorkflow/paths.ts`, `tools/TypecheckTool/baseline.ts` |
| `getWorktreePaths` | `(cwd: string) => Promise<string[]>` | `commands/resume/resume.tsx`, `defaultAction/resume.ts`, `sessions/indexing/search.ts` |
| `getWorktreePathsPortable` | `(cwd: string) => Promise<string[]>` | `sessions/sessionStoragePortable.ts` |
| `isWorktreeModeEnabled` | `() => boolean` | `platform/main/action/parseOptions.ts`, `tools/tools.ts`, `platform/entrypoints/cli.tsx` dynamically |

**Structure constraints:**
- `getWorktreePathsPortable.ts` imports Node built-ins only. `sessionStoragePortable.ts` is shared with an editor-extension host and must not pull in logging, bootstrap state or the process helpers.
- No caller reads `findGitRoot.cache` or `findCanonicalGitRoot.cache`. Keeping them is optional. `getIsGit.cache.clear` must stay, and must make the next `getIsGit()` judge again.

## Observable behaviour

Every function in the unit resolves or returns a value. None of them throws or
rejects in the cases below.

### 1. Where commands run

Three working directories are in play, and which one a function uses is part
of the contract. The suite keeps them apart.

| Function | Works in |
|---|---|
| `getBranch(cwd)`, `getAheadBehind(cwd)`, `getFileStatus(cwd)` | the directory given, with a 5 s time limit (not pinned) |
| `getAheadBehind()`, `getIsHeadOnRemote()`, `getIsGit()`, `getWorktreeCount()`, `isCurrentDirectoryBareGitRepo()`, the cache key of `detectCurrentRepositoryWithHost()`, the default of `addFileGlobRuleToGitignore` | the session cwd, `getCwd()` from `src/shared/fs/cwd.ts`. That honours `runWithCwdOverride` |
| `getIsClean()`, `getFileStatus()`, `stashToCleanState()`, `findRemoteBase()` | the process working directory, `process.cwd()` |
| `getHead()`, `getBranch()`, `getDefaultBranch()`, `getRemoteUrl()` | the session's cached git state (section 4) |

The git binary is `gitExe()`, except for `isPathGitignored` and
`getWorktreePathsPortable`, which run `git` by name from `PATH` at call time.
Read-only commands should not take git's optional locks, so that they never
race a git command of the user's (not pinned).

### 2. Repository roots

**`findGitRoot(startPath)`:**
- **The root.** Starting at the path and climbing, the first directory that holds a `.git` entry is the root. A `.git` counts when it is a directory or a regular file, following symlinks, whatever the file contains. The filesystem root is examined too (not pinned).
- **What the path can be.** A directory, a file, or a path that does not exist yet, which is answered by its ancestors. A trailing slash is fine.
- **What does not count.** A `.git` of another kind, such as a dangling symlink, does not count, and the climb goes on.
- **Nesting.** The innermost repository wins.
- **No repository.** `null`.
- **Symlinks are not resolved.** The climb is lexical.
  - A path through a link to a repository's root answers with the link's path.
  - A path through a link to a subdirectory of a repository is outside any repository and answers `null` (Findings 14).
- **Spelling.** The result is NFC-normalized (Findings 15).
- **Memory.** Answers are remembered per start path, as spelled.
  - A repository created or removed after the first lookup is not noticed.
  - The memory is bounded and forgets the least recently used paths. The suite only requires that a few hundred other lookups make a path be examined again. Today's bound is 50 paths.
- **Relative paths.** They are resolved against the process working directory (not pinned).

**`dirIsInGitRepo(cwd)`** resolves to whether `findGitRoot(cwd)` is not null.

**`getIsGit()`** resolves to whether the session cwd lies in a repository.
- It judges at its first call and keeps that answer for the process, even after the session cwd moves.
- `getIsGit.cache.clear()` makes the next call judge again.

### 3. Canonical roots and worktrees

**`findCanonicalGitRoot(startPath)`** gives the repository identity:
- `null` when `findGitRoot` gives `null`;
- the `findGitRoot` answer for a regular repository, a submodule, or anything whose `.git` file does not lead to a valid worktree (see Security requirements);
- for a **linked worktree**, the main working tree: the directory that holds the shared `.git` directory. That holds from any depth inside the worktree, and through a symlink to it;
- for a **worktree of a bare repository**, the bare repository's own directory (the shared git directory, when its name is not `.git`);
- NFC-normalized.

Worktrees whose pointers git recorded as relative paths are not mapped: see
Findings 5.

**Memory.** Answers are remembered per root and bounded like `findGitRoot`. A
worktree that has been removed still maps to its main repository.

**`resolveWorkspaceRoots(cwd, additionalDirs)`:**
- It gives the canonical root of `cwd`, then the canonical root of each additional directory, in order.
- Entries with no repository are dropped, and a root already listed is not repeated.

**`dedupeCanonicalRoots(roots)`** drops `null` and empty entries, and keeps
the first occurrence of each root, in order.

**`findNestedGitRoots(baseDir, opts)`:**
- **What it reports.** The canonical root of every repository found in the directories below `baseDir`, never `baseDir` itself. Whether `baseDir` is a repository makes no difference.
- **What counts as a repository.** A directory with its own `.git` entry, of any kind that exists. It is reported and not descended into.
- **Linked worktrees** below the base are reported as their main repository, which may lie outside `baseDir`.
- **What it never enters:**
  - symlinked directories;
  - names starting with `.`;
  - `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `coverage`, `.next`, `.turbo`, `.cache`, `.venv`, `venv` and `__pycache__`.
- **Depth.** The children of `baseDir` are level 1. `maxDepth` defaults to 3: `base/a/b/c` is found, and `base/a/b/c/d` is not.
- **Width.** `maxDirs` defaults to 1500. At most that many directories are examined, and whatever lies beyond is not found.
- **Order.** Not part of the contract.
- **Failures.** A missing or unreadable base, or a file given as base, gives `[]`. Unreadable subdirectories are skipped.

### 4. The session's cached git state

`getHead()`, `getBranch()` without an argument, `getDefaultBranch()` and
`getRemoteUrl()` return what the session-wide cache of
`src/vcs/git/gitFilesystem.ts` returns (`getCachedHead`, `getCachedBranch`,
`getCachedDefaultBranch`, `getCachedRemoteUrl`). That module is its own unit
(`vcs/gitFilesystem`).
- **Binding.** The cache is bound by the first read in the process, to the repository of the session cwd at that moment.
- **Refresh.** It follows commits, branch switches and changes of the remote (pinned). How it behaves after the session cwd moves to another repository is recorded in Findings 10.

| Value | Named branch | Detached HEAD | Unborn branch | Outside a repository |
|---|---|---|---|---|
| `getHead()` | commit SHA | commit SHA | `''` | `''` |
| `getBranch()` | branch name | `'HEAD'` | branch name | `'HEAD'` |

- **`getDefaultBranch()`** reads the branch that `refs/remotes/origin/HEAD` points at. Without it, `'main'` when `origin/main` exists, else `'master'` when `origin/master` exists, else `'main'`. Outside a repository it is `'main'`.
- **`getRemoteUrl()`** is the `origin` URL from the repository's config, or `null`. A linked worktree reads the shared config.
- **Worktrees.** Inside a linked worktree, head and branch are the worktree's own, and the remote and the default branch are the shared ones.

**`getGitState()`** resolves to the six values below, read concurrently. It
resolves to `null` if any of the reads throws, which none does today.

| Field | Source |
|---|---|
| `commitHash` | `getHead()` |
| `branchName` | `getBranch()` |
| `remoteUrl` | `getRemoteUrl()` |
| `isHeadOnRemote` | `getIsHeadOnRemote()` |
| `isClean` | `getIsClean()` |
| `worktreeCount` | `getWorktreeCount()` |

**`getGithubRepo()`** resolves to `owner/name` when `getRemoteUrl()` parses
(section 7) with the host exactly `github.com`, and `null` otherwise.

**`getWorktreeCount()`:**
- The count is 1 for the main working tree, plus every linked worktree registered with the repository. That includes a registered worktree whose directory is gone, until `git worktree prune`.
- It is the same from any worktree of the repository, 1 for a plain repository, and 0 outside one.
- The count is read at call time.

**`getGitDir(cwd)`:**
- For a checkout, `<root>/.git`.
- For a linked worktree, the administrative directory its `.git` file names (`<main>/.git/worktrees/<name>`), resolved against the worktree root.
- `null` outside a repository.

### 5. Commands

- **`getBranch(cwd)`** gives the branch checked out in `cwd`: its name, `'HEAD'` when detached, or `''` on an unborn branch, outside a repository, for a missing directory or on any git failure. An empty `cwd` means no argument (not pinned).
- **`getAheadBehind(cwd?)`** counts the commits HEAD has that its upstream lacks (`ahead`), and the reverse (`behind`). Both are 0 without an upstream, outside a repository, or on a failure.
- **`getIsHeadOnRemote()`** is true when the session branch has an upstream that resolves, even if HEAD is ahead of it (Findings 13), and false otherwise.
- **`getIsClean(options)`** is true when `git status --porcelain` reports nothing.
  - Untracked files count, unless `ignoreUntracked` is set.
  - Outside a repository it is true (Findings 11).
- **`getFileStatus(cwd?)`** splits the porcelain entries.
  - Untracked entries (`??`) go to `untracked` and everything else to `tracked`.
  - Paths are relative to the repository root, even when the command runs in a subdirectory.
  - An untracked directory is one entry, with a trailing `/`.
  - A rename is one tracked entry. Its text is not pinned.
  - Nothing to report, or no repository, gives two empty lists.
  - Names that git quotes are returned quoted (Findings 3).
- **`stashToCleanState(message?)`** stashes every change, untracked files included, under `message`.
  - The default message is described under Formats.
  - It resolves true when the stash succeeds, and also when there was nothing to stash, in which case no stash entry is created.
  - Afterwards `git status --porcelain` is empty.
  - `git stash pop` brings back the tracked edits and the formerly untracked files. Their index state afterwards is not pinned.
  - It resolves false when git fails, outside a repository for one, and see Findings 2.
- **`findRemoteBase()`** gives the upstream of the current branch as `<remote>/<branch>`. Without one, it gives the first of `origin/main`, `origin/staging` and `origin/master` that exists, else `null`.
  - The remote's own default branch never decides (Findings 1).
  - Outside a repository it gives `null`.
- **`gitExe()`** is the absolute path of the `git` found on `PATH` at the first call, kept for the process. It is `'git'` when none is found.

### 6. The bare-repository check

**`isCurrentDirectoryBareGitRepo()`** judges the session cwd synchronously. The
rules, in the order that decides:

1. A `.git` that is a regular file (a linked worktree or a submodule): not flagged, whatever else the directory holds.
2. A `.git` directory that holds a regular file named `HEAD`: not flagged.
3. Otherwise, with no `.git`, or a `.git` directory without a regular `HEAD`, it is flagged when the directory itself holds any of these:
   - a regular file `HEAD`;
   - a directory `objects`;
   - a directory `refs`.

   Indicators of the wrong kind do not count: `HEAD` as a directory, or `objects` and `refs` as files.

A real bare repository is flagged. So is any directory with a `refs/`
directory in it, a subdirectory of a checkout included (Findings 18).

### 7. Remote URLs

**`parseGitRemote(input)`** trims the input and accepts exactly two forms.

**The scp-like form,** `git@<host>:<owner>/<name>`:
- The user must be `git`.
- There are exactly two path segments.

**The URL form,** `<scheme>://[<user-info>@]<host>[:<port>]/<owner>/<name>`:
- The scheme is `http`, `https`, `ssh` or `git`, in lower case.
- There are exactly two path segments, with no trailing slash.

**Common rules:**
- **The host** must contain a dot, and its last label must be letters only. That rejects SSH config aliases such as `github.com-work`, `localhost` and IP addresses.
- **The name** loses one trailing `.git` and may contain dots: `widgets.git.git` becomes `widgets.git`.
- **Ports** stay in `host` for `http` and `https` (`ghe.corp.example:8443`), and are dropped for `ssh` and `git`.
- **User-info** never reaches the result.
- **Case.** Host, owner and name come back as written.
- **Anything else** gives `null`: other users, schemes, extra or missing segments, web page URLs, `file://`, an upper-case scheme, and a port in the scp-like form. The suite lists these cases.

**`parseGitHubRepository(input)`** trims the input:
- **A remote `parseGitRemote` accepts** gives `owner/name` when its host is exactly `github.com`, and `null` for every other host, GitHub Enterprise and `www.github.com` included.
- **Otherwise,** an input with no `://` and no `@` that splits on `/` into exactly two non-empty parts is taken as the shorthand `owner/name`. One trailing `.git` is removed from the name, and the case is kept.
- **Anything else** gives `null`.

### 8. The session's repository

**`detectCurrentRepositoryWithHost()`:**
- It gives `parseGitRemote(await getRemoteUrl())`, or `null` when there is no origin or it does not parse.
- **Memory.** The answer is remembered per session cwd for the process, `null` included.
  - A later change of the remote is not seen from the same cwd, although another cwd sees it.
  - A failure is remembered as `null`.

**`detectCurrentRepository()`** gives `owner/name` when that answer's host is
exactly `github.com`, and `null` otherwise. It shares the same memory.

**`clearRepositoryCaches()`** forgets every remembered answer.

### 9. Known clones of GitHub repositories

**The data.** The global config field `githubRepoPaths` maps a lower-cased
`owner/name` to absolute paths, most recently used first. See Formats.

**`updateGithubRepoPathMapping()`:**
- **When it records.** Only when `detectCurrentRepository()` names a GitHub repository. Otherwise it changes nothing.
- **Which path.**
  - It records the repository root that `findGitRoot` finds for the session's original directory (`getOriginalCwd()`). When that directory is in no repository, the directory itself is recorded.
  - Detection uses the session cwd, and the path uses the original directory.
  - The path is recorded resolved through symlinks and NFC-normalized. If it cannot be resolved, it is recorded as given.
- **Where in the list.** The path moves to the front, and is not duplicated. When it is already first, nothing is written: no config write, and no change notification.
- **Failures.** Errors are logged to the debug log and never escape.

**`getKnownPathsForRepo(repo)`** gives the list under `repo` lower-cased, or
`[]`.

**`filterExistingPaths(paths)`** keeps the paths that exist, following
symlinks, so a dangling link is dropped. Order and repeats are kept.

**`validateRepoAtPath(path, expectedRepo)`:**
- It is true when the repository that contains `path` has an origin that `parseGitHubRepository` turns into `expectedRepo`, compared case-insensitively.
- A linked worktree is judged by its shared origin.
- It is false for another repository, another host, no origin, no repository, a missing path, and any failure.

**`removePathFromRepo(repo, path)`:**
- It removes every copy of `path` under the lower-cased key, and removes the key once its list is empty.
- It writes nothing when `path` is not listed or `repo` is unknown.

### 10. Ignore rules

**`isPathGitignored(filePath, cwd)`** is true only when `git check-ignore`
says so. Git decides:
- **The sources.** The `.gitignore` files at every depth, each applying below its own directory, then `info/exclude`, then the global excludes file that git uses:
  - `core.excludesFile` when it is set;
  - otherwise `$XDG_CONFIG_HOME/git/ignore` when `XDG_CONFIG_HOME` is set;
  - otherwise `~/.config/git/ignore`.
- **Precedence** is git's, so negations win where git says they do.
- **Tracked files** are never ignored.
- **Paths.** A relative `filePath` is read from `cwd`. An absolute one works from anywhere in the repository.
- **False** outside a repository, for a path outside the repository, for a missing `cwd`, and on any failure.

**`getGlobalGitignorePath()`** is `<home>/.config/git/ignore`, where `<home>`
is `os.homedir()`. The suite pins it for a setup with git left at its
defaults.

**`addFileGlobRuleToGitignore(filename, cwd = getCwd())`:**
1. **Outside a repository** it does nothing. The global file and its directory are not created.
2. **When git already ignores `filename`** as seen from `cwd`, it does nothing. That covers the repository's rules and the global file alike. For a name ending in `/`, the question is asked about a file inside it.
3. **Otherwise** it adds the rule `**/<filename>` to the global file:
   - the directory is created when missing;
   - a missing file is created holding the rule;
   - a file that already holds the rule is left alone, even when git does not apply it, for example because of a repository negation;
   - otherwise the rule is appended on a line of its own, preceded by a newline.

   See Formats for the exact bytes.
4. **Failures** are logged with `logError` and never escape. A directory where the global file belongs is left as it was.

Today the rule is written to `getGlobalGitignorePath()` in every setup
(Findings 6 and 7).

### 11. Worktree lists

**`getWorktreePaths(cwd)`:**
- **The list.** Every working tree of the repository that holds `cwd`, from `git worktree list --porcelain` run in `cwd`. Each path is NFC-normalized.
- **Order.** The working tree that contains `cwd` comes first: equal to it, or with `cwd` inside it. The rest follow in `localeCompare` order.
- **Special cases:**
  - A repository without linked worktrees lists itself alone.
  - A bare repository lists its own directory next to its worktrees.
  - A worktree nested inside the main tree is listed like any other. For its order, see Findings 4.
- **Failures.** `[]` outside a repository, for a missing directory, and on any failure.

**`getWorktreePathsPortable(cwd)`:**
- **The list.** The same paths, NFC-normalized, in git's order: the main working tree first. There is no reordering around `cwd`.
- **Failures.** `[]` on any failure: outside a repository, a missing directory, `git` not on `PATH`, or the 5 s time limit (not pinned).

### 12. Worktree mode

**`isWorktreeModeEnabled()`** is always true. It reads no setting, environment
variable, flag or directory.

## Formats

- **The global ignore file.**
  - The exact bytes are pinned by fixtures that the real writer produced, in `src/vcs/git/__fixtures__/rewrite/`:
    - `global-ignore.created.txt`: a new file with one rule;
    - `global-ignore.appended-to-unterminated.txt`: a rule appended to `node_modules` with no final newline;
    - `global-ignore.appended-to-terminated.txt`: appended to `*.swp\n`, which leaves a blank line;
    - `global-ignore.directory-rule.txt`: a directory rule, which keeps its slash.
  - A rule is `**/` followed by the name exactly as given, and ends with a newline.
- **The stash message.**
  - The default is `Claudin auto-stash - <timestamp>`, where the timestamp is `Date.prototype.toISOString()`: UTC, with milliseconds.
  - `TeleportStash.tsx` passes `Teleport auto-stash`.
  - The message appears in `git stash list` as `On <branch>: <message>`.
- **`githubRepoPaths` in the global config.** An object that maps a lower-cased `owner/name` to an array of absolute paths, most recent first. Under `bun test` the global config is an in-memory object (`NODE_ENV=test`).

Nothing outside the unit pins any of these texts.

## Security requirements

**Pinned by the tests:**
- **A `.git` file cannot borrow another repository's identity.** Project config, trust and hooks are keyed by `findCanonicalGitRoot`, and a cloned repository controls its own `.git` file. A `.git` file maps its directory to another repository only when both of these hold:
  - its administrative directory is a direct child of `<shared git dir>/worktrees`;
  - that directory's back-link names this directory's own `.git`. The comparison resolves symlinks in this directory's path, but not in the `.git` entry itself.

  Three forgeries are pinned, and each resolves to the attacker's own directory:
  - an administrative directory elsewhere, whose `commondir` points at the victim's `.git`;
  - a copy of the victim worktree's `.git` pointer;
  - a `.git` symlinked to the victim worktree's `.git` file.

  Two legitimate cases are pinned alongside: a worktree reached through a symlink, and a bare repository's worktree.
- **The bare-repository indicators** of section 6. The shell tools rely on them to ask before running git in a directory where git would read hooks from the cwd.
- **User-info in a remote URL** (`user:token@`) never appears in `parseGitRemote`'s result.
- **The ignore writer** does nothing outside a repository.

**Not pinned:**
- **The debug log receives the raw origin URL,** tokens included (Findings 9).
- **`findRemoteBase` contacts `origin` over the network** for nothing (Findings 1).

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| `.git` is a regular file with junk in it | `findGitRoot` treats the directory as a root; `findCanonicalGitRoot` gives that same directory | yes |
| `.git` file pointing at a missing administrative directory | `findCanonicalGitRoot` gives the directory itself | yes |
| Repository directory named in NFD | roots come back NFC, a spelling that does not exist on Linux | yes |
| A worktree removed after it was looked up | `findCanonicalGitRoot` still gives the main repository | yes |
| A directory that does not exist | `getBranch(dir)` `''`, `getAheadBehind(dir)` zeros, both worktree lists `[]`, `isPathGitignored` false, `validateRepoAtPath` false | yes |
| Unborn branch | cached branch is the branch name, cached head `''`, `getBranch(dir)` `''` | yes |
| Nothing to stash | `stashToCleanState` true, with no stash entry | yes |
| A registered worktree whose directory was deleted | counted by `getWorktreeCount` until pruned | yes |
| `findNestedGitRoots` given a file | `[]` | yes |
| An `origin` named by a relative local path such as `acme/widgets` | `validateRepoAtPath(…, 'acme/widgets')` is true, through the shorthand rule | no |
| `https://user:p@ss@host/o/r`, with an unencoded `@` in the password | the host comes back as `ss@host` | no |
| `https://github.com:443/o/r` | parses with host `github.com:443`, which is then not github.com | no |
| Relative `startPath` given to `findGitRoot` | resolved against the process working directory, and remembered under the relative spelling | no |
| `getFileStatus` names with spaces or non-ASCII characters | come back in git's quoted form | no: to be fixed (Findings 3) |

## Tests that pin it

The suite is 155 tests in seven files next to the unit. Three runs in a row
passed.

| File | Tests | Covers |
|---|---|---|
| `git.characterization.test.ts` | 41 | roots, canonical roots, the three forgeries, workspace and nested roots, `gitExe`, `getIsGit`, `dirIsInGitRepo`, `getGitDir`, the bare-repository check |
| `git.commands.characterization.test.ts` | 18 | `getBranch(cwd)`, `getAheadBehind`, `getIsHeadOnRemote`, `getIsClean`, `getFileStatus`, `stashToCleanState`, `findRemoteBase`, `getWorktreeCount`, and which directory each one uses |
| `git.session.characterization.test.ts` | 14 | the cached getters, `getGitState`, `getGithubRepo`, `detectCurrentRepository(+WithHost)`, `clearRepositoryCaches`, `updateGithubRepoPathMapping`, the `gitExe` fallback |
| `detectRepository.characterization.test.ts` | 45 | every accepted and rejected remote form, and `parseGitHubRepository` |
| `githubRepoPathMapping.characterization.test.ts` | 11 | `getKnownPathsForRepo`, `filterExistingPaths`, `validateRepoAtPath`, `removePathFromRepo` |
| `gitignore.characterization.test.ts` | 16 | `isPathGitignored` against every ignore source, `getGlobalGitignorePath`, `addFileGlobRuleToGitignore` |
| `getWorktreePaths.characterization.test.ts` | 10 | both worktree listings and `isWorktreeModeEnabled` |

**Line coverage** of the old code:

| File | Lines |
|---|---|
| `git.ts` | 93.2% |
| `detectRepository.ts` | 92.1% |
| `githubRepoPathMapping.ts` | 93.1% |
| `gitignore.ts`, `getWorktreePaths.ts`, `getWorktreePathsPortable.ts`, `worktreeModeEnabled.ts` | 100% |

**The probe spec.** `scripts/migrations/probes/rewrite-vcs-git.json` has 40
probes: 20 in `git.ts`, 6 in `detectRepository.ts`, 5 in
`githubRepoPathMapping.ts`, 4 in `gitignore.ts`, 2 in each worktree listing and
1 in the mode switch. Every probe turned at least one test red.

**How the suite drives the unit.** The rewrite has to keep these working:
- **Real repositories.** Every test builds real repositories and worktrees in `mkdtemp` directories.
- **git is cut off** from the machine's configuration: `HOME` is a temp directory, with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. `XDG_CONFIG_HOME` and the `GIT_*` location variables are removed, and `CLAUDIN_CONFIG_DIR` points into the temp home.
- **The three working directories.**
  - The session cwd is set with `runWithCwdOverride`.
  - The process working directory is set with `process.chdir` and restored.
  - The original directory is set with `setOriginalCwd` and restored.
- **The session cache in this process.** It cannot be reset, so the session file binds it at load time to a repository it built, and checks that the binding took. The in-process cases run only then, which a targeted run guarantees. In a whole-suite run another file may have bound it first, and they are skipped.
- **Fresh processes.** Every scenario of the cached state also runs in a fresh `bun` process, with its own cache, home and config directory, so it is pinned in any run. The driver imports the unit by path and calls its exports.
- **The home directory.** Bun fixes `os.homedir()` when the process starts. The ignore writer is pointed at a temp home by spying on `homedir` in the `os` module namespace. A guard refuses to call the writer unless `getGlobalGitignorePath()` already points inside the temp home. One case runs the writer in a fresh process started with `HOME` at a temp directory, without the spy.
- **The global config.** `githubRepoPaths` is seeded and read back through `saveGlobalConfig` and `getGlobalConfig`. Writes are counted with `onGlobalConfigChange`.

**Existing tests.** `src/vcs/git/git.test.ts` is this project's own and stays.
It covers `dedupeCanonicalRoots` and `findNestedGitRoots`.

**Sibling suites that mock these paths:**
- `memory/memdir/teamMemPrompts.test.ts` and `commands/autofix-pr/shared.test.ts` mock `src/vcs/git/git.js`. They spread the real module and override `getIsGit`, `getBranch`, `getDefaultBranch` and `findCanonicalGitRoot`.
- `agent/plans/plans.test.ts` and `tools/AgentWorkflow/paths.test.ts` mock `src/vcs/git/gitignore.js`.

**Not pinned, and why:**
- **The rows marked "no"** in the table above.
- **Timeouts** of 5 s and 10 minutes. They are not observable without a hanging git.
- **The optional-lock flag** of read-only commands. Its effect is a race.
- **The filesystem root as a repository.** The tests cannot write `/.git`.
- **The per-path git-directory memory of `gitFilesystem.ts`.** It is that unit's to pin.
- **Behaviour the Findings mark as "fix".** It is described there, and left unpinned so that the rewrite can fix it.

## Findings

Each finding has a decision. "Fix" means the rewrite changes the behaviour,
and no test pins the old one.

1. **`findRemoteBase` asks the remote for nothing.** When the branch has no upstream, it contacts `origin` over the network, which can be slow, can reach credential helpers, and has a 10-minute limit. The answer never affects the result, because git rejects the query as made (exit 128), so the remote's default branch never decides. The suite pins that.
   - **Decision: fix.** Drop the query. The results stay the same. This is pure hardening.
2. **`stashToCleanState` fails from a subdirectory.** When the process working directory is a subdirectory of the repository and untracked files exist, it resolves false and stashes nothing. Porcelain paths are relative to the root, while `git add` reads them against the working directory. `TeleportStash` runs where the CLI was started.
   - **Decision: fix.** Nothing depends on the failure.
3. **Names that git quotes come back quoted.** `getFileStatus` returns them in git's quoted form: names with spaces, quotes, backslashes, control characters or non-ASCII characters, such as `"sp ace.txt"` or `"caf\303\251.txt"`. `stashToCleanState` then cannot add such untracked files and fails. `TeleportStash` displays these names, and `DiffDialog` only counts them.
   - **Decision: fix.** Read git's NUL-separated output.
   - **Keep:** a rename stays one tracked entry.
4. **The wrong current worktree comes first.** `getWorktreePaths` puts the main working tree first when `cwd` is inside a worktree nested in it. That is Claudin's own layout, `.claudin/worktrees/<slug>`.
   - **Decision: fix.** The current worktree is the deepest listed one that contains `cwd`. No caller depends on the order: the session loaders re-sort by prefix length, and the cross-project check ignores the list.
5. **Worktrees recorded with relative paths are not mapped.** Git 2.48 added `--relative-paths` and `worktree.useRelativePaths`, and `findCanonicalGitRoot` treats such a worktree as its own root.
   - **Decision: keep for parity** (pinned). Project config, auto-memory, agent memory and the trust decision of those worktrees are stored under the worktree path today. Mapping them to the main repository moves that state and needs a migration of its own.
6. **The global ignore rule can land where git never reads it.** `addFileGlobRuleToGitignore` always writes `~/.config/git/ignore`, but git reads `$XDG_CONFIG_HOME/git/ignore` when `XDG_CONFIG_HOME` is set, and `core.excludesFile` when that is set. The suite pins git's side of this. The machine this was characterized on sets `XDG_CONFIG_HOME`.
   - **Decision: fix.** Write to the file git reads for global excludes. Determine it from the user's global git configuration and the environment only, never from the repository's own config: a cloned repository controls that, and could aim the write at any file.
   - **Keep:** `getGlobalGitignorePath()` may keep returning the default location.
7. **The "already present" check matches a substring.** The file counts as holding the rule when the rule's text appears anywhere in it, so `**/foo.json.bak` hides `**/foo.json`.
   - **Decision: fix.** Compare whole lines.
8. **The `github.com` comparison is case-sensitive.** A remote spelled `https://GitHub.com/…` is not recognized as GitHub by `parseGitHubRepository`, `detectCurrentRepository` or `getGithubRepo`.
   - **Decision: fix.** Compare the host case-insensitively. `parseGitRemote` may keep returning the host as written.
9. **Security: remote URLs in the debug log.** `detectCurrentRepositoryWithHost` writes the raw origin URL to the debug log, twice, credentials included (`https://x-access-token:<token>@…`). `parseGitHubRepository` logs any input it cannot parse.
   - **Decision: fix.** Redact the user-info before logging. This is pure hardening that legitimate use never notices.
10. **The cached getters are bound to the first repository.** When the session cwd moves to another repository, `getHead`, `getBranch()`, `getDefaultBranch`, `getRemoteUrl` and everything built on them keep answering for the first one. A change in the first repository makes them read the current cwd, but they keep watching the first.
    - **Decision: keep for parity** (not pinned). The cache belongs to `vcs/gitFilesystem`; hand the finding to that unit.
11. **Outside a repository, `getIsClean()` reports clean,** and so does `getGitState().isClean`.
    - **Decision: keep for parity** (pinned). Teleport and the remote-session preconditions would turn from proceeding to refusing.
12. **Two working directories.** Four functions run in the process working directory while the rest use the session cwd, and after a shell `cd` the two differ.
    - **Decision: keep for parity** (pinned). The callers of the process-directory functions (teleport, the review-scope skill) run their own git commands in the process directory too. Moving only these would split one operation across two repositories.
13. **`getIsHeadOnRemote` only checks for an upstream,** not whether HEAD is pushed.
    - **Decision: keep for parity** (pinned). Its only reader is `getGitState`, which feeds the feedback report.
14. **`findGitRoot` does not resolve symlinks.** A path through a link into a repository's subdirectory is outside any repository.
    - **Decision: keep for parity** (pinned). Many callers use roots as identity keys, and resolving links would change them.
15. **Roots are NFC-normalized,** which on Linux gives a spelling that does not exist for an NFD-named directory.
    - **Decision: keep for parity** (pinned). Every path the session stores is NFC, and changing one producer would split identities.
16. **`getChangedFiles` returns empty names.** For every entry whose status has a space in the second column, which is staged-only changes and renames, it returns an empty string.
    - **Decision: out of scope.** Nothing imports it.
17. **`getWorktreePaths`' comment** said that a single worktree gives an empty list. It gives the one worktree, and the suite pins that.
    - **Decision: no code change.**
18. **Any directory with a `refs/` directory or a `HEAD` file is flagged** by `isCurrentDirectoryBareGitRepo`, even inside a checkout.
    - **Decision: keep for parity** (pinned). It is a conservative false positive, and the callers only ask for permission.

## Out of scope

- **`getChangedFiles`.** Nothing imports it (Findings 16). Drop the export. The knip baseline does not list it, because the sibling suites spread the whole module, so there is nothing to refresh.
- **The watcher behind the cached getters, and the per-path git-directory memory.** Both belong to `vcs/gitFilesystem`.

## Target design

- **Keep the seven files as the public surface.** They stay under `src/vcs/git/`, with the same names and paths, since sibling suites mock two of them by path. Each is a thin facade over focused modules in a `src/vcs/git/repository/` folder, each with its own colocated tests.
- **Roots.** A pure walker, `(path, stat) => root | null`, under one explicit, bounded, least-recently-used memory keyed by the path as given. The worktree-pointer validation is a named predicate, with its two security rules side by side. The canonical memory and the root memory are separate instances.
- **Running git.** One runner takes an explicit working-directory policy, `{ dir }`, `'session'` or `'process'`, so that the choice in section 1 is visible at every call site. It never throws: it returns `{ ok, stdout }`, and callers map failure to their documented fallback.
- **Parsers.** Pure and separately tested:
  - `git status --porcelain -z` into `GitFileStatus` (fixes Findings 3);
  - the worktree porcelain into paths;
  - ahead/behind counts;
  - remote URLs (section 7).

  Each accepted remote form is one named matcher, and the host check is one predicate.
- **Session state.** The four cached getters delegate to `gitFilesystem.ts` unchanged. `getGitState` composes the six reads.
- **Repository detection.** A per-cwd memory with an explicit `clear`, and a small function that projects the answer onto github.com.
- **Known clones.** Functions over a narrow port, `{ read(): Record<string, string[]> | undefined; write(next): void }`, wired to the global config. Path resolution is injected, so that the promotion logic is pure.
- **Global ignore.**
  - A resolver for the file git reads for global excludes (Findings 6).
  - Line-based rule insertion as a pure function, `(content | null, rule) => content | null` (Findings 7).
  - A writer that logs and swallows errors.
- **Worktree lists.** One parser, and an ordering function that puts the deepest containing worktree first (Findings 4). `getWorktreePathsPortable` stays Node-only.
- **Types.**
  - Explicit, with no `any`.
  - A `WorkingDirectory` union for the runner.
  - Regexes at module level.
  - `ParsedRepository`, `GitFileStatus` and `GitRepoState` kept as they are.
- **Call-time reads.** Environment, `PATH`, the cwd and settings are read at call time, except `gitExe()` and `getIsGit()`, which are resolved once as today.
