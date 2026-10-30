/**
 * Error-path diagnosis.
 *
 * A failing git/gh command is verbose and the useful part is three lines. This
 * module prepends ONE line naming what went wrong and the next command to run,
 * then the raw text unchanged — it never replaces or truncates it, because
 * truncating an error is how a model loops.
 *
 * Errors are deliberately NOT budgeted and NOT delta'd; `run.ts` routes a
 * non-zero exit here instead of through the summarizer.
 *
 * Every pattern below was taken from real output captured by driving the
 * fixtures in `__fixtures__/repo.ts` (see `errors.test.ts`, which re-runs those
 * commands rather than asserting against remembered strings). That matters:
 * modern git rejects a stale push with `! [rejected] … (fetch first)`, not the
 * "non-fast-forward" wording an invented regex would have looked for.
 *
 * In-progress state (rule 4 of the plan) is read out of the command's own
 * output, not from the filesystem. `isInTransientGitState`
 * (`src/vcs/git/gitDiff.ts:379`) answers a related question but is async and
 * returns a bare boolean, and this function is synchronous and receives no cwd
 * — so the two cannot share an implementation. Git's own text is also strictly
 * more informative: it names WHICH operation is unfinished.
 */

import { ghCommandPair } from 'src/tools/GitTool/grammar.js'

/** Show at most this many conflicted paths before collapsing the rest. */
const MAX_LISTED_PATHS = 10

/**
 * SIGTERM, which is how `run.ts` stops a command that reached its ceiling. It
 * arrives here only for a NON-watch command — a watch that runs out of time is
 * a stall, not a failure, and never enters the error lane.
 */
const SIGTERM_EXIT = 143

// --- repository / invocation state -----------------------------------------

const NOT_A_REPO_RE = /^fatal: not a git repository/m
const NO_COMMITS_RE = /does not have any commits yet/
const UNKNOWN_SUBCOMMAND_RE = /^git: '(.+?)' is not a git command/m
const UNKNOWN_REVISION_RE = /unknown revision or path not in the working tree/
const AMBIGUOUS_ARG_RE = /ambiguous argument '([^']*)'/
const VALUED_FLAG_RE = /^(--[\w-]+)=(.*)$/
const OPTION_RE = /^--?[A-Za-z0-9]/
const QUOTE_START_RE = /^['"]/
/** Format flags whose value may also come as the next argument. */
const BARE_FORMAT_FLAGS: ReadonlySet<string> = new Set(['--format', '--pretty'])
const BAD_PATHSPEC_RE = /^error: pathspec '(.+?)' did not match any file/m
const CANNOT_DELETE_BRANCH_RE = /^error: cannot delete branch/m
const BRANCH_NOT_MERGED_RE = /is not fully merged/

// --- an operation is already unfinished -------------------------------------

const REBASE_DIR_EXISTS_RE = /there is already a rebase-merge directory|there is already an am\/rebase-apply directory/
const UNMERGED_BLOCKS_RE = /^error: (\w+) is not possible because you have unmerged files/m
const RESOLVE_INDEX_FIRST_RE = /you need to resolve your current index first/

// --- conflicts ---------------------------------------------------------------

/** Global, for `matchAll` only — `test()` on it would carry `lastIndex`. */
const CONFLICT_LINE_RE = /^CONFLICT \([^)]*\): (.+)$/gm
const HAS_CONFLICT_RE = /^CONFLICT \([^)]*\):/m
const MERGE_CONFLICT_IN_RE = /^Merge conflict in (.+)$/
const TRAILING_COLON_RE = /:$/
const STASH_KEPT_RE = /The stash entry is kept in case you need it again/
/** The hint block names the operation that owns `--continue`. */
const CONTINUE_HINT_RE = /git (rebase|cherry-pick|revert|merge|am) --continue/

// --- working tree in the way -------------------------------------------------

const WOULD_OVERWRITE_RE =
  /^error: Your local changes to the following files would be overwritten by (\w+):/m
