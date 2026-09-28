/**
 * Characterization of the cached getters of src/vcs/git/gitFilesystem.ts:
 * getCachedBranch, getCachedHead, getCachedRemoteUrl, getCachedDefaultBranch.
 *
 * Each value is compared with git's own answer for the same repository. Then
 * the repository is changed, and the test waits for the cache to notice (it
 * polls the files it watches every 10 ms under NODE_ENV=test), or checks that
 * it did not.
 *
 * Why the tests are split this way. The getters share one watcher per
 * process, and the implementation this suite was written against ties it to
 * the repository of the first call for good.
 * - The first describe follows one linked worktree through a series of
 *   changes with the normally imported module, whose lines are the ones
 *   coverage counts. If an earlier suite of the same `bun test` process has
 *   already tied that instance to another repository, these tests fall back
 *   to a private copy: a query string makes Bun evaluate the module again,
 *   with a watcher of its own. Only then, because a second instance of a file
 *   corrupts Bun's coverage report for it.
 * - The second describe needs a new repository per test, so each test reads
 *   the getters in a fresh Bun process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { markScrollActivity } from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import * as sharedModule from 'src/vcs/git/gitFilesystem.js'

type CachedGetters = Pick<
  typeof sharedModule,
  'getCachedBranch' | 'getCachedHead' | 'getCachedRemoteUrl' | 'getCachedDefaultBranch'
>

type Reading = {
  branch: string
  head: string
  remoteUrl: string | null
  defaultBranch: string
}

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

async function privateGetters(): Promise<CachedGetters> {
  const copy: CachedGetters = await import(`src/vcs/git/gitFilesystem.js?cache-char=${Date.now()}`)
  return copy
}

/** Runs in a fresh Bun process: reads the four getters from inside a directory. */
const READER_SOURCE = `
const [modulePath, cwdModulePath, directory, rounds] = process.argv.slice(2)
const getters = await import(modulePath)
const { runWithCwdOverride } = await import(cwdModulePath)
const readOnce = () =>
  runWithCwdOverride(directory, async () => {
    const [branch, head, remoteUrl, defaultBranch] = await Promise.all([
      getters.getCachedBranch(),
      getters.getCachedHead(),
      getters.getCachedRemoteUrl(),
      getters.getCachedDefaultBranch(),
    ])
    return { branch, head, remoteUrl, defaultBranch }
  })
const readings = await Promise.all(Array.from({ length: Number(rounds) }, readOnce))
process.stdout.write('\\nREADINGS ' + JSON.stringify(readings) + '\\n')
process.exit(0)
`

let readerFile = ''

/** The getters' answers inside `directory`, from a process that never saw another repository. */
function readInFreshProcess(directory: string, rounds = 1): Reading[] {
  readerFile ||= scratch.put(scratch.tempDir('reader'), 'read-getters.mjs', READER_SOURCE)
  const child = Bun.spawnSync(
    [
      process.execPath,
      `--preload=${Bun.resolveSync('src/stubs/test-preload.ts', import.meta.dir)}`,
      readerFile,
      Bun.resolveSync('src/vcs/git/gitFilesystem.js', import.meta.dir),
      Bun.resolveSync('src/shared/fs/cwd.js', import.meta.dir),
      directory,
      String(rounds),
    ],
    { env: { ...process.env, NODE_ENV: 'test' }, stdin: 'ignore' },
  )
  const line = child.stdout
    .toString()
    .split('\n')
    .find(text => text.startsWith('READINGS '))
  if (child.exitCode !== 0 || line === undefined) {
    throw new Error(`reader process failed (exit ${child.exitCode}):\n${child.stderr.toString()}`)
  }
  return JSON.parse(line.slice('READINGS '.length)) as Reading[]
}

function readOnceInFreshProcess(directory: string): Reading {
  return readInFreshProcess(directory)[0]!
}

/** All four values, asked at once, from inside `cwd`. */
function readAll(getters: CachedGetters, cwd: string): Promise<Reading> {
  return runWithCwdOverride(cwd, async () => {
    const [branch, head, remoteUrl, defaultBranch] = await Promise.all([
      getters.getCachedBranch(),
      getters.getCachedHead(),
      getters.getCachedRemoteUrl(),
      getters.getCachedDefaultBranch(),
    ])
    return { branch, head, remoteUrl, defaultBranch }
  })
}

/** Reads until `settled` holds or `withinMs` runs out; returns the last reading. */
async function readUntil(
  getters: CachedGetters,
  cwd: string,
  settled: (reading: Reading) => boolean,
  withinMs = 3000,
): Promise<Reading> {
  const deadline = Date.now() + withinMs
  let reading = await readAll(getters, cwd)
  while (!settled(reading) && Date.now() < deadline) {
    await Bun.sleep(5)
    reading = await readAll(getters, cwd)
  }
  return reading
}

