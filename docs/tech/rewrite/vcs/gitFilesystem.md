# Spec: `vcs/gitFilesystem`

Files: `src/vcs/git/gitFilesystem.ts` and `src/vcs/git/gitConfigParser.ts`.

## Purpose

The module answers questions about a git repository by reading its `.git`
directory, without starting a `git` process. It reports:

- which git directory a path belongs to;
- what a ref and `HEAD` resolve to;
- origin's URL, and any single value of a repository's `config`;
- how many worktrees the repository has;
- four values about the repository of the session's working directory,
  cached in memory and refreshed when git changes the files they come from:
  - the branch;
  - the `HEAD` commit;
  - origin's URL;
  - the default branch.

Nearly every git-aware feature reaches it, most through the wrappers in
`src/vcs/git/git.ts`:
- `getBranch()`, `getHead()`, `getDefaultBranch()`, `getRemoteUrl()` and
  `getWorktreeCount()`, which feed the system context, pull-request status,
  the bridge, teleport and tips;
- `detectRepository`, which derives the GitHub owner and repository from
  origin's URL.

The rest of its callers use it directly: the worktree lifecycle, plugin
versioning, and the GitHub repository path mapping.

Its answers must match what git reports for the same repository, except where
this spec records a deliberate difference.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `resolveGitDir` | `(startPath?: string) => Promise<string \| null>` | `src/vcs/git/git.ts` (`getGitDir`, which `src/vcs/git/gitDiff.ts` uses to look for `MERGE_HEAD` and the other transient-state files); `src/vcs/git/worktree/createWorktree.ts`; `src/vcs/git/worktree/postCreationSetup.ts`. `src/vcs/git/commitAttribution.ts` imports it and never calls it. |
| `clearResolveGitDirCache` | `() => void` | `src/commands/clear/caches.ts` (`/clear`) |
| `getCommonDir` | `(gitDir: string) => Promise<string \| null>` | `postCreationSetup.ts` |
| `resolveRef` | `(gitDir: string, ref: string) => Promise<string \| null>` | `createWorktree.ts`, to skip `git fetch` when `refs/remotes/origin/<default>` is already there |
| `getHeadForDir` | `(cwd: string) => Promise<string \| null>` | `src/plugins/pluginVersioning.ts` (a plugin's version is the first 12 characters) and `src/plugins/installedPluginsManager.ts` |
| `readWorktreeHeadSha` | `(worktreePath: string) => Promise<string \| null>` | `createWorktree.ts` (fast resume of an existing worktree) and `src/vcs/git/worktree/sessionLifecycle.ts` |
| `getRemoteUrlForDir` | `(cwd: string) => Promise<string \| null>` | `src/vcs/git/githubRepoPathMapping.ts` (`validateRepoAtPath`) |
| `getCachedBranch` | `() => Promise<string>` | `git.ts` `getBranch()` when called without a directory |
| `getCachedHead` | `() => Promise<string>` | `git.ts` `getHead()` |
| `getCachedRemoteUrl` | `() => Promise<string \| null>` | `git.ts` `getRemoteUrl()` |
| `getCachedDefaultBranch` | `() => Promise<string>` | `git.ts` `getDefaultBranch()` |
| `getWorktreeCountFromFs` | `() => Promise<number>` | `git.ts` `getWorktreeCount()` |
| `parseGitConfigValue` (in `gitConfigParser.ts`) | `(gitDir: string, section: string, subsection: string \| null, key: string) => Promise<string \| null>` | `postCreationSetup.ts` (`core.hooksPath`), and this module (`remote.origin.url`) |

Six more names are exported today, and nothing imports them. They are
`isSafeRefName`, `isValidGitSha`, `readGitHead`, `readRawSymref` and
`isShallowClone` in `gitFilesystem.ts`, and `parseConfigString` in
`gitConfigParser.ts`. `knip-baseline.json` lists all six as unused exports. The
rewrite drops them (see Out of scope). What the first four and
`parseConfigString` do is specified below through the exports that callers
use.

## Observable behaviour

### 1. The git directory of a path: `resolveGitDir(startPath?)`

- **Start path.** Without an argument, the start path is `getCwd()`
  (`src/shared/fs/cwd.ts`), so a `runWithCwdOverride` directory counts. A
  relative argument is resolved against the process working directory.
- **The walk.** From the start path upward, the first directory with a `.git`
  entry, file or directory, is the repository root.
  - The start path may be a file, or may not exist. The walk goes up from it
    all the same.
  - The walk is `findGitRoot` from `src/vcs/git/git.ts`, which memoizes its
    answers per start path. Keep using it, so that both modules agree on the
    root.
- **A `.git` directory.** The answer is `<root>/.git`.
- **A `.git` file** (a linked worktree, a submodule, `--separate-git-dir`). Its
  content, with surrounding whitespace removed, must start with `gitdir:`. The
  rest, trimmed, is the answer. A relative path is resolved against the root,
  as a submodule's `gitdir: ../../.git/modules/<path>` needs. A `.git` file
  that does not fit is finding F5.
- **No repository**, or a `.git` file that cannot be read: `null`.
- **Paths are not canonicalized.** A start path reached through a symlink gives
  an answer that keeps the symlink. `git rev-parse --absolute-git-dir` reports
  the real path.
- **Memoized per resolved start path,** a `null` included. A changed `.git` file
  is not noticed from a start path already asked about, until
  `clearResolveGitDirCache()` empties the memo. A start path not asked before
  sees the change at once.

### 2. Refs: `getCommonDir(gitDir)` and `resolveRef(gitDir, ref)`

**`getCommonDir`** reads `<gitDir>/commondir`, trims it, and resolves it
against `gitDir`. An absolute path is taken as it is. A linked worktree's git
directory has one (`../..`), which leads to the main `.git`. A main repository
or a submodule has none, and the answer is `null`, as it is for a missing or
unreadable file.

**`resolveRef`** answers the object id a ref names, or `null`. `ref` is a path
below the git directory: `refs/heads/main`, `refs/tags/v1`,
`refs/remotes/origin/HEAD`, `HEAD`. It is not checked, so callers pass
constants or names that have passed the ref-name rule (section 4).

The lookup, as a caller sees it:

1. **The loose file** `<gitDir>/<ref>`, trimmed:
   - `ref: <target>` is a symbolic ref. The target must pass the ref-name
     rule, or the answer is `null`. It is then looked up in the same way,
     from the same git directory.
   - Otherwise the content must be one full object id (section 4): 40 or 64
     lowercase hex digits. Anything else gives `null`, and `packed-refs` is not
     consulted. A broken loose ref hides a packed entry of the same name, and
     git ignores both too.
2. **`<gitDir>/packed-refs`,** when there is no loose file. The entry is the
   line `<id> <name>` whose name is exactly `ref`. The header (`# pack-refs
   with: …`) and the peeled lines (`^<id>`, after annotated tags) never match.
   The id must be a full object id, or the answer is `null`.
3. **The common dir,** when steps 1 and 2 found nothing and `gitDir` has a
   common dir other than itself. Steps 1 and 2 are repeated there. So from a
   linked worktree's git directory, the worktree's own refs (`HEAD`,
   `refs/worktree/*`, `refs/bisect/*`) come first and the shared ones after.

Results match `git rev-parse <ref>`:
- loose and packed refs alike;
- a loose ref that shadows a packed one;
- an annotated tag, which answers the tag object's id and not the commit it
  peels to;
- SHA-256 repositories.

Symbolic chains are followed, and the suite pins chains of up to four hops,
which is where git stops. A cycle is finding F1. A missing ref or directory
gives `null`, and the function never throws.

### 3. HEAD: `getHeadForDir(cwd)` and `readWorktreeHeadSha(worktreePath)`

The `HEAD` file is read with surrounding whitespace removed, and CRLF is
accepted:

- **`ref:`**, then any whitespace or none, then a name:
  - **Under `refs/heads/`,** it is a branch. The part after `refs/heads/` must
    pass the ref-name rule, or `HEAD` counts as unreadable.
  - **Any other name,** such as `refs/remotes/origin/main` or `refs/tags/v1`
    (git lets `HEAD` point anywhere under `refs/`). The whole name must pass
    the rule. It resolves as in section 2, and `HEAD` counts as detached at
    that id.
- **A full object id:** detached at that id.
- **Anything else** is unreadable: uppercase hex (which git accepts),
  abbreviated or overlong ids, trailing text, an empty file.

**`getHeadForDir(cwd)`** is for any directory.
- **The git directory.** It comes from `resolveGitDir(cwd)`, so it walks up and
  shares that memo. A directory that does not exist inside a repository answers
  for that repository.
- **The answer.**
  - On a branch: the branch's tip.
  - On a branch with no commit yet: `null`.
  - Detached: the id.
  - `null` outside a repository, and when `HEAD` is unreadable.
- **A non-branch `HEAD` that does not resolve** gives `''` today (finding F4).

**`readWorktreeHeadSha(worktreePath)`** reads `HEAD` for exactly that directory.
- **Only the `.git` file.** `<worktreePath>/.git` is read as a gitfile. There is
  no upward walk and no memo.
- **The prefix.** The content, trimmed, must start with `gitdir:` exactly, in
  lower case. A relative path is resolved against `worktreePath`.
- **The answer.** `HEAD` then resolves as in `getHeadForDir`. Refs come through
  the common dir, which is where a linked worktree's branches live.
- **`null` when:**
  - the path does not exist;
  - `.git` is a directory, as in the main worktree;
  - the prefix is missing;
  - the git directory it names is gone (a worktree deleted without prune);
  - `HEAD` is unreadable.
- **Submodules work,** through their relative gitdir.

### 4. Names and ids that are accepted

This is the module's security boundary. The answers flow into shell commands,
paths and prompts: the commit-push-pr skill interpolates the branch into
shell.

**A ref name** is accepted only when:
- it is not empty;
- it uses only ASCII letters, digits, `/`, `.`, `_`, `+`, `@` and `-`;
- it does not start with `-` or `/`;
- it has no `..`;
- it has no empty or `.` path component.

The rule applies in four places:
- the branch in `HEAD`;
- a non-branch name in `HEAD`;
- the target of a loose symbolic ref;
- the branch `refs/remotes/origin/HEAD` names (section 7).

It accepts `feature/login`, `release-1.2.3+build`,
`dependabot/npm_and_yarn/@types/node-18.0.0`, `UP/Case_9`, `user@host` and
`v1.x`. It refuses:
- names git also refuses: `../x`, `-rf`, `a//b`, `a/./b`, `a..b`, `up@{1}`,
  and names with a blank, tab or newline;
- shell text: `$(…)`, `;`, backticks;
- names git allows: `fix/#123`, `feature/ação`, `a,b`, `user's`, `x=y`,
  `{x}`.

A branch refused by the rule is reported as no branch at all (finding F16).

**An object id** is accepted only as exactly 40 or 64 lowercase hexadecimal
digits, once surrounding whitespace is removed.

### 5. Origin's URL: `getRemoteUrlForDir(cwd)` and `getCachedRemoteUrl()`

- **Where it is read.** `remote.origin.url`, read as in section 6, from
  `<gitDir>/config`. When that gives no value, or an empty one, and the git
  directory has a common dir, it is read from `<commonDir>/config`.
  - A linked worktree therefore reads the main repository's config.
  - A submodule reads its own (`.git/modules/<path>/config`).
- **Several URLs.** The answer is the first one, which is what
  `git remote get-url origin` prints. `git config --get` prints the last.
- **As written.** `url.<base>.insteadOf` is not applied, so the answer is what
  `git config --get` prints. `git remote get-url` applies it.
- **No origin, or no repository:** `null`.

### 6. One config value: `parseGitConfigValue(gitDir, section, subsection, key)`

- **The file.** It reads `<gitDir>/config` on every call, with no cache. A
  missing or unreadable file, or a directory in its place, gives `null`. It
  never throws.
- **Matching:**
  - The section name is matched without regard to case.
  - The subsection is matched exactly, case included. `subsection: null`
    matches only headers without a subsection.
  - The key is matched without regard to case.
  - A key counts only inside a matching section. Sections that do not match,
    including a section whose name merely begins like the wanted one, reset
    the match.
- **Which value.** The first assignment of the key in file order. A later block
  of the same section is reached only when the earlier ones had none. A key
  written without `=` is passed over, and the search goes on.

What it reads **exactly as `git config` does** (all pinned against git):

| Topic | Behaviour |
|---|---|
| Headers | `[section]` and `[section "subsection"]`. Blanks and tabs between the two parts. Blanks before the `[`. A `#` or `;` comment after the `]`. In a subsection, `\"` and `\\` stand for `"` and `\`, and any other escaped character stands for itself. A subsection may contain `]`. `[remote ""]` has an empty subsection. |
| Names | Letters, digits and `-` in section and key names. |
| Assignments | `key = value`, with any blanks or tabs around `=`, or none. The value may contain `=`. |
| Comments | Whole-line `#` and `;` comments, and blank lines. Outside quotes, `#` or `;` ends the value, even with no blank before it. Inside quotes they are text. |
| Quotes | `"…"` keeps the blanks inside it. Quotes may cover part of a value: `a" b "c` reads as `a b c`. |
| Escapes inside quotes | `\t`, `\n`, `\b`, `\"` and `\\`. |
| Escapes outside quotes | `\\` stands for `\`, as in a Windows `hooksPath` that git writes as `C:\\hooks`. |
| Blanks | Leading and trailing blanks are dropped. Runs of blanks inside are kept. Tabs inside are kept too, as recent git does. Older gits turned them into spaces, so this one case is not asked of git. |
| Empty values | `key =`, `key = ""`, `key =   ` and `key = # c` are all the empty string. |
| Line ends and bytes | CRLF line ends. A UTF-8 byte order mark. No newline at the end of the file. A lone CR inside a value is kept. |

