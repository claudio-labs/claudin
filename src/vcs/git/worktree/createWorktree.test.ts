import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { spawnSync } from 'child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import * as configModule from 'src/platform/config/config.js'
import * as hooksModule from 'src/platform/lifecycleHooks/hooks.js'
import * as settingsModule from 'src/platform/settings/settings.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import * as gitModule from 'src/vcs/git/git.js'
import {
  createAgentWorktree,
  createWorktreeForSession,
  getOrCreateWorktree,
  removeAgentWorktree,
} from 'src/vcs/git/worktree/createWorktree.js'
import { _resetGitWorktreeMutationLocksForTesting } from 'src/vcs/git/worktree/mutationLock.js'
import * as postCreationSetup from 'src/vcs/git/worktree/postCreationSetup.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from 'src/vcs/git/worktree/session.js'

// Every git call here runs in a temp repo with a local bare repo as `origin`,
// so nothing reaches the network or this checkout. The boundaries that are
// process-global — settings, the hooks config, the project config file, and
// the fs-watcher cache behind getBranch()/getDefaultBranch() — are spied, so
// a case states the settings it runs under and leaves nothing behind.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function initRepo(dir: string): void {
  gitIn(dir, 'init', '-q', '-b', 'main')
  gitIn(dir, 'config', 'user.email', 't@t')
  gitIn(dir, 'config', 'user.name', 't')
  gitIn(dir, 'config', 'commit.gpgsign', 'false')
}

function commit(dir: string, file: string, content: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), content)
  gitIn(dir, 'add', '-A', '--', file)
  gitIn(dir, 'commit', '-q', '-m', `add ${file}`)
  return gitIn(dir, 'rev-parse', 'HEAD')
}

type Fixture = {
  repo: string
  origin: string
  /** main as pushed to origin */
  originSha: string
  /** local HEAD: one commit ahead of origin/main */
  localSha: string
}

/**
 * A repo whose `origin` is a local bare repo. origin/main is pushed and
 * tracked; HEAD then gains one local-only commit, so HEAD and origin/main
 * are different SHAs and a case can tell which one a worktree started from.
 */
