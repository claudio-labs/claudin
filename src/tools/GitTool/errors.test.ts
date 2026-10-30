/**
 * Every case here drives a REAL failure through the fixtures and feeds git's
 * own bytes to the diagnoser. No test asserts against a string someone believed
 * git emits — that is the point: modern git rejects a stale push with
 * `(fetch first)`, not the "non-fast-forward" wording an invented regex would
 * have matched.
 *
 * `exec()` interleaves stdout and stderr onto one fd, so the tests concatenate
 * the two exactly as the tool sees them.
 */
import { chmodSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  cleanupAllFakeGh,
  GH_NOT_AUTHENTICATED,
  GH_RATE_LIMITED,
  installFakeGh,
  type FakeGhRule,
} from 'src/tools/GitTool/__fixtures__/fakeGh.js'
import {
  cleanupAllRepos,
  conflictingBranches,
  detachedHeadRepo,
  emptyRepo,
  git,
  gitTry,
  repoBehindOrigin,
  repoWithCommits,
  repoWithFailingPreCommitHook,
  repoWithOrigin,
  repoWithUnreachableOrigin,
  writeRepoFile,
} from 'src/tools/GitTool/__fixtures__/repo.js'
import { diagnose, diagnoseGitFailure, filesGitWouldOverwrite, readOnlyAnswer } from 'src/tools/GitTool/errors.js'

afterAll(() => {
  cleanupAllRepos()
  cleanupAllFakeGh()
})

/** Run git for real and hand back what the Git tool would see. */
function fail(cwd: string, args: string[]): { output: string; code: number } {
  const run = gitTry(cwd, args)
  expect(run.code).not.toBe(0)
  return { output: `${run.stdout}${run.stderr}`, code: run.code }
}

function diagnoseReal(cwd: string, args: string[]): string {
  const { output, code } = fail(cwd, args)
  const line = diagnose(`git ${args.join(' ')}`, code, output)
  expect(line).not.toBeNull()
  return line ?? ''
}

describe('repository state', () => {
  test('not a git repository', () => {
    expect(diagnoseReal(tmpdir(), ['status'])).toContain('Not inside a git repository')
  })

  test('empty repo has no history to show', () => {
    const line = diagnoseReal(emptyRepo(), ['log', '--oneline', '-10'])
    expect(line).toContain('no commits yet')
  })
})

