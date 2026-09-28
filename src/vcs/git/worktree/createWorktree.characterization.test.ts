/**
 * Characterization of worktree creation and removal through git, pinned for
 * the clean-base rewrite (docs/tech/rewrite/vcs/worktree.md): where a worktree
 * lands, which commit it starts from, what each wrapper returns and publishes,
 * and how removal behaves. Hook-based creation is in the `.hooks` suite, and
 * what runs after a worktree is first made is in the post-creation suite.
 *
 * Every case builds real repositories (a bare `origin` and clones of it) and
 * lets the unit run git against them, with git cut off from the machine's
 * configuration. The session working directory is set per call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import {
  commitOf,
  localBranches,
  openWorktreeLab,
  registeredWorktrees,
  type WorktreeLab,
} from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  createAgentWorktree,
  createWorktreeForSession,
  getCurrentWorktreeSession,
  parsePRReference,
  removeAgentWorktree,
} from 'src/vcs/git/worktree.js'

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

const worktreesOf = (root: string): string => join(root, '.claudin', 'worktrees')

/** Clones `origin` aside, commits, pushes the commit to `destination`. */
function pushFromAside(origin: string, destination: string): string {
  const holder = lab.git.tempDir('aside')
  lab.git.run(holder, 'clone', '-q', origin, 'work')
  const work = join(holder, 'work')
  const commit = lab.git.commit(work, `for ${destination}`)
  lab.git.run(work, 'push', '-q', 'origin', `HEAD:${destination}`)
  return commit
}

async function rejection(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a rejection')
}

describe('where a worktree lands', () => {
  test('under <root>/.claudin/worktrees, on worktree-<slug>, with nesting flattened by +', async () => {
    const { clone, base } = lab.upstream('lands')
    const made = await lab.inSession(clone, () => createAgentWorktree('team/api'))
    const path = join(worktreesOf(clone), 'team+api')
    expect(made.worktreePath).toBe(path)
    expect(made.worktreeBranch).toBe('worktree-team+api')
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, path])
    expect(lab.git.run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('worktree-team+api')
    expect(lab.git.run(path, 'rev-parse', 'HEAD')).toBe(base)
    expect(existsSync(join(path, 'notes.txt'))).toBe(true)
  })

  test('the session wrapper uses the root of the session directory, even from a subdirectory', async () => {
    const { clone } = lab.upstream('subdir')
    const inner = join(clone, 'deep', 'er')
    mkdirSync(inner, { recursive: true })
    const session = await lab.inSession(inner, () => createWorktreeForSession('s-sub', 'here'))
    expect(session.originalCwd).toBe(inner)
    expect(session.worktreePath).toBe(join(worktreesOf(clone), 'here'))
  })

  test('from inside a linked worktree, the agent wrapper goes to the main repository', async () => {
    const { clone } = lab.upstream('canon')
    const linked = join(lab.git.tempDir('linked'), 'wt')
    lab.git.run(clone, 'worktree', 'add', '-q', '-b', 'side', linked)
    const made = await lab.inSession(linked, () => createAgentWorktree('agent-a2222222'))
    expect(made.gitRoot).toBe(clone)
    expect(made.worktreePath).toBe(join(worktreesOf(clone), 'agent-a2222222'))
  })
})

