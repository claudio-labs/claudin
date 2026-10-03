# Spec: `vcs/worktree`

Files: `src/vcs/git/worktree/createWorktree.ts`, `includeFiles.ts`,
`mutationLock.ts`, `postCreationSetup.ts`, `session.ts`, `sessionLifecycle.ts`,
`slugNaming.ts` and `tmuxSession.ts`, all under `src/vcs/git/worktree/`, and
the barrel every caller imports them through, `src/vcs/git/worktree.ts`.

## Purpose

Git worktrees for sessions and sub-agents. The unit creates a linked worktree
for a named task, or hands it to a user-configured WorktreeCreate hook when the
project uses another VCS. It prepares a new worktree with what git does not
carry over (local settings, the main checkout's git hooks, linked directories,
gitignored files listed in `.worktreeinclude`). It records which worktree the
session is in, attaches the session to a worktree someone else created, and
leaves it again, keeping or removing the worktree. It sweeps throwaway
worktrees that crashed sub-agents left behind. And it implements
`claudin --worktree <name> --tmux`, which creates the worktree and relaunches
the CLI inside a tmux session there before the full CLI loads.

Callers: the `--worktree` startup path (`platform/setup.ts`), the EnterWorktree
and ExitWorktree tools, the worktree exit dialog, AgentTool, the bridge and
the headless workflow runner (agent worktrees), the periodic cleanup, the CLI
entrypoint (the tmux fast path), and a dozen readers of the current worktree
session (system prompt, REPL, status line, `/cd`, `/clear`, `/exit`, `/ide`).

Some of the unit's error messages reach the model, as EnterWorktree tool
errors. They are described below by the facts they must state.

## Public contract

Every name below is exported by `src/vcs/git/worktree.ts` and must keep its
name and type. The barrel path stays: `agent/repl/resumeSession.test.ts` and
`agent/repl/hooks/useReplExit.test.tsx` replace it with `mock.module`, and the
modules those tests exercise import from it. For the same reason no module
behind the barrel may import the barrel itself.

| Export | Signature | Used by |
|---|---|---|
| `validateWorktreeSlug` | `(slug: string) => void`, throws | `tools/EnterWorktreeTool` (its `name` schema) |
| `worktreeBranchName` | `(slug: string) => string` | `platform/setup.ts` |
| `withGitWorktreeMutationLock` | `<T>(repoRoot: string, fn: () => Promise<T>) => Promise<T>` | no caller outside the unit |
| `_resetGitWorktreeMutationLocksForTesting` | `() => void` | tests |
| `createWorktreeForSession` | `(sessionId: string, slug: string, tmuxSessionName?: string, options?: { prNumber?: number }) => Promise<WorktreeSession>` | `platform/setup.ts`, EnterWorktree |
| `createAgentWorktree` | `(slug: string) => Promise<{ worktreePath: string; worktreeBranch?: string; headCommit?: string; gitRoot?: string; hookBased?: boolean }>` | `tools/AgentTool/AgentTool.tsx`, `platform/bridge/bridgeMain.ts`, `platform/headless/workflow/runWorkflowHeadless.ts` |
| `removeAgentWorktree` | `(worktreePath: string, worktreeBranch?: string, gitRoot?: string, hookBased?: boolean) => Promise<boolean>` | the same three |
| `parsePRReference` | `(input: string) => number \| null` | `platform/main/action/parseOptions.ts` |
| `copyWorktreeIncludeFiles` | `(repoRoot: string, worktreePath: string) => Promise<string[]>` | no caller outside the unit |
| `getCurrentWorktreeSession` | `() => WorktreeSession \| null` | prompts, REPL, `useReplExit`, `resumeSession`, `/cd`, `/clear`, `/exit`, `/ide`, `WorktreeExitDialog`, `StatusLine`, `sessions/lifecycle/restore/worktree.ts`, EnterWorktree, ExitWorktree |
| `restoreWorktreeSession` | `(session: WorktreeSession \| null) => void` | `sessions/lifecycle/restore/worktree.ts`; tests |
| `WorktreeSession` (type) | see below | `commands/cd/cd.ts` |
| `attachExistingWorktree` | `(path: string, sessionId: string) => Promise<WorktreeSession>` | EnterWorktree |
| `keepWorktree` | `() => Promise<void>` | ExitWorktree, `WorktreeExitDialog` |
| `cleanupWorktree` | `() => Promise<void>` | ExitWorktree, `WorktreeExitDialog` |
| `cleanupStaleAgentWorktrees` | `(cutoffDate: Date) => Promise<number>` | `platform/cleanup.ts` |
| `hasWorktreeChanges` | `(worktreePath: string, headCommit: string) => Promise<boolean>` | AgentTool |
| `generateTmuxSessionName` | `(repoPath: string, branch: string) => string` | `platform/setup.ts` |
| `getTmuxInstallInstructions` | `() => string` | `parseOptions.ts` |
| `isTmuxAvailable` | `() => Promise<boolean>` | `parseOptions.ts` |
| `createTmuxSessionForWorktree` | `(sessionName: string, worktreePath: string) => Promise<{ created: boolean; error?: string }>` | `platform/setup.ts` |
| `killTmuxSession` | `(sessionName: string) => Promise<boolean>` | ExitWorktree, `WorktreeExitDialog` |
| `execIntoTmuxWorktree` | `(args: string[]) => Promise<{ handled: boolean; error?: string }>` | `platform/entrypoints/cli.tsx`, through a dynamic import |

**`WorktreeSession`**, a plain object type, fields in alphabetical order:

| Field | Type | Meaning |
|---|---|---|
| `attached` | `boolean?` | the session entered a worktree it did not create; ExitWorktree never removes such a one |
| `creationDurationMs` | `number?` | milliseconds the creation took, setup included; absent when an existing worktree was resumed |
| `hookBased` | `boolean?` | a WorktreeCreate hook made it |
| `originalBranch` | `string?` | the branch the session was on before entering |
| `originalCwd` | `string` | where the session came from, and where leaving returns to |
| `originalHeadCommit` | `string?` | the commit the worktree started from (created), or its HEAD when entered (resumed or attached); ExitWorktree counts commits since it |
| `sessionId` | `string` | the session that entered |
| `tmuxSessionName` | `string?` | the tmux session made for it, which ExitWorktree kills on removal |
| `usedSparsePaths` | `boolean?` | sparse checkout was configured |
| `worktreeBranch` | `string?` | its branch |
| `worktreeName` | `string` | the slug as given, not flattened |
| `worktreePath` | `string` | its directory |