Where it **deliberately differs from git**, pinned against both:

| Input | Module | git |
|---|---|---|
| A key assigned twice, or a section repeated with the key in each block | the first value | the last, for `git config --get` |
| A key written without `=`, and no later assignment | `null` | present, with an empty value |
| A line git cannot parse (`!!!`, `my_key = x`, `url x = y`) | skipped; the search goes on | refuses the whole file |
| An unclosed quote in a value | the value runs to the end of the line | refuses the file |
| An unknown escape inside quotes (`"a\qb"`) | the character without its backslash | refuses the file |
| A header with text after the subsection, or an unclosed subsection quote | matches nothing | refuses the file |

Where it **differs from git and the rewrite fixes it**. These are findings
F6 to F10, and no test pins the old behaviour:
- escapes outside quotes;
- continuation lines;
- blanks at the end of a quoted part;
- the old `[section.subsection]` header;
- a key on its header's line.

### 7. The four cached values

**What each one is:**

| Getter | Answer | When there is none |
|---|---|---|
| `getCachedBranch()` | the branch `HEAD` names, even one with no commit yet | `'HEAD'`. That covers detached, a `HEAD` that names a non-branch ref, an unreadable `HEAD` (a name the rule refuses, a bad id), and no repository. |
| `getCachedHead()` | the commit id `HEAD` resolves to | `''`. That covers no commit yet, an unreadable `HEAD`, and no repository. |
| `getCachedRemoteUrl()` | origin's URL, as in section 5 | `null` |
| `getCachedDefaultBranch()` | see the list below | `'main'` |

