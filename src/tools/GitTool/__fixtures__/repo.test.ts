/**
 * The fixtures assert their own claims. A fixture that lies — a "mid-rebase"
 * repo that is not actually mid-rebase, a "non-fast-forward" remote that
 * accepts the push — produces a green test that guards nothing, which is the
 * exact failure mode the Git tool's error-path suite is meant to catch.
 */
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  cleanupAllRepos,
  conflictingBranches,
  detachedHeadRepo,
  dirtyRepo,
  emptyRepo,
  git,
  gitTry,
  midMergeRepo,
  midRebaseRepo,
  repoBehindOrigin,
  repoWithCommits,
  repoWithFailingPreCommitHook,
  repoWithOrigin,
  repoWithUnreachableOrigin,
  stagedRepo,
  untrackedRepo,
  writeRepoFile,
} from 'src/tools/GitTool/__fixtures__/repo.js'
import {
  cleanupAllFakeGh,
  GH_NOT_AUTHENTICATED,
  GH_RATE_LIMITED,
  ghPrListRule,
  ghPrViewRule,
  ghRunViewLogRule,
  installFakeGh,
} from 'src/tools/GitTool/__fixtures__/fakeGh.js'

const NO_COMMITS_RE = /does not have any commits yet|unknown revision/i
const CONFLICT_RE = /CONFLICT|Automatic merge failed|could not apply/i
const REJECTED_RE = /rejected|non-fast-forward|fetch first/i
const UNREACHABLE_RE = /does not appear to be a git repository|not found|Could not read/i

afterAll(() => {
  cleanupAllRepos()
  cleanupAllFakeGh()
})

