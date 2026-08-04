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
} from './__fixtures__/fakeGh.js'
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
} from './__fixtures__/repo.js'
import { diagnose, diagnoseGitFailure } from './errors.js'

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

  test('rebase with a dirty tree', () => {
    const repo = conflictingBranches()
    writeRepoFile(repo.path, repo.conflictPath, 'dirty\n')
    const line = diagnoseReal(repo.path, ['rebase', repo.feature])
    expect(line).toContain('needs a clean tree')
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

describe('gh', () => {
  function runFakeGh(args: string[], rule: FakeGhRule): string {
    const fake = installFakeGh([rule], { fallback: rule })
    try {
      const res = Bun.spawnSync(['gh', ...args], { env: fake.env })
      return `${res.stdout.toString()}${res.stderr.toString()}`
    } finally {
      fake.cleanup()
    }
  }

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