**The default branch** is read from the common dir, or the git directory:
1. **`refs/remotes/origin/HEAD`,** when it is a loose symbolic ref to
   `refs/remotes/origin/<name>` and `<name>` passes the rule. `<name>` may
   contain `/`, as in `release/2.x`. A target outside `refs/remotes/origin/` is
   ignored.
2. **Otherwise `'main'`,** if `refs/remotes/origin/main` resolves, loose or
   packed.
3. **Otherwise `'master'`,** if `refs/remotes/origin/master` does.
4. **Otherwise `'main'`.**

A clone's answers equal git's:
- `git branch --show-current`, or `HEAD` when detached;
- `git rev-parse HEAD`;
- `git config --get remote.origin.url`;
- `git symbolic-ref --short refs/remotes/origin/HEAD`, without `origin/`.

**Which repository.** The one that contains `getCwd()`. Today that is the
directory of the first call in the process, and the module stays tied to it
(finding F2).

**Caching and invalidation:**
- **Computed once.** Each value is computed on its first call and then served
  from memory.
- **What is watched.** Three files are polled for changes: every 10 ms when
  `NODE_ENV` is `test`, every second otherwise. A change to any one marks all
  four values stale, and the next call reads the disk again:
  - `HEAD` in the git directory, which is per worktree;
  - `config` in the common dir, or in the git directory when there is none;
  - the loose ref file of the current branch, in the common dir, or in the git
    directory when there is none. It is watched even before it exists, so the
    first commit of a new branch is seen.
