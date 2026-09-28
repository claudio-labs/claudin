/**
 * The defects the rewrite fixed (docs/tech/rewrite/vcs/gitFilesystem.md,
 * findings F1 to F5), through the public exports and against real
 * repositories. Where git has an opinion, the test asks it too.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getHeadForDir,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from 'src/vcs/git/gitFilesystem.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

function cachedIn(dir: string) {
  return runWithCwdOverride(dir, async () => ({
    branch: await getCachedBranch(),
    head: await getCachedHead(),
    remoteUrl: await getCachedRemoteUrl(),
    defaultBranch: await getCachedDefaultBranch(),
  }))
}

async function cachedUntil(dir: string, settled: (head: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000
  let head = (await cachedIn(dir)).head
  while (!settled(head) && Date.now() < deadline) {
    await Bun.sleep(5)
    head = (await cachedIn(dir)).head
  }
  return head
}

describe('F1: a symbolic ref cycle settles on no commit instead of spinning', () => {
  test('resolveRef, getHeadForDir and the cached getters all answer', async () => {
    const repo = scratch.repo('cycle')
    const gitDir = join(repo, '.git')
    scratch.put(gitDir, 'refs/heads/a', 'ref: refs/heads/b\n')
    scratch.put(gitDir, 'refs/heads/b', 'ref: refs/heads/a\n')
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/a\n')

    expect(await resolveRef(gitDir, 'refs/heads/a')).toBeNull()
    expect(await getHeadForDir(repo)).toBeNull()
    expect(await cachedIn(repo)).toMatchObject({ branch: 'a', head: '' })
    expect(scratch.attempt(repo, 'rev-parse', '--verify', '-q', 'refs/heads/a').ok).toBe(false)
  }, 10_000)

  test('readWorktreeHeadSha of a linked worktree whose branch is caught in a cycle', async () => {
    const main = scratch.repo('cycle-main')
    const worktree = join(scratch.tempDir('cycle-linked'), 'wt')
    scratch.run(main, 'worktree', 'add', '-q', '-b', 'loop', worktree)
    scratch.put(join(main, '.git'), 'refs/heads/loop', 'ref: refs/heads/loop\n')
    expect(await readWorktreeHeadSha(worktree)).toBeNull()
  }, 10_000)
})

describe('F2: the cached values follow the working directory to its repository', () => {
  test('two repositories in turn, each answered for itself, and changes in the second are seen', async () => {
    const first = scratch.repo('follow-first', 'alpha')
    scratch.run(first, 'remote', 'add', 'origin', 'https://example.com/first.git')
    const second = scratch.repo('follow-second', 'beta')
    scratch.run(second, 'remote', 'add', 'origin', 'https://example.com/second.git')
    scratch.run(second, 'update-ref', 'refs/remotes/origin/master', scratch.run(second, 'rev-parse', 'HEAD'))

    expect(await cachedIn(first)).toEqual({
      branch: 'alpha',
      head: scratch.run(first, 'rev-parse', 'HEAD'),
      remoteUrl: 'https://example.com/first.git',
      defaultBranch: 'main',
    })
    expect(await cachedIn(second)).toEqual({
      branch: 'beta',
      head: scratch.run(second, 'rev-parse', 'HEAD'),
      remoteUrl: 'https://example.com/second.git',
      defaultBranch: 'master',
    })
    expect((await cachedIn(first)).branch).toBe('alpha')

    const tip = scratch.commit(second, 'seen from the second repository')
    expect(await cachedUntil(second, head => head === tip)).toBe(tip)
    expect((await cachedIn(first)).head).toBe(scratch.run(first, 'rev-parse', 'HEAD'))
  }, 10_000)

  test('a linked worktree and its main repository keep their own branch and commit', async () => {
    const main = scratch.repo('follow-main')
    const worktree = join(scratch.tempDir('follow-linked'), 'wt')
    scratch.run(main, 'worktree', 'add', '-q', '-b', 'side', worktree)
    const sideTip = scratch.commit(worktree, 'on side')
    expect(await cachedIn(worktree)).toMatchObject({ branch: 'side', head: sideTip })
    expect(await cachedIn(main)).toMatchObject({ branch: 'main', head: scratch.run(main, 'rev-parse', 'HEAD') })
  }, 10_000)
})

describe('F3: the reftable placeholder is no branch', () => {
  test('HEAD naming refs/heads/.invalid reads as HEAD with no commit, and git refuses the name', async () => {
    const repo = scratch.repo('placeholder')
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n')
    expect(await cachedIn(repo)).toMatchObject({ branch: 'HEAD', head: '' })
    expect(await getHeadForDir(repo)).toBeNull()
    expect(scratch.attempt(repo, 'check-ref-format', '--branch', '.invalid').ok).toBe(false)
  })
})

describe('F4: a symbolic HEAD outside refs/heads/ that resolves to nothing is null, not empty', () => {
  test('getHeadForDir and readWorktreeHeadSha', async () => {
    const main = scratch.repo('dangling-main')
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/remotes/origin/gone\n')
    expect(await getHeadForDir(main)).toBeNull()
    expect(scratch.attempt(main, 'rev-parse', '--verify', '-q', 'HEAD').ok).toBe(false)

    const other = scratch.repo('dangling-other')
    const worktree = join(scratch.tempDir('dangling-linked'), 'wt')
    scratch.run(other, 'worktree', 'add', '-q', '--detach', worktree)
    writeFileSync(join(other, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/tags/none\n')
    expect(await readWorktreeHeadSha(worktree)).toBeNull()
  })
})

describe('F5: a .git file git would refuse makes no repository', () => {
  function pointerWith(label: string, text: string): string {
    const dir = scratch.tempDir(label)
    writeFileSync(join(dir, '.git'), text)
    return dir
  }

  test.each([
    ['without gitdir:', (target: string) => `${target}\n`],
    ['naming a directory that does not exist', (target: string) => `gitdir: ${target}-gone\n`],
    ['of several lines', (target: string) => `gitdir: ${target}\nmore\n`],
  ])('a .git file %s', async (label, content) => {
    const target = join(scratch.repo(`f5-target-${label.length}`), '.git')
    const pointer = pointerWith(`f5-${label.length}`, content(target))
    mkdirSync(join(pointer, 'below'))
    expect(await resolveGitDir(pointer)).toBeNull()
    expect(await resolveGitDir(join(pointer, 'below'))).toBeNull()
    expect(await getHeadForDir(pointer)).toBeNull()
    expect(await readWorktreeHeadSha(pointer)).toBeNull()
    expect(scratch.attempt(pointer, 'rev-parse', '--git-dir').ok).toBe(false)
  })
})