/** What git says about the directory, in the getters' terms. */
function gitReading(cwd: string): Reading {
  const originHead = scratch.attempt(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return {
    branch: scratch.run(cwd, 'branch', '--show-current') || 'HEAD',
    head: scratch.run(cwd, 'rev-parse', 'HEAD'),
    remoteUrl: scratch.attempt(cwd, 'config', '--get', 'remote.origin.url').stdout || null,
    defaultBranch: originHead.ok ? originHead.stdout.replace(/^origin\//, '') : 'main',
  }
}

describe('one watched linked worktree, followed through a series of changes', () => {
  let main = ''
  let worktree = ''
  let firstTip = ''
  let getters: CachedGetters = sharedModule
  let touches = 0

  const read = (settled: (reading: Reading) => boolean, withinMs?: number) =>
    readUntil(getters, worktree, settled, withinMs)

  /** A config write: one of the three things the cache watches. */
  const touchConfig = () => {
    touches += 1
    scratch.run(main, 'config', 'char.touch', String(touches))
  }

  /**
   * The shared instance is used when it follows this worktree: two branch
   * switches in a row must each be noticed.
   */
  async function gettersFollowing(): Promise<CachedGetters> {
    await readAll(sharedModule, worktree)
    for (const trial of ['trial/one', 'trial/two']) {
      scratch.run(worktree, 'checkout', '-q', '-b', trial)
      const seen = await readUntil(sharedModule, worktree, r => r.branch === trial, 1500)
      if (seen.branch !== trial) {
        scratch.run(worktree, 'checkout', '-q', 'wt/one')
        return privateGetters()
      }
    }
    scratch.run(worktree, 'checkout', '-q', 'wt/one')
    return sharedModule
  }

  beforeAll(async () => {
    main = scratch.repo('watched')
    firstTip = scratch.run(main, 'rev-parse', 'HEAD')
    scratch.run(main, 'remote', 'add', 'origin', 'https://example.com/first.git')
    for (const name of ['trunk', 'master']) {
      scratch.run(main, 'update-ref', `refs/remotes/origin/${name}`, firstTip)
    }
    scratch.run(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    worktree = join(scratch.tempDir('watched-linked'), 'wt')
    scratch.run(main, 'worktree', 'add', '-q', '-b', 'wt/one', worktree)
    getters = await gettersFollowing()
  })

  test('in a linked worktree the four values are what git reports', async () => {
    const reading = await read(r => r.branch === 'wt/one')
    expect(reading).toEqual(gitReading(worktree))
    expect(reading).toEqual({
      branch: 'wt/one',
      head: firstTip,
      remoteUrl: 'https://example.com/first.git',
      defaultBranch: 'trunk',
    })
  })

  test('a commit on the current branch is noticed', async () => {
    const tip = scratch.commit(worktree, 'first change')
    expect((await read(r => r.head === tip)).head).toBe(tip)
  })

  test('a branch switch is noticed, and so are commits on the new branch', async () => {
    scratch.run(worktree, 'checkout', '-q', '-b', 'wt/two')
    expect((await read(r => r.branch === 'wt/two')).branch).toBe('wt/two')
    await Bun.sleep(50) // the watch on the new branch's ref is armed just after the switch is seen
    const tip = scratch.commit(worktree, 'on two')
    expect((await read(r => r.head === tip)).head).toBe(tip)
    expect(tip).toBe(gitReading(worktree).head)
  })

  test('a change to the shared config is noticed: the remote url', async () => {
    scratch.run(main, 'remote', 'set-url', 'origin', 'https://example.com/second.git')
    const reading = await read(r => r.remoteUrl === 'https://example.com/second.git')
    expect(reading.remoteUrl).toBe('https://example.com/second.git')
    expect(reading.remoteUrl).toBe(gitReading(worktree).remoteUrl)
  })

  test('values are held between watched changes: a new origin/HEAD shows only after one', async () => {
    scratch.run(main, 'remote', 'set-head', 'origin', 'master')
    await Bun.sleep(250)
    expect((await readAll(getters, worktree)).defaultBranch).toBe('trunk')

    const tip = scratch.commit(worktree, 'wakes the cache')
    const reading = await read(r => r.head === tip && r.defaultBranch === 'master')
    expect(reading.defaultBranch).toBe('master')
    expect(reading.defaultBranch).toBe(gitReading(worktree).defaultBranch)
  })

  test('detaching: the branch reads HEAD, and commits made detached are noticed', async () => {
    scratch.run(worktree, 'checkout', '-q', '--detach')
    expect((await read(r => r.branch === 'HEAD')).branch).toBe('HEAD')
    expect(scratch.run(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    const tip = scratch.commit(worktree, 'detached work')
    expect((await read(r => r.head === tip)).head).toBe(tip)
  })

  test('a tampered HEAD reads as HEAD with an empty head, never as the text it holds', async () => {
    const headFile = join(main, '.git', 'worktrees', 'wt', 'HEAD')
    writeFileSync(headFile, 'ref: refs/heads/$(touch owned)\n')
    const reading = await read(r => r.branch === 'HEAD' && r.head === '')
    expect(reading.branch).toBe('HEAD')
    expect(reading.head).toBe('')

    writeFileSync(headFile, 'ref: refs/heads/wt/two\n')
    expect((await read(r => r.branch === 'wt/two')).branch).toBe('wt/two')
  })

  test('a branch name git allows outside [A-Za-z0-9/._+@-] reads as HEAD, with an empty head', async () => {
    scratch.run(worktree, 'checkout', '-q', '-b', 'fix/#123')
    const reading = await read(r => r.branch === 'HEAD' && r.head === '')
    expect(reading.branch).toBe('HEAD')
    expect(reading.head).toBe('')
    expect(scratch.run(worktree, 'branch', '--show-current')).toBe('fix/#123')

    scratch.run(worktree, 'checkout', '-q', 'wt/two')
    expect((await read(r => r.branch === 'wt/two')).branch).toBe('wt/two')
  })

  test("HEAD naming a remote-tracking branch reads as HEAD, with that branch's commit", async () => {
    scratch.run(worktree, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/trunk')
    const reading = await read(r => r.branch === 'HEAD' && r.head === firstTip)
    expect(reading.branch).toBe('HEAD')
    expect(reading.head).toBe(scratch.run(worktree, 'rev-parse', 'HEAD'))

    scratch.run(worktree, 'symbolic-ref', 'HEAD', 'refs/heads/wt/two')
    expect((await read(r => r.branch === 'wt/two')).branch).toBe('wt/two')
  })

  test('a branch with no commit yet: its name and an empty head, until its first commit', async () => {
    scratch.run(worktree, 'checkout', '-q', '--orphan', 'wt/fresh')
    const before = await read(r => r.branch === 'wt/fresh')
    expect(before.branch).toBe('wt/fresh')
    expect(before.head).toBe('')
    await Bun.sleep(50) // as above: let the watch on the new ref be armed
    const tip = scratch.commit(worktree, 'root of fresh')
    expect((await read(r => r.head === tip)).head).toBe(tip)
  })

  test('git pack-refs changes no value, and the next commit is still noticed', async () => {
    const before = await readAll(getters, worktree)
    scratch.run(worktree, 'pack-refs', '--all')
    await Bun.sleep(100)
    expect(await readAll(getters, worktree)).toEqual(before)

    const tip = scratch.commit(worktree, 'after packing')
    expect((await read(r => r.head === tip)).head).toBe(tip)
  })

  test('without origin/HEAD the default branch is origin/main, else origin/master, else main', async () => {
    scratch.run(main, 'remote', 'set-head', 'origin', 'trunk')
    touchConfig()
    expect((await read(r => r.defaultBranch === 'trunk')).defaultBranch).toBe('trunk')

    scratch.run(main, 'remote', 'set-head', 'origin', '--delete')
    touchConfig()
    expect((await read(r => r.defaultBranch === 'master')).defaultBranch).toBe('master')

    scratch.run(main, 'update-ref', 'refs/remotes/origin/main', firstTip)
    touchConfig()
    expect((await read(r => r.defaultBranch === 'main')).defaultBranch).toBe('main')

    scratch.run(main, 'update-ref', '-d', 'refs/remotes/origin/main')
    touchConfig()
    expect((await read(r => r.defaultBranch === 'master')).defaultBranch).toBe('master')

    scratch.run(main, 'update-ref', '-d', 'refs/remotes/origin/master')
    touchConfig()
    expect((await read(r => r.defaultBranch === 'main')).defaultBranch).toBe('main')
  })

  test('an origin/HEAD naming an unsafe branch is refused, and the fallback answers', async () => {
    scratch.run(main, 'update-ref', 'refs/remotes/origin/master', firstTip)
    scratch.put(join(main, '.git'), 'refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/$(touch owned)\n')
    touchConfig()
    expect((await read(r => r.defaultBranch === 'master')).defaultBranch).toBe('master')
  })

  test('scrolling does not hold back noticing a branch switch', async () => {
    const scrolling = setInterval(markScrollActivity, 25)
    try {
      markScrollActivity()
      scratch.run(worktree, 'checkout', '-q', '-b', 'wt/scrolled')
      expect((await read(r => r.branch === 'wt/scrolled', 1000)).branch).toBe('wt/scrolled')
    } finally {
      clearInterval(scrolling)
    }
  })
})

describe('a fresh process per repository', () => {
  test('outside any repository: HEAD, an empty head, no url, and main', () => {
    const reading = readOnceInFreshProcess(scratch.tempDir('outside'))
    expect(reading).toEqual({ branch: 'HEAD', head: '', remoteUrl: null, defaultBranch: 'main' })
  })

  test('a clone: the four values are what git reports', () => {
    const upstream = scratch.repo('upstream', 'develop')
    const clone = join(scratch.tempDir('clones'), 'clone')
    scratch.run(upstream, 'clone', '-q', upstream, clone)
    const reading = readOnceInFreshProcess(clone)
    expect(reading).toEqual(gitReading(clone))
    expect(reading.branch).toBe('develop')
    expect(reading.remoteUrl).toBe(upstream)
    expect(reading.defaultBranch).toBe('develop')
  })

  test('a repository with no remote: no url, and main', () => {
    const repo = scratch.repo('lonely', 'work')
    expect(readOnceInFreshProcess(repo)).toEqual({
      branch: 'work',
      head: scratch.run(repo, 'rev-parse', 'HEAD'),
      remoteUrl: null,
      defaultBranch: 'main',
    })
  })

  test('without origin/HEAD: origin/master alone gives master, origin/main is preferred', () => {
    const repo = scratch.repo('fallback')
    const tip = scratch.run(repo, 'rev-parse', 'HEAD')
    scratch.run(repo, 'update-ref', 'refs/remotes/origin/master', tip)
    expect(readOnceInFreshProcess(repo).defaultBranch).toBe('master')
    scratch.run(repo, 'update-ref', 'refs/remotes/origin/main', tip)
    expect(readOnceInFreshProcess(repo).defaultBranch).toBe('main')
  })

  test('origin/HEAD may name a nested branch', () => {
    const repo = scratch.repo('nested-default')
    scratch.run(repo, 'update-ref', 'refs/remotes/origin/release/2.x', scratch.run(repo, 'rev-parse', 'HEAD'))
    scratch.run(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/2.x')
    expect(readOnceInFreshProcess(repo).defaultBranch).toBe('release/2.x')
  })

  test('an origin/HEAD that points outside refs/remotes/origin/ is ignored', () => {
    const repo = scratch.repo('foreign-default')
    const tip = scratch.run(repo, 'rev-parse', 'HEAD')
    scratch.run(repo, 'update-ref', 'refs/remotes/upstream/dev', tip)
    scratch.run(repo, 'update-ref', 'refs/remotes/origin/master', tip)
    scratch.run(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/upstream/dev')
    expect(readOnceInFreshProcess(repo).defaultBranch).toBe('master')
  })

  test('remote-tracking branches that only exist in packed-refs are found', () => {
    const repo = scratch.repo('packed-default')
    scratch.run(repo, 'update-ref', 'refs/remotes/origin/master', scratch.run(repo, 'rev-parse', 'HEAD'))
    scratch.run(repo, 'pack-refs', '--all')
    expect(readOnceInFreshProcess(repo).defaultBranch).toBe('master')
  })

  test('calls racing on a cold cache agree', () => {
    const repo = scratch.repo('racing')
    const [first, second, third] = readInFreshProcess(repo, 3)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(first).toEqual(gitReading(repo))
  })

  test('a submodule directory: its own branch, head, url and default branch', () => {
    const library = scratch.repo('sub-library')
    const outer = scratch.repo('sub-outer')
    scratch.run(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'mods/lib')
    const inner = join(outer, 'mods', 'lib')
    const reading = readOnceInFreshProcess(inner)
    expect(reading).toEqual(gitReading(inner))
    expect(reading.remoteUrl).toBe(library)
  })

  const reftableWorks = scratch.attempt(scratch.tempDir('reftable-check'), 'init', '-q', '--ref-format=reftable').ok

  test.skipIf(!reftableWorks)('a reftable repository: the url is read; HEAD is unknown or right', async () => {
    const repo = scratch.repo('reftable', 'main', '--ref-format=reftable')
    scratch.run(repo, 'remote', 'add', 'origin', 'https://example.com/rt.git')
    const reading = readOnceInFreshProcess(repo)
    const tip = scratch.run(repo, 'rev-parse', 'HEAD')
    expect(reading.remoteUrl).toBe('https://example.com/rt.git')
    expect(['', tip]).toContain(reading.head)
    expect([null, tip]).toContain(await sharedModule.getHeadForDir(repo))
  })
})