/** "cannot rebase: …", and the pull form "cannot pull with rebase: …", unstaged or staged. */
const UNSTAGED_BLOCKS_RE =
  /^error: cannot (pull with rebase|\w+): (?:You have unstaged changes|Your index contains uncommitted changes)/m

/** Git refused because the working tree or the index is dirty. */
export function blockedByUncommittedChanges(output: string): boolean {
  return WOULD_OVERWRITE_RE.test(output) || UNSTAGED_BLOCKS_RE.test(output)
}

/**
 * The paths a "would be overwritten" refusal lists, as git names them (from
 * the top of the repository); null for a refusal that lists none, like
 * "cannot pull with rebase: You have unstaged changes".
 */
export function filesGitWouldOverwrite(output: string): string[] | null {
  const head = WOULD_OVERWRITE_RE.exec(output)
  if (!head) return null
  const files: string[] = []
  for (const line of output.slice(head.index + head[0].length).split('\n').slice(1)) {
    if (!line.startsWith('\t')) break
    files.push(line.slice(1))
  }
  return files
}

// --- branch / remote ---------------------------------------------------------

const DETACHED_HEAD_RE = /You are not currently on a branch/
const PUSH_REJECTED_RE = /^ ! \[(?:remote )?rejected\] +(.*)$/m
const REJECT_REASON_RE = /\(([^)]+)\)\s*$/
const HOOK_DECLINED_RE = /hook declined to update/
const FAILED_TO_PUSH_RE = /^error: failed to push some refs to/m
const UNREACHABLE_REMOTE_RE = /Could not read from remote repository/
const NO_PUSH_DESTINATION_RE = /^fatal: No configured push destination/m
const DIVERGENT_BRANCHES_RE = /Need to specify how to reconcile divergent branches/

// --- commit ------------------------------------------------------------------

const NOTHING_TO_COMMIT_RE = /nothing to commit, working tree clean|nothing added to commit/
const NO_CHANGES_ADDED_RE = /^no changes added to commit/m

// --- gh ----------------------------------------------------------------------

const GH_NOT_AUTHENTICATED_RE = /gh auth login|not logged (?:in )?to any GitHub hosts/
const GH_RATE_LIMIT_RE = /API rate limit exceeded/
/** The shell's own message when `gh` is absent — `exec()` runs through bash. */
const GH_NOT_FOUND_RE = /gh[^\n]*: command not found|executable file not found/
const GH_NO_PR_RE = /no pull requests found|Could not resolve to a PullRequest/i
/** `gh pr checks` before GitHub registered any run for the branch. */
const GH_NO_CHECKS_RE = /^no checks reported on the '.+' branch/m
const NO_UPSTREAM_RE = /^fatal: no upstream configured for branch '([^']+)'/m
/** The workflow run a GitHub Actions check URL belongs to. */
const GH_ACTIONS_RUN_RE = /\/actions\/runs\/(\d+)/
/** What `gh pr checks` exits with when a check failed — and when it found none. */
const GH_CHECKS_FAILED_EXIT = 1
/** `gh` failures every later `gh` command in a batch would repeat. */
const GH_ENVIRONMENT_RES: readonly RegExp[] = [GH_NOT_AUTHENTICATED_RE, GH_RATE_LIMIT_RE, GH_NOT_FOUND_RE]

/** Global git flags that take a value, so the subcommand is not the next token. */
const GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
])

const WHITESPACE_RE = /\s+/

/**
 * The subcommand a command is really running. Kept local rather than imported
 * from `grammar.ts`: a diagnosis must never depend on the accept/refuse parse
 * succeeding, and this needs to skip `git -C <dir>` which that parse does not.
 */
function subcommandOf(command: string): string {
  const tokens = command.trim().split(WHITESPACE_RE).slice(1)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) break
    if (GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return ''
}

function isGh(command: string): boolean {
  return command.trim().startsWith('gh ')
}

