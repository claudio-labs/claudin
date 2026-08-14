import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/utils/fs/cwd.js'
import { invalidateSessionEnvCache } from 'src/services/session/sessionEnvironment.js'
import {
  cleanupAllFakeGh,
  GH_NOT_AUTHENTICATED,
  GH_RATE_LIMITED,
  ghPrListRule,
  ghPrViewRule,
  installFakeGh,
} from './__fixtures__/fakeGh.js'
import {
  cleanupAllRepos,
  conflictingBranches,
  detachedHeadRepo,
  git,
  gitTry,
  repoBehindOrigin,
  repoWithCommits,
  repoWithFailingPreCommitHook,
  repoWithOrigin,
  repoWithUnreachableOrigin,
  stagedRepo,
  writeRepoFile,
} from './__fixtures__/repo.js'
import { formatGitBatchResult, runGitBatch } from './run.js'
import type { GitBatchResult } from './types.js'

/**
 * End-to-end, one family at a time: real temporary repositories, the real
 * executor, and assertions on `formatGitBatchResult` — the exact text a model
 * would receive. That is what makes this suite different from its siblings:
 * `grammar.test.ts` owns the classification, `errors.test.ts` owns the
 * diagnosis regexes, and this file owns the whole pipe with all of them wired
 * together.
 *
 * Every repository lives in the OS temp dir. A test that runs git against the
 * real checkout is a bug in the test.
 */

const scratchDirs: string[] = []

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `claudin-git-e2e-${label}-`))
  scratchDirs.push(dir)
  return dir
}

/**
 * The fake `gh` is installed ONCE, at module load, and re-aimed per test with
 * `setRules`.
 *
 * Getting it onto the child's PATH takes more than setting `process.env.PATH`,
 * and the reason is worth recording. The bash provider writes an environment
 * snapshot on the process's FIRST `exec()`, and every command afterwards runs
 * `source <snapshot> && …`, which re-exports the PATH captured at that moment.
 * Under `bun test` that first exec usually belongs to a different test file, so
 * a PATH set here never reaches the child — measured: the fake recorded zero
 * invocations while a stale directory answered the call.
 *
 * `CLAUDE_ENV_FILE` is the lever that works, and it is a production mechanism
 * rather than a reach into internals: `getSessionEnvironmentScript()` sources
 * it AFTER the snapshot (`bashProvider.ts:157-169`), which is exactly what it
 * exists for — persisting a venv activation across commands.
 */
const originalPath = process.env.PATH
const originalEnvFile = process.env.CLAUDE_ENV_FILE
const fakeGh = installFakeGh()
const ghEnvFile = join(fakeGh.binDir, 'env.sh')
writeFileSync(ghEnvFile, `export PATH="${fakeGh.binDir}:$PATH"\n`)
process.env.PATH = fakeGh.path
process.env.CLAUDE_ENV_FILE = ghEnvFile
invalidateSessionEnvCache()

