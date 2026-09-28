// Characterization of the worktree listings (getWorktreePaths.ts and
// getWorktreePathsPortable.ts) and of the worktree-mode switch
// (worktreeModeEnabled.ts), written for the clean-base rewrite
// (docs/tech/rewrite/vcs/git.md), against real repositories and worktrees.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getWorktreePaths } from 'src/vcs/git/getWorktreePaths.js'
import { getWorktreePathsPortable } from 'src/vcs/git/getWorktreePathsPortable.js'
import { isWorktreeModeEnabled } from 'src/vcs/git/worktreeModeEnabled.js'

const WHO = {
  GIT_AUTHOR_NAME: 'Worktree Fixture',
  GIT_AUTHOR_EMAIL: 'worktrees@fixture.invalid',
  GIT_COMMITTER_NAME: 'Worktree Fixture',
  GIT_COMMITTER_EMAIL: 'worktrees@fixture.invalid',
}
const INHERITED_GIT_VARS = [
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

const cleanup: string[] = []
const envWas: Record<string, string | undefined> = {}

function dirFor(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `char-worktrees-${tag}-`)))
  cleanup.push(dir)
  return dir
}

function override(key: string, value: string | undefined): void {
  if (!(key in envWas)) envWas[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  const home = dirFor('home')
  for (const key of INHERITED_GIT_VARS) override(key, undefined)
  override('HOME', home)
  override('GIT_CONFIG_GLOBAL', '/dev/null')
  override('GIT_CONFIG_NOSYSTEM', '1')
  override('GIT_TERMINAL_PROMPT', '0')
  override('CLAUDIN_CONFIG_DIR', join(home, '.claudin'))
  for (const [key, value] of Object.entries(WHO)) override(key, value)
})

afterAll(() => {
  Object.keys(envWas).forEach(key => override(key, envWas[key]))
  cleanup.forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (res.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${res.stderr.toString()}`)
}

/** A main working tree with one commit, plus linked worktrees at the given paths. */
function mainWithLinked(main: string, linked: string[]): string {
  mkdirSync(main, { recursive: true })
  git(main, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(main, 'README.md'), 'readme\n')
  git(main, 'add', 'README.md')
  git(main, 'commit', '--quiet', '-m', 'seed')
  linked.forEach((path, i) => git(main, 'worktree', 'add', '--quiet', '-b', `wt-${i}`, path))
  return main
}

describe('getWorktreePaths', () => {
  test('lists every working tree: the one holding cwd first, then the rest in alphabetical order', async () => {
    const base = dirFor('order')
    const [charlie, alpha, bravo] = ['charlie', 'alpha', 'bravo'].map(name => join(base, name))
    const main = mainWithLinked(join(base, 'main'), [charlie, alpha, bravo])
    mkdirSync(join(bravo, 'src'))
    expect(await getWorktreePaths(join(bravo, 'src'))).toEqual([bravo, alpha, charlie, main])
    expect(await getWorktreePaths(main)).toEqual([main, alpha, bravo, charlie])
    expect(await getWorktreePaths(charlie)).toEqual([charlie, alpha, bravo, main])
  })

  test('a repository without linked worktrees lists itself alone', async () => {
    const main = mainWithLinked(join(dirFor('single'), 'repo'), [])
    expect(await getWorktreePaths(main)).toEqual([main])
  })

  test('a worktree nested inside the main tree is listed along with it', async () => {
    const base = dirFor('nested')
    const main = join(base, 'main')
    const nested = join(main, '.claudin', 'worktrees', 'task')
    mainWithLinked(main, [nested])
    const listed = await getWorktreePaths(main)
    expect([...listed].sort()).toEqual([main, nested].sort())
    expect(listed[0]).toBe(main)
  })

  test('paths come back NFC-normalized', async () => {
    const base = dirFor('nfc')
    const decomposed = join(base, 'cafe\u0301-wt')
    const main = mainWithLinked(join(base, 'main'), [decomposed])
    expect(await getWorktreePaths(main)).toEqual([main, decomposed.normalize('NFC')])
  })

  test('a bare repository lists itself next to its worktrees', async () => {
    const base = dirFor('bare')
    const seed = mainWithLinked(join(base, 'seed'), [])
    const store = join(base, 'store.git')
    git(base, 'clone', '--quiet', '--bare', seed, store)
    const checkout = join(base, 'checkout')
    git(store, 'worktree', 'add', '--quiet', checkout, 'main')
    expect(await getWorktreePaths(checkout)).toEqual([checkout, store])
  })

  test('empty outside a repository or for a directory that does not exist', async () => {
    const plain = dirFor('plain')
    expect(await getWorktreePaths(plain)).toEqual([])
    expect(await getWorktreePaths(join(plain, 'missing'))).toEqual([])
  })
})

describe('getWorktreePathsPortable', () => {
  test("lists every working tree in git's order, the main one first, wherever cwd is", async () => {
    const base = dirFor('portable')
    const zulu = join(base, 'zulu')
    const echo = join(base, 'echo')
    const main = mainWithLinked(join(base, 'main'), [zulu, echo])
    const fromZulu = await getWorktreePathsPortable(zulu)
    expect(fromZulu[0]).toBe(main)
    expect([...fromZulu].sort()).toEqual([echo, main, zulu].sort())
    expect(await getWorktreePathsPortable(main)).toEqual(fromZulu)
  })

  test('paths come back NFC-normalized', async () => {
    const base = dirFor('portable-nfc')
    const decomposed = join(base, 'nai\u0308ve')
    const main = mainWithLinked(join(base, 'main'), [decomposed])
    expect(await getWorktreePathsPortable(main)).toEqual([main, decomposed.normalize('NFC')])
  })

  test('empty outside a repository, for a missing directory, or when git is not on PATH', async () => {
    const plain = dirFor('portable-plain')
    const main = mainWithLinked(join(dirFor('portable-path'), 'main'), [])
    expect(await getWorktreePathsPortable(plain)).toEqual([])
    expect(await getWorktreePathsPortable(join(plain, 'missing'))).toEqual([])
    const pathBefore = process.env.PATH
    process.env.PATH = dirFor('no-git-here')
    try {
      expect(await getWorktreePathsPortable(main)).toEqual([])
    } finally {
      process.env.PATH = pathBefore
    }
    expect(await getWorktreePathsPortable(main)).toEqual([main])
  })
})

describe('isWorktreeModeEnabled', () => {
  test('is always on, reading neither the cwd, the environment nor any setting', () => {
    expect(isWorktreeModeEnabled()).toBe(true)
    const plain = dirFor('mode')
    expect(runWithCwdOverride(plain, () => isWorktreeModeEnabled())).toBe(true)
    const pathBefore = process.env.PATH
    process.env.PATH = plain
    try {
      expect(isWorktreeModeEnabled()).toBe(true)
    } finally {
      process.env.PATH = pathBefore
    }
  })
})