The sessions module persists every field except `creationDurationMs` and
`usedSparsePaths` in the transcript (`saveWorktreeState`, as
`PersistedWorktreeSession` in `shared/types/logs.ts`) and gives them back
through `restoreWorktreeSession` on `--resume`, so their names and meanings are
stored data.

**Structure constraints:**
- Optional parameters stay optional parameters, without default values: `src/vcs/git/worktree.test.ts` pins each export's `Function.length` (for example 4 for `createWorktreeForSession` and `removeAgentWorktree`, 0 for `keepWorktree`), and pins the exact set of value exports.
- `copyWorktreeIncludeFiles`, `withGitWorktreeMutationLock` and the reset stay exported while that pin lists them.

## Observable behaviour

### 1. Names and places

**`validateWorktreeSlug(slug)`** returns nothing or throws an `Error`,
synchronously, before any caller does anything else.
- **The shape.** One or more segments separated by `/`. Each segment is
  non-empty and uses only ASCII letters, digits, `.`, `_` and `-`, and is not
  exactly `.` or `..` (`.hidden` and `..x` are fine).
- **The length.** At most 64 characters in all.
- **Order.** The length is judged first: a slug over the limit is refused for
  its length whatever it contains. Then the segments, left to right; the first
  bad one decides which refusal is given.
- **The refusals** all start with `Invalid worktree name`, and state:
  - for the length: the limit, 64, and the slug's length;
  - for a `.` or `..` segment: the slug in double quotes, and that `"."` and
    `".."` segments are not allowed;
  - otherwise: the slug in double quotes, that each `/`-separated segment must
    be non-empty, and the allowed characters: letters, digits, dots,
    underscores and dashes.

  Each refusal names only its own rule.

**`worktreeBranchName(slug)`** is `worktree-` followed by the slug with every
`/` replaced by `+`. It does not validate. Since `+` is outside the slug
alphabet, two different valid slugs never share a branch or a directory.

**Where worktrees live.** `<root>/.claudin/worktrees/<slug, / replaced by +>`,
with `<root>` chosen per entry point (section 3). The `.claudin/worktrees`
directory is created when missing.

### 2. The per-repository lock

**`withGitWorktreeMutationLock(repoRoot, fn)`** runs `fn` and settles as it
does, with the same value or the same error object.
- **One at a time per key.** Calls with the same `repoRoot` run in call order.
  A call starts `fn` only once every earlier call with that key has settled,
  whether it resolved or rejected. A failure is not passed on to later holders.
- **Keys are strings.** `/r` and `/r/` are different repositories; nothing is
  normalized. Calls with different keys never wait for each other.
- **`_resetGitWorktreeMutationLocksForTesting()`** forgets every lock: the
  next call for any key starts at once, even while an earlier holder runs.

**What it guarantees on disk.** Creating a worktree through git and removing
an agent worktree through git are serialized per repository root:
- concurrent creations of one slug make one worktree, and every caller gets
  the same answer;
- concurrent creations, or removals, of different slugs in one repository all
  succeed.

### 3. Creating a worktree through git

Three entry points create worktrees: the session wrapper (section 6), the
agent wrapper (section 7) and the tmux fast path (section 15).

**The repository.**
- The session wrapper: the repository root of the session directory
  (`getCwd()`). Findings F7.
- The agent wrapper and the fast path: the main repository, which for a
  session directory inside a linked worktree is the main working tree.

**Resuming.** When the worktree's directory already holds a linked worktree
whose HEAD can be read, nothing is fetched, created or set up. The answer's
head commit is that worktree's current HEAD.
- A worktree removed through git is created afresh.
- A worktree whose directory was deleted without `git worktree prune` cannot
  be created again (Findings F8).

**A new worktree.** Branch `worktree-<flattened slug>` is created at the base,
or reset to it when it exists and is not checked out elsewhere. The base:

1. **A pull request** (the session wrapper's `prNumber`, or a pull request
   reference given to the fast path): `pull/<n>/head` is fetched from
   `origin`, and the base is what arrived (`FETCH_HEAD`). A number of 0 counts
   as no pull request.
2. **Otherwise, `settings.worktree.baseRef` is `head`:** the local `HEAD`,
   whatever branch or detached commit it is. Nothing is fetched.
3. **Otherwise (`fresh`, the default):** `origin/<default branch>`, where the
   default branch is what `vcs/gitFilesystem` reports for the session
   directory.
   - When `refs/remotes/origin/<default>` exists locally, it is used as it is,
     however stale, and nothing is fetched.
   - Otherwise `git fetch origin <default>` runs. On success the base is the
     fetched `origin/<default>`, and the local remote-tracking ref now exists.
     On failure (no `origin`, unreachable) the base is the local `HEAD`.

**Fetches never wait for credentials.** Both fetches run with
`GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS` set to the empty string, whatever
the caller's environment says, and with standard input closed (that last part
is not pinned).

**Sparse checkout.** When `settings.worktree.sparsePaths` is a non-empty list,
the worktree is created without a checkout, git's cone-mode sparse checkout is
set to those paths, and then HEAD is checked out. The worktree then holds the
listed directories and the files at the top level, and `git status` is clean.
If git refuses the paths (a glob, for one) or the checkout fails, the worktree
is removed again, unregistered and its directory gone, and the call rejects.
The branch may remain.

**Failures** reject with an `Error` whose message is one of these formats,
where `<git>` is git's error output:

| Failure | Message |
|---|---|
| the pull request fetch | `Failed to fetch PR #<n>: <git>`, trimmed; when git printed nothing, a note that the pull request may not exist or `origin` may be missing (not pinned) |
| no base commit (a repository without commits) | names the ref in double quotes (`"HEAD"`, `"origin/<default>"`, `"FETCH_HEAD"`) and says the base branch could not be resolved |
| `git worktree add` refused: the branch is checked out elsewhere, a directory that is not a worktree is in the way, a registered worktree's directory is gone | `Failed to create worktree: <git>` |
| sparse checkout refused | `Failed to configure sparse-checkout: <git>` |
| checkout after sparse setup | `Failed to checkout sparse worktree: <git>` (not pinned) |

### 4. After a worktree is first created

These steps run once, right after creation, in all three entry points, and
never when resuming. Each is best effort: a failure is logged and creation
still succeeds. `<root>` is the repository of section 3.

1. **Local settings.** `<root>/.claudin/settings.local.json` is copied byte
   for byte to `<worktree>/.claudin/settings.local.json`. Without one, no
   settings file appears; an empty `.claudin/` directory may (not pinned).
2. **Git hooks.** If `<root>/.husky` is a directory, or else
   `<root>/.git/hooks` is, `core.hooksPath` in the repository's shared
   configuration is set to that directory's absolute path. The main checkout
   and every worktree then run the main checkout's hooks. With neither, the
   setting is left alone.
   - A relative value that names the chosen directory (`.husky`) is rewritten
     as its absolute path.
   - Any other value already set is replaced today (Findings F14: fix).
3. **Linked directories.** Each entry of `settings.worktree.symlinkDirectories`
   (none by default) becomes a symbolic link at `<worktree>/<entry>` whose
   target is the absolute path `<root>/<entry>`:
   - an entry with a `..` path segment is skipped;
   - an absolute entry is taken below the repository: `/x` links
     `<worktree>/x` to `<root>/x`;
   - nothing happens when something already exists at the link's place (a
     tracked file or directory) or when its parent directory is missing in the
     worktree;
   - a source missing from the main checkout still gets its link, dangling
     until the directory appears there (Findings F13).
4. **`.worktreeinclude`** is applied (section 5).

### 5. `.worktreeinclude`

**`copyWorktreeIncludeFiles(repoRoot, worktreePath)`** copies gitignored files
of the main checkout into a new worktree, and resolves to the relative paths
it copied.
- **The include file.** `<repoRoot>/.worktreeinclude`, in gitignore syntax:
  `#` comments, blank lines, globs, `**`, `!` negation, a leading `/` anchors,
  trailing blanks are dropped and leading blanks are part of the pattern. CRLF
  line ends are accepted. Without the file, or without any pattern in it: `[]`,
  and nothing is touched.
- **Candidates.** Only files git reports as untracked and ignored in
  `repoRoot`, under the standard exclude sources. Tracked files are never
  copied (the worktree has them from its checkout), and neither are untracked
  files that nothing ignores.
- **Choice.** A candidate is copied when the include patterns match its path,
  with gitignore semantics: a pattern that names one of its parent directories
  matches it too.
- **Wholly ignored directories.** git lists a directory whose whole content is
  ignored as one entry. Its files are considered only when one of these holds:
  - a pattern, without its leading `/`, starts with the directory's path;
  - a pattern with a glob character after a literal start (`config/**/*.pem`)
    has a literal start that the directory's path begins with;
  - a pattern matches the directory itself (`build`).

  Anchorless patterns such as `*.key` never reach inside such a directory, by
  design: it is what keeps a huge ignored tree like `node_modules/` from being
  walked.
- **Copying.** Each chosen file goes to the same relative path under
  `worktreePath`, with missing parent directories created. An existing file is
  overwritten. A file that cannot be read or written is skipped. Nothing else
  is created.
- **The answer.** The relative paths copied: first the files git listed one by
  one, in git's sorted order, then those found inside expanded directories, in
  git's order.
- **Not a repository:** `[]`.

The fixture pair in `src/vcs/git/worktree/__fixtures__/rewrite/` pins the
rules together: `worktreeinclude` is an include file, and
`worktreeinclude.copied.txt` is exactly what the real code copied, in order,
from the repository the suite builds for it.

### 6. The session wrapper: `createWorktreeForSession`

1. **The slug** is validated first. A refusal rejects before anything else:
   no hook runs, no git command, no directory, no session.