/**
 * `git log -5 --format=%h %s`: unquoted, the space ends the format at `%h` and
 * git reads `%s` as a revision — "ambiguous argument '%s'". The generic
 * "revision does not exist" line got the same command resent six times by four
 * sub-agents of one session in the 2026-10-08..15 census, so this names the
 * split and writes the quoted form.
 *
 * The value runs from the nearest flag before the argument git named
 * (`--format=%h`, `--date=format:%Y`, or a bare `--format`) through the named
 * one and any placeholders after it — `%h - %s`, `%h by %an`. It must carry a
 * placeholder past the flag, so a misspelled branch after a format, or a
 * `--since=2.weeks foo`, keeps the generic line; so does a value that was
 * already quoted.
 */
function splitFormatDiagnosis(command: string, output: string): string | null {
  const named = AMBIGUOUS_ARG_RE.exec(output)?.[1]
  if (named === undefined) return null
  const tokens = command.trim().split(WHITESPACE_RE)
  const at = tokens.indexOf(named)
  if (at === -1) return null

  let start = -1
  for (let i = at - 1; i > 0 && start === -1; i--) {
    const token = tokens[i] ?? ''
    if (VALUED_FLAG_RE.test(token) || BARE_FORMAT_FLAGS.has(token)) start = i
    else if (OPTION_RE.test(token)) return null
  }
  if (start === -1) return null
  let end = at
  while (end + 1 < tokens.length) {
    const next = tokens[end + 1] ?? ''
    if (OPTION_RE.test(next) || !next.includes('%')) break
    end++
  }
  if (!tokens.slice(at, end + 1).some(token => token.includes('%'))) return null

  const valued = VALUED_FLAG_RE.exec(tokens[start] ?? '')
  const flag = valued?.[1] ?? tokens[start] ?? ''
  const value = [...(valued ? [valued[2] ?? ''] : []), ...tokens.slice(start + 1, end + 1)].join(' ')
  if (QUOTE_START_RE.test(value) || (value.includes("'") && value.includes('"'))) return null
  const quoted = value.includes("'") ? `"${value}"` : `'${value}'`
  return `The \`${flag}\` value has an unquoted space: the shell split it, and git read \`${named}\` as a revision. Quote the whole value: \`${flag}=${quoted}\`.`
}

/** The paths git named as conflicted, capped so a wide conflict stays one line. */
function conflictedPaths(output: string): string[] {
  const paths: string[] = []
  for (const match of output.matchAll(CONFLICT_LINE_RE)) {
    const rest = match[1]
    if (rest === undefined) continue
    const inMatch = MERGE_CONFLICT_IN_RE.exec(rest)
    if (inMatch?.[1]) {
      paths.push(inMatch[1])
      continue
    }
    // `CONFLICT (modify/delete): path deleted in X and modified in Y` — the
    // path leads the message.
    const first = rest.split(WHITESPACE_RE)[0]
    if (first) paths.push(first.replace(TRAILING_COLON_RE, ''))
  }
  return paths
}

function formatPaths(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const shown = paths.slice(0, MAX_LISTED_PATHS)
  const more = paths.length - shown.length
  return `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
}

/**
 * Which operation owns `--continue`. The hint block is authoritative because a
 * conflict raised by `git pull` belongs to the merge or rebase it ran, not to
 * `pull`; the command is only the fallback.
 */
function conflictedOperation(command: string, output: string): string {
  const hinted = CONTINUE_HINT_RE.exec(output)
  if (hinted?.[1]) return hinted[1]
  const sub = subcommandOf(command)
  if (sub === 'rebase' || sub === 'cherry-pick' || sub === 'revert' || sub === 'am') {
    return sub
  }
  return 'merge'
}

function conflictDiagnosis(command: string, output: string): string {
  const paths = formatPaths(conflictedPaths(output))
  const where = paths ? ` in ${paths}` : ''
  if (STASH_KEPT_RE.test(output)) {
    return `\`git stash pop\` conflicted${where}; the stash entry was kept. Resolve the files, \`git add\` them, then \`git stash drop\` when you are done.`
  }
  const op = conflictedOperation(command, output)
  if (op === 'merge') {
    return `Merge conflict${where}. Resolve the files and \`git commit\`, or \`git merge --abort\` to back out.`
  }
  return `\`git ${op}\` stopped on a conflict${where}. Resolve the files, \`git add\` them, then \`git ${op} --continue\` — or \`git ${op} --abort\` to back out.`
}

