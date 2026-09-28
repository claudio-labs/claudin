import { describe, expect, test } from 'bun:test'
import { MemoryGitFiles } from 'src/vcs/git/__testutils__/memoryGitFiles.js'
import type { WatchFile } from 'src/vcs/git/gitFilesystem/filePoller.js'
import {
  createRepoStateCache,
  type RepoStateDeps,
  type RepoValues,
} from 'src/vcs/git/gitFilesystem/repoState.js'

const TIP = 'ab'.repeat(20)
const NEXT = 'cd'.repeat(20)

/** Watches that fire only when the test says a file changed. */
class FakeWatches {
  private readonly listeners = new Map<string, Set<() => void>>()

  readonly watchFile: WatchFile = (path, onChange) => {
    const forPath = this.listeners.get(path) ?? new Set()
    forPath.add(onChange)
    this.listeners.set(path, forPath)
    return () => {
      forPath.delete(onChange)
      if (forPath.size === 0) this.listeners.delete(path)
    }
  }

  watched(): string[] {
    return [...this.listeners.keys()].sort()
  }

  change(path: string): void {
    for (const listener of [...(this.listeners.get(path) ?? [])]) listener()
  }
}

/** Scrolling that lasts until the test ends it. */
class FakeScroll {
  private waiting: Array<() => void> = []
  scrolling = false

  readonly waitForScrollIdle = (): Promise<void> =>
    this.scrolling ? new Promise(resolve => this.waiting.push(resolve)) : Promise.resolve()

  stop(): void {
    this.scrolling = false
    for (const resolve of this.waiting.splice(0)) resolve()
  }
}

function repository(root: string, branch: string, url: string): Record<string, string> {
  return {
    [`${root}/.git/HEAD`]: `ref: refs/heads/${branch}\n`,
    [`${root}/.git/refs/heads/${branch}`]: `${TIP}\n`,
    [`${root}/.git/config`]: `[remote "origin"]\n\turl = ${url}\n`,
  }
}

function setUp(files: MemoryGitFiles, maxRepositories = 4) {
  const watches = new FakeWatches()
  const scroll = new FakeScroll()
  const cleanups: Array<() => Promise<void>> = []
  const deps: RepoStateDeps = {
    files,
    watchFile: watches.watchFile,
    waitForScrollIdle: scroll.waitForScrollIdle,
    registerCleanup: cleanup => {
      cleanups.push(cleanup)
      return () => {}
    },
    maxRepositories,
  }
  return { cache: createRepoStateCache(deps), watches, scroll, cleanups }
}

