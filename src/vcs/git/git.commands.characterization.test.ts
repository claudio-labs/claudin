// Characterization of the git.ts commands that spawn git, written for the
// clean-base rewrite (docs/tech/rewrite/vcs/git.md). Three working directories
// are in play and the suite keeps them apart on purpose: an explicit `cwd`
// argument, the session cwd (`getCwd()`, set here with runWithCwdOverride), and
// the process working directory (`process.chdir`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  findRemoteBase,
  getAheadBehind,
  getBranch,
  getFileStatus,
  getIsClean,
  getIsHeadOnRemote,
  getWorktreeCount,
  stashToCleanState,
} from 'src/vcs/git/git.js'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Command Fixture',
  GIT_AUTHOR_EMAIL: 'commands@fixture.invalid',
  GIT_COMMITTER_NAME: 'Command Fixture',
  GIT_COMMITTER_EMAIL: 'commands@fixture.invalid',
}
const LEAKY_GIT_VARIABLES = [
  'XDG_CONFIG_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]

const madeDirs: string[] = []
const originalEnv: Record<string, string | undefined> = {}
let launchDir = ''

function tempDir(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `char-gitcmd-${tag}-`)))
  madeDirs.push(dir)
  return dir
}

function assignEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in originalEnv)) originalEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeAll(() => {
  launchDir = process.cwd()
  const home = tempDir('home')
  assignEnv(Object.fromEntries(LEAKY_GIT_VARIABLES.map(key => [key, undefined])))
  assignEnv({
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    CLAUDIN_CONFIG_DIR: join(home, '.claudin'),
    ...IDENTITY,
  })
})

afterAll(() => {
  process.chdir(launchDir)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

function run(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (out.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

function repoAt(dir: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true })
  run(dir, 'init', '--quiet', `--initial-branch=${branch}`)
  return dir
}

function save(repo: string, file: string, body: string): void {
  writeFileSync(join(repo, file), body)
  run(repo, 'add', '--', file)
  run(repo, 'commit', '--quiet', '-m', `save ${file}`)
}

/** A clone whose main branch tracks a local bare origin. */
function trackedClone(tag: string): { base: string; origin: string; work: string } {
  const base = tempDir(tag)
  const origin = join(base, 'origin.git')
  run(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  const work = repoAt(join(base, 'work'))
  save(work, 'seed.txt', 'seed\n')
  run(work, 'remote', 'add', 'origin', origin)
  run(work, 'push', '--quiet', '-u', 'origin', 'main')
  return { base, origin, work }
}

/** Runs `action` with the process working directory at `dir`, then puts it back. */
async function fromProcessDir<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await action()
  } finally {
    process.chdir(previous)
  }
}

describe('getBranch with an explicit directory', () => {
  test('asks git there: the branch name, HEAD when detached, an empty string otherwise', async () => {
    const base = tempDir('branch')
    const repo = repoAt(join(base, 'repo'), 'trunk')
    save(repo, 'a.txt', 'a')
    run(repo, 'checkout', '--quiet', '-b', 'feature/login')
    mkdirSync(join(repo, 'pkg'))
    expect(await getBranch(repo)).toBe('feature/login')
    expect(await getBranch(join(repo, 'pkg'))).toBe('feature/login')
    run(repo, 'checkout', '--quiet', '--detach')
    expect(await getBranch(repo)).toBe('HEAD')
    const unborn = repoAt(join(base, 'unborn'), 'fresh')
    expect(await getBranch(unborn)).toBe('')
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await getBranch(plain)).toBe('')
    expect(await getBranch(join(base, 'missing'))).toBe('')
  })
})