function pushDiagnosis(output: string): string | null {
  const rejected = PUSH_REJECTED_RE.exec(output)
  if (rejected) {
    const reason = REJECT_REASON_RE.exec(rejected[1] ?? '')?.[1] ?? ''
    if (HOOK_DECLINED_RE.test(output) || reason === 'hook declined') {
      return 'The remote rejected the push: a server-side hook declined it. The hook output is above; nothing was pushed.'
    }
    if (reason === 'stale info') {
      return '`--force-with-lease` refused: your view of the remote branch is stale. Run `git fetch` and check what moved before retrying.'
    }
    if (reason === 'fetch first' || reason === 'non-fast-forward') {
      return 'Push rejected: the remote has commits you do not have. Run `git pull --rebase` (or fetch and rebase) and push again — do not force unless you know what you are overwriting.'
    }
    return `Push rejected (${reason || 'see below'}). Nothing was pushed.`
  }
  if (FAILED_TO_PUSH_RE.test(output)) {
    return 'The push failed before reaching the remote — a local `pre-push` hook rejected it. Its output is above.'
  }
  return null
}

/**
 * @returns the output with a diagnosis line prepended, or the output unchanged
 * when nothing is recognised.
 */
export function diagnoseGitFailure(
  command: string,
  exitCode: number,
  output: string,
): string {
  const diagnosis = diagnose(command, exitCode, output)
  if (diagnosis === null) return output
  return output.trim() ? `${diagnosis}\n\n${output}` : diagnosis
}

/**
 * A failure about where the batch runs rather than about the command, so going
 * on would only repeat it: no repository, or `gh` signed out, throttled (each
 * repeat spends quota) or missing. A timeout counts too — not because the next
 * read would fail, but because each could cost another full timeout. "No
 * commits yet" does not: `git status` still answers there.
 */
export function isEnvironmentalFailure(command: string, exitCode: number, output: string): boolean {
  if (exitCode === SIGTERM_EXIT || NOT_A_REPO_RE.test(output)) return true
  return isGh(command) && GH_ENVIRONMENT_RES.some(re => re.test(output))
}

/** `gh pr checks` before GitHub registered any run for the branch — `run.ts` waits on it in a watch. */
export function reportsNoChecksYet(output: string): boolean {
  return GH_NO_CHECKS_RE.test(output)
}

/**
 * `git rev-parse --abbrev-ref @{u}` on a branch that was never pushed exits
 * 128, and that IS what the model asked: the pre-PR read checks tracking
 * before the first push, so every new branch "failed" it — about 8 of the 53
 * Git errors in the 2026-10-08..15 census.
 */
function noUpstreamAnswer(output: string): string | null {
  const branch = NO_UPSTREAM_RE.exec(output)?.[1]
  if (branch === undefined) return null
  return `\`${branch}\` has no upstream: it was never pushed, or was pushed without \`-u\`. \`git push -u origin ${branch}\` sets one.`
}

/**
 * `gh pr checks` exits 1 when a check failed, and when GitHub has registered
 * no check for the branch. Either is the state of CI the model asked for: the
 * 2026-10-16..19 census saw four come back `is_error`. A failed check names
 * the command that shows its log, with the run id read from the check's URL.
 */