async function readAll(values: RepoValues) {
  const [branch, head, remoteUrl, defaultBranch] = await Promise.all([
    values.branch(),
    values.head(),
    values.remoteUrl(),
    values.defaultBranch(),
  ])
  return { branch, head, remoteUrl, defaultBranch }
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('createRepoStateCache', () => {
  test('F2: each git directory answers for its own repository', async () => {
    const files = new MemoryGitFiles({
      ...repository('/one', 'alpha', 'https://example.com/one.git'),
      ...repository('/two', 'beta', 'https://example.com/two.git'),
    })
    const { cache } = setUp(files)
    expect(await readAll(cache.valuesFor('/one/.git'))).toEqual({
      branch: 'alpha',
      head: TIP,
      remoteUrl: 'https://example.com/one.git',
      defaultBranch: 'main',
    })
    expect((await readAll(cache.valuesFor('/two/.git'))).branch).toBe('beta')
    expect((await readAll(cache.valuesFor('/one/.git'))).remoteUrl).toBe('https://example.com/one.git')
  })

  test('watches HEAD, the config and the current branch ref, in the common dir when there is one', async () => {
    const files = new MemoryGitFiles({
      '/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/side\n',
      '/main/.git/worktrees/wt/commondir': '../..\n',
      '/main/.git/refs/heads/side': `${TIP}\n`,
    })
    const { cache, watches } = setUp(files)
    await readAll(cache.valuesFor('/main/.git/worktrees/wt'))
    expect(watches.watched()).toEqual([
      '/main/.git/config',
      '/main/.git/refs/heads/side',
      '/main/.git/worktrees/wt/HEAD',
    ])
  })

  test('values are held until a watched file changes, then all four are read again', async () => {
    const files = new MemoryGitFiles(repository('/r', 'main', 'https://example.com/a.git'))
    const { cache, watches } = setUp(files)
    const values = cache.valuesFor('/r/.git')
    await readAll(values)

    files.write('/r/.git/refs/heads/main', `${NEXT}\n`)
    files.write('/r/.git/config', '[remote "origin"]\n\turl = https://example.com/b.git\n')
    expect(await readAll(values)).toMatchObject({ head: TIP, remoteUrl: 'https://example.com/a.git' })

    watches.change('/r/.git/refs/heads/main')
    expect(await readAll(values)).toMatchObject({ head: NEXT, remoteUrl: 'https://example.com/b.git' })
  })

  test('calls that race on a cold value share one read', async () => {
    const files = new MemoryGitFiles(repository('/r', 'main', 'https://example.com/a.git'))
    const { cache } = setUp(files)
    const values = cache.valuesFor('/r/.git')
    const readings = await Promise.all([readAll(values), readAll(values), readAll(values)])
    expect(readings[1]).toEqual(readings[0])
    expect(readings[2]).toEqual(readings[0])
    expect(files.reads.filter(path => path === '/r/.git/config')).toHaveLength(1)
  })

  test('after a branch switch the watch moves to the new branch, and none is kept while detached', async () => {
    const files = new MemoryGitFiles(repository('/r', 'main', 'u'))
    const { cache, watches } = setUp(files)
    const values = cache.valuesFor('/r/.git')
    await readAll(values)

    files.write('/r/.git/HEAD', 'ref: refs/heads/topic\n')
    watches.change('/r/.git/HEAD')
    expect(await values.branch()).toBe('topic')
    await settle()
    expect(watches.watched()).toContain('/r/.git/refs/heads/topic')
    expect(watches.watched()).not.toContain('/r/.git/refs/heads/main')

    files.write('/r/.git/HEAD', `${TIP}\n`)
    watches.change('/r/.git/HEAD')
    expect(await values.branch()).toBe('HEAD')
    await settle()
    expect(watches.watched()).toEqual(['/r/.git/HEAD', '/r/.git/config'])
  })

  test('scrolling holds back moving the watch, never noticing the switch', async () => {
    const files = new MemoryGitFiles(repository('/r', 'main', 'u'))
    const { cache, watches, scroll } = setUp(files)
    const values = cache.valuesFor('/r/.git')
    await readAll(values)

    scroll.scrolling = true
    files.write('/r/.git/HEAD', 'ref: refs/heads/topic\n')
    watches.change('/r/.git/HEAD')
    expect(await values.branch()).toBe('topic')
    await settle()
    expect(watches.watched()).toContain('/r/.git/refs/heads/main')

    scroll.stop()
    await settle()
    expect(watches.watched()).toContain('/r/.git/refs/heads/topic')
    expect(watches.watched()).not.toContain('/r/.git/refs/heads/main')
  })

  test('the first commit of a new branch is noticed: its ref is watched before it exists', async () => {
    const files = new MemoryGitFiles({ '/r/.git/HEAD': 'ref: refs/heads/fresh\n' })
    const { cache, watches } = setUp(files)
    const values = cache.valuesFor('/r/.git')
    expect(await readAll(values)).toMatchObject({ branch: 'fresh', head: '' })

    files.write('/r/.git/refs/heads/fresh', `${TIP}\n`)
    watches.change('/r/.git/refs/heads/fresh')
    expect(await values.head()).toBe(TIP)
  })

  test('graceful shutdown stops every watch', async () => {
    const files = new MemoryGitFiles({
      ...repository('/one', 'a', 'u'),
      ...repository('/two', 'b', 'u'),
    })
    const { cache, watches, cleanups } = setUp(files)
    await readAll(cache.valuesFor('/one/.git'))
    await readAll(cache.valuesFor('/two/.git'))
    expect(cleanups).toHaveLength(1)
    expect(watches.watched()).toHaveLength(6)

    await cleanups[0]!()
    expect(watches.watched()).toEqual([])
  })

  test('past the bound, the least recently used repository stops being watched', async () => {
    const files = new MemoryGitFiles({
      ...repository('/one', 'a', 'u'),
      ...repository('/two', 'b', 'u'),
      ...repository('/three', 'c', 'u'),
    })
    const { cache, watches } = setUp(files, 2)
    await readAll(cache.valuesFor('/one/.git'))
    await readAll(cache.valuesFor('/two/.git'))
    await readAll(cache.valuesFor('/one/.git'))
    await readAll(cache.valuesFor('/three/.git'))
    const watched = watches.watched()
    expect(watched.some(path => path.startsWith('/two/'))).toBe(false)
    expect(watched.some(path => path.startsWith('/one/'))).toBe(true)
    expect(watched.some(path => path.startsWith('/three/'))).toBe(true)
  })
})