afterAll(() => {
  process.env.PATH = originalPath
  // Leaving CLAUDE_ENV_FILE set would prepend this directory to every shell
  // command in every later test file of the same process.
  if (originalEnvFile === undefined) delete process.env.CLAUDE_ENV_FILE
  else process.env.CLAUDE_ENV_FILE = originalEnvFile
  invalidateSessionEnvCache()
  cleanupAllFakeGh()
  cleanupAllRepos()
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir === undefined) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The tool runs a bare `git`, so it picks up whatever identity the machine has
 * configured — including a `commit.gpgsign` that would make every fixture
 * commit fail. Pin both in the repo's own config, which beats the global one.
 */
function pinCommitIdentity(root: string): void {
  git(root, ['config', 'user.name', 'Git Tool Fixture'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
}

type Ran = {
  result: GitBatchResult
  /** What the model sees. */
  text: string
  codes: number[]
}

/**
 * Drive the real executor with `pwd()` pointing at `cwd`.
 *
 * `exec()` resolves the working directory from `pwd()`
 * (`src/utils/proc/Shell.ts:221`), never from an argument, so this override is the
 * ONLY supported way to aim the tool at a fixture — and it is the same
 * mechanism a worktree-isolated sub-agent uses.
 */
async function runIn(cwd: string, commands: string[]): Promise<Ran> {
  const result = await runWithCwdOverride(cwd, () =>
    runGitBatch({
      commands,
      abortSignal: new AbortController().signal,
      timeoutMs: 20_000,
    }),
  )
  return {
    result,
    text: formatGitBatchResult(result),
    codes: result.outcomes.map(o => o.exitCode),
  }
}

describe('add / commit', () => {
  test('stages and commits', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)
    writeRepoFile(root, 'src/app.ts', 'export const version = 500\n')

    const ran = await runIn(root, ['git add src/app.ts', 'git commit -m "bump"'])

    expect(ran.codes).toEqual([0, 0])
    expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('bump')
  })

  test('nothing to commit is diagnosed, not just echoed', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)

    const ran = await runIn(root, ['git commit -m "nothing"'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('Nothing to commit')
    // The raw text survives underneath the diagnosis.
    expect(ran.text).toContain('nothing to commit')
  })

  test('a rejecting pre-commit hook is named as a hook', async () => {
    const root = repoWithFailingPreCommitHook()
    pinCommitIdentity(root)

    const ran = await runIn(root, ['git commit -m "blocked"'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('git hook')
    expect(ran.text).toContain('pre-commit says no')
  })
})

describe('branch / tag / stash', () => {
  test('lists, creates and deletes a branch', async () => {
    const root = repoWithCommits()

    const created = await runIn(root, ['git branch spike', 'git branch --list'])
    expect(created.codes).toEqual([0, 0])
    expect(created.text).toContain('spike')

    const deleted = await runIn(root, ['git branch -d spike'])
    expect(deleted.codes).toEqual([0])
    expect(git(root, ['branch', '--list'])).not.toContain('spike')
  })

  test('creates and lists a tag', async () => {
    const root = repoWithCommits()

    const ran = await runIn(root, ['git tag v9.9.9', 'git tag --list'])

    expect(ran.codes).toEqual([0, 0])
    expect(ran.text).toContain('v9.9.9')
  })

  test('refuses to delete an unmerged branch', async () => {
    const { path } = conflictingBranches()

    const ran = await runIn(path, ['git branch -d feature'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('refused to delete that branch')
  })

  test('stash push then list', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)
    writeRepoFile(root, 'src/app.ts', 'export const version = 77\n')

    const ran = await runIn(root, ['git stash push -m wip', 'git stash list'])

    expect(ran.codes).toEqual([0, 0])
    expect(ran.text).toContain('wip')
  })

  test('a conflicting `stash pop` reports the conflict', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)
    writeRepoFile(root, 'src/app.ts', 'export const version = 111\n')
    git(root, ['stash', 'push', '-m', 'wip'])
    writeRepoFile(root, 'src/app.ts', 'export const version = 222\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'diverge'])

    const ran = await runIn(root, ['git stash pop'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text.toLowerCase()).toContain('conflict')
  })
})

describe('checkout / switch / restore', () => {
  test('switches branches', async () => {
    const { path, feature } = conflictingBranches()

    const ran = await runIn(path, [`git switch ${feature}`, 'git branch --show-current'])

    expect(ran.codes).toEqual([0, 0])
    expect(ran.text).toContain(feature)
  })

  test('refuses when local changes would be overwritten', async () => {
    const { path, feature, conflictPath } = conflictingBranches()
    writeRepoFile(path, conflictPath, 'uncommitted local edit\n')

    const ran = await runIn(path, [`git checkout ${feature}`])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('would be overwritten')
    expect(ran.text).toContain('nothing was changed')
  })

  test('restore brings a modified file back', async () => {
    const root = repoWithCommits()
    writeRepoFile(root, 'src/app.ts', 'export const version = -1\n')

    const ran = await runIn(root, ['git restore src/app.ts', 'git status --short'])

    expect(ran.codes).toEqual([0, 0])
    expect(ran.result.outcomes[1]?.output.trim()).toBe('')
  })

  test('a detached HEAD is reported as such', async () => {
    const root = detachedHeadRepo()

    const ran = await runIn(root, ['git status'])

    expect(ran.codes).toEqual([0])
    // The Bash output filter rewrites a bare `git status` to
    // `--porcelain --branch`, so the detached state arrives in porcelain form.
    expect(ran.text).toContain('## HEAD (no branch)')
  })

  test('a detached HEAD blocks `git pull` with an explanation', async () => {
    const { path } = repoWithOrigin()
    git(path, ['checkout', '-q', '--detach', 'HEAD'])

    const ran = await runIn(path, ['git pull'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('HEAD is detached')
  })
})

describe('merge / rebase / cherry-pick / revert', () => {
  test('a clean merge succeeds', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)
    git(root, ['checkout', '-q', '-b', 'side'])
    writeRepoFile(root, 'side.txt', 'side\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'side commit'])
    git(root, ['checkout', '-q', 'main'])

    const ran = await runIn(root, ['git merge side'])

    expect(ran.codes).toEqual([0])
    expect(git(root, ['log', '-1', '--pretty=%s']).trim()).toBe('side commit')
  })

  test('a conflicting merge names the conflicted path and how to get out', async () => {
    const { path, feature, conflictPath } = conflictingBranches()
    pinCommitIdentity(path)

    const ran = await runIn(path, [`git merge ${feature}`])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain(conflictPath)
    expect(ran.text).toContain('--abort')
  })

  test('a second rebase while one is in progress says so', async () => {
    const { path, feature } = conflictingBranches()
    pinCommitIdentity(path)
    // Leave a rebase unfinished, then try again — the real "already in
    // progress" path, driven through the tool both times.
    const first = await runIn(path, [`git rebase ${feature}`])
    expect(first.codes[0]).not.toBe(0)

    const second = await runIn(path, [`git rebase ${feature}`])

    expect(second.codes[0]).not.toBe(0)
    expect(second.text).toContain('already in progress')

    const aborted = await runIn(path, ['git rebase --abort'])
    expect(aborted.codes).toEqual([0])
    expect(gitTry(path, ['status']).stdout).not.toContain('rebase in progress')
  })

  test('a conflicting cherry-pick is diagnosed', async () => {
    const { path, feature } = conflictingBranches()
    pinCommitIdentity(path)

    const ran = await runIn(path, [`git cherry-pick ${feature}`])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text.toLowerCase()).toContain('conflict')
  })

  test('a clean revert succeeds', async () => {
    const root = repoWithCommits(3)
    pinCommitIdentity(root)

    const ran = await runIn(root, ['git revert --no-edit HEAD'])

    expect(ran.codes).toEqual([0])
    expect(git(root, ['log', '-1', '--pretty=%s'])).toContain('Revert')
  })
})

describe('fetch / pull / push against a local bare origin', () => {
  test('fetch and push both work for real', async () => {
    const { path } = repoWithOrigin()
    pinCommitIdentity(path)
    writeRepoFile(path, 'src/app.ts', 'export const version = 3000\n')
    git(path, ['add', '-A'])
    git(path, ['commit', '-q', '-m', 'push me'])

    const ran = await runIn(path, ['git fetch', 'git push'])

    expect(ran.codes).toEqual([0, 0])
  })

  test('pull with nothing new is a clean no-op', async () => {
    const { path } = repoWithOrigin()
    pinCommitIdentity(path)

    const ran = await runIn(path, ['git pull'])

    expect(ran.codes).toEqual([0])
    expect(ran.text).toContain('already up to date')
  })

  test('a rejected push explains that the remote moved on', async () => {
    const { path } = repoBehindOrigin()

    const ran = await runIn(path, ['git push'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('fetch')
    expect(ran.text).toContain('[rejected]')
  })

  test('an unreachable remote is named as unreachable', async () => {
    const { path } = repoWithUnreachableOrigin()

    const ran = await runIn(path, ['git fetch origin'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('remote could not be reached')
  })
})

describe('worktree', () => {
  test('add, list and remove', async () => {
    const root = repoWithCommits()
    const wt = join(scratch('wt'), 'linked')

    const added = await runIn(root, [`git worktree add ${wt} -b linked`])
    expect(added.codes).toEqual([0])

    const listed = await runIn(root, ['git worktree list'])
    expect(listed.text).toContain(wt)

    const removed = await runIn(root, [`git worktree remove ${wt}`])
    expect(removed.codes).toEqual([0])
    expect(git(root, ['worktree', 'list'])).not.toContain(wt)
  })
})

describe('gh, against a fake on PATH', () => {
  test('a PR view and list come back through the tool', async () => {
    const root = repoWithCommits()
    fakeGh.setRules([
      ghPrViewRule({ number: 7, title: 'Add the Git tool', state: 'OPEN' }),
      ghPrListRule([{ number: 7, title: 'Add the Git tool' }]),
    ])
    fakeGh.clearInvocations()

    const ran = await runIn(root, ['gh pr view 7', 'gh pr list'])

    expect(ran.codes).toEqual([0, 0])
    expect(ran.text).toContain('Add the Git tool')
    // Proof the fake really served both, rather than a real gh answering —
    // and that the existing Bash output filter's rewrite still applies, which
    // is why `gh pr list` arrives asking for specific JSON fields.
    const invoked = fakeGh.invocations()
    expect(invoked[0]).toEqual(['pr', 'view', '7'])
    expect(invoked[1]?.slice(0, 3)).toEqual(['pr', 'list', '--json'])
  })

  test('an unauthenticated gh is named, and the batch stops there', async () => {
    const root = repoWithCommits()
    fakeGh.setRules([{ ...GH_NOT_AUTHENTICATED, match: 'pr' }])

    const ran = await runIn(root, ['gh pr view 7', 'gh pr list'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('not authenticated')
    expect(ran.result.notRun).toEqual(['gh pr list'])
  })

  test('a rate-limited gh is named', async () => {
    const root = repoWithCommits()
    fakeGh.setRules([{ ...GH_RATE_LIMITED, match: 'pr checks' }])

    const ran = await runIn(root, ['gh pr checks'])

    expect(ran.codes[0]).not.toBe(0)
    expect(ran.text).toContain('rate-limited')
  })
})

describe('batches', () => {
  test('status + diff + log come back as one framed result', async () => {
    const root = repoWithCommits()
    writeRepoFile(root, 'src/app.ts', 'export const version = 4242\n')

    const ran = await runIn(root, ['git status', 'git diff', 'git log -3'])

    expect(ran.codes).toEqual([0, 0, 0])
    // A batch pays for `$ command` headers; a single command does not.
    expect(ran.text).toContain('$ git status')
    expect(ran.text).toContain('$ git diff')
    expect(ran.text).toContain('$ git log -3')
    expect(ran.text).toContain('4242')
  })

  test('a single command renders bare, exactly like a Bash result', async () => {
    const root = repoWithCommits()

    const ran = await runIn(root, ['git status --short'])

    expect(ran.text).not.toContain('$ git status')
  })

  test('the second command failing leaves the third unrun and says so', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)

    const ran = await runIn(root, [
      'git status --short',
      'git commit -m "nothing staged"',
      'git log -1',
    ])

    expect(ran.result.outcomes).toHaveLength(2)
    expect(ran.result.notRun).toEqual(['git log -1'])
    expect(ran.text).toContain('Stopped because')
    expect(ran.text).toContain('git log -1')
  })
})

/**
 * Task #22. `exec()` takes its working directory from `pwd()`, so a tool that
 * reached for `process.cwd()` instead would run every command in the main
 * checkout. That is not hypothetical: `runtests-tool-shell-env-bugs.md` records
 * exactly that bug in a sibling tool, where a worktree sub-agent tested the
 * main tree. In a tool that COMMITS, the same bug commits to the wrong repo.
 */
describe('working directory', () => {
  test('commands run where pwd() points, not where the process started', async () => {
    const root = repoWithCommits()

    const ran = await runIn(root, ['git rev-parse --show-toplevel'])

    expect(ran.codes).toEqual([0])
    // macOS reports /private/var for /var, so compare the basename.
    expect(ran.text.trim().endsWith(root.split('/').pop() ?? '')).toBe(true)
    expect(ran.text).not.toContain(process.cwd())
  })

  test('a commit made in a worktree does not move the main checkout', async () => {
    const root = repoWithCommits()
    pinCommitIdentity(root)
    const wt = join(scratch('isolation'), 'linked')
    git(root, ['worktree', 'add', '-q', wt, '-b', 'isolated'])
    pinCommitIdentity(wt)
    const mainHeadBefore = git(root, ['rev-parse', 'HEAD']).trim()

    writeRepoFile(wt, 'src/app.ts', 'export const version = 909\n')
    const ran = await runIn(wt, ['git add -A', 'git commit -m "in the worktree"'])

    expect(ran.codes).toEqual([0, 0])
    expect(git(wt, ['log', '-1', '--pretty=%s']).trim()).toBe('in the worktree')
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(mainHeadBefore)
    expect(git(root, ['status', '--short']).trim()).toBe('')
  })
})