describe('getAheadBehind', () => {
  test('counts commits on each side of the upstream, in the given directory', async () => {
    const { base, origin, work } = trackedClone('ab')
    save(work, 'local-1.txt', '1')
    save(work, 'local-2.txt', '2')
    const peer = join(base, 'peer')
    run(base, 'clone', '--quiet', origin, peer)
    save(peer, 'remote-1.txt', 'r')
    run(peer, 'push', '--quiet', 'origin', 'main')
    run(work, 'fetch', '--quiet', 'origin')
    expect(await getAheadBehind(work)).toEqual({ ahead: 2, behind: 1 })
  })

  test('without a directory it reads the session cwd, not the process directory', async () => {
    const { work } = trackedClone('ab-session')
    save(work, 'ahead.txt', 'x')
    const elsewhere = repoAt(join(tempDir('ab-elsewhere'), 'r'))
    const counts = await fromProcessDir(elsewhere, () => runWithCwdOverride(work, () => getAheadBehind()))
    expect(counts).toEqual({ ahead: 1, behind: 0 })
  })

  test('zeros when there is no upstream or no repository', async () => {
    const lone = repoAt(join(tempDir('ab-none'), 'r'))
    save(lone, 'a.txt', 'a')
    expect(await getAheadBehind(lone)).toEqual({ ahead: 0, behind: 0 })
    expect(await getAheadBehind(tempDir('ab-plain'))).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('getIsHeadOnRemote', () => {
  test('only asks whether the session branch has an upstream, even when it is ahead of it', async () => {
    const { work } = trackedClone('upstream')
    save(work, 'unpushed.txt', 'u')
    expect(await runWithCwdOverride(work, () => getIsHeadOnRemote())).toBe(true)
    run(work, 'checkout', '--quiet', '-b', 'local-only')
    expect(await runWithCwdOverride(work, () => getIsHeadOnRemote())).toBe(false)
    expect(await runWithCwdOverride(tempDir('upstream-none'), () => getIsHeadOnRemote())).toBe(false)
  })
})

describe('getIsClean (process working directory)', () => {
  test('clean only when git status reports nothing; untracked files count unless told otherwise', async () => {
    const repo = repoAt(join(tempDir('clean'), 'r'))
    save(repo, 'a.txt', 'a')
    expect(await fromProcessDir(repo, () => getIsClean())).toBe(true)
    writeFileSync(join(repo, 'stray.txt'), 's')
    expect(await fromProcessDir(repo, () => getIsClean())).toBe(false)
    expect(await fromProcessDir(repo, () => getIsClean({ ignoreUntracked: true }))).toBe(true)
    writeFileSync(join(repo, 'a.txt'), 'changed')
    expect(await fromProcessDir(repo, () => getIsClean({ ignoreUntracked: true }))).toBe(false)
  })

  test('the session cwd does not matter, and outside a repository the answer is clean (kept for parity)', async () => {
    const clean = repoAt(join(tempDir('clean-proc'), 'r'))
    save(clean, 'a.txt', 'a')
    const dirty = repoAt(join(tempDir('clean-dirty'), 'r'))
    writeFileSync(join(dirty, 'untracked.txt'), 'u')
    expect(await fromProcessDir(clean, () => runWithCwdOverride(dirty, () => getIsClean()))).toBe(true)
    expect(await fromProcessDir(tempDir('clean-none'), () => getIsClean())).toBe(true)
  })
})

describe('getFileStatus', () => {
  test('splits changes into tracked and untracked entries, paths relative to the repository root', async () => {
    const repo = repoAt(join(tempDir('status'), 'r'))
    mkdirSync(join(repo, 'src'))
    save(repo, 'keep.txt', 'k')
    save(repo, 'gone.txt', 'g')
    save(repo, 'old-name.txt', 'o')
    save(repo, 'src/edit.ts', 'e')
    writeFileSync(join(repo, 'src', 'edit.ts'), 'edited')
    writeFileSync(join(repo, 'staged.txt'), 's')
    run(repo, 'add', 'staged.txt')
    rmSync(join(repo, 'gone.txt'))
    run(repo, 'mv', 'old-name.txt', 'new-name.txt')
    writeFileSync(join(repo, 'loose.txt'), 'l')
    mkdirSync(join(repo, 'fresh-dir'))
    writeFileSync(join(repo, 'fresh-dir', 'inside.txt'), 'i')
    const status = await getFileStatus(join(repo, 'src'))
    expect([...status.untracked].sort()).toEqual(['fresh-dir/', 'loose.txt'])
    expect(status.tracked).toHaveLength(4)
    expect(status.tracked).toEqual(expect.arrayContaining(['src/edit.ts', 'staged.txt', 'gone.txt']))
  })

  test('without a directory it reads the process directory; nothing to report or no repository gives empty lists', async () => {
    const repo = repoAt(join(tempDir('status-proc'), 'r'))
    save(repo, 'a.txt', 'a')
    writeFileSync(join(repo, 'a.txt'), 'b')
    const other = repoAt(join(tempDir('status-other'), 'r'))
    writeFileSync(join(other, 'noise.txt'), 'n')
    const status = await fromProcessDir(repo, () => runWithCwdOverride(other, () => getFileStatus()))
    expect(status).toEqual({ tracked: ['a.txt'], untracked: [] })
    const quiet = repoAt(join(tempDir('status-quiet'), 'r'))
    save(quiet, 'a.txt', 'a')
    expect(await getFileStatus(quiet)).toEqual({ tracked: [], untracked: [] })
    expect(await getFileStatus(tempDir('status-none'))).toEqual({ tracked: [], untracked: [] })
  })
})

describe('stashToCleanState (process working directory)', () => {
  test('stashes tracked edits and untracked files under the given message, leaving a clean tree', async () => {
    const repo = repoAt(join(tempDir('stash'), 'r'))
    save(repo, 'a.txt', 'original\n')
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    writeFileSync(join(repo, 'notes.txt'), 'draft\n')
    const other = repoAt(join(tempDir('stash-other'), 'r'))
    writeFileSync(join(other, 'untouched.txt'), 'u')
    const ok = await fromProcessDir(repo, () => runWithCwdOverride(other, () => stashToCleanState('before teleport')))
    expect(ok).toBe(true)
    expect(run(repo, 'status', '--porcelain')).toBe('')
    expect(run(repo, 'stash', 'list')).toContain('before teleport')
    expect(run(other, 'status', '--porcelain')).toBe('?? untouched.txt')
    run(repo, 'stash', 'pop', '--quiet')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('draft\n')
  })

  test('the default message names the product and carries an ISO timestamp', async () => {
    const repo = repoAt(join(tempDir('stash-default'), 'r'))
    save(repo, 'a.txt', 'a')
    writeFileSync(join(repo, 'a.txt'), 'b')
    expect(await fromProcessDir(repo, () => stashToCleanState())).toBe(true)
    expect(run(repo, 'stash', 'list')).toMatch(
      /Claudin auto-stash - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    )
  })

  test('a clean tree succeeds without creating a stash; outside a repository it fails', async () => {
    const repo = repoAt(join(tempDir('stash-clean'), 'r'))
    save(repo, 'a.txt', 'a')
    expect(await fromProcessDir(repo, () => stashToCleanState('noop'))).toBe(true)
    expect(run(repo, 'stash', 'list')).toBe('')
    expect(await fromProcessDir(tempDir('stash-none'), () => stashToCleanState('x'))).toBe(false)
  })
})

describe('findRemoteBase (process working directory)', () => {
  test('the upstream of the current branch wins', async () => {
    const { work } = trackedClone('base-up')
    run(work, 'checkout', '--quiet', '-b', 'topic')
    run(work, 'push', '--quiet', '-u', 'origin', 'topic')
    expect(await fromProcessDir(work, () => findRemoteBase())).toBe('origin/topic')
  })

  test('without an upstream: the first of origin/main, origin/staging, origin/master that exists', async () => {
    const repo = repoAt(join(tempDir('base-fallback'), 'r'))
    save(repo, 'a.txt', 'a')
    const head = run(repo, 'rev-parse', 'HEAD')
    const ask = (): Promise<string | null> => fromProcessDir(repo, () => findRemoteBase())
    expect(await ask()).toBeNull()
    run(repo, 'update-ref', 'refs/remotes/origin/master', head)
    expect(await ask()).toBe('origin/master')
    run(repo, 'update-ref', 'refs/remotes/origin/staging', head)
    expect(await ask()).toBe('origin/staging')
    run(repo, 'update-ref', 'refs/remotes/origin/main', head)
    expect(await ask()).toBe('origin/main')
  })

  test("the remote's own default branch is not what decides", async () => {
    const { work, origin } = trackedClone('base-head')
    run(work, 'push', '--quiet', 'origin', 'main:develop', 'main:master')
    run(origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop')
    run(work, 'push', '--quiet', 'origin', '--delete', 'main')
    run(work, 'fetch', '--quiet', '--prune', 'origin')
    run(work, 'branch', '--quiet', '--unset-upstream')
    expect(run(work, 'ls-remote', '--symref', 'origin', 'HEAD')).toContain('refs/heads/develop')
    expect(await fromProcessDir(work, () => findRemoteBase())).toBe('origin/master')
  })

  test('the session cwd does not matter, and outside a repository there is no base', async () => {
    const { work } = trackedClone('base-session')
    const lone = repoAt(join(tempDir('base-lone'), 'r'))
    save(lone, 'a.txt', 'a')
    expect(await fromProcessDir(lone, () => runWithCwdOverride(work, () => findRemoteBase()))).toBeNull()
    expect(await fromProcessDir(tempDir('base-none'), () => findRemoteBase())).toBeNull()
  })
})

describe('getWorktreeCount (session cwd)', () => {
  test('the main working tree plus every registered linked worktree, seen from any of them', async () => {
    const base = tempDir('count')
    const main = repoAt(join(base, 'main'))
    save(main, 'a.txt', 'a')
    const count = (dir: string): Promise<number> => runWithCwdOverride(dir, () => getWorktreeCount())
    expect(await count(main)).toBe(1)
    run(main, 'worktree', 'add', '--quiet', '-b', 'one', join(base, 'one'))
    run(main, 'worktree', 'add', '--quiet', '-b', 'two', join(base, 'two'))
    expect(await count(main)).toBe(3)
    expect(await count(join(base, 'two'))).toBe(3)
  })

  test('a worktree whose directory is gone counts until it is pruned; outside a repository the count is zero', async () => {
    const base = tempDir('count-stale')
    const main = repoAt(join(base, 'main'))
    save(main, 'a.txt', 'a')
    run(main, 'worktree', 'add', '--quiet', '-b', 'doomed', join(base, 'doomed'))
    rmSync(join(base, 'doomed'), { recursive: true, force: true })
    const count = (): Promise<number> => runWithCwdOverride(main, () => getWorktreeCount())
    expect(await count()).toBe(2)
    run(main, 'worktree', 'prune')
    expect(await count()).toBe(1)
    expect(await runWithCwdOverride(tempDir('count-none'), () => getWorktreeCount())).toBe(0)
  })
})