function repoWithOrigin(opts: { trackOrigin?: boolean } = {}): Fixture {
  const origin = tempDir('claudin-wt-origin-')
  gitIn(origin, 'init', '-q', '--bare', '-b', 'main')
  const repo = tempDir('claudin-wt-repo-')
  initRepo(repo)
  const originSha = commit(repo, 'base.txt', 'base\n')
  gitIn(repo, 'remote', 'add', 'origin', origin)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  if (opts.trackOrigin === false) {
    gitIn(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
  }
  const localSha = commit(repo, 'local.txt', 'local only\n')
  return { repo, origin, originSha, localSha }
}

let settings: ReturnType<typeof settingsModule.getInitialSettings> = {}
let hasCreateHook = false
const createHookCalls: string[] = []
const removeHookCalls: string[] = []
let removeHookResult = true
const postSetupCalls: Array<[string, string]> = []
const savedProjectConfigs: unknown[] = []
const spies: Array<{ mockRestore: () => void }> = []

let prevCwd: string
let prevConfigDir: string | undefined

beforeAll(() => {
  prevCwd = getCwd()
  prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  process.env.CLAUDIN_CONFIG_DIR = tempDir('claudin-wt-config-')
})

afterAll(() => {
  setCwd(prevCwd)
  if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  settings = {}
  hasCreateHook = false
  removeHookResult = true
  createHookCalls.length = 0
  removeHookCalls.length = 0
  postSetupCalls.length = 0
  savedProjectConfigs.length = 0
  spies.push(
    spyOn(settingsModule, 'getInitialSettings').mockImplementation(() => settings),
    spyOn(hooksModule, 'hasWorktreeCreateHook').mockImplementation(() => hasCreateHook),
    spyOn(hooksModule, 'executeWorktreeCreateHook').mockImplementation(async name => {
      createHookCalls.push(name)
      return { worktreePath: `/vcs/hooked/${name}` }
    }),
    spyOn(hooksModule, 'executeWorktreeRemoveHook').mockImplementation(async path => {
      removeHookCalls.push(path)
      return removeHookResult
    }),
    spyOn(postCreationSetup, 'performPostCreationSetup').mockImplementation(
      async (repoRoot, worktreePath) => {
        postSetupCalls.push([repoRoot, worktreePath])
      },
    ),
    spyOn(configModule, 'saveCurrentProjectConfig').mockImplementation(updater => {
      savedProjectConfigs.push(
        (updater as unknown as (c: Record<string, unknown>) => Record<string, unknown>)({ kept: 1 }),
      )
    }),
    spyOn(gitModule, 'getDefaultBranch').mockImplementation(async () => 'main'),
    spyOn(gitModule, 'getBranch').mockImplementation(async () => 'main'),
  )
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  _resetGitWorktreeMutationLocksForTesting()
  restoreWorktreeSession(null)
  setCwd(prevCwd)
})

const headOf = (dir: string) => gitIn(dir, 'rev-parse', 'HEAD')
const branchOf = (dir: string) => gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

describe('getOrCreateWorktree', () => {
  test('creates <repo>/.claudin/worktrees/<slug> on branch worktree-<slug>', async () => {
    const { repo, localSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }

    const result = await getOrCreateWorktree(repo, 'feature')

    expect(result).toEqual({
      worktreePath: join(repo, '.claudin', 'worktrees', 'feature'),
      worktreeBranch: 'worktree-feature',
      headCommit: localSha,
      baseBranch: 'HEAD',
      existed: false,
    })
    expect(branchOf(result.worktreePath)).toBe('worktree-feature')
    expect(existsSync(join(result.worktreePath, 'local.txt'))).toBe(true)
  })

  test('a nested slug is flattened with + in both the path and the branch', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }

    const result = await getOrCreateWorktree(repo, 'user/feat')

    expect(result.worktreePath).toBe(join(repo, '.claudin', 'worktrees', 'user+feat'))
    expect(result.worktreeBranch).toBe('worktree-user+feat')
    expect(branchOf(result.worktreePath)).toBe('worktree-user+feat')
  })

  test('baseRef "head" branches from the local HEAD, unpushed commits included', async () => {
    const { repo, localSha, originSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }

    const result = await getOrCreateWorktree(repo, 'from-head')

    expect(localSha).not.toBe(originSha)
    expect(headOf(result.worktreePath)).toBe(localSha)
  })

  test('baseRef "fresh" uses the tracked origin/<default> without fetching', async () => {
    const { repo, origin, originSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'fresh' } }
    // A commit on origin that the local tracking ref has not seen: if the
    // create fetched, the worktree would start from it instead.
    const other = tempDir('claudin-wt-other-')
    gitIn(other, 'clone', '-q', origin, '.')
    gitIn(other, 'config', 'user.email', 't@t')
    gitIn(other, 'config', 'user.name', 't')
    gitIn(other, 'config', 'commit.gpgsign', 'false')
    commit(other, 'remote-only.txt', 'r\n')
    gitIn(other, 'push', '-q', 'origin', 'main')

    const result = await getOrCreateWorktree(repo, 'fresh-tracked')

    expect(result).toMatchObject({ baseBranch: 'origin/main', headCommit: originSha })
    expect(headOf(result.worktreePath)).toBe(originSha)
    expect(existsSync(join(result.worktreePath, 'local.txt'))).toBe(false)
  })

  test('baseRef "fresh" fetches origin/<default> when it is not tracked locally', async () => {
    const { repo, originSha } = repoWithOrigin({ trackOrigin: false })
    settings = { worktree: { baseRef: 'fresh' } }

    const result = await getOrCreateWorktree(repo, 'fresh-fetched')

    expect(result).toMatchObject({ baseBranch: 'origin/main', headCommit: originSha })
    expect(headOf(result.worktreePath)).toBe(originSha)
  })

  test('baseRef "fresh" falls back to HEAD when there is no origin to fetch', async () => {
    const repo = tempDir('claudin-wt-noorigin-')
    initRepo(repo)
    const sha = commit(repo, 'a.txt', 'a\n')
    settings = { worktree: { baseRef: 'fresh' } }

    const result = await getOrCreateWorktree(repo, 'no-origin')

    expect(result).toMatchObject({ baseBranch: 'HEAD', headCommit: sha, existed: false })
  })

  test('a PR number fetches pull/<n>/head from origin and branches from FETCH_HEAD', async () => {
    const { repo, origin } = repoWithOrigin()
    // Publish a PR head on the bare origin the way GitHub exposes it.
    const prSha = commit(repo, 'pr.txt', 'pr change\n')
    gitIn(repo, 'push', '-q', 'origin', 'HEAD:refs/pull/42/head')
    gitIn(repo, 'reset', '-q', '--hard', 'HEAD~1')
    expect(gitIn(origin, 'rev-parse', 'refs/pull/42/head')).toBe(prSha)

    const result = await getOrCreateWorktree(repo, 'pr-42', { prNumber: 42 })

    expect(result).toMatchObject({ baseBranch: 'FETCH_HEAD', headCommit: prSha })
    expect(existsSync(join(result.worktreePath, 'pr.txt'))).toBe(true)
  })

  test('a PR that origin does not have throws, naming the PR', async () => {
    const { repo } = repoWithOrigin()

    await expect(getOrCreateWorktree(repo, 'pr-404', { prNumber: 404 })).rejects.toThrow(
      'Failed to fetch PR #404:',
    )
    expect(existsSync(join(repo, '.claudin', 'worktrees', 'pr-404'))).toBe(false)
  })

  test('a PR without any origin remote throws too', async () => {
    const repo = tempDir('claudin-wt-pr-noorigin-')
    initRepo(repo)
    commit(repo, 'a.txt', 'a\n')

    await expect(getOrCreateWorktree(repo, 'pr-1', { prNumber: 1 })).rejects.toThrow(
      'Failed to fetch PR #1:',
    )
  })

  test('throws when the base cannot be resolved (a repo with no commits)', async () => {
    const repo = tempDir('claudin-wt-empty-')
    initRepo(repo)
    settings = { worktree: { baseRef: 'head' } }

    await expect(getOrCreateWorktree(repo, 'nothing')).rejects.toThrow(
      'Failed to resolve base branch "HEAD": git rev-parse failed',
    )
  })

  test('throws when git worktree add fails', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    // -B cannot reset a branch that is checked out in another worktree.
    gitIn(repo, 'checkout', '-q', '-b', 'worktree-busy')

    await expect(getOrCreateWorktree(repo, 'busy')).rejects.toThrow(
      'Failed to create worktree:',
    )
  })

  test('-B reuses an orphan branch left behind by a removed worktree dir', async () => {
    const { repo, localSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    gitIn(repo, 'branch', 'worktree-orphan', 'HEAD~1')

    const result = await getOrCreateWorktree(repo, 'orphan')

    expect(headOf(result.worktreePath)).toBe(localSha)
  })

  test('resumes an existing worktree without touching git, reporting ITS head', async () => {
    const { repo, localSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const created = await getOrCreateWorktree(repo, 'again')
    const advanced = commit(created.worktreePath, 'in-worktree.txt', 'w\n')

    // A removed origin would make any fetch fail: resume must not need one.
    gitIn(repo, 'remote', 'remove', 'origin')
    settings = { worktree: { baseRef: 'fresh' } }
    const resumed = await getOrCreateWorktree(repo, 'again')

    expect(resumed).toEqual({
      worktreePath: created.worktreePath,
      worktreeBranch: 'worktree-again',
      headCommit: advanced,
      existed: true,
    })
    expect(advanced).not.toBe(localSha)
  })

  test('two concurrent creates of one slug: one creates, the other resumes', async () => {
    const { repo, localSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }

    const results = await Promise.all([
      getOrCreateWorktree(repo, 'race'),
      getOrCreateWorktree(repo, 'race'),
    ])

    expect(results.map(r => r.existed).sort()).toEqual([false, true])
    expect(results.map(r => r.headCommit)).toEqual([localSha, localSha])
  })

  test('sparsePaths checks out only the listed directories (plus root files)', async () => {
    const repo = tempDir('claudin-wt-sparse-')
    initRepo(repo)
    commit(repo, 'src/a.ts', 'a\n')
    commit(repo, 'docs/b.md', 'b\n')
    commit(repo, 'root.txt', 'r\n')
    settings = { worktree: { baseRef: 'head', sparsePaths: ['src'] } }

    const result = await getOrCreateWorktree(repo, 'sparse')

    expect(existsSync(join(result.worktreePath, 'src', 'a.ts'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'root.txt'))).toBe(true)
    expect(existsSync(join(result.worktreePath, 'docs', 'b.md'))).toBe(false)
  })

  test('a failed sparse-checkout tears the half-made worktree down', async () => {
    const { repo } = repoWithOrigin()
    // In cone mode a pattern must be a directory; a glob is rejected.
    settings = { worktree: { baseRef: 'head', sparsePaths: ['!*bad['] } }

    const attempt = getOrCreateWorktree(repo, 'sparse-bad')

    await expect(attempt).rejects.toThrow('Failed to configure sparse-checkout:')
    expect(existsSync(join(repo, '.claudin', 'worktrees', 'sparse-bad', '.git'))).toBe(false)
    expect(gitIn(repo, 'worktree', 'list')).not.toContain('sparse-bad')
  })
})