- **Nothing else is watched.** That covers remote-tracking refs,
  `refs/remotes/origin/HEAD`, `packed-refs` and other branches. So a
  `git fetch` or `git remote set-head` shows only once one of the three files
  changes.
- **After a branch switch** the new branch's ref file is watched and the old
  one no longer. The new watch is in place shortly after the switch is
  noticed, and later while the terminal is scrolling (`waitForScrollIdle()` in
  `src/platform/bootstrap/state.ts`).
- **Scrolling never delays** marking the values stale.
- **While detached** no ref file is watched. `HEAD` itself changes with each
  commit.
- **`git pack-refs`** changes no value.
- **Concurrent first calls** agree with each other.
- **Graceful shutdown.** Watching stops then, through a cleanup registered with
  `registerCleanup()` (`src/shared/cleanupRegistry.ts`).

### 8. Worktree count: `getWorktreeCountFromFs()`

- **The repository** is the one that contains `getCwd()`.
- **The count** is one for the main worktree, plus one per entry in
  `<commonDir>/worktrees/`, or `<gitDir>/worktrees/` for a main repository.
  - This equals the number of entries `git worktree list` shows. That includes
    a worktree whose directory was deleted without `git worktree prune`, until
    the prune.
  - It is the same from any of the worktrees.
- **Edge values.** `1` when there is no `worktrees/` directory. `0` outside a
  repository.