function ghChecksAnswer(command: string, exitCode: number, output: string): string | null {
  if (exitCode !== GH_CHECKS_FAILED_EXIT || ghCommandPair(command) !== 'pr checks') return null
  if (GH_NO_CHECKS_RE.test(output)) {
    return 'No checks are registered for this branch yet. After a push they usually appear within seconds — a `--watch` waits up to 90s for them — and if they never do, no workflow runs on this branch.'
  }
  // Rows are name, state, elapsed, URL, description, tab-separated. A watch
  // prints one table per refresh, hence the sets.
  const names = new Set<string>()
  const runs = new Set<string>()
  for (const line of output.split('\n')) {
    const [name, state, , url] = line.split('\t')
    if (state !== 'fail' || !name) continue
    names.add(name)
    const run = url === undefined ? undefined : GH_ACTIONS_RUN_RE.exec(url)?.[1]
    if (run !== undefined) runs.add(run)
  }
  if (names.size === 0) return null
  const failed = `${names.size} check${names.size === 1 ? '' : 's'} failed: ${[...names].join(', ')}.`
  if (runs.size === 0) return failed
  const views = [...runs].map(run => `\`gh run view ${run} --log-failed\``).join(' and ')
  return `${failed} ${views} ${runs.size === 1 ? 'shows the failing step' : 'show the failing steps'}.`
}

/**
 * The reply a read's non-zero exit carries, when it carries one. `run.ts`
 * reports it instead of an error — for read-only commands only, since a write
 * that exits non-zero did not do its job whatever it printed.
 *
 * `stopsWrites`: whether a write queued behind it still must not run. No
 * upstream says nothing against a commit; a failed or missing check is no
 * green light, and `["gh pr checks 4", "gh pr merge 4"]` stopped at the
 * checks while their exit was an error.
 */
export type ReadOnlyAnswer = { text: string; stopsWrites: boolean }

export function readOnlyAnswer(command: string, exitCode: number, output: string): ReadOnlyAnswer | null {
  const upstream = noUpstreamAnswer(output)
  if (upstream !== null) return { text: upstream, stopsWrites: false }
  const checks = ghChecksAnswer(command, exitCode, output)
  return checks === null ? null : { text: checks, stopsWrites: true }
}