describe('which commit a new worktree starts from', () => {
  test('by default, the local origin/<default branch>, without fetching', async () => {
    const { origin, clone, base } = lab.upstream('fresh')
    const moved = pushFromAside(origin, 'main')
    const unpushed = lab.git.commit(clone, 'local only')
    for (const settings of [{}, { worktree: { baseRef: 'fresh' } }]) {
      lab.writeSettings(settings)
      const slug = `fresh-${Object.keys(settings).length}`
      const made = await lab.inSession(clone, () => createAgentWorktree(slug))
      expect(made.headCommit).toBe(base)
      expect(lab.git.run(made.worktreePath, 'rev-parse', 'HEAD')).toBe(base)
    }
    expect([moved, unpushed]).not.toContain(base)
    expect(commitOf(lab.git, clone, 'refs/remotes/origin/main')).toBe(base)
  })

  test("follows the remote's default branch when it is not main", async () => {
    const seed = lab.git.repo('trunk-seed', 'trunk')
    const tip = lab.git.run(seed, 'rev-parse', 'HEAD')
    const origin = lab.git.tempDir('trunk-origin')
    lab.git.run(origin, 'init', '-q', '--bare', '-b', 'trunk')
    lab.git.run(seed, 'push', '-q', origin, 'trunk')
    const holder = lab.git.tempDir('trunk-clone')
    lab.git.run(holder, 'clone', '-q', origin, 'repo')
    const clone = join(holder, 'repo')
    lab.git.commit(clone, 'ahead of trunk')
    const made = await lab.inSession(clone, () => createAgentWorktree('on-trunk'))
    expect(made.headCommit).toBe(tip)
  })

  test('fetches origin/<default> when it is missing locally, and bases on what arrived', async () => {
    const { origin } = lab.upstream('fetch')
    const local = lab.git.repo('fetch-local')
    lab.git.run(local, 'remote', 'add', 'origin', origin)
    const remoteTip = pushFromAside(origin, 'main')
    expect(commitOf(lab.git, local, 'refs/remotes/origin/main')).toBeNull()
    const made = await lab.inSession(local, () => createAgentWorktree('fetched'))
    expect(made.headCommit).toBe(remoteTip)
    expect(commitOf(lab.git, local, 'refs/remotes/origin/main')).toBe(remoteTip)
  })

  test('falls back to the local HEAD when there is no origin to fetch from', async () => {
    const solo = lab.git.repo('solo')
    const head = lab.git.commit(solo, 'second')
    const made = await lab.inSession(solo, () => createAgentWorktree('solo-wt'))
    expect(made.headCommit).toBe(head)
  })

  test('baseRef "head" bases on the local HEAD even when origin/main differs', async () => {
    const { clone, base } = lab.upstream('head')
    lab.git.run(clone, 'switch', '-q', '-c', 'feature')
    const head = lab.git.commit(clone, 'feature work')
    lab.writeSettings({ worktree: { baseRef: 'head' } })
    const made = await lab.inSession(clone, () => createAgentWorktree('from-head'))
    expect(made.headCommit).toBe(head)
    expect(head).not.toBe(base)
  })

  test('a pull request is fetched from origin as pull/<n>/head', async () => {
    const { origin, clone } = lab.upstream('pr')
    const proposed = pushFromAside(origin, 'refs/pull/7/head')
    const session = await lab.inSession(clone, () =>
      createWorktreeForSession('s-pr', 'pr-7', undefined, { prNumber: 7 }),
    )
    expect(session.originalHeadCommit).toBe(proposed)
    expect(session.worktreeBranch).toBe('worktree-pr-7')
    expect(lab.git.run(session.worktreePath, 'rev-parse', 'HEAD')).toBe(proposed)
  })

  test('a pull request number of 0 counts as no pull request', async () => {
    const { clone, base } = lab.upstream('pr0')
    const session = await lab.inSession(clone, () =>
      createWorktreeForSession('s-pr0', 'pr-0', undefined, { prNumber: 0 }),
    )
    expect(session.originalHeadCommit).toBe(base)
  })
})

describe('fetches never wait for credentials', () => {
  function sshRecorder(): { dir: string; read(): string } {
    const dir = lab.git.tempDir('ssh')
    const script = join(dir, 'fake-ssh')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `{ printf 'prompt=%s\\n' "\${GIT_TERMINAL_PROMPT-unset}"; printf 'askpass=[%s]%s\\n' "\${GIT_ASKPASS-}" "\${GIT_ASKPASS+set}"; } > '${dir}/seen'`,
        'exit 1',
        '',
      ].join('\n'),
    )
    chmodSync(script, 0o755)
    return { dir: script, read: () => readFileSync(join(dir, 'seen'), 'utf8') }
  }

  function repoWithUnreachableOrigin(label: string, ssh: string): string {
    const repo = lab.git.repo(label)
    lab.git.run(repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/unreachable.git')
    lab.git.run(repo, 'config', 'core.sshCommand', ssh)
    lab.env.set('GIT_TERMINAL_PROMPT', '1')
    lab.env.set('GIT_ASKPASS', '/bin/true')
    return repo
  }

  test('the default-branch fetch runs with prompting switched off', async () => {
    const ssh = sshRecorder()
    const repo = repoWithUnreachableOrigin('noprompt', ssh.dir)
    const head = lab.git.run(repo, 'rev-parse', 'HEAD')
    const made = await lab.inSession(repo, () => createAgentWorktree('noprompt'))
    expect(ssh.read()).toBe('prompt=0\naskpass=[]set\n')
    expect(made.headCommit).toBe(head)
  })

  test('the pull-request fetch runs with prompting switched off', async () => {
    const ssh = sshRecorder()
    const repo = repoWithUnreachableOrigin('noprompt-pr', ssh.dir)
    await rejection(() =>
      lab.inSession(repo, () => createWorktreeForSession('s-np', 'pr-5', undefined, { prNumber: 5 })),
    )
    expect(ssh.read()).toBe('prompt=0\naskpass=[]set\n')
  })
})