- **No cache** beyond the `resolveGitDir` memo.

## Formats on disk

The module reads these formats, and they are pinned. The files in
`src/vcs/git/__fixtures__/rewrite/` were written by git 2.55.0, with a fixed
author and clock:

| File | Format | Fixture |
|---|---|---|
| `.git`, as a file | `gitdir: <path>\n`. Absolute for a linked worktree (`<main>/.git/worktrees/<name>`), relative for a submodule. | `gitfile-submodule` |
| `<gitDir>/commondir` | a path relative to the git directory, `../..\n` for a linked worktree | `commondir` |
| `HEAD` | `ref: refs/heads/<branch>\n`, or `<id>\n` when detached | inline in the suite |
| a loose ref | `<id>\n`, or `ref: <target>\n` for a symbolic ref, such as `refs/remotes/origin/HEAD` | inline |
| `packed-refs` | `# pack-refs with: peeled fully-peeled sorted \n`, then `<id> <name>\n` sorted by name, each annotated tag followed by `^<peeled id>\n`. Symbolic refs are never packed. | `packed-refs` |
| `config` | `[section]` / `[section "sub"]` headers and tab-indented `key = value` lines. git quotes a value that has `#`, `;` or blanks at either end, and escapes `\`, `"`, tab and newline as `\\`, `\"`, `\t` and `\n`, inside quotes or not. | `config` |
| `<commonDir>/worktrees/<name>/` | one directory per linked worktree | built by the suite |

## Edge cases and errors

No export throws or rejects. A row that names a finding is a defect the
Findings section decides; the table records it as it is today.

| Case | What the caller sees | Pinned |
|---|---|---|
| A symbolic ref cycle (`a` → `b` → `a`), in `HEAD`, a branch ref or `refs/remotes/origin/*` | `resolveRef`, `getHeadForDir`, `readWorktreeHeadSha` and the cached getters never settle, and keep reading files | no: F1 |
| The working directory moves to another repository (`EnterWorktree`, a `cd` in Bash, a sub-agent under `runWithCwdOverride`) | the cached values keep answering for the first repository | no: F2 |
| A reftable repository (`git init --ref-format=reftable`) | `getCachedBranch()` gives `.invalid`. `HEAD` resolves to nothing: `getCachedHead()` gives `''` and `getHeadForDir` `null`. The remote URL is read normally. | partly: F3 |
| A symbolic `HEAD` outside `refs/heads/` that resolves to nothing | `getHeadForDir` and `readWorktreeHeadSha` give `''` | no: F4 |
| A `.git` file without `gitdir:` | `resolveGitDir` gives the `.git` file's own path | no: F5 |
| A `.git` file naming a directory that does not exist | `resolveGitDir` gives that path, and everything read through it is `null` | no: F5 |
| A `.git` file of several lines | `resolveGitDir` gives a path with a newline in it | no: F5 |
| `gitdir:` with no blank after the colon, or with blanks before it | accepted; git refuses both | yes |
| A bare repository, or `GIT_DIR` / `GIT_WORK_TREE` in the environment | not recognized: only a `.git` entry makes a repository, and the variables are ignored | yes, for bare |
| A path first asked about outside any repository, then `git init` there | stays `null` even after `clearResolveGitDirCache()`, because `findGitRoot`'s memo (`vcs/git`) is not cleared. A new start path below it sees the repository. | no: F22 |
| A value in an included file (`include.path`, `includeIf`), in global or system config, or in `config.worktree` | not seen | no: F14 |
| A call that arrives while a recompute of the same cached value is running | may get the previous value | no |
| A NUL byte in a config value | kept; git ends the value there | no |

