// Characterization of repository discovery in src/vcs/git/git.ts, written for
// the clean-base rewrite (docs/tech/rewrite/vcs/git.md). Every case drives the
// exports against real repositories built in temp directories, with git cut
// off from the user's configuration.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, isAbsolute, join, relative } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  dedupeCanonicalRoots,
  dirIsInGitRepo,
  findCanonicalGitRoot,
  findGitRoot,
  findNestedGitRoots,
  getGitDir,
  getIsGit,
  gitExe,
  isCurrentDirectoryBareGitRepo,
  resolveWorkspaceRoots,
} from 'src/vcs/git/git.js'

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Discovery Fixture',
  GIT_AUTHOR_EMAIL: 'discovery@fixture.invalid',
  GIT_COMMITTER_NAME: 'Discovery Fixture',
  GIT_COMMITTER_EMAIL: 'discovery@fixture.invalid',
}
// Variables that would let the caller's own git setup leak into a fixture.
const SCRUBBED = [
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

const temporary: string[] = []
const envBefore = new Map<string, string | undefined>()

function freshDir(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `char-git-${tag}-`)))
  temporary.push(dir)
  return dir
}

function setEnv(key: string, value: string | undefined): void {
  if (!envBefore.has(key)) envBefore.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  const home = freshDir('home')
  for (const key of SCRUBBED) setEnv(key, undefined)
  setEnv('HOME', home)
  setEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  setEnv('GIT_CONFIG_NOSYSTEM', '1')
  setEnv('GIT_TERMINAL_PROMPT', '0')
  setEnv('CLAUDIN_CONFIG_DIR', join(home, '.claudin'))
  for (const [key, value] of Object.entries(AUTHOR)) setEnv(key, value)
})