describe('sparse checkout', () => {
  function layeredRepo(label: string): string {
    const repo = lab.git.repo(label)
    lab.git.put(repo, 'src/app.ts', 'app\n')
    lab.git.put(repo, 'src/lib/util.ts', 'util\n')
    lab.git.put(repo, 'docs/guide.md', 'guide\n')
    lab.git.run(repo, 'add', '.')
    lab.git.run(repo, 'commit', '-q', '-m', 'layers')
    return repo
  }

  test('sparsePaths checks out only those directories, plus the files at the top', async () => {
    const repo = layeredRepo('sparse')
    lab.writeSettings({ worktree: { sparsePaths: ['src'] } })
    const session = await lab.inSession(repo, () => createWorktreeForSession('s-sp', 'slim'))
    const tree = session.worktreePath
    expect(session.usedSparsePaths).toBe(true)
    expect(existsSync(join(tree, 'src', 'lib', 'util.ts'))).toBe(true)
    expect(existsSync(join(tree, 'notes.txt'))).toBe(true)
    expect(existsSync(join(tree, 'docs'))).toBe(false)
    expect(lab.git.run(tree, 'sparse-checkout', 'list')).toBe('src')
    expect(lab.git.run(tree, 'status', '--porcelain')).toBe('')
  })

  test('a sparse path git refuses tears the new worktree down and says why', async () => {
    const repo = layeredRepo('sparse-bad')
    lab.writeSettings({ worktree: { sparsePaths: ['src/*'] } })
    const message = await rejection(() =>
      lab.inSession(repo, () => createAgentWorktree('torn')),
    )
    expect(message).toStartWith('Failed to configure sparse-checkout: ')
    expect(message).toContain('specify directories rather than patterns')
    expect(registeredWorktrees(lab.git, repo)).toEqual([repo])
    expect(existsSync(join(worktreesOf(repo), 'torn'))).toBe(false)
  })

  test('without sparsePaths the session records usedSparsePaths false', async () => {
    const repo = layeredRepo('dense')
    lab.writeSettings({ worktree: { sparsePaths: [] } })
    const session = await lab.inSession(repo, () => createWorktreeForSession('s-dense', 'full'))
    expect(session.usedSparsePaths).toBe(false)
    expect(existsSync(join(session.worktreePath, 'docs', 'guide.md'))).toBe(true)
  })
})