describe('conflicts', () => {
  test('merge conflict names the file and both exits', () => {
    const repo = conflictingBranches()
    const line = diagnoseReal(repo.path, ['merge', repo.feature])
    expect(line).toContain('Merge conflict')
    expect(line).toContain(repo.conflictPath)
    expect(line).toContain('git merge --abort')
  })

  test('rebase conflict names rebase --continue, not merge', () => {
    const repo = conflictingBranches()
    const line = diagnoseReal(repo.path, ['rebase', repo.feature])
    expect(line).toContain('git rebase --continue')
    expect(line).toContain(repo.conflictPath)
  })

  test('cherry-pick conflict names cherry-pick --continue', () => {
    const repo = conflictingBranches()
    const sha = git(repo.path, ['rev-parse', repo.feature]).trim()
    const line = diagnoseReal(repo.path, ['cherry-pick', sha])
    expect(line).toContain('git cherry-pick --continue')
  })

  test('revert conflict names revert --continue', () => {
    const repo = conflictingBranches()
    const sha = git(repo.path, ['rev-parse', 'HEAD']).trim()
    git(repo.path, ['checkout', '-q', repo.feature])
    const line = diagnoseReal(repo.path, ['revert', '--no-edit', sha])
    expect(line).toContain('git revert --continue')
  })

  test('stash pop conflict says the entry was kept', () => {
    const root = repoWithCommits(2)
    writeRepoFile(root, 'src/app.ts', 'stashed\n')
    git(root, ['stash'])
    writeRepoFile(root, 'src/app.ts', 'other\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'conflicting'])
    const line = diagnoseReal(root, ['stash', 'pop'])
    expect(line).toContain('stash entry was kept')
  })

  test('the operation is read from the hint, not the command that hit it', () => {
    // A conflict raised by `git pull` belongs to the merge it ran.
    const repo = conflictingBranches()
    const { output, code } = fail(repo.path, ['rebase', repo.feature])
    expect(diagnose('git pull', code, output)).toContain('git rebase --continue')
  })
})

describe('an operation already in progress', () => {
  test('a second rebase reports the unfinished one', () => {
    const repo = conflictingBranches()
    fail(repo.path, ['rebase', repo.feature])
    const line = diagnoseReal(repo.path, ['rebase', repo.feature])
    expect(line).toContain('rebase is already in progress')
    expect(line).toContain('--abort')
  })

  test('committing mid-conflict names the unresolved files', () => {
    const repo = conflictingBranches()
    fail(repo.path, ['merge', repo.feature])
    const line = diagnoseReal(repo.path, ['commit', '-m', 'x'])
    expect(line).toContain('unresolved conflicts')
    expect(line).toContain('git add')
  })

  test('checkout mid-conflict reports the dirty index', () => {
    const repo = conflictingBranches()
    fail(repo.path, ['merge', repo.feature])
    const line = diagnoseReal(repo.path, ['checkout', repo.feature])
    expect(line).toContain('unresolved conflicts')
  })
})

describe('working tree in the way', () => {
  test('checkout that would overwrite local changes', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty local\n')
    const line = diagnoseReal(repo.path, ['checkout', repo.feature])
    expect(line).toContain('would be overwritten by checkout')
    expect(line).toContain('git stash')
  })

  test('filesGitWouldOverwrite lists the paths git names, and nothing for a refusal that names none', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty local\n')
    expect(filesGitWouldOverwrite(fail(repo.path, ['checkout', repo.feature]).output)).toEqual([repo.conflictPath])
    expect(filesGitWouldOverwrite(fail(repo.path, ['rebase', repo.feature]).output)).toBeNull()
  })

  test('rebase with a dirty tree', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty\n')
    const line = diagnoseReal(repo.path, ['rebase', repo.feature])
    expect(line).toContain('needs a clean tree')
  })

  test('a pull that rebases over unstaged changes names --autostash', () => {
    // The 2026-10-05..11 census: 7 pulls refused this way, every one over files
    // the harness itself had written, and git's text named no way forward.
    const { path } = repoWithOrigin()
    git(path, ['config', 'pull.rebase', 'true'])
    writeRepoFile(path, 'src/app.ts', 'dirty\n')
    expect(diagnoseReal(path, ['pull'])).toContain('git pull --autostash')
    // `--ff-only` does not avoid it: pull.rebase still picks the rebase.
    expect(diagnoseReal(path, ['pull', '--ff-only'])).toContain('git pull --autostash')
  })

  test('a pull that rebases over staged changes names --autostash too', () => {
    const { path } = repoWithOrigin()
    git(path, ['config', 'pull.rebase', 'true'])
    writeRepoFile(path, 'src/app.ts', 'staged\n')
    git(path, ['add', 'src/app.ts'])
    expect(diagnoseReal(path, ['pull'])).toContain('git pull --autostash')
  })

  test('a pull that would overwrite local changes names no --autostash', () => {
    // A would-overwrite refusal means the incoming commits touch the dirty
    // files, so `--autostash` would leave the tree conflicted with exit 0 and
    // the stash kept (review of fix/census-2026-10-30).
    const { path } = repoBehindOrigin()
    git(path, ['reset', '-q', '--hard', 'HEAD~1'])
    git(path, ['config', 'pull.rebase', 'false'])
    writeRepoFile(path, 'src/app.ts', 'dirty\n')
    const line = diagnoseReal(path, ['pull', '--ff-only'])
    expect(line).toContain('would be overwritten by merge')
    expect(line).toContain('git stash')
    expect(line).not.toContain('--autostash')
  })

  test('a rebase over a dirty tree names --autostash', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty\n')
    expect(diagnoseReal(repo.path, ['rebase', repo.feature])).toContain('git rebase --autostash')
  })

  test('a checkout that would overwrite names no --autostash it does not have', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty local\n')
    expect(diagnoseReal(repo.path, ['checkout', repo.feature])).not.toContain('--autostash')
  })
})