## Security requirements

**Pinned by the tests:**
- **Tampered names are refused,** even when the file they point at holds a
  valid id. Each would otherwise read a file of the attacker's choosing:
  - path traversal: `refs/heads/../../x`, and `refs/remotes/../../x` as a
    non-branch `HEAD`;
  - argument injection: `-rf`;
  - shell text: `$(…)`, `;`, backticks, blanks, tab, newline;
  - git's `@{` syntax.
- **The same rule** applies to symbolic ref targets, and to the branch
  `refs/remotes/origin/HEAD` names.
- **Only full lowercase ids** leave the module as ids. Loose, packed and
  detached `HEAD` content is checked alike.
- **`getCachedBranch()` never returns text outside the allowlist.** A refused
  name reads as `'HEAD'`, because callers interpolate the branch into shell.

**Finding F1, fixed in the rewrite: a symbolic ref cycle never settles.** A
repository whose `.git` holds `refs/heads/a` → `ref: refs/heads/b` and back
makes every lookup through it spin on file reads forever. That covers the
cached getters for the working directory, `getHeadForDir` for a plugin
directory, and `readWorktreeHeadSha`. The threat is the one the name checks
already defend against: a repository from an archive, a shared file system or
a crafted project. git stops after four hops and reports the ref as dangling.
The rewrite bounds the chain the same way (at most five reads) and answers
`null`. This is pure hardening, because no legitimate repository has a longer
chain.

**Kept for parity: the allowlist is narrower than git** (finding F16). Valid
branches with `#`, `,`, `'`, `=`, braces or any non-ASCII letter read as "no
branch":
- `getCachedBranch()` gives `'HEAD'`;
- `getCachedHead()` gives `''`;
- `getHeadForDir()` gives `null`.

Names like `fix/#123` and `feature/ação` are common. Widening the list is a
security decision for the callers that put the branch in shell. It needs
quoting at those call sites first, so it is not part of this rewrite.

**Trusted input.** `resolveRef`'s `ref` argument is not checked. It must stay a
constant or a name that has passed the rule. A `.git` file may name any
directory, as it can for git, and the module then reads that directory's
`HEAD`, refs and `config`. Everything read there is still checked as above.
Config values come back verbatim: `getRemoteUrlForDir`'s answer is parsed by
its callers, and `core.hooksPath` is only compared.

## Tests that pin it

**The suite.** Three files, 136 tests, about 3.5 s. Coverage of the old module
is 94.4% of the lines of `gitFilesystem.ts` and 99.4% of `gitConfigParser.ts`.
- **`src/vcs/git/gitFilesystem.characterization.test.ts`** has 57 tests on
  sections 1 to 5 and 8, and on the on-disk fixtures. It builds real
  repositories with the git CLI: commits, branches, detached `HEAD`, loose and
  packed refs, tags, linked worktrees, submodules, `--separate-git-dir`,
  SHA-256 and remotes. Every answer is compared with `git rev-parse`,
  `git config`, `git remote get-url` or `git worktree list` for the same
  repository.
- **`src/vcs/git/gitFilesystem.config.characterization.test.ts`** has 55 tests,
  one per syntax case in section 6. Each asks `git config -f <file> --get` the
  same question. One case, tabs inside a value, is not asked of git, because
  older gits turned tabs into spaces.
- **`src/vcs/git/gitFilesystem.cache.characterization.test.ts`** has 24 tests
  on section 7.
  - **One watched worktree.** The first describe follows one linked worktree
    through switches, commits, detaching, a tampered `HEAD`, `pack-refs`,
    config changes and default-branch fallbacks. It waits for the cache by
    polling, and relies on the 10 ms interval under `NODE_ENV=test`.
  - **A fresh process per repository.** The second describe runs each case in
    a fresh Bun process (`src/stubs/test-preload.ts` preloaded), because the
    old module ties itself to its first repository.
  - **Why the first describe may switch instances.** It uses the normally
    imported module, whose lines coverage counts. Bun gives a module a new
    instance when its import specifier carries a query string. When an earlier
    suite in the same process has already tied that instance elsewhere, the
    describe switches to such a copy. It avoids the copy otherwise, because a
    second instance corrupts Bun's coverage report for the file.
  - **The rewrite needs neither workaround.** Once the cached values follow
    the working directory (F2), the switch never happens, and a fresh process
    stays equivalent.