describe('creation failures', () => {
  test('a leftover worktree-<slug> branch is reset to the new base', async () => {
    const { clone, base } = lab.upstream('orphan')
    lab.git.run(clone, 'branch', 'worktree-again', 'HEAD')
    lab.git.run(clone, 'switch', '-q', 'worktree-again')
    const stale = lab.git.commit(clone, 'stale branch work')
    lab.git.run(clone, 'switch', '-q', 'main')
    const made = await lab.inSession(clone, () => createAgentWorktree('again'))
    expect(made.headCommit).toBe(base)
    expect(commitOf(lab.git, clone, 'worktree-again')).toBe(base)
    expect(stale).not.toBe(base)
  })

  test('a worktree-<slug> branch checked out elsewhere fails with git\'s complaint', async () => {
    const { clone } = lab.upstream('taken')
    lab.git.run(clone, 'worktree', 'add', '-q', '-b', 'worktree-taken', join(lab.git.tempDir('other'), 'wt'))
    const message = await rejection(() => lab.inSession(clone, () => createAgentWorktree('taken')))
    expect(message).toStartWith('Failed to create worktree: ')
    expect(message).toContain('worktree-taken')
  })

  test('a directory already at the worktree path that is not a worktree fails creation', async () => {
    const { clone } = lab.upstream('occupied')
    lab.git.put(join(worktreesOf(clone), 'occupied'), 'leftover.txt', 'x\n')
    const message = await rejection(() => lab.inSession(clone, () => createAgentWorktree('occupied')))
    expect(message).toStartWith('Failed to create worktree: ')
    expect(message).toContain('already exists')
  })

  test('a repository without commits has no base to resolve', async () => {
    const empty = lab.git.tempDir('unborn')
    lab.git.run(empty, 'init', '-q', '-b', 'main')
    for (const settings of [{}, { worktree: { baseRef: 'head' } }]) {
      lab.writeSettings(settings)
      const message = await rejection(() => lab.inSession(empty, () => createAgentWorktree('nothing')))
      expect(message).toContain('"HEAD"')
      expect(message).toContain('base branch')
    }
  })

  test('a pull request that origin does not have fails, naming the number and git\'s reason', async () => {
    const { clone } = lab.upstream('nopr')
    const message = await rejection(() =>
      lab.inSession(clone, () => createWorktreeForSession('s-nopr', 'pr-9', undefined, { prNumber: 9 })),
    )
    expect(message).toStartWith('Failed to fetch PR #9: ')
    expect(message).toContain('pull/9/head')
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
  })

  test('a pull request without any origin fails the same way', async () => {
    const solo = lab.git.repo('pr-solo')
    const message = await rejection(() =>
      lab.inSession(solo, () => createWorktreeForSession('s-prs', 'pr-3', undefined, { prNumber: 3 })),
    )
    expect(message).toStartWith('Failed to fetch PR #3: ')
    expect(message).toContain("'origin'")
  })
})

describe('resuming an existing worktree', () => {
  test('the agent wrapper hands back the worktree as it is now and freshens its mtime', async () => {
    const { clone } = lab.upstream('resume')
    const first = await lab.inSession(clone, () => createAgentWorktree('again'))
    const moved = lab.git.commit(first.worktreePath, 'work in the worktree')
    const longAgo = new Date('2001-02-03T04:05:06Z')
    utimesSync(first.worktreePath, longAgo, longAgo)
    const before = Date.now()
    const second = await lab.inSession(clone, () => createAgentWorktree('again'))
    expect(second).toEqual({ ...first, headCommit: moved })
    expect(statSync(first.worktreePath).mtimeMs).toBeGreaterThanOrEqual(before - 2_000)
  })

  test('the session wrapper reports no creation time and the current HEAD', async () => {
    const { clone, base } = lab.upstream('resume-s')
    const first = await lab.inSession(clone, () => createWorktreeForSession('s-r1', 'again'))
    expect(first.creationDurationMs).toBeNumber()
    expect(first.creationDurationMs).toBeGreaterThanOrEqual(0)
    expect(first.originalHeadCommit).toBe(base)
    const moved = lab.git.commit(first.worktreePath, 'work')
    const second = await lab.inSession(clone, () => createWorktreeForSession('s-r2', 'again'))
    expect(second.worktreePath).toBe(first.worktreePath)
    expect(second.creationDurationMs).toBeUndefined()
    expect(second.originalHeadCommit).toBe(moved)
    expect(second.sessionId).toBe('s-r2')
  })

  test('a worktree removed through git is created afresh', async () => {
    const { clone } = lab.upstream('recreate')
    const first = await lab.inSession(clone, () => createAgentWorktree('recreate'))
    lab.git.run(clone, 'worktree', 'remove', '--force', first.worktreePath)
    const second = await lab.inSession(clone, () => createAgentWorktree('recreate'))
    expect(second.worktreePath).toBe(first.worktreePath)
    expect(existsSync(join(second.worktreePath, '.git'))).toBe(true)
  })

  test('a worktree whose directory was deleted without pruning cannot be created again', async () => {
    const { clone } = lab.upstream('gone')
    const first = await lab.inSession(clone, () => createAgentWorktree('gone'))
    rmSync(first.worktreePath, { recursive: true, force: true })
    const message = await rejection(() => lab.inSession(clone, () => createAgentWorktree('gone')))
    expect(message).toStartWith('Failed to create worktree: ')
    expect(message).toContain(first.worktreePath)
  })
})