describe('createWorktreeForSession', () => {
  test('rejects an invalid slug before creating anything', async () => {
    hasCreateHook = true
    await expect(createWorktreeForSession('s', '../escape')).rejects.toThrow(
      '".." path segments',
    )
    expect(createHookCalls).toEqual([])
  })

  test('with a WorktreeCreate hook, the hook makes the worktree and git is not used', async () => {
    const dir = tempDir('claudin-wt-nogit-')
    setCwd(dir)
    hasCreateHook = true

    const session = await createWorktreeForSession('sess-hook', 'hooked', 'tmux-1')

    expect(createHookCalls).toEqual(['hooked'])
    expect(session).toEqual({
      originalCwd: dir,
      worktreePath: '/vcs/hooked/hooked',
      worktreeName: 'hooked',
      sessionId: 'sess-hook',
      tmuxSessionName: 'tmux-1',
      hookBased: true,
    })
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(savedProjectConfigs).toEqual([{ kept: 1, activeWorktreeSession: session }])
  })

  test('without a hook and outside git it throws, saving nothing', async () => {
    setCwd(tempDir('claudin-wt-nogit-'))

    await expect(createWorktreeForSession('s', 'x')).rejects.toThrow(
      'Cannot create a worktree: not in a git repository',
    )
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(savedProjectConfigs).toEqual([])
  })

  test('creates a git worktree, runs post-creation setup, publishes and saves the session', async () => {
    const { repo, localSha } = repoWithOrigin()
    setCwd(repo)
    settings = { worktree: { baseRef: 'head' } }

    const session = await createWorktreeForSession('sess-1', 'sess-wt')

    const worktreePath = join(repo, '.claudin', 'worktrees', 'sess-wt')
    expect(session).toMatchObject({
      originalCwd: repo,
      worktreePath,
      worktreeName: 'sess-wt',
      worktreeBranch: 'worktree-sess-wt',
      originalBranch: 'main',
      originalHeadCommit: localSha,
      sessionId: 'sess-1',
      usedSparsePaths: false,
    })
    expect(typeof session.creationDurationMs).toBe('number')
    expect(session.hookBased).toBeUndefined()
    expect(postSetupCalls).toEqual([[repo, worktreePath]])
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(savedProjectConfigs).toEqual([{ kept: 1, activeWorktreeSession: session }])
  })

  test('resuming skips post-creation setup and reports no creation time', async () => {
    const { repo } = repoWithOrigin()
    setCwd(repo)
    settings = { worktree: { baseRef: 'head' } }
    await createWorktreeForSession('sess-1', 'resume-me')
    postSetupCalls.length = 0

    const session = await createWorktreeForSession('sess-2', 'resume-me')

    expect(postSetupCalls).toEqual([])
    expect(session.creationDurationMs).toBeUndefined()
    expect(session.sessionId).toBe('sess-2')
  })

  test('records that sparse paths were used', async () => {
    const { repo } = repoWithOrigin()
    setCwd(repo)
    settings = { worktree: { baseRef: 'head', sparsePaths: ['src'] } }
    commit(repo, 'src/a.ts', 'a\n')

    const session = await createWorktreeForSession('sess-1', 'sparse-sess')

    expect(session.usedSparsePaths).toBe(true)
  })
})