describe('remote failures', () => {
  test('push rejected because the remote moved on', () => {
    const { path } = repoBehindOrigin()
    const line = diagnoseReal(path, ['push', 'origin', 'main'])
    expect(line).toContain('the remote has commits you do not have')
    expect(line).toContain('git pull --rebase')
  })

  test('--force-with-lease refused on stale info', () => {
    const { path } = repoBehindOrigin()
    const line = diagnoseReal(path, ['push', '--force-with-lease', 'origin', 'main'])
    expect(line).toContain('stale')
  })

  test('a server-side hook declining the push', () => {
    const { path, remote } = repoWithOrigin()
    const hook = join(remote, 'hooks', 'update')
    writeFileSync(hook, '#!/bin/sh\necho "update hook says no" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    writeRepoFile(path, 'src/app.ts', 'export const version = 9\n')
    git(path, ['add', '-A'])
    git(path, ['commit', '-q', '-m', 'y'])
    const line = diagnoseReal(path, ['push', 'origin', 'main'])
    expect(line).toContain('server-side hook')
  })

  test('a local pre-push hook rejecting', () => {
    const { path } = repoWithOrigin()
    const hook = join(path, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, '#!/bin/sh\necho "pre-push says no" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    writeRepoFile(path, 'src/app.ts', 'export const version = 5\n')
    git(path, ['add', '-A'])
    git(path, ['commit', '-q', '-m', 'x'])
    const line = diagnoseReal(path, ['push', 'origin', 'main'])
    expect(line).toContain('pre-push')
  })

  test('unreachable remote', () => {
    const { path } = repoWithUnreachableOrigin()
    expect(diagnoseReal(path, ['fetch', 'origin'])).toContain('could not be reached')
  })

  test('no push destination configured', () => {
    expect(diagnoseReal(repoWithCommits(2), ['push'])).toContain('No remote is configured')
  })

  test('divergent branches with no strategy', () => {
    const { path } = repoBehindOrigin()
    expect(diagnoseReal(path, ['pull', 'origin', 'main'])).toContain('diverged')
  })

  test('detached HEAD has no branch to push', () => {
    const { path } = repoWithOrigin()
    git(path, ['checkout', '-q', '--detach', 'HEAD~1'])
    expect(diagnoseReal(path, ['push', 'origin'])).toContain('HEAD is detached')
  })

  test('detached HEAD is reported for pull too', () => {
    const { path } = repoWithOrigin()
    git(path, ['checkout', '-q', '--detach', 'HEAD~1'])
    expect(diagnoseReal(path, ['pull'])).toContain('HEAD is detached')
  })

  test('an unreachable remote outranks the detached HEAD behind it', () => {
    // git resolves the remote first, so this really is a remote failure — the
    // diagnosis must follow git, not the repo state we happen to know about.
    const root = detachedHeadRepo()
    git(root, ['remote', 'add', 'origin', tmpdir()])
    expect(diagnoseReal(root, ['pull'])).toContain('could not be reached')
  })
})

describe('commit failures', () => {
  test('nothing staged', () => {
    const root = repoWithCommits(2)
    writeRepoFile(root, 'src/app.ts', 'unstaged edit\n')
    expect(diagnoseReal(root, ['commit', '-m', 'nope'])).toContain('Nothing to commit')
  })

  test('clean tree', () => {
    expect(diagnoseReal(repoWithCommits(2), ['commit', '-m', 'nope'])).toContain(
      'Nothing to commit',
    )
  })

  test('a pre-commit hook rejecting — git itself prints nothing', () => {
    const root = repoWithFailingPreCommitHook()
    const { output, code } = fail(root, ['commit', '-m', 'blocked'])
    // The whole output is the hook's; there is no git marker to key on, which
    // is why the diagnosis is inferred from the command and worded as a guess.
    expect(output.trim()).toBe('pre-commit says no')
    const line = diagnose('git commit -m blocked', code, output)
    expect(line).toContain('most likely by a git hook')
  })
})

describe('bad arguments', () => {
  test('unknown revision', () => {
    expect(diagnoseReal(repoWithCommits(2), ['diff', 'nosuchref'])).toContain(
      'revision does not exist',
    )
  })

  test('a --format split at its space names the quoted form', () => {
    // What bash hands git for `git log -5 --format=%h %s`.
    const line = diagnoseReal(repoWithCommits(2), ['log', '-5', '--format=%h', '%s'])
    expect(line).toContain("git read `%s` as a revision")
    expect(line).toContain("`--format='%h %s'`")
    expect(
      diagnoseReal(repoWithCommits(2), ['log', '--pretty=format:%h', '%an', '%s', '-3']),
    ).toContain("`--pretty='format:%h %an %s'`")
  })

  test('the quoted form keeps every word of the split value', () => {
    const root = repoWithCommits(2)
    // git names `%s`; the bare `-` between is part of the format.
    expect(diagnoseReal(root, ['log', '--format=%h', '-', '%s'])).toContain(
      "`--format='%h - %s'`",
    )
    // git names `by`, a word with no placeholder: the `%an` after it counts.
    expect(diagnoseReal(root, ['log', '--format=%h', 'by', '%an'])).toContain(
      "`--format='%h by %an'`",
    )
    // A ref after the placeholders is not swallowed into the format.
    expect(diagnoseReal(root, ['log', '--format=%h', '%an', '%s', 'main'])).toContain(
      "`--format='%h %an %s'`",
    )
  })

  test('the split is named on the flag it happened in', () => {
    const root = repoWithCommits(2)
    expect(
      diagnoseReal(root, ['log', '--format=%h', '--date=format:%Y', '%H']),
    ).toContain("`--date='format:%Y %H'`")
    // A bare `--format` takes its value from the next argument.
    expect(diagnoseReal(root, ['log', '--format', '%h', '%s'])).toContain(
      "`--format='%h %s'`",
    )
  })

  test('a value holding an apostrophe is double-quoted', () => {
    expect(
      diagnose(
        "git log --format=%h's %s",
        128,
        "fatal: ambiguous argument '%s': unknown revision or path not in the working tree.",
      ),
    ).toContain('`--format="%h\'s %s"`')
    expect(
      diagnose(
        'git log --format=%h %s',
        128,
        "fatal: ambiguous argument '%s': unknown revision or path not in the working tree.",
      ),
    ).toContain("`--format='%h %s'`")
  })

  test('no placeholder past the flag, or a value already quoted, stays an unknown revision', () => {
    const root = repoWithCommits(2)
    expect(diagnoseReal(root, ['log', '%s'])).toContain('revision does not exist')
    // A misspelled branch after a format, and a non-format flag before a bad ref.
    expect(diagnoseReal(root, ['log', '--format=%h', 'maain'])).toContain(
      'revision does not exist',
    )
    expect(diagnoseReal(root, ['log', '--since=2.weeks', 'maain'])).toContain(
      'revision does not exist',
    )
    // Another option between the flag and the word git named: not the split.
    expect(diagnoseReal(root, ['log', '--format=%h', '--oneline', '%s'])).toContain(
      'revision does not exist',
    )
    expect(diagnoseReal(root, ['log', '--since=2.weeks', '-3', '%s'])).toContain(
      'revision does not exist',
    )
    expect(
      diagnose(
        "git log --format='%h %s' %an",
        128,
        "fatal: ambiguous argument '%an': unknown revision or path not in the working tree.",
      ),
    ).toContain('revision does not exist')
  })

  test('pathspec matching nothing', () => {
    expect(diagnoseReal(repoWithCommits(2), ['checkout', 'does-not-exist'])).toContain(
      'does-not-exist',
    )
  })

  test('branch delete refused', () => {
    expect(diagnoseReal(repoWithCommits(2), ['branch', '-d', 'main'])).toContain(
      'refused to delete',
    )
  })

  test('unknown subcommand', () => {
    expect(diagnoseReal(repoWithCommits(2), ['frobnicate'])).toContain('not a git subcommand')
  })
})

function runFakeGh(args: string[], rule: FakeGhRule): string {
  const fake = installFakeGh([rule], { fallback: rule })
  try {
    const res = Bun.spawnSync(['gh', ...args], { env: fake.env })
    return `${res.stdout.toString()}${res.stderr.toString()}`
  } finally {
    fake.cleanup()
  }
}

describe('gh', () => {
  test('not authenticated', () => {
    const output = runFakeGh(['pr', 'view', '12'], GH_NOT_AUTHENTICATED)
    expect(output).toContain('gh auth login')
    expect(diagnose('gh pr view 12', 4, output)).toContain('not authenticated')
  })

  test('rate limited', () => {
    const output = runFakeGh(['api', 'repos/x/y'], GH_RATE_LIMITED)
    expect(diagnose('gh api repos/x/y', 1, output)).toContain('rate-limited')
  })

  test('gh missing from PATH', () => {
    // The tool runs through bash, so the real text is the shell's, not Node's.
    const res = Bun.spawnSync(['bash', '-c', 'gh-definitely-not-installed pr view'])
    const output = `${res.stdout.toString()}${res.stderr.toString()}`
    expect(output).toContain('command not found')
    expect(diagnose('gh pr view', 127, output)).toContain('not installed')
  })

  test('no pull request for the branch', () => {
    const output = runFakeGh(['pr', 'view'], {
      match: '',
      stderr: 'no pull requests found for branch "feat/x"\n',
      exitCode: 1,
    })
    expect(diagnose('gh pr view', 1, output)).toContain('No pull request matches')
  })

  test('a git diagnosis never leaks into a gh command', () => {
    // `nothing to commit` is a git signature; a gh failure carrying it must not
    // be diagnosed as a commit problem.
    expect(diagnose('gh pr list', 1, 'nothing to commit, working tree clean')).toBeNull()
  })
})

describe('the fold', () => {
  test('the raw output is preserved in full, diagnosis first', () => {
    const repo = conflictingBranches()
    const { output, code } = fail(repo.path, ['merge', repo.feature])
    const folded = diagnoseGitFailure(`git merge ${repo.feature}`, code, output)
    expect(folded.endsWith(output)).toBe(true)
    expect(folded.length).toBeGreaterThan(output.length)
    expect(folded.split('\n')[0]).toContain('Merge conflict')
  })

  test('an unrecognised failure is returned untouched', () => {
    const raw = 'error: something nobody has seen before\n'
    expect(diagnoseGitFailure('git bisect run ./x', 1, raw)).toBe(raw)
  })

  test('a diagnosis with empty output stands alone', () => {
    const folded = diagnoseGitFailure('git commit -m x', 1, '   ')
    expect(folded).toContain('most likely by a git hook')
    expect(folded).not.toContain('\n\n')
  })
})

/**
 * A non-zero exit that IS the reply to a read. The 2026-10-16..19 census saw
 * four `gh pr checks` come back `is_error` for checks that failed or did not
 * exist yet — what the model asked, both times.
 */
describe('read-only answers', () => {
  const RUN = 'https://github.com/o/r/actions/runs/38076085366/job/114283200164'

  test('a failed check names the check and the command that shows its log', () => {
    // `gh pr checks` exits 1 when a check failed; the rows are tab-separated.
    const output = runFakeGh(['pr', 'checks', '4'], {
      match: '',
      stdout: `smoke-and-tests\tfail\t32s\t${RUN}\t\nlint\tpass\t9s\thttps://github.com/o/r/actions/runs/38076085366/job/2\t\n`,
      exitCode: 1,
    })
    const answer = readOnlyAnswer('gh pr checks 4', 1, output)?.text
    expect(answer).toContain('1 check failed: smoke-and-tests')
    expect(answer).toContain('`gh run view 38076085366 --log-failed`')
  })

  test('failed checks in two runs name both runs, once each', () => {
    const output =
      `a\tfail\t1s\t${RUN}\t\n` +
      'b\tfail\t1s\thttps://github.com/o/r/actions/runs/38076085366/job/3\t\n' +
      'c\tfail\t1s\thttps://github.com/o/r/actions/runs/99/job/4\t\n'
    const answer = readOnlyAnswer('gh pr checks 4', 1, output)?.text
    expect(answer).toContain('3 checks failed: a, b, c')
    expect(answer).toContain('`gh run view 38076085366 --log-failed`')
    expect(answer).toContain('`gh run view 99 --log-failed`')
    expect(answer?.match(/38076085366/g)).toHaveLength(1)
  })

  test('a failed check with no run URL still answers', () => {
    const answer = readOnlyAnswer('gh pr checks 4', 1, 'external\tfail\t0\thttps://ci.example.test/x\t\n')?.text
    expect(answer).toContain('1 check failed: external')
    expect(answer).not.toContain('gh run view')
  })

  test('no checks yet is an answer, with the reason', () => {
    const output = runFakeGh(['pr', 'checks', '5'], {
      match: '',
      stderr: "no checks reported on the 'feat/x' branch\n",
      exitCode: 1,
    })
    expect(readOnlyAnswer('gh pr checks 5', 1, output)?.text).toContain('No checks are registered for this branch yet')
  })

  test('no upstream is an answer', () => {
    const answer = readOnlyAnswer('git rev-parse --abbrev-ref @{u}', 128, "fatal: no upstream configured for branch 'feat/x'\n")
    expect(answer?.text).toContain('`feat/x` has no upstream')
  })

  test('a checks answer still stops a write behind it; no upstream does not', () => {
    // Neither is an error, but a failed or missing check is no green light for
    // the `gh pr merge` or `git push` the model queued after reading it.
    expect(readOnlyAnswer('gh pr checks 4', 1, `x\tfail\t1s\t${RUN}\t\n`)?.stopsWrites).toBe(true)
    expect(readOnlyAnswer('gh pr checks 4', 1, "no checks reported on the 'feat/x' branch\n")?.stopsWrites).toBe(true)
    expect(readOnlyAnswer('git rev-parse @{u}', 128, "fatal: no upstream configured for branch 'x'\n")?.stopsWrites).toBe(false)
  })

  test('the same text from another command, or another exit, is no answer', () => {
    const failed = `smoke-and-tests\tfail\t32s\t${RUN}\t\n`
    // Only `pr checks` exits 1 for a failed check; another command's `fail` row is not that.
    expect(readOnlyAnswer('gh run list', 1, failed)).toBeNull()
    expect(readOnlyAnswer('gh pr checks 4', 4, failed)).toBeNull()
    expect(readOnlyAnswer('gh pr checks 4', 1, 'HTTP 502: Bad Gateway\n')).toBeNull()
  })
})