/** Exported for the tests, which assert the sentence rather than the fold. */
export function diagnose(
  command: string,
  exitCode: number,
  output: string,
): string | null {
  // First, because it explains an otherwise inexplicable result: git printed
  // nothing wrong, it simply never finished.
  if (exitCode === SIGTERM_EXIT) {
    return 'The command was still running when the timeout stopped it, so anything below is partial. Pass a larger `timeout` if it legitimately takes that long.'
  }
  if (isGh(command)) return diagnoseGh(output)

  // Repository-level failures first: they explain every later symptom.
  if (NOT_A_REPO_RE.test(output)) {
    return 'Not inside a git repository. Check the working directory, or run `git init` if this is meant to be a new repo.'
  }
  if (NO_COMMITS_RE.test(output)) {
    return 'The repository has no commits yet, so there is nothing to show. Make the first commit before reading history.'
  }

  // An unfinished operation blocks everything else, so report it before the
  // symptom the current command happened to hit.
  if (REBASE_DIR_EXISTS_RE.test(output)) {
    return 'A rebase is already in progress. Finish it with `git rebase --continue`, or `git rebase --abort` to back out, before running this.'
  }
  const blocked = UNMERGED_BLOCKS_RE.exec(output)
  if (blocked) {
    const verb = (blocked[1] ?? 'That').toLowerCase()
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} is blocked by unresolved conflicts from an earlier operation. Resolve the files, \`git add\` them, then \`--continue\` that operation (or abort it).`
  }
  if (RESOLVE_INDEX_FIRST_RE.test(output)) {
    return 'The index still holds unresolved conflicts from an earlier operation. Resolve those files and `git add` them (or abort the operation) before switching state.'
  }

  if (HAS_CONFLICT_RE.test(output)) {
    return conflictDiagnosis(command, output)
  }

  const overwrite = WOULD_OVERWRITE_RE.exec(output)
  if (overwrite) {
    // No `--autostash` here, even for a pull: this refusal means the incoming
    // commits touch the dirty files, so the stash re-applies onto what the
    // pull just changed, and a conflict there still exits 0.
    return `Uncommitted changes would be overwritten by ${overwrite[1] ?? 'this command'}. Commit them, \`git stash\` them, or discard them first — nothing was changed.`
  }
  const unstaged = UNSTAGED_BLOCKS_RE.exec(output)
  if (unstaged) {
    // A rebasing pull (pull.rebase, or `--rebase`) has a one-step way through:
    // `--autostash`. Without it the model spent 1-3 calls on a stash/fetch/merge
    // of its own.
    if (unstaged[1] === 'pull with rebase') {
      return '`git pull` is rebasing, and a rebase needs a clean tree. `git pull --autostash` stashes your changes, pulls and puts them back in one step — nothing was changed.'
    }
    if (unstaged[1] === 'rebase') {
      return '`git rebase` needs a clean tree. `git rebase --autostash` stashes your changes, rebases and puts them back in one step — nothing was changed.'
    }
    return `\`git ${unstaged[1] ?? 'rebase'}\` needs a clean tree. Commit or \`git stash\` your changes first — nothing was changed.`
  }

  if (DETACHED_HEAD_RE.test(output)) {
    return 'HEAD is detached, so there is no branch to use. Name the branch explicitly, or `git switch -c <branch>` to keep this work.'
  }
  if (DIVERGENT_BRANCHES_RE.test(output)) {
    return 'Local and remote have diverged and git will not guess. Re-run with `--rebase` or `--no-rebase`, or set `pull.rebase`.'
  }
  if (NO_PUSH_DESTINATION_RE.test(output)) {
    return 'No remote is configured to push to. Add one with `git remote add origin <url>`, or name the remote and branch explicitly.'
  }
  if (UNREACHABLE_REMOTE_RE.test(output)) {
    return 'The remote could not be reached — wrong URL, or no access. Check `git remote -v` and your credentials.'
  }
  const push = pushDiagnosis(output)
  if (push !== null) return push

  if (NOTHING_TO_COMMIT_RE.test(output) || NO_CHANGES_ADDED_RE.test(output)) {
    return 'Nothing to commit — no staged changes. Stage the files you meant to include with `git add` first.'
  }

  if (UNKNOWN_REVISION_RE.test(output)) {
    return (
      splitFormatDiagnosis(command, output) ??
      'That revision does not exist here. Check the ref with `git log --oneline -5` or `git branch -a`.'
    )
  }
  const pathspec = BAD_PATHSPEC_RE.exec(output)
  if (pathspec) {
    return `No file or ref matches \`${pathspec[1] ?? ''}\`. Check the spelling, or use \`--\` to separate paths from revisions.`
  }
  if (CANNOT_DELETE_BRANCH_RE.test(output) || BRANCH_NOT_MERGED_RE.test(output)) {
    return 'Git refused to delete that branch. The reason is below — switch off it, or use `-D` if you accept losing the unmerged commits.'
  }
  const unknown = UNKNOWN_SUBCOMMAND_RE.exec(output)
  if (unknown) {
    return `\`${unknown[1] ?? ''}\` is not a git subcommand. Check the spelling.`
  }

  // Last: a commit that failed for none of the reasons above was rejected by a
  // hook. Git prints nothing of its own in that case — the text is the hook's —
  // so this is inferred from the command, and worded as such.
  if (subcommandOf(command) === 'commit') {
    return 'The commit was rejected, most likely by a git hook — the output below is the hook\'s own. Fix what it reports, then commit again.'
  }

  return null
}

function diagnoseGh(output: string): string | null {
  if (GH_NOT_AUTHENTICATED_RE.test(output)) {
    return '`gh` is not authenticated. Run `gh auth login` (or set `GH_TOKEN`) before using the forge commands.'
  }
  if (GH_RATE_LIMIT_RE.test(output)) {
    return 'GitHub rate-limited this request. Wait for the window to reset, or authenticate to get the higher limit.'
  }
  if (GH_NO_PR_RE.test(output)) {
    return 'No pull request matches. Check the number or branch with `gh pr list`.'
  }
  if (GH_NOT_FOUND_RE.test(output)) {
    return '`gh` is not installed or not on PATH. Install the GitHub CLI, or use the git remote directly.'
  }
  if (NOT_A_REPO_RE.test(output)) {
    return 'Not inside a git repository, so `gh` cannot tell which repo you mean. Change directory, or pass `--repo owner/name`.'
  }
  return null
}