describe('createAgentWorktree', () => {
  test('with no baseRef setting, starts from the local HEAD, unpushed commits included', async () => {
    const { repo, localSha } = repoWithOrigin()
    setCwd(repo)

    const result = await createAgentWorktree('agent-head')

    expect(headOf(result.worktreePath)).toBe(localSha)
  })

  test('an explicit baseRef "fresh" still starts it from origin/<default>', async () => {
    const { repo, originSha } = repoWithOrigin()
    settings = { worktree: { baseRef: 'fresh' } }
    setCwd(repo)

    const result = await createAgentWorktree('agent-fresh')

    expect(headOf(result.worktreePath)).toBe(originSha)
  })

  test('rejects an invalid slug', async () => {
    await expect(createAgentWorktree('/abs')).rejects.toThrow('must be non-empty')
  })

  test('with a WorktreeCreate hook, returns the hook path and marks it hookBased', async () => {
    hasCreateHook = true
    expect(await createAgentWorktree('agent-h')).toEqual({
      worktreePath: '/vcs/hooked/agent-h',
      hookBased: true,
    })
    expect(createHookCalls).toEqual(['agent-h'])
  })

  test('without a hook and outside git it throws', async () => {
    setCwd(tempDir('claudin-wt-nogit-'))
    await expect(createAgentWorktree('agent-x')).rejects.toThrow(
      'Cannot create agent worktree: not in a git repository',
    )
  })

  test('creates a git worktree under the repo and does not publish a session', async () => {
    const { repo } = repoWithOrigin()
    setCwd(repo)

    const result = await createAgentWorktree('agent-a1')

    const worktreePath = join(repo, '.claudin', 'worktrees', 'agent-a1')
    expect(result).toMatchObject({
      worktreePath,
      worktreeBranch: 'worktree-agent-a1',
      gitRoot: repo,
    })
    expect(result.hookBased).toBeUndefined()
    expect(branchOf(worktreePath)).toBe('worktree-agent-a1')
    expect(postSetupCalls).toEqual([[repo, worktreePath]])
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(savedProjectConfigs).toEqual([])
  })

  test('from inside a session worktree, lands in the MAIN repo worktrees dir', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const outer = await getOrCreateWorktree(repo, 'outer')
    setCwd(outer.worktreePath)

    const result = await createAgentWorktree('agent-nested')

    expect(result.gitRoot).toBe(repo)
    expect(result.worktreePath).toBe(join(repo, '.claudin', 'worktrees', 'agent-nested'))
  })

  test('resuming bumps the dir mtime so the stale sweep keeps it, and skips setup', async () => {
    const { repo } = repoWithOrigin()
    setCwd(repo)
    const first = await createAgentWorktree('agent-old')
    const longAgo = new Date('2020-01-01T00:00:00Z')
    utimesSync(first.worktreePath, longAgo, longAgo)
    postSetupCalls.length = 0

    const again = await createAgentWorktree('agent-old')

    expect(again.worktreePath).toBe(first.worktreePath)
    expect(again.headCommit).toBe(headOf(first.worktreePath))
    expect(postSetupCalls).toEqual([])
    expect(statSync(first.worktreePath).mtime.getTime()).toBeGreaterThan(longAgo.getTime())
  })
})

