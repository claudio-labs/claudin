import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative } from 'path'

import {
  type ProjectWalkDeps,
  walkProjectConfigDirs,
  walkStop,
  worktreeFallbackDirs,
} from 'src/memory/instructions/markdownConfig/projectDirectories.js'
import { findCanonicalGitRoot, findGitRoot } from 'src/vcs/git/git.js'

type FakeRepositories = {
  /** Every repository root; a path belongs to the nearest one at or above it. */
  roots: string[]
  /** Worktree root → the main checkout it belongs to. */
  worktreeOf?: Record<string, string>
  session: string
}

function fakeDeps({ roots, worktreeOf = {}, session }: FakeRepositories): ProjectWalkDeps {
  const rootOf = (path: string): string | null =>
    roots
      .filter(root => path === root || path.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null
  return {
    homeDir: () => '/home/nobody',
    sessionRoot: () => session,
    findGitRoot: rootOf,
    findCanonicalGitRoot: path => {
      const root = rootOf(path)
      return root === null ? null : (worktreeOf[root] ?? root)
    },
  }
}

describe('walkStop', () => {
  test('outside any repository nothing but home or the filesystem root ends the walk', () => {
    expect(walkStop('/work/site', fakeDeps({ roots: [], session: '/work' }))).toBeUndefined()
  })

  test('inside the session\'s repository, at its root', () => {
    expect(walkStop('/app/src', fakeDeps({ roots: ['/app'], session: '/app' }))).toBe('/app')
  })

  test('a repository nested in the session\'s walks on to the session\'s root', () => {
    const deps = fakeDeps({ roots: ['/app', '/app/vendor/lib'], session: '/app' })
    expect(walkStop('/app/vendor/lib/src', deps)).toBe('/app')
  })

  test('a worktree of the session\'s repository stops at its own root, nested or not', () => {
    const deps = fakeDeps({
      roots: ['/app', '/app/.claudin/worktrees/topic'],
      worktreeOf: { '/app/.claudin/worktrees/topic': '/app' },
      session: '/app',
    })
    expect(walkStop('/app/.claudin/worktrees/topic/pkg', deps)).toBe('/app/.claudin/worktrees/topic')
  })

  test('a sibling whose path starts with the session\'s stops at its own root', () => {
    const deps = fakeDeps({ roots: ['/app', '/app-tools'], session: '/app' })
    expect(walkStop('/app-tools/bin', deps)).toBe('/app-tools')
  })

  test('with the session outside any repository, a nested repository stops at its own root', () => {
    const deps = fakeDeps({ roots: ['/outer', '/outer/vendor/lib'], session: '/elsewhere' })
    expect(walkStop('/outer/vendor/lib/src', deps)).toBe('/outer/vendor/lib')
  })

  test('a repository that holds the session\'s stops at its own root', () => {
    const deps = fakeDeps({ roots: ['/outer', '/outer/vendor/lib'], session: '/outer/vendor/lib' })
    expect(walkStop('/outer/docs', deps)).toBe('/outer')
  })
})

describe('worktreeFallbackDirs', () => {
  const worktree = fakeDeps({
    roots: ['/main', '/wt/topic'],
    worktreeOf: { '/wt/topic': '/main' },
    session: '/main',
  })

  test('a worktree whose root has no directory of its own falls back to the main checkout\'s', () => {
    expect(worktreeFallbackDirs('agents', '/wt/topic/pkg', ['/wt/topic/pkg/.claudin/agents'], worktree)).toEqual([
      '/main/.claudin/agents',
    ])
  })

  test('a worktree whose root has its own directory reads only that', () => {
    expect(worktreeFallbackDirs('agents', '/wt/topic', ['/wt/topic/.claudin/agents'], worktree)).toEqual([])
  })

  test('a checkout that is no worktree has no fallback, even when its root\'s directory was not walked', () => {
    // As when home, below the repository's root, ended the walk first.
    const repository = fakeDeps({ roots: ['/dotfiles'], session: '/dotfiles/home/project' })
    expect(worktreeFallbackDirs('agents', '/dotfiles/home/project', [], repository)).toEqual([])
  })

  test('outside any repository there is no fallback', () => {
    expect(worktreeFallbackDirs('agents', '/loose', [], fakeDeps({ roots: [], session: '/loose' }))).toEqual([])
  })
})

describe('walkProjectConfigDirs on disk', () => {
  let root: string
  let deps: ProjectWalkDeps

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'md-walk-')))
    // A `.git` directory is all a repository root needs here.
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    deps = {
      homeDir: () => join(root, 'home'),
      sessionRoot: () => root,
      findGitRoot: path => findGitRoot(path),
      findCanonicalGitRoot: path => findCanonicalGitRoot(path),
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const walked = (cwd: string): string[] =>
    walkProjectConfigDirs('agents', join(root, cwd), deps).map(dir => relative(root, dir))

  function file(path: string): string {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '# not a directory\n')
    return full
  }

  test('a file where .claudin/<subdir> belongs is passed over, and the walk goes on', () => {
    file('repo/pkg/.claudin/agents')
    mkdirSync(join(root, 'repo', '.claudin', 'agents'), { recursive: true })
    expect(walked('repo/pkg')).toEqual(['repo/.claudin/agents'])
  })

  test('a link to a file where .claudin/<subdir> belongs is passed over too', () => {
    const target = file('elsewhere/agents.md')
    mkdirSync(join(root, 'repo', 'pkg', '.claudin'), { recursive: true })
    symlinkSync(target, join(root, 'repo', 'pkg', '.claudin', 'agents'))
    expect(walked('repo/pkg')).toEqual([])
  })

  test('a relative cwd resolves against the process\'s own, and the directories come back absolute', () => {
    const repoDir = join(root, 'repo', '.claudin', 'agents')
    mkdirSync(repoDir, { recursive: true })
    const relativeCwd = relative(process.cwd(), join(root, 'repo'))
    expect(walkProjectConfigDirs('agents', relativeCwd, deps)).toEqual([repoDir])
  })
})