- **Shared harness:** `src/vcs/git/__testutils__/scratchRepos.ts`.
  - It runs git with no global or system config, `HOME` in a temp directory,
    and no inherited `GIT_*` variable.
  - It keeps every temp directory free of symlinks, so paths compare with
    git's.
- **Controls the suite relies on:** `runWithCwdOverride` for the working
  directory, and `markScrollActivity()` to hold the terminal "scrolling".
- **git versions.**
  - The reftable case needs git 2.45 and is skipped on older gits.
  - Otherwise the suite needs git 2.31 or later, for
    `rev-parse --path-format`.
  - It was run with git 2.55.0.

**The probes.** `scripts/migrations/probes/rewrite-vcs-gitFilesystem.json` has
40 probes, 31 on `gitFilesystem.ts` and 9 on `gitConfigParser.ts`. Every one
turns the suite red.

No other test imports either file.

**Not pinned, and why:**
- **F1 to F10.** The old behaviour is the defect, and a test of it would
  outlive the fix. The cycle cannot be pinned without hanging the run.
- **`isShallowClone`,** which is dropped.
- **Stopping at graceful shutdown.** Observing it means running every cleanup
  registered in the process.
- **The one-second production interval,** and the scroll deferral of the new
  branch's watch. The suite pins only that scrolling does not delay noticing a
  switch.
- **The previous value served during a running recompute.**
- **What a reftable repository reports** beyond the remote URL. The suite
  accepts either unknown or git's answer for its `HEAD`.
- **Windows paths.**

## Out of scope

- **The six unused exports** listed under Public contract. Drop them and
  refresh `knip-baseline.json` in the same change. `isShallowClone` goes with
  its behaviour: no caller has ever used it.
- **Following `include` and `includeIf`, and reading global, system or
  per-worktree config** (F14). The module answers from the repository's own
  file. Callers treat `null` as "not configured".
- **Reading the reftable format** (F3). A reftable repository reports "unknown",
  never a wrong value.
- **Bare repositories, and `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR`.**
  The module finds repositories by their `.git` entry only.

## Findings