describe('createWorktreeForSession', () => {
  test('returns and publishes the session, and leaves the process where it was', async () => {
    const { clone, base } = lab.upstream('publish')
    const processDir = process.cwd()
    const session = await lab.inSession(clone, () =>
      createWorktreeForSession('s-pub', 'feat/one', 'publish_worktree-feat+one'),
    )
    expect(session).toEqual({
      originalCwd: clone,
      worktreePath: join(worktreesOf(clone), 'feat+one'),
      worktreeName: 'feat/one',
      worktreeBranch: 'worktree-feat+one',
      originalBranch: 'main',
      originalHeadCommit: base,
      sessionId: 's-pub',
      tmuxSessionName: 'publish_worktree-feat+one',
      creationDurationMs: session.creationDurationMs,
      usedSparsePaths: false,
    })
    expect(getCurrentWorktreeSession()).toBe(session)
    expect(process.cwd()).toBe(processDir)
    expect(lab.inSession(clone, () => session.originalCwd)).toBe(clone)
  })

  test('records the branch the session directory was on, or HEAD when detached', async () => {
    // One repository per state: the branch comes from a cache that notices a
    // switch by polling, and that timing is vcs/gitFilesystem's to pin.
    const cases: Array<[string, string[], string]> = [
      ['topic', ['switch', '-q', '-c', 'topic'], 'topic'],
      ['detached', ['switch', '-q', '--detach', 'HEAD'], 'HEAD'],
    ]
    for (const [label, move, expected] of cases) {
      const { clone } = lab.upstream(`branch-${label}`)
      lab.git.run(clone, ...move)
      const session = await lab.inSession(clone, () => createWorktreeForSession(`s-${label}`, label))
      expect(session.originalBranch).toBe(expected)
    }
  })

  test('an invalid slug is refused before anything is created or published', async () => {
    const { clone } = lab.upstream('refuse')
    const message = await rejection(() =>
      lab.inSession(clone, () => createWorktreeForSession('s-bad', '../escape')),
    )
    expect(message).toContain('"../escape"')
    expect(existsSync(join(clone, '.claudin'))).toBe(false)
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('outside a git repository with no hook it refuses, pointing at hooks', async () => {
    const message = await rejection(() =>
      lab.inSession(lab.anchor, () => createWorktreeForSession('s-nogit', 'x')),
    )
    for (const fact of ['not in a git repository', 'WorktreeCreate', 'settings.json']) {
      expect(message).toContain(fact)
    }
    expect(getCurrentWorktreeSession()).toBeNull()
  })
})

describe('createAgentWorktree', () => {
  test('returns path, branch, base and root, and publishes nothing', async () => {
    const { clone, base } = lab.upstream('agent')
    const processDir = process.cwd()
    const made = await lab.inSession(clone, () => createAgentWorktree('agent-a3333333'))
    expect(made).toEqual({
      worktreePath: join(worktreesOf(clone), 'agent-a3333333'),
      worktreeBranch: 'worktree-agent-a3333333',
      headCommit: base,
      gitRoot: clone,
    })
    expect(getCurrentWorktreeSession()).toBeNull()
    expect(process.cwd()).toBe(processDir)
  })

  test('an invalid slug is refused before anything is created', async () => {
    const { clone } = lab.upstream('agent-bad')
    const message = await rejection(() => lab.inSession(clone, () => createAgentWorktree('a b')))
    expect(message).toContain('"a b"')
    expect(existsSync(join(clone, '.claudin'))).toBe(false)
  })

  test('outside a git repository with no hook, the refusal carries the text AgentTool matches', async () => {
    const message = await rejection(() => lab.inSession(lab.anchor, () => createAgentWorktree('x')))
    expect(message).toContain('Cannot create agent worktree: not in a git repository')
    expect(message).toContain('WorktreeCreate')
  })
})

describe('removeAgentWorktree through git', () => {
  test('removes a dirty worktree and deletes its branch', async () => {
    const { clone } = lab.upstream('rm')
    const made = await lab.inSession(clone, () => createAgentWorktree('rm-me'))
    writeFileSync(join(made.worktreePath, 'notes.txt'), 'edited\n')
    writeFileSync(join(made.worktreePath, 'untracked.txt'), 'new\n')
    const done = await removeAgentWorktree(made.worktreePath, made.worktreeBranch, made.gitRoot)
    expect(done).toBe(true)
    expect(existsSync(made.worktreePath)).toBe(false)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(localBranches(lab.git, clone)).toEqual(['main'])
  })

  test('without a branch it keeps the branch', async () => {
    const { clone } = lab.upstream('rm-keep')
    const made = await lab.inSession(clone, () => createAgentWorktree('keep-branch'))
    expect(await removeAgentWorktree(made.worktreePath, undefined, made.gitRoot)).toBe(true)
    expect(localBranches(lab.git, clone)).toEqual(['main', 'worktree-keep-branch'])
  })

  test('a branch that cannot be deleted does not turn the removal into a failure', async () => {
    const { clone } = lab.upstream('rm-nobranch')
    const made = await lab.inSession(clone, () => createAgentWorktree('ghost'))
    expect(await removeAgentWorktree(made.worktreePath, 'no-such-branch', made.gitRoot)).toBe(true)
    expect(existsSync(made.worktreePath)).toBe(false)
  })

  test('a path that is not a worktree is left alone and reported as not removed', async () => {
    const { clone } = lab.upstream('rm-plain')
    const plain = join(worktreesOf(clone), 'plain')
    lab.git.put(plain, 'file.txt', 'x\n')
    expect(await removeAgentWorktree(plain, 'main', clone)).toBe(false)
    expect(existsSync(join(plain, 'file.txt'))).toBe(true)
    expect(localBranches(lab.git, clone)).toEqual(['main'])
  })

  test('without a git root nothing is removed', async () => {
    const { clone } = lab.upstream('rm-noroot')
    const made = await lab.inSession(clone, () => createAgentWorktree('rooted'))
    expect(await removeAgentWorktree(made.worktreePath, made.worktreeBranch)).toBe(false)
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, made.worktreePath])
  })
})