describe('removeAgentWorktree', () => {
  test('hook-based: delegates to the WorktreeRemove hook and reports whether it ran', async () => {
    expect(await removeAgentWorktree('/vcs/hooked/a', undefined, undefined, true)).toBe(true)
    removeHookResult = false
    expect(await removeAgentWorktree('/vcs/hooked/b', undefined, undefined, true)).toBe(false)
    expect(removeHookCalls).toEqual(['/vcs/hooked/a', '/vcs/hooked/b'])
  })

  test('without a git root it refuses', async () => {
    expect(await removeAgentWorktree('/somewhere', 'worktree-x')).toBe(false)
    expect(removeHookCalls).toEqual([])
  })

  test('removes the worktree dir and deletes its branch', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const wt = await getOrCreateWorktree(repo, 'to-remove')

    expect(await removeAgentWorktree(wt.worktreePath, wt.worktreeBranch, repo)).toBe(true)

    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(gitIn(repo, 'branch', '--list', 'worktree-to-remove')).toBe('')
  })

  test('removes even a dirty worktree (--force)', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const wt = await getOrCreateWorktree(repo, 'dirty')
    writeFileSync(join(wt.worktreePath, 'base.txt'), 'edited\n')
    writeFileSync(join(wt.worktreePath, 'untracked.txt'), 'u\n')

    expect(await removeAgentWorktree(wt.worktreePath, wt.worktreeBranch, repo)).toBe(true)
    expect(existsSync(wt.worktreePath)).toBe(false)
  })

  test('without a branch name it removes the dir and keeps the branch', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const wt = await getOrCreateWorktree(repo, 'keep-branch')

    expect(await removeAgentWorktree(wt.worktreePath, undefined, repo)).toBe(true)

    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(gitIn(repo, 'branch', '--list', 'worktree-keep-branch')).toContain(
      'worktree-keep-branch',
    )
  })

  test('a path that is not a worktree fails without deleting the branch', async () => {
    const { repo } = repoWithOrigin()
    gitIn(repo, 'branch', 'worktree-ghost')

    expect(
      await removeAgentWorktree(join(repo, 'not-a-worktree'), 'worktree-ghost', repo),
    ).toBe(false)
    expect(gitIn(repo, 'branch', '--list', 'worktree-ghost')).toContain('worktree-ghost')
  })

  test('a branch that is already gone still counts as removed', async () => {
    const { repo } = repoWithOrigin()
    settings = { worktree: { baseRef: 'head' } }
    const wt = await getOrCreateWorktree(repo, 'gone-branch')

    expect(await removeAgentWorktree(wt.worktreePath, 'worktree-never-existed', repo)).toBe(
      true,
    )
    expect(existsSync(wt.worktreePath)).toBe(false)
  })
})