| # | Finding | Decision |
|---|---|---|
| F1 | **Security.** A symbolic ref cycle never settles (see Security requirements). | **Fix:** bound the chain like git, answer `null`. |
| F2 | The cached values are tied to the repository of the first call in the process. After the working directory moves to another repository, they keep answering for the first one, and changes there go unnoticed: after `EnterWorktree` the branch shown is the old one. When a watched file of the first repository changes, the next call recomputes from wherever it is made, and every caller gets that answer until the next change. The first repository can then read the other one's branch. When the first call came from outside any repository, nothing is ever watched. | **Fix:** answer for the repository of `getCwd()` at each call, `runWithCwdOverride` included. No caller wants another repository's values. |
| F3 | In a reftable repository, `HEAD` holds git's placeholder `ref: refs/heads/.invalid`, and `getCachedBranch()` reports `.invalid`. git 3.0 is planned to make reftable the default, and from then on every value here is unknown for new repositories. | **Fix** the placeholder: refuse ref-name components that begin with `.`, which git refuses too. The branch then reads `'HEAD'`. **Track** reftable support: the design below leaves room for a fallback that runs git. |
| F4 | A symbolic `HEAD` outside `refs/heads/` that resolves to nothing makes `getHeadForDir` and `readWorktreeHeadSha` answer `''`, not `null`. `installedPluginsManager.ts` turns only `null` into `undefined`. | **Fix:** `null`. |
| F5 | `resolveGitDir` accepts any `.git` file. With no `gitdir:` it answers the file's own path; with several lines, a path containing a newline; with a missing target, that path. git refuses all three. | **Fix:** `null` unless the `.git` file names an existing directory. Every caller already degrades to "no repository" on these paths. |
| F6 | Config: escapes outside quotes (`\t`, `\n`, `\b`, `\"`) are not decoded, and an unknown one keeps its backslash. git writes them unquoted: `git config remote.origin.url 'x"y'` stores `x\"y`, which reads back as `x\y`. | **Fix:** decode them as inside quotes. An unknown escape stands for its character, as it does inside quotes. |
| F7 | Config: blanks at the end of a quoted part are dropped. `"abc  "` reads as `abc`, while git keeps them, and quotes such a value for that very reason. | **Fix:** keep blanks inside quotes; trim only unquoted trailing blanks. |
| F8 | Config: a backslash at the end of a line does not continue the value on the next line. `url = abc\` then `def` reads as `abc\`. git reads `abcdef`, in quotes or not. | **Fix.** |
| F9 | Config: the old `[section.subsection]` header is ignored. git reads it with the subsection in lower case. | **Fix.** |
| F10 | Config: a key on its section's header line (`[core] hooksPath = /x`) is ignored. git reads it. | **Fix.** |
| F11 | Config: the first of several values wins. git's `--get` takes the last. | **Keep:** for `remote.origin.url` the first is the URL git fetches from and `git remote get-url` prints. A duplicated `core.hooksPath` is pathological. |
| F12 | Config: a key without `=` reads as `null`. git has it, with no value. | **Keep:** no caller reads a boolean. |
| F13 | Config: lines git rejects are skipped, while git refuses the whole file. | **Keep:** best effort, never throws. The pinned cases are in section 6. |
| F14 | Config: no includes; no global, system or `config.worktree` values. | **Keep** (Out of scope). |
| F15 | The remote URL ignores `url.<base>.insteadOf`. | **Keep:** it matches `git config --get`. A `gh:owner/repo` shorthand then yields no GitHub repository, which callers already handle. |
| F16 | **Security trade-off.** Valid branch names outside the allowlist read as "no branch". | **Keep** (see Security requirements). |
| F17 | An uppercase-hex id in `HEAD` or a ref is refused; git accepts it. | **Keep:** git never writes one. |
| F18 | Answers keep symlinks; git reports real paths. | **Keep:** callers read files through the path and never compare it. |
| F19 | `gitdir:` with no blank after the colon, or with blanks before it, is accepted; git refuses both. | **Keep:** harmless. |
| F20 | Bare repositories and `GIT_DIR` are not recognized. | **Keep** (Out of scope). |
| F21 | The default branch goes stale after `git fetch` or `git remote set-head` until `HEAD`, the config or the current branch's ref changes. | **Keep:** it is the cache's contract, and it is pinned. |
| F22 | `clearResolveGitDirCache()` cannot revive a start path that `findGitRoot` (`vcs/git`) memoized as outside any repository. | **Report to `vcs/git`:** `/clear` should reset that memo too. Nothing changes in this unit. |
| F23 | `commitAttribution.ts` imports `resolveGitDir` and never calls it. | **Report:** remove the import when `vcs/gitDiff` is rewritten. |

## Target design

- **Keep the thirteen exports** in the Public contract, with their names and
  signatures, in the same two files: `gitFilesystem.ts` and
  `gitConfigParser.ts`. Behind them, split by responsibility, within
  `src/vcs/git/`:
  - **Git directory resolution:** the `.git` entry, the gitfile, the common
    dir, and the per-start-path memo with its clear.
  - **A ref store reader:** loose, then packed, then the common dir, with the
    symbolic chain bounded (F1). It reads through a small file-reading port, so
    the parsing can be tested without a disk.
  - **A HEAD reader** that returns an explicit union: a branch, detached at an
    id, or unreadable. Unreadable never becomes `''` (F4).
  - **Pure validation:** the ref-name rule, extended by F3, and the id rule.
  - **A pure config parser** from text to a lookup, and a thin reader of the
    file. It should follow git's grammar for everything git accepts (F6 to
    F10), keep the differences in section 6, and stay lenient on the rest.
    Write it from the grammar in section 6, not as a port.
  - **The cached repository state:**
    - One entry per git directory, resolved from `getCwd()` at each call
      (F2). Keep the map small and bounded, because sub-agents under
      `runWithCwdOverride` can alternate between worktrees.
    - Each entry holds the four lazily computed values, the three watched
      paths, and the re-arming of the branch ref after a switch.
    - The watching goes through an injected watch or stat dependency (a
      `…Deps` parameter, `.claudin/rules/code-design.md`).
    - The polling interval stays at 10 ms under `NODE_ENV=test` and one second
      otherwise.
    - Watching stops at graceful shutdown through `registerCleanup()`.
- **Keep `findGitRoot`** from `src/vcs/git/git.ts` for the upward walk, and
  `waitForScrollIdle()` before re-arming a watch after a `HEAD` change.
- **Types.** Explicit throughout, with no `any`. The object id stays a
  `string` at the boundary, since callers take it as one.
- **Room for reftable** (F3). The ref store sits behind one interface, so that
  a later fallback that runs `git` can take over when
  `extensions.refStorage = reftable`.