afterAll(() => {
  getIsGit.cache.clear?.()
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${run.stderr.toString()}`)
  }
  return run.stdout.toString().trim()
}

function newRepo(dir: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', `--initial-branch=${branch}`)
  return dir
}

function commit(repo: string, file: string, body = file): string {
  writeFileSync(join(repo, file), body)
  git(repo, 'add', '--', file)
  git(repo, 'commit', '--quiet', '-m', `touch ${file}`)
  return git(repo, 'rev-parse', 'HEAD')
}

/** A main repository with one commit and a linked worktree next to it. */
function repoWithWorktree(tag: string): { base: string; main: string; linked: string } {
  const base = freshDir(tag)
  const main = newRepo(join(base, 'main'))
  commit(main, 'README.md')
  const linked = join(base, 'linked')
  git(main, 'worktree', 'add', '--quiet', '-b', `${tag}-side`, linked)
  return { base, main, linked }
}

/**
 * A linked worktree whose pointers are relative, the layout of
 * `git worktree add --relative-paths` (git 2.48+). Older git gets the same two
 * files rewritten by hand, in the format newer git writes.
 */
function addRelativeWorktree(main: string, linked: string, branch: string): void {
  const native = Bun.spawnSync(
    ['git', 'worktree', 'add', '--quiet', '--relative-paths', '-b', branch, linked],
    { cwd: main, env: process.env, stdout: 'pipe', stderr: 'pipe' },
  )
  if (native.exitCode === 0) return
  git(main, 'worktree', 'add', '--quiet', '-b', branch, linked)
  const admin = join(main, '.git', 'worktrees', basename(linked))
  writeFileSync(join(linked, '.git'), `gitdir: ${relative(linked, admin)}\n`)
  writeFileSync(join(admin, 'gitdir'), `${relative(admin, join(linked, '.git'))}\n`)
}

describe('findGitRoot', () => {
  test('climbs from a directory, a nested directory or a file to the directory holding .git', () => {
    const repo = newRepo(join(freshDir('climb'), 'project'))
    mkdirSync(join(repo, 'src', 'inner'), { recursive: true })
    writeFileSync(join(repo, 'src', 'inner', 'leaf.ts'), '')
    expect(findGitRoot(repo)).toBe(repo)
    expect(findGitRoot(join(repo, 'src', 'inner'))).toBe(repo)
    expect(findGitRoot(join(repo, 'src', 'inner', 'leaf.ts'))).toBe(repo)
    expect(findGitRoot(`${join(repo, 'src')}/`)).toBe(repo)
  })

  test('a path that does not exist yet is answered by its ancestors', () => {
    const repo = newRepo(join(freshDir('ahead'), 'r'))
    expect(findGitRoot(join(repo, 'not', 'made', 'yet.txt'))).toBe(repo)
  })

  test('a .git regular file marks a root whatever it contains', () => {
    const checkout = join(freshDir('gitfile'), 'checkout')
    mkdirSync(join(checkout, 'pkg'), { recursive: true })
    writeFileSync(join(checkout, '.git'), 'no pointer in here\n')
    expect(findGitRoot(join(checkout, 'pkg'))).toBe(checkout)
  })

  test('the innermost repository wins', () => {
    const outer = newRepo(join(freshDir('nest'), 'outer'))
    const inner = newRepo(join(outer, 'third_party', 'inner'))
    expect(findGitRoot(join(inner, 'x'))).toBe(inner)
    expect(findGitRoot(join(outer, 'third_party'))).toBe(outer)
  })

  test('null when no ancestor holds .git', () => {
    expect(findGitRoot(join(freshDir('bare-land'), 'a', 'b'))).toBeNull()
  })

  test('a dangling .git symlink does not count, and the climb goes on', () => {
    const outer = newRepo(join(freshDir('dangle'), 'outer'))
    const child = join(outer, 'child')
    mkdirSync(child)
    symlinkSync(join(outer, 'no-such-target'), join(child, '.git'))
    expect(findGitRoot(child)).toBe(outer)
  })

  test('symlinks are not resolved: a root is reported as reached, and a link into a subdirectory is not recognised', () => {
    const base = freshDir('links')
    const repo = newRepo(join(base, 'real'))
    mkdirSync(join(repo, 'lib'))
    symlinkSync(repo, join(base, 'to-root'))
    symlinkSync(join(repo, 'lib'), join(base, 'to-lib'))
    expect(findGitRoot(join(base, 'to-root', 'lib'))).toBe(join(base, 'to-root'))
    expect(findGitRoot(join(base, 'to-lib'))).toBeNull()
  })

  test('the root comes back NFC-normalized even when the directory is NFD on disk', () => {
    const repo = newRepo(join(freshDir('nfd'), 'cafe\u0301'))
    const composed = repo.normalize('NFC')
    expect(composed).not.toBe(repo)
    expect(findGitRoot(join(repo, 'inside'))).toBe(composed)
  })

  test('answers are remembered: a repository created after the first lookup is not noticed', () => {
    const dir = join(freshDir('memo'), 'later')
    mkdirSync(dir)
    expect(findGitRoot(dir)).toBeNull()
    newRepo(dir)
    expect(findGitRoot(dir)).toBeNull()
  })

  test('the memory is bounded: after many other lookups a path is examined again', () => {
    const dir = join(freshDir('evict'), 'later')
    mkdirSync(dir)
    expect(findGitRoot(dir)).toBeNull()
    newRepo(dir)
    const filler = freshDir('filler')
    for (let i = 0; i < 300; i++) findGitRoot(join(filler, `p${i}`))
    expect(findGitRoot(dir)).toBe(dir)
  })
})

describe('findCanonicalGitRoot', () => {
  test('a regular repository is its own canonical root', () => {
    const repo = newRepo(join(freshDir('canon'), 'repo'))
    commit(repo, 'a.txt')
    mkdirSync(join(repo, 'sub'))
    expect(findCanonicalGitRoot(join(repo, 'sub'))).toBe(repo)
  })

  test('a linked worktree maps to the main working tree, from any depth and through a symlink', () => {
    const { base, main, linked } = repoWithWorktree('wt')
    mkdirSync(join(linked, 'deep', 'er'), { recursive: true })
    symlinkSync(linked, join(base, 'linked-alias'))
    expect(findGitRoot(linked)).toBe(linked)
    expect(findCanonicalGitRoot(linked)).toBe(main)
    expect(findCanonicalGitRoot(join(linked, 'deep', 'er'))).toBe(main)
    expect(findCanonicalGitRoot(join(base, 'linked-alias'))).toBe(main)
  })

  test('a worktree of a bare repository maps to the bare repository directory', () => {
    const base = freshDir('bare-wt')
    const seed = newRepo(join(base, 'seed'))
    commit(seed, 'a.txt')
    const store = join(base, 'store.git')
    git(base, 'clone', '--quiet', '--bare', seed, store)
    const checkout = join(base, 'checkout')
    git(store, 'worktree', 'add', '--quiet', checkout, 'main')
    expect(findCanonicalGitRoot(checkout)).toBe(store)
  })

  test('a submodule stays its own root', () => {
    const base = freshDir('submodule')
    const lib = newRepo(join(base, 'lib'))
    commit(lib, 'lib.txt')
    const app = newRepo(join(base, 'app'))
    commit(app, 'app.txt')
    git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib, 'deps/lib')
    const sub = join(app, 'deps', 'lib')
    expect(findGitRoot(sub)).toBe(sub)
    expect(findCanonicalGitRoot(sub)).toBe(sub)
  })

  test('null outside any repository', () => {
    expect(findCanonicalGitRoot(freshDir('canon-none'))).toBeNull()
  })

  test('a .git file that is not a usable pointer leaves the directory as its own root', () => {
    const base = freshDir('junk')
    const noPrefix = join(base, 'no-prefix')
    mkdirSync(noPrefix)
    writeFileSync(join(noPrefix, '.git'), 'something else entirely\n')
    const nowhere = join(base, 'nowhere')
    mkdirSync(nowhere)
    writeFileSync(join(nowhere, '.git'), `gitdir: ${join(base, 'missing', 'admin')}\n`)
    expect(findCanonicalGitRoot(noPrefix)).toBe(noPrefix)
    expect(findCanonicalGitRoot(nowhere)).toBe(nowhere)
  })

  test('a worktree recorded with relative paths is not mapped to its main repository (kept for parity)', () => {
    const base = freshDir('relative')
    const main = newRepo(join(base, 'main'))
    commit(main, 'a.txt')
    const linked = join(base, 'rel-linked')
    addRelativeWorktree(main, linked, 'rel-side')
    const admin = join(main, '.git', 'worktrees', basename(linked))
    expect(readFileSync(join(linked, '.git'), 'utf8')).toStartWith('gitdir: ..')
    expect(isAbsolute(readFileSync(join(admin, 'gitdir'), 'utf8').trim())).toBe(false)
    expect(git(linked, 'rev-parse', '--show-toplevel')).toBe(linked)
    expect(findCanonicalGitRoot(linked)).toBe(linked)
  })

  test('answers are remembered: a removed worktree still maps to its main repository', () => {
    const { main, linked } = repoWithWorktree('gone')
    expect(findCanonicalGitRoot(linked)).toBe(main)
    git(main, 'worktree', 'remove', '--force', linked)
    expect(existsSync(linked)).toBe(false)
    expect(findCanonicalGitRoot(linked)).toBe(main)
  })

  describe('a forged .git pointer never borrows another repository', () => {
    test('an admin directory outside <common dir>/worktrees is refused', () => {
      const base = freshDir('forge-parent')
      const victim = newRepo(join(base, 'victim'))
      commit(victim, 'a.txt')
      const attacker = join(base, 'attacker')
      const admin = join(attacker, 'admin')
      mkdirSync(admin, { recursive: true })
      writeFileSync(join(admin, 'commondir'), join(victim, '.git'))
      writeFileSync(join(admin, 'gitdir'), join(attacker, '.git'))
      writeFileSync(join(attacker, '.git'), `gitdir: ${admin}\n`)
      expect(findCanonicalGitRoot(attacker)).toBe(attacker)
    })

    test("pointing at another repository's real worktree entry is refused", () => {
      const { base, main, linked } = repoWithWorktree('forge-entry')
      const attacker = join(base, 'attacker')
      mkdirSync(attacker)
      writeFileSync(join(attacker, '.git'), readFileSync(join(linked, '.git'), 'utf8'))
      expect(findCanonicalGitRoot(linked)).toBe(main)
      expect(findCanonicalGitRoot(attacker)).toBe(attacker)
    })

    test("a .git symlinked to another worktree's .git file is refused", () => {
      const { base, main, linked } = repoWithWorktree('forge-link')
      const attacker = join(base, 'attacker')
      mkdirSync(attacker)
      symlinkSync(join(linked, '.git'), join(attacker, '.git'))
      expect(findCanonicalGitRoot(linked)).toBe(main)
      expect(findCanonicalGitRoot(attacker)).toBe(attacker)
    })
  })
})

describe('resolveWorkspaceRoots and dedupeCanonicalRoots', () => {
  test('the cwd root comes first, then each extra directory, canonical, without repeats or non-repositories', () => {
    const { base, main, linked } = repoWithWorktree('ws')
    const other = newRepo(join(base, 'other'))
    mkdirSync(join(other, 'x'))
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(resolveWorkspaceRoots(linked, [main, plain, join(other, 'x'), other])).toEqual([main, other])
  })

  test('a cwd outside any repository contributes nothing', () => {
    const base = freshDir('ws-out')
    const plain = join(base, 'plain')
    mkdirSync(plain)
    const repo = newRepo(join(base, 'repo'))
    expect(resolveWorkspaceRoots(plain, [repo])).toEqual([repo])
    expect(resolveWorkspaceRoots(plain, [])).toEqual([])
  })

  test('dedupe keeps first occurrences in order and drops null and empty entries', () => {
    expect(dedupeCanonicalRoots(['/b', null, '', '/a', '/b', null, '/a'])).toEqual(['/b', '/a'])
  })
})

describe('findNestedGitRoots', () => {
  test('reports repositories below the base down to three levels, not below a found one, never the base', async () => {
    const base = newRepo(join(freshDir('mono'), 'mono'))
    const levelOne = newRepo(join(base, 'one'))
    const levelThree = newRepo(join(base, 'x', 'y', 'three'))
    newRepo(join(base, 'x', 'y', 'z', 'four'))
    newRepo(join(levelOne, 'inside-one'))
    const found = await findNestedGitRoots(base)
    expect([...found].sort()).toEqual([levelOne, levelThree].sort())
  })

  test('hidden directories and dependency or build output directories are skipped', async () => {
    const base = freshDir('noise')
    const kept = newRepo(join(base, 'kept'))
    const noisy = ['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
      '.next', '.turbo', '.cache', '.venv', 'venv', '__pycache__', '.hidden']
    for (const name of noisy) newRepo(join(base, name, 'buried'))
    newRepo(join(base, 'target-like'))
    const found = await findNestedGitRoots(base)
    expect([...found].sort()).toEqual([kept, join(base, 'target-like')].sort())
  })

  test('symlinked directories are not followed', async () => {
    const base = freshDir('nested-links')
    const scan = join(base, 'scan')
    mkdirSync(scan)
    const outside = newRepo(join(base, 'outside'))
    symlinkSync(outside, join(scan, 'alias'))
    expect(await findNestedGitRoots(scan)).toEqual([])
  })

  test('a linked worktree or a .git file below the base is reported through its canonical root', async () => {
    const { base, main } = repoWithWorktree('nested-wt')
    const scan = join(base, 'scan')
    mkdirSync(scan)
    git(main, 'worktree', 'add', '--quiet', '-b', 'scan-side', join(scan, 'wt'))
    const pointer = join(scan, 'pointer')
    mkdirSync(pointer)
    writeFileSync(join(pointer, '.git'), 'gitdir: ../elsewhere\n')
    expect([...(await findNestedGitRoots(scan))].sort()).toEqual([main, pointer].sort())
  })

  test('maxDepth and maxDirs bound the walk', async () => {
    const base = freshDir('bounds')
    const shallow = newRepo(join(base, 'a', 'shallow'))
    newRepo(join(base, 'a', 'b', 'deeper'))
    expect(await findNestedGitRoots(base, { maxDepth: 2 })).toEqual([shallow])
    const wide = freshDir('wide')
    const all = ['r1', 'r2', 'r3', 'r4', 'r5'].map(name => newRepo(join(wide, name)))
    const capped = await findNestedGitRoots(wide, { maxDirs: 2 })
    expect(capped).toHaveLength(2)
    for (const root of capped) expect(all).toContain(root)
    expect(await findNestedGitRoots(wide)).toHaveLength(5)
  })

  test('a missing base or a file as base yields an empty list', async () => {
    const base = freshDir('nested-missing')
    writeFileSync(join(base, 'file'), '')
    expect(await findNestedGitRoots(join(base, 'nope'))).toEqual([])
    expect(await findNestedGitRoots(join(base, 'file'))).toEqual([])
  })
})

describe('gitExe', () => {
  test('resolves git on PATH to an absolute path once and keeps that answer', () => {
    const first = gitExe()
    expect(first).toBe(Bun.which('git') ?? 'git')
    expect(isAbsolute(first)).toBe(true)
    const pathBefore = process.env.PATH
    process.env.PATH = freshDir('empty-path')
    try {
      expect(gitExe()).toBe(first)
    } finally {
      process.env.PATH = pathBefore
    }
  })
})

describe('getIsGit, dirIsInGitRepo, getGitDir', () => {
  test('getIsGit judges the session cwd at its first call and keeps the answer until its cache is cleared', async () => {
    const repo = newRepo(join(freshDir('isgit'), 'r'))
    mkdirSync(join(repo, 'deep'))
    const outside = freshDir('isgit-out')
    getIsGit.cache.clear?.()
    expect(await runWithCwdOverride(join(repo, 'deep'), () => getIsGit())).toBe(true)
    expect(await runWithCwdOverride(outside, () => getIsGit())).toBe(true)
    getIsGit.cache.clear?.()
    expect(await runWithCwdOverride(outside, () => getIsGit())).toBe(false)
    expect(await runWithCwdOverride(repo, () => getIsGit())).toBe(false)
    getIsGit.cache.clear?.()
  })

  test('dirIsInGitRepo answers whether a directory lies in a repository', async () => {
    const { base, linked } = repoWithWorktree('inrepo')
    expect(await dirIsInGitRepo(linked)).toBe(true)
    expect(await dirIsInGitRepo(join(linked, 'missing', 'child'))).toBe(true)
    expect(await dirIsInGitRepo(base)).toBe(false)
  })

  test('getGitDir: the .git directory of a checkout, the admin directory of a linked worktree, null elsewhere', async () => {
    const { base, main, linked } = repoWithWorktree('gitdir')
    mkdirSync(join(main, 'sub'))
    expect(await getGitDir(join(main, 'sub'))).toBe(join(main, '.git'))
    expect(await getGitDir(linked)).toBe(join(main, '.git', 'worktrees', basename(linked)))
    expect(await getGitDir(base)).toBeNull()
  })
})

describe('isCurrentDirectoryBareGitRepo (judges the session cwd)', () => {
  const judge = (dir: string): boolean => runWithCwdOverride(dir, () => isCurrentDirectoryBareGitRepo())

  test('a checkout root is not flagged, even with HEAD, objects/ and refs/ beside a valid .git', () => {
    const repo = newRepo(join(freshDir('bare-ok'), 'r'))
    writeFileSync(join(repo, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(repo, 'objects'))
    mkdirSync(join(repo, 'refs'))
    expect(judge(repo)).toBe(false)
  })

  test('a directory whose .git is a file is not flagged, whatever else it holds', () => {
    const { linked } = repoWithWorktree('bare-file')
    writeFileSync(join(linked, 'HEAD'), 'ref: refs/heads/x\n')
    mkdirSync(join(linked, 'objects'))
    expect(judge(linked)).toBe(false)
  })

  test('a real bare repository is flagged', () => {
    const store = join(freshDir('bare-real'), 'store.git')
    mkdirSync(store)
    git(store, 'init', '--quiet', '--bare')
    expect(judge(store)).toBe(true)
  })

  test('without .git, any single indicator flags the directory: a HEAD file, an objects/ or a refs/ directory', () => {
    const base = freshDir('bare-one')
    const withHead = join(base, 'head')
    const withObjects = join(base, 'objects-only')
    const withRefs = join(base, 'refs-only')
    for (const dir of [withHead, withObjects, withRefs]) mkdirSync(dir)
    writeFileSync(join(withHead, 'HEAD'), 'x')
    mkdirSync(join(withObjects, 'objects'))
    mkdirSync(join(withRefs, 'refs'))
    expect(judge(withHead)).toBe(true)
    expect(judge(withObjects)).toBe(true)
    expect(judge(withRefs)).toBe(true)
  })

  test('indicators of the wrong kind do not flag: HEAD as a directory, objects or refs as files', () => {
    const dir = freshDir('bare-kinds')
    mkdirSync(join(dir, 'HEAD'))
    writeFileSync(join(dir, 'objects'), '')
    writeFileSync(join(dir, 'refs'), '')
    expect(judge(dir)).toBe(false)
  })

  test('a .git directory without a regular HEAD file falls back to the indicators', () => {
    const base = freshDir('bare-broken')
    const noHead = join(base, 'no-head')
    mkdirSync(join(noHead, '.git'), { recursive: true })
    writeFileSync(join(noHead, 'HEAD'), 'ref: refs/heads/evil\n')
    const headDir = join(base, 'head-dir')
    mkdirSync(join(headDir, '.git', 'HEAD'), { recursive: true })
    mkdirSync(join(headDir, 'refs'))
    const quiet = join(base, 'quiet')
    mkdirSync(join(quiet, '.git'), { recursive: true })
    expect(judge(noHead)).toBe(true)
    expect(judge(headDir)).toBe(true)
    expect(judge(quiet)).toBe(false)
  })

  test('a plain directory is not flagged; a subdirectory of a checkout is judged on its own contents', () => {
    const repo = newRepo(join(freshDir('bare-sub'), 'r'))
    const plainSub = join(repo, 'plain')
    const refsSub = join(repo, 'docs')
    mkdirSync(plainSub)
    mkdirSync(join(refsSub, 'refs'), { recursive: true })
    expect(judge(freshDir('bare-plain'))).toBe(false)
    expect(judge(plainSub)).toBe(false)
    expect(judge(refsSub)).toBe(true)
  })
})