describe('repo fixtures', () => {
  test('emptyRepo has a git dir and no commits', () => {
    const root = emptyRepo()
    expect(existsSync(join(root, '.git'))).toBe(true)
    const head = gitTry(root, ['rev-parse', 'HEAD'])
    expect(head.code).not.toBe(0)
    const log = gitTry(root, ['log'])
    expect(log.code).not.toBe(0)
    expect(log.stderr).toMatch(NO_COMMITS_RE)
  })

  test('repoWithCommits(n) really has n commits on main', () => {
    const root = repoWithCommits(4)
    expect(git(root, ['rev-list', '--count', 'HEAD']).trim()).toBe('4')
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
    // A diff between commits must have hunks to summarize.
    expect(git(root, ['diff', 'HEAD~1', 'HEAD'])).toContain('src/app.ts')
  })

  test('dirtyRepo has an unstaged modification', () => {
    const status = git(dirtyRepo(), ['status', '--porcelain'])
    expect(status).toContain(' M src/app.ts')
  })

  test('stagedRepo has a staged modification', () => {
    const root = stagedRepo()
    expect(git(root, ['status', '--porcelain'])).toContain('M  src/app.ts')
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('src/app.ts')
  })

  test('untrackedRepo has an untracked file', () => {
    expect(git(untrackedRepo(), ['status', '--porcelain'])).toContain('?? scratch/')
  })

  test('repoWithFailingPreCommitHook rejects a commit', () => {
    const run = gitTry(repoWithFailingPreCommitHook(), ['commit', '-m', 'blocked'])
    expect(run.code).not.toBe(0)
    expect(`${run.stdout}${run.stderr}`).toContain('pre-commit says no')
  })

  test('conflictingBranches conflicts on merge', () => {
    const repo = conflictingBranches()
    expect(git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(repo.base)
    const merge = gitTry(repo.path, ['merge', repo.feature])
    expect(merge.code).not.toBe(0)
    expect(`${merge.stdout}${merge.stderr}`).toMatch(CONFLICT_RE)
  })

  test('midMergeRepo is left mid-merge', () => {
    const repo = midMergeRepo()
    expect(existsSync(join(repo.path, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(git(repo.path, ['status'])).toContain('You have unmerged paths')
  })

  test('midRebaseRepo is left mid-rebase and --abort recovers', () => {
    const repo = midRebaseRepo()
    const inProgress =
      existsSync(join(repo.path, '.git', 'rebase-merge')) ||
      existsSync(join(repo.path, '.git', 'rebase-apply'))
    expect(inProgress).toBe(true)
    expect(gitTry(repo.path, ['rebase', '--abort']).code).toBe(0)
    expect(git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(repo.base)
  })

  test('detachedHeadRepo has no symbolic HEAD', () => {
    const root = detachedHeadRepo()
    expect(gitTry(root, ['symbolic-ref', '-q', 'HEAD']).code).not.toBe(0)
    expect(git(root, ['status'])).toContain('HEAD detached')
  })
})

describe('remote fixtures (local bare origin, no network)', () => {
  test('repoWithOrigin is in sync and can push again', () => {
    const { path, remote } = repoWithOrigin()
    expect(git(path, ['ls-remote', 'origin'])).toContain('refs/heads/main')
    expect(existsSync(join(remote, 'HEAD'))).toBe(true)
    const push = gitTry(path, ['push', 'origin', 'main'])
    expect(push.code).toBe(0)
    expect(gitTry(path, ['fetch', 'origin']).code).toBe(0)
  }, 20_000)

  test('repoBehindOrigin has its push rejected non-fast-forward', () => {
    const { path } = repoBehindOrigin()
    const push = gitTry(path, ['push', 'origin', 'main'])
    expect(push.code).not.toBe(0)
    expect(`${push.stdout}${push.stderr}`).toMatch(REJECTED_RE)
    // …and the divergence is real, so `pull` has something to reconcile.
    expect(gitTry(path, ['fetch', 'origin']).code).toBe(0)
    expect(git(path, ['rev-list', '--count', 'HEAD..origin/main']).trim()).not.toBe('0')
  }, 20_000)

  test('repoWithUnreachableOrigin fails to fetch', () => {
    const { path } = repoWithUnreachableOrigin()
    const fetch = gitTry(path, ['fetch', 'origin'])
    expect(fetch.code).not.toBe(0)
    expect(`${fetch.stdout}${fetch.stderr}`).toMatch(UNREACHABLE_RE)
  }, 20_000)

  test('a fixture repo is isolated from this checkout', () => {
    const root = repoWithCommits(1)
    writeRepoFile(root, 'src/app.ts', 'export const version = -1\n')
    // The fixture lives under the OS temp dir, not inside the project.
    expect(root.startsWith(process.cwd())).toBe(false)
  })
})

/** Runs a command through `sh -c` so PATH resolution is exercised, as the tool does. */
function sh(command: string, env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('fakeGh', () => {
  test('resolves through PATH and replays the matching rule', () => {
    const fake = installFakeGh([
      ghPrViewRule({ number: 12, title: 'A PR', state: 'OPEN' }),
      ghPrListRule([{ number: 12 }, { number: 13 }]),
    ])
    const view = sh('gh pr view 12 --json number,title,state', fake.env)
    expect(view.code).toBe(0)
    expect(JSON.parse(view.stdout)).toEqual({ number: 12, title: 'A PR', state: 'OPEN' })

    const list = sh('gh pr list --json number', fake.env)
    expect(list.code).toBe(0)
    expect(JSON.parse(list.stdout)).toHaveLength(2)

    // The argv is recorded, which is how "the tool appended --json" gets proven.
    const calls = fake.invocations()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['pr', 'view', '12', '--json', 'number,title,state'])
  })

  test('an unmatched invocation fails loudly with the argv', () => {
    const fake = installFakeGh([ghPrViewRule({ number: 1 })])
    const run = sh('gh issue list', fake.env)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('no rule matched: issue list')
  })

  test('canned auth and rate-limit failures carry gh exit codes', () => {
    const authFake = installFakeGh([], { fallback: GH_NOT_AUTHENTICATED })
    const auth = sh('gh pr view 1', authFake.env)
    expect(auth.code).toBe(4)
    expect(auth.stderr).toContain('gh auth login')
    expect(auth.stderr).not.toContain('no rule matched')

    const limitFake = installFakeGh([{ ...GH_RATE_LIMITED, match: 'api' }])
    const limited = sh('gh api repos/o/r', limitFake.env)
    expect(limited.code).toBe(1)
    expect(limited.stderr).toContain('API rate limit exceeded')
  })

  test('setRules swaps behaviour without reinstalling', () => {
    const fake = installFakeGh([ghRunViewLogRule('line one\nline two')])
    expect(sh('gh run view 7 --log', fake.env).stdout).toContain('line two')
    fake.setRules([ghRunViewLogRule('replaced')])
    expect(sh('gh run view 7 --log', fake.env).stdout.trim()).toBe('replaced')
    fake.clearInvocations()
    expect(fake.invocations()).toHaveLength(0)
  })

  test('regex rules match on the joined argv', () => {
    const fake = installFakeGh([
      { match: '^pr checks \\d+$', regex: true, stdout: 'all green\n', exitCode: 0 },
    ])
    expect(sh('gh pr checks 42', fake.env).stdout.trim()).toBe('all green')
    expect(sh('gh pr checks', fake.env).code).toBe(1)
  })
})