2. **With a WorktreeCreate hook** (section 8), the hook makes the worktree, in
   or out of a git repository. The session is `originalCwd` (the session
   directory), `worktreePath` (the hook's path), `worktreeName` (the slug),
   `sessionId`, `tmuxSessionName` and `hookBased: true`. It has no branch, no
   commit, no creation time and no sparse flag.
3. **Outside a git repository without a hook** it rejects. The message says it
   is not in a git repository, and that WorktreeCreate/WorktreeRemove hooks in
   `settings.json` enable worktrees with other VCS systems.
4. **Otherwise, through git** (section 3), the session is:

   | Field | Value |
   |---|---|
   | `originalCwd` | the session directory at call time, even a subdirectory |
   | `worktreePath` | as in section 1 |
   | `worktreeName` | the slug as given |
   | `worktreeBranch` | `worktree-<flattened slug>` |
   | `originalBranch` | the session directory's branch, as `vcs/gitFilesystem` reports it: `HEAD` when detached |
   | `originalHeadCommit` | the base when created, the worktree's HEAD when resumed |
   | `sessionId`, `tmuxSessionName` | as given |
   | `creationDurationMs` | milliseconds, 0 or more, when created; absent when resumed |
   | `usedSparsePaths` | whether `settings.worktree.sparsePaths` is non-empty at call time; also when resuming, which is not pinned (Findings F15) |

5. **The session is published** as the current worktree session (section 9):
   the very object returned.
6. **Nothing moves.** The process working directory and the session directory
   are left as they were; the callers move them.

A failure of section 3 rejects, and nothing is published.

### 7. Agent worktrees

**`createAgentWorktree(slug)`:**
1. **The slug** is validated first, as above.
2. **With a WorktreeCreate hook,** the answer is exactly
   `{ worktreePath, hookBased: true }`.
3. **Outside a git repository without a hook** it rejects, and the message
   contains exactly `Cannot create agent worktree: not in a git repository`
   (AgentTool matches this text to fall back to the current directory) and
   names WorktreeCreate hooks.
4. **Otherwise** section 3 runs in the main repository, and the answer is
   exactly `{ worktreePath, worktreeBranch, headCommit, gitRoot }`, where
   `gitRoot` is the main repository root and `headCommit` is the base when
   created or the current HEAD when resumed.
5. **Resuming** sets the worktree directory's modification time to now, so
   that the stale sweep (section 12) leaves it alone.
6. **Nothing is published** and nothing moves.

**`removeAgentWorktree(worktreePath, worktreeBranch?, gitRoot?, hookBased?)`:**
- **`hookBased`:** the WorktreeRemove hooks run with the path. The answer is
  `true` when at least one is configured and ran, even when it failed, and
  `false` when none is configured. git is not touched.
- **No `gitRoot`:** `false`, and nothing is done.
- **Otherwise,** under the lock of `gitRoot`, the worktree is removed with
  `git worktree remove --force` run from `gitRoot`, uncommitted and untracked
  work included.
  - If git refuses (the path is not a worktree), the answer is `false` and the
    branch is left.
  - Otherwise the given branch, if any, is force-deleted (a failure there is
    ignored), and the answer is `true`.

### 8. Hook-based worktrees

- **Which hook.** A WorktreeCreate hook counts as configured when
  `hasWorktreeCreateHook()` of `platform/lifecycleHooks` says so (settings,
  plugin or SDK hooks). It then replaces git for creation in all three entry
  points, in or out of a git repository.
- **What it gets.** The event `WorktreeCreate`, and `name`: the slug as given,
  not flattened. Its standard output, trimmed, is the worktree path.
- **Failure.** A hook that fails or prints nothing makes creation reject with
  the lifecycle module's error, which starts `WorktreeCreate hook failed`.
- **Removal** of a hook-made worktree runs the WorktreeRemove hooks, with
  `worktree_path`.

### 9. The current worktree session

- **One per process.** `getCurrentWorktreeSession()` returns the published
  session, the very object, or `null`. Every import of the barrel sees the same
  one.
- **Publishing.** `restoreWorktreeSession(session)` publishes it as given,
  without copying or checking it. `restoreWorktreeSession(null)` clears it.
- **Who publishes.** The session wrapper and `attachExistingWorktree` publish;
  `keepWorktree` and `cleanupWorktree` clear; the stale sweep reads it.

### 10. Attaching: `attachExistingWorktree(path, sessionId)`

- **The repository.** The session directory must be in a git repository,
  else it rejects saying it is not in one.
- **The path** is resolved: a relative path against the process working
  directory, and symbolic links followed. It must be one of the repository's
  registered worktrees, compared by resolved path. That works from the main
  checkout and from any of its worktrees.
- **Refusals.** Both messages start with `path` as given:
  - a path that is not a registered worktree of this repository: the message
    points at `git worktree add`, and at EnterWorktree's `name` for a fresh
    one. That covers a plain directory, a missing path and another
    repository's worktree;
  - the main worktree, through a symbolic link too: the message says it is
    the main worktree.
- **The session:**

  | Field | Value |
  |---|---|
  | `originalCwd` | the session directory |
  | `worktreePath` | the resolved path |
  | `worktreeName` | its last path component |
  | `worktreeBranch` | its branch; absent when detached |
  | `originalBranch` | the session directory's branch |
  | `originalHeadCommit` | the worktree's HEAD commit |
  | `sessionId` | as given |
  | `hookBased`, `attached` | `false`, `true` |

  It is published. Nothing on disk changes and nothing moves.

### 11. Leaving: `keepWorktree()` and `cleanupWorktree()`

Both do nothing without a current session, and neither ever rejects.

**`keepWorktree()`** changes the process working directory to the session's
`originalCwd` and clears the session. The worktree and its branch stay. When
the directory change fails (the original directory is gone), nothing else
happens and the session stays published.

**`cleanupWorktree()`:**
1. **Back to the original directory,** as for keep. A failure there ends the
   call: nothing is removed and the session stays.
2. **A hook-made session:** the WorktreeRemove hooks run with the path, and git
   is not touched, not even for a branch.
3. **Otherwise** `git worktree remove --force` runs in `originalCwd`, not in
   the session directory, uncommitted and untracked work included.
4. **The session is cleared**, whether the removal worked or not.
5. **The branch.** For a git session with a branch, the branch is
   force-deleted from `originalCwd`, even when the removal failed (Findings
   F10). The call resolves after that.

### 12. The stale sweep: `cleanupStaleAgentWorktrees(cutoffDate)`

- **The repository.** The main repository of the session directory. The
  answer is 0 outside a repository, and when `<main>/.claudin/worktrees` does
  not exist.
- **Throwaway names.** Only entries of that directory whose names have one of
  these shapes are candidates; every other name is never touched:

  | Made by | Shape |
  |---|---|
  | AgentTool | `agent-a` and 7 lowercase hex digits |
  | the workflow tool | `wf_`, 8 lowercase hex, `-`, 3 lowercase hex, `-`, digits |
  | older builds | `wf-` and digits |
  | the bridge | `bridge-` and one or more groups of `[A-Za-z0-9_]`, joined by single dashes |
  | template jobs | `job-`, 1 to 55 of `[A-Za-z0-9._-]`, `-`, 8 lowercase hex |

- **What keeps a candidate.** Any of:
  - it is the current session's worktree (exact path);
  - its modification time is at or after the cutoff;
  - `git status` on tracked files fails or reports a change (untracked files
    do not count);
  - its HEAD has a commit that no remote-tracking ref reaches, or that check
    fails;
  - git does not know it as a worktree: a plain directory is left in place and
    not counted.
- **Removal.** As `removeAgentWorktree` with the branch `worktree-<name>`: the
  worktree and its branch go.
- **Prune.** When at least one was removed, `git worktree prune` runs in the
  main repository, so registrations whose directories are gone disappear too.
  When none was, nothing is pruned.
- **The answer** is the number removed.

### 13. `hasWorktreeChanges(worktreePath, headCommit)`

Fail-closed:
- `true` when `git status` in the worktree reports anything, tracked or
  untracked, staged or not;
- `true` when HEAD has commits that `headCommit` does not reach;
- `true` when either git command fails: not a repository, a missing directory,
  an unknown commit;
- `false` otherwise, HEAD being behind `headCommit` included.

### 14. tmux helpers

- **`generateTmuxSessionName(repoPath, branch)`** is the last path component
  of `repoPath` (a trailing slash ignored), `_`, and `branch`, with every `/`
  and `.` replaced by `_`. Other characters are kept, spaces and `:` included.
- **`getTmuxInstallInstructions()`**, by `getPlatform()`:
  - macOS: the Homebrew command;
  - Linux and WSL: the apt command (Debian/Ubuntu) and the dnf command
    (Fedora/RHEL);
  - Windows: that tmux is not natively available, suggesting WSL or Cygwin,
    with no command;
  - anything else: a generic hint to use the system package manager.
- **`isTmuxAvailable()`** is whether `tmux -V` exits 0, found through the
  current `PATH`.
- **`createTmuxSessionForWorktree(name, path)`** starts a detached tmux session
  named `name`, whose first window runs the default shell in `path`. The
  answer is `{ created: true }`, or `{ created: false, error }` with tmux's
  error output, "duplicate session" for a name taken.
- **`killTmuxSession(name)`** ends that session: `true` when tmux succeeded,
  `false` otherwise. On a name taken by prefix, see Findings F2.

### 15. The fast path: `execIntoTmuxWorktree(args)`

`cli.tsx` calls it before the full CLI loads when the arguments contain
`--tmux` or `--tmux=classic` and a worktree flag. `handled: true` means done,
and the CLI exits. `handled: false` always comes with `error`, which the CLI
prints before exiting.

**Refusals.** `handled: false`, and an `error` that starts with `Error: `.
When several apply, the first in this list wins:
1. `process.platform` is `win32`: `--tmux` is not supported on Windows.
2. `tmux -V` fails: tmux is not installed, with an install hint: the Homebrew
   command on macOS, the apt command elsewhere (Findings F6).
3. The worktree name is invalid: `Error: ` and the slug refusal of section 1.
4. A WorktreeCreate hook fails: `Error: ` and its error.
5. No hook and no git repository: `--worktree` requires a git repository.
6. Creation fails (section 3): `Error: ` and its message.

**The name.**
- It is the argument after `-w` or `--worktree`, when there is one and it does
  not start with `-`, or what follows `--worktree=`. The last occurrence wins.
- A pull request reference (`parsePRReference`) becomes `pr-<n>`, and that
  pull request is the base.
- Without a name, a random `<adjective>-<noun>-<suffix>` is made up:
  adjectives `swift`, `bright`, `calm`, `keen`, `bold`; nouns `fox`, `owl`,
  `elm`, `oak`, `ray`; a suffix of up to four base-36 characters.

**The worktree.**
- **With a WorktreeCreate hook,** in or out of git, the hook's path is used,
  and a line naming that path is printed. The repository name is the last
  component of the main repository root, or of the session directory outside
  git.
- **Otherwise** section 3 runs in the main repository, with the pull request
  when there is one. A new worktree prints one line naming the worktree
  directory and its base (`origin/<default>`, `HEAD` or `FETCH_HEAD`), then
  gets section 4. A resumed one prints nothing and gets no setup.

**The tmux session name** is `<repository name>_<worktreeBranchName(name)>`,
with `/` and `.` replaced by `_`.

**What runs in it** is `process.execPath` (Findings F3), followed by `args`
in their order, without:
- `--tmux` and `--tmux=classic`;
- `-w` and `--worktree`, and the argument after one when it does not start
  with `-`;
- anything starting with `--worktree=`;
- empty strings.

It runs in the worktree directory.

**Inside tmux** (`TMUX` set in `process.env`):
- if a session of that name exists, the current client is switched to it;
- otherwise the session is created detached, running the command, and the
  current client is switched to it.

No control mode and no tip here.

**Outside tmux:**
- tmux attaches the terminal to the session of that name, creating it with
  the command when it does not exist. It runs in the foreground and holds the
  terminal until tmux exits, on detach or when the session ends.
- In iTerm2 (`TERM_PROGRAM=iTerm.app`, `ITERM_SESSION_ID`, or the detected
  terminal) the client uses tmux control mode (`-CC`), unless `--tmux=classic`
  was given.
- In control mode, when the session is new, a tip is printed first: to open
  tmux windows as iTerm2 tabs, set iTerm2's Settings > General > tmux option
  "Tabs in attaching window".

The answer is `{ handled: true }` either way, whatever tmux's exit status
(Findings F4).

**Environment.** Under Bun, the tmux check, the existence check and the
client switch run with the environment the process started with, while the
session is created with the current `process.env` (Findings F5).

### 16. `parsePRReference(input)`

- **`#<digits>`**, and nothing else: the number (`#007` is 7, `#0` is 0).
- **A pull request URL:** `http` or `https` in any case, any host (a port
  included), exactly two path segments, then `pull/<digits>`, optionally
  followed by `/`, a query, a fragment, or `/` and then those. The number.
- **Anything else** is `null`: a bare number (that is a worktree name), blanks
  around `#`, text before `#` or after the digits, `pulls` or `issues`, a
  missing or extra path segment, `/files` after the number, GitLab and
  Bitbucket URLs, other schemes, and no scheme at all.

## Formats

- **Worktree layout.** `<root>/.claudin/worktrees/<flattened slug>` on branch
  `worktree-<flattened slug>`.
- **`.worktreeinclude`.** gitignore syntax. Pinned by the fixture pair in
  `src/vcs/git/worktree/__fixtures__/rewrite/`: the include file, and the
  manifest of what the real code copied, in order.
- **The shared git configuration** gets `core.hooksPath = <absolute path>`.
- **tmux session names** as in sections 14 and 15.
- **Hook input.** `hook_event_name` (`WorktreeCreate` or `WorktreeRemove`), and
  `name` or `worktree_path`. The other fields come from `platform/lifecycleHooks`.

**Text pinned byte for byte outside the new suites.** The rewrite keeps these
or updates the tests with it:
- `src/vcs/git/worktree.test.ts` (this project's own, kept):
  - the slug refusals contain `".." path segments`, `must be non-empty`,
    `only letters, digits, dots, underscores, and dashes`, and
    `must be 64 characters or fewer (got 65)` (and `(got 400)`);
  - the attach refusals contain `not a registered worktree` and
    `main worktree`;
  - the four install hints are compared whole.
- `src/tools/AgentTool/AgentTool.tsx` matches
  `Cannot create agent worktree: not in a git repository` in the agent
  wrapper's refusal (section 7).

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| Two concurrent creations of one slug | one worktree, the same answer for both | yes |
| A branch `worktree-<slug>` left from an earlier worktree | reset to the new base | yes |
| That branch checked out in another worktree | `Failed to create worktree: …` naming the branch | yes |
| A non-worktree directory at the worktree path | `Failed to create worktree: …` with git's "already exists" | yes |
| The worktree directory deleted by hand, not pruned | creation fails with git's message naming the path | yes (F8) |
| A repository with no commit | the base cannot be resolved, for `fresh` and `head` alike | yes |
| `origin/<default>` present locally but stale | used as it is, no fetch | yes |
| No `origin` at all | base is the local `HEAD`; a pull request fails | yes |
| A glob in `sparsePaths` | creation rejects, and the half-made worktree is removed | yes |
| `.claudin/settings.local.json` that cannot be copied (a directory) | creation succeeds | yes |
| `.husky` is a file | `.git/hooks` is used | yes |
| Neither `.husky` nor `.git/hooks` | `core.hooksPath` untouched | yes |
| An attach path through a symbolic link | resolved to the worktree | yes |
| A relative attach path | read from the process working directory | yes |
| Attaching to a registered worktree whose directory is gone | published today (F9) | no: fix |
| `keepWorktree` or `cleanupWorktree` with the original directory gone | nothing happens, the session stays | yes (F11) |
| `cleanupWorktree` when removal fails | the session is cleared and the branch deleted anyway | yes (F10) |
| A non-ASCII file named in `.worktreeinclude` | never copied (F12) | no: fix |
| `-w` or `--worktree` followed by another flag, or last | that occurrence names nothing; with no other name, a random one | yes |
| `killTmuxSession` for a missing name that prefixes another session | kills the other session (F2) | no: fix |

## Security requirements

**Pinned by the tests:**
- **The slug is the path boundary.** It is joined into a path, and it arrives
  from the model (EnterWorktree's `name`) and from the command line. Refused
  are: `..` and `.` segments, a leading `/` (an absolute path), empty
  segments, `\` and `:` (Windows separators and drive letters), every
  character outside the alphabet, and more than 64 characters. Validation runs
  before any hook, git command or directory.
- **The flattened mapping is injective,** so two slugs never share a branch or
  a directory, and a nested slug never lands inside another worktree.
- **Fetches never prompt** (section 3).
- **`symlinkDirectories` entries with `..` are skipped,** and absolute ones stay
  below the repository.
- **The include copy stays inside the repository:** it copies only files git
  lists under `repoRoot`, to the same relative paths under the worktree.
- **The sweep never removes work:** only throwaway names, never the current
  session's worktree, a dirty one, one with unpushed commits, or a recent one.
- **`hasWorktreeChanges` fails closed.**

**Not pinned:**
- **tmux targets match by prefix** (Findings F2). A kill can hit another
  session.
- **Links can be redirected by the repository.** `symlinkDirectories` entries
  are resolved through the repository's own tracked symbolic links. Settings
  and repository content come from the same project, so this adds nothing a
  project could not do with a tracked symbolic link.

## Tests that pin it

The suite is 255 tests in nine files next to the unit. Three runs in a row
passed.

| File | Tests | Covers |
|---|---|---|
| `slugNaming.characterization.test.ts` | 39 | every accepted and refused slug shape, the order of the checks, the facts each refusal states, `worktreeBranchName` |
| `mutationLock.characterization.test.ts` | 12 | who runs when, as data-driven scenarios; results and failures; the reset; concurrent creations and removals in one real repository |
| `session.characterization.test.ts` | 27 | the one session binding, and the barrel exporting every contract name |
| `createWorktree.characterization.test.ts` | 76 | where worktrees land, every base selection, credential-free fetches, sparse checkout, creation failures, resuming, both wrappers' answers, removal, `parsePRReference` |
| `createWorktree.hooks.characterization.test.ts` | 9 | WorktreeCreate and WorktreeRemove hooks through both wrappers and removal |
| `includeFiles.characterization.test.ts` | 11 | the fixture pair, each rule behind it, and the edge cases |
| `postCreationSetup.characterization.test.ts` | 12 | local settings, the hooks path, linked directories, the include copy, and none of it on resume |
| `sessionLifecycle.characterization.test.ts` | 30 | attach, keep, cleanup, the sweep, `hasWorktreeChanges` |
| `tmuxSession.characterization.test.ts` | 39 | session names, install hints, the session helpers, and the fast path: refusals, in-process, in its own process inside tmux, and attaching from a terminal |

**Line coverage** of the old code: `worktree.ts`, `session.ts`,
`slugNaming.ts` and `mutationLock.ts` 100%, `createWorktree.ts` 99.7%,
`sessionLifecycle.ts` 97.7%, `includeFiles.ts` 96.8%, `postCreationSetup.ts`
95.9%, `tmuxSession.ts` 85.0%. The lines left in `tmuxSession.ts` run only
in the driver processes described below.

**The probe spec.** `scripts/migrations/probes/rewrite-vcs-worktree.json` has
40 probes: 9 in `createWorktree.ts`, 9 in `sessionLifecycle.ts`, 8 in
`tmuxSession.ts`, 4 each in `includeFiles.ts` and `postCreationSetup.ts`, 3 in
`mutationLock.ts`, 2 in `slugNaming.ts` and 1 in `session.ts`. Every probe
turned at least one test red.

**How the suite drives the unit.** The rewrite has to keep these working:
- **Real repositories.** A bare `origin` with clones of it, in `mkdtemp`
  directories. git is cut off from the machine's configuration:
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` in a temp
  directory, and the `GIT_*` location variables removed
  (`src/vcs/git/__testutils__/isolatedGitEnv.ts`, `scratchRepos.ts`).
- **A lab per test** (`src/vcs/git/__testutils__/worktreeLab.ts`):
  - `CLAUDIN_CONFIG_DIR` points at a temp directory, and its `settings.json`
    carries the `worktree.*` settings and the hooks;
  - the session's original directory and the managed-settings directory are
    temp directories;
  - hooks run without the trust prompt (a non-interactive session);
  - the session binding, the locks and the in-memory project config start and
    end empty;
  - the session directory is set per call with `runWithCwdOverride`, and the
    process directory is restored after keep and cleanup.
- **Real command hooks** save the JSON they receive.
- **Credential prompts** are observed through a repository `core.sshCommand`
  that records the environment git gives it.
- **tmux runs for real** on a private server per test
  (`src/vcs/git/__testutils__/tmuxLab.ts`):
  - `TMUX_TMPDIR` points at a temp directory, and the server starts with
    `-f /dev/null`;
  - only that server is killed;
  - `process.execPath` is pointed at a recorder script, which writes down its
    working directory, session and arguments, then waits to be released.

  Under Bun, `child_process.spawnSync` without `env` uses the environment the
  process started with (F5). The fast path's calls that depend on it run in a
  fresh `bun test` process whose startup environment points at the private
  server:
  - **inside tmux,** the process runs with `TMUX` naming that server, and a
    real client, attached from a pane, is there to be switched;
  - **attaching from a terminal,** the process runs inside a pane of the
    private server, whose terminal the attach takes.

  The in-process fast-path tests run only when the test runner itself is not
  inside tmux and no tmux server answers on its own socket. Every tmux test is
  skipped when tmux is not on `PATH`.
- **Outcomes are awaited plainly.** Under Bun, `expect(promise).resolves` and
  `.rejects` wait by spinning the event loop, so a lock that never releases
  would hang the whole run instead of timing one test out.
- **tmux and git versions.** The suite ran with tmux 3.7c and git 2.55.0.

**Existing tests.** `src/vcs/git/worktree.test.ts` is this project's own and
stays, without its inherited cases, which the suite covers. It pins the export
set and each export's arity, the slug refusals' wording, the four install
hints, `generateTmuxSessionName`, the session accessors, the lock's
release-on-throw and the attach refusals.

**Not pinned, and why:**
- **The rows marked "no"** above, and everything the Findings mark "fix".
- **The empty `.claudin/` directory** a worktree may get without local
  settings. Nothing can observe it: git ignores empty directories.
- **The 100 ms pause before deleting the branch** in `cleanupWorktree`, and
  the debug log lines.
- **A failed checkout after sparse setup,** and a pull request fetch that
  prints nothing: real git does not produce them on demand.
- **The fast path's switch in the in-process tests.** It reaches the test
  runner's own tmux; the driver tests pin it.
- **Windows.** The Windows refusal is pinned; Windows paths are not.

## Out of scope

- **`activeWorktreeSession` in the project config** (Findings F1). The rewrite
  drops those writes.

## Findings

Each finding has a decision. "Fix" means the rewrite changes the behaviour,
and no test pins the old one.

1. **F1. `activeWorktreeSession` is written and never read.** The session
   wrapper and attach store the session in the project config, and keep and
   cleanup clear it. Nothing in the tree reads the field; resume uses the
   transcript.
   - **Decision: remove as dead.** Pinned: nothing.
2. **F2. tmux targets match by prefix.** `killTmuxSession` and the fast path's
   existence check pass the name as a plain tmux target, which tmux resolves
   by exact name and then by prefix. With no session `repo_worktree-a`, a kill
   ends `repo_worktree-ab`. Inside tmux, the fast path then believes the
   session exists and switches to the other one. Verified with tmux 3.7c.
   - **Decision: fix.** Use exact-match targets. No caller relies on prefix
     matching, and a wrong kill loses work.
3. **F3. The fast path relaunches `process.execPath` with the arguments
   only.** Under the default install, a compiled binary, that is the CLI. On
   the Node path (`node dist/cli.mjs`, used by `bun run dev` and the npm
   wrapper's fallback) it is `node`, so tmux runs `node <args>`, a Node REPL
   or an error instead of Claudin.
   - **Decision: fix.** Relaunch the CLI the way the current process was
     launched: the runtime, its script when there is one, then the filtered
     arguments. The suite pins only that the filtered arguments end the
     command line and run in the worktree, which holds either way.
4. **F4. The fast path ignores tmux's exit status.** When attaching fails, it
   still answers `handled: true`, and the CLI exits without a word of its own.
   - **Decision: keep for parity** (not pinned). tmux prints its own error on
     the terminal, and a non-zero status also ends ordinary sessions (a killed
     server), which an error message would misreport.
5. **F5. Two environments in one operation.** Under Bun, the fast path's tmux
   check, existence check and client switch run with the environment the
   process started with, and the session is created with the current
   `process.env`. When the environment changed after start (settings applied
   to `process.env`, for one), the check and the switch can reach another
   tmux server, or another `PATH`, than the creation.
   - **Decision: fix.** Every tmux command uses the current `process.env`.
     This is pure hardening: nothing differs unless the environment changed.
6. **F6. Two install hints.** `getTmuxInstallInstructions()` names apt and dnf
   on Linux and WSL. The fast path's own refusal names apt alone, and picks
   by `process.platform`, so every platform but macOS gets the apt hint.
   - **Decision: fix.** The fast path uses `getTmuxInstallInstructions()`.
     The suite pins only what both share.
7. **F7. Session worktrees nest under a linked worktree.** From a session
   directory inside a linked worktree, the session wrapper creates the new
   worktree under that worktree's `.claudin/worktrees`, while the agent
   wrapper and the fast path use the main repository. Both callers move to the
   main repository first, so it does not happen today.
   - **Decision: fix.** Use the main repository in all three entry points. No
     caller sees a difference.
8. **F8. A deleted worktree directory blocks re-creation.** Creating a
   worktree whose directory was deleted without `git worktree prune` fails
   with git's message, which names the path, until the user prunes.
   - **Decision: keep for parity** (pinned). Pruning on the user's behalf
     would also drop the registrations of other missing worktrees, for example
     on an unmounted drive.
9. **F9. Attach accepts a worktree whose directory is gone.** Git still lists
   it, so the session is published, with no branch and no commit. The
   caller's directory change then fails, and EnterWorktree refuses to run
   again ("Already in a worktree session") until ExitWorktree runs.
   - **Decision: fix.** Refuse it like an unregistered path, before
     publishing anything.
10. **F10. Cleanup deletes the branch even when the removal failed.**
    - **Decision: keep for parity** (pinned). Removing means discarding.
      ExitWorktree refuses to remove without confirmation when it cannot
      count the changes, and git refuses to delete a branch that is still
      checked out.
11. **F11. Keep and cleanup give up quietly when the original directory is
    gone,** leaving the session published and the worktree in place.
    - **Decision: keep for parity** (pinned). The session stays so that
      leaving can be retried.
12. **F12. Names git quotes are never copied.** git's listing quotes file
    names with non-ASCII characters, double quotes, backslashes or control
    characters. Such a name never matches `.worktreeinclude` and is never
    copied.
    - **Decision: fix.** Read git's NUL-separated listing.
13. **F13. A missing link source still gets its link.** A
    `symlinkDirectories` entry absent from the main checkout becomes a
    dangling link in the new worktree.
    - **Decision: keep for parity** (pinned). The link starts working when the
      directory appears in the main checkout, after an install for one.
14. **F14. The hooks path is replaced whatever it was.** Creation points the
    shared `core.hooksPath` at `<root>/.husky` or `<root>/.git/hooks`, for the
    main checkout too. A repository that uses another directory (`.githooks`,
    or husky 9's `.husky/_`) loses its hooks in every worktree and in the
    main checkout.
    - **Decision: fix.** When a hooks path is already set, keep that
      directory, made absolute against the main checkout, so that worktrees
      reach the same files. Only when none is set, use `.husky` or
      `.git/hooks` as today (pinned).
15. **F15. `usedSparsePaths` describes the settings, not the worktree.** On a
    resume it reports whether sparse paths are configured now, even for a
    worktree created before they were.
    - **Decision: keep for parity** (not pinned). Its only reader, the REPL's
      tip about slow creation, also needs a creation time, which a resume
      does not have.
16. **F16. Headless workflow worktrees are never swept.** The headless workflow
    runner names its worktrees `wf-<workflow>-<base-36 time>`, which no
    throwaway shape matches, so the ones a killed run leaves behind stay
    forever. The shapes deliberately spare user names like `wf-myfeature`.
    - **Decision: report to `platform/headless`.** Give its worktrees a shape
      the sweep can recognize. Nothing changes in this unit.

## Target design

- **Keep the barrel** `src/vcs/git/worktree.ts` and its export list. Behind it,
  modules split by responsibility under `src/vcs/git/worktree/`, each with its
  own colocated tests, and none importing the barrel.
- **Pure cores** (`.claudin/rules/code-design.md`, "pure core, thin shell"):
  - slug validation and the name and path mapping;
  - the choice of base, from the settings, the pull request and what the
    repository has locally, as a plan: fetch this, then base on that;
  - the choice of files to copy, from git's NUL-separated listings and the
    include patterns (F12);
  - the classification of throwaway names, as a table of named shapes;
  - the fast path's argument handling: the name, the pull request, classic
    mode and the arguments passed on;
  - the tmux session name.
- **Thin shells over narrow ports**, passed as `…Deps`:
  - a git runner (arguments, working directory, environment) that never
    throws;
  - a tmux runner that always uses the current environment (F5) and exact
    targets (F2);
  - the hook runner of `platform/lifecycleHooks`;
  - the file system.

  The tests then need no `mock.module`.
- **Post-creation steps as a list** of independent, best-effort steps: local
  settings, hooks path (F14), links, include copy.
- **The lock** as a small keyed queue with an explicit reset for tests.
- **The session binding** stays a single module-level value behind the two
  accessors.
- **Types.** Explicit throughout, with no `any`. A creation result that says
  whether the worktree was created or resumed. `WorktreeSession` kept as it
  is.

## Outcome

Rewritten per method on 2026-10-03, the first unit to go through the `bodies`
sandbox (`docs/tech/rewrite/levers.md`, "Rewriting per method").

- **Done.** The 27 inherited bodies were written anew, and seven small modules
  took the parts that read better on their own: `gitCommand`, `tmuxCommand`,
  `tmuxLaunch`, `baseChoice`, `includeSelection`, `worktreeList` and
  `throwawayNames`. The nine characterization suites pass unchanged.
  - **Fixed, each with a test:** F1, F2, F3, F5, F7, F9, F12 and F14.
  - **Kept for parity:** F4, F8, F10, F11, F13 and F15.
  - **F6 deviates:** the fast path reads `process.platform` at call time,
    because `getPlatform()` is memoized and the suite switches platforms
    inside one process.
- **Probes.**
  - `rewrite-vcs-worktree.json`: 79 probes on the new code.
  - `worktree.json`: kept its 5 surface and suite probes. Its 20 stale
    probes were pruned, because every behaviour they guarded is pinned again in
    `rewrite-vcs-worktree.json`.
- **Residue, reviewed.** 1,104 inherited lines down to 41, every one dictated
  by the contract:
  - `createWorktree.ts` (13): the signatures of `getOrCreateWorktree`,
    `createWorktreeForSession` and `createAgentWorktree`, and their opening
    `validateWorktreeSlug` call and path/branch derivation.
  - `session.ts` (6): the fields of `WorktreeSession`, and the two one-line
    accessors.
  - `sessionLifecycle.ts` (8) and `slugNaming.ts` (2): signatures and their
    first statement.
  - `tmuxLaunch.ts` (4) and `tmuxSession.ts` (2): the `tmux` argument lists,
    which the protocol fixes.
  - `mutationLock.ts` (6, openclaude): the signature of
    `withGitWorktreeMutationLock`, and the read of the previous holder.

  They go when the contract is redesigned, after every consumer has been
  rewritten.