describe('parsePRReference', () => {
  const numbers: Array<[string, number]> = [
    ['#1', 1],
    ['#0', 0],
    ['#007', 7],
    ['#123456', 123456],
    ['https://github.com/acme/widgets/pull/42', 42],
    ['http://github.com/acme/widgets/pull/8', 8],
    ['https://git.example.org/acme/widgets/pull/15', 15],
    ['https://git.example.org:8443/acme/widgets/pull/16', 16],
    ['HTTPS://GITHUB.COM/ACME/WIDGETS/PULL/17', 17],
    ['https://github.com/acme/widgets/pull/18/', 18],
    ['https://github.com/acme/widgets/pull/19?diff=split', 19],
    ['https://github.com/acme/widgets/pull/20#discussion_r1', 20],
    ['https://github.com/acme/widgets/pull/21/?x=1#y', 21],
  ]
  for (const [input, expected] of numbers) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(parsePRReference(input)).toBe(expected)
    })
  }

  const notReferences = [
    '',
    '42',
    '#',
    '# 4',
    ' #4',
    '#4 ',
    '#-4',
    '#4.5',
    '#4a',
    'x#4',
    'pr-4',
    'pull/4',
    'https://github.com/acme/widgets/pull/four',
    'https://bitbucket.org/acme/widgets/pull-requests/4',
    'ftp://github.com/acme/widgets/pull/4',
    'https://github.com/acme/pull/4',
    'https://github.com/acme/widgets/extra/pull/4',
    'https://github.com//widgets/pull/4',
    'https://github.com/acme/widgets/pull/',
    'https://github.com/acme/widgets/pull/4x',
    'https://github.com/acme/widgets/pull/4/files',
    'https://github.com/acme/widgets/pulls/4',
    'https://github.com/acme/widgets/issues/4',
    'https://gitlab.com/acme/widgets/-/merge_requests/4',
    'ssh://github.com/acme/widgets/pull/4',
    'github.com/acme/widgets/pull/4',
  ]
  for (const input of notReferences) {
    test(`${JSON.stringify(input)} is not a reference`, () => {
      expect(parsePRReference(input)).toBeNull()
    })
  }
})
