/**
 * Characterization of the direct readers in src/vcs/git/gitFilesystem.ts:
 * everything that answers a question about a repository by reading its .git
 * directory instead of running git. Each answer is compared with what git
 * itself reports for the same repository, built for real in a temp directory.
 * Where the module deliberately parts from git, the test says so in its name.
 *
 * The cached getters live in gitFilesystem.cache.characterization.test.ts and
 * the config reader in gitFilesystem.config.characterization.test.ts.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import {
  clearResolveGitDirCache,
  getCommonDir,
  getHeadForDir,
  getRemoteUrlForDir,
  getWorktreeCountFromFs,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from 'src/vcs/git/gitFilesystem.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

/** Ids recorded in the fixtures, which git 2.55.0 wrote with a fixed clock. */
const FIXTURE_FIRST_COMMIT = 'c926b124dcf7a73c78746d8ecf4e90e5993986b2'
const FIXTURE_SECOND_COMMIT = 'b0e2e36f2ecd3d4e89ea1410b6157974b65d97b7'
const FIXTURE_TAG_OBJECT = '9c8a10389c920cde49ef50e195833d93fa5a4b44'

const runningAsRoot = process.getuid?.() === 0

function gitSays(cwd: string, ...args: string[]): string {
  return scratch.run(cwd, ...args)
}

function listedWorktrees(cwd: string): number {
  return gitSays(cwd, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter(line => line.startsWith('worktree ')).length
}

/** A main repository with one linked worktree checked out on `branch`. */
function withLinkedWorktree(branch = 'side'): { main: string; worktree: string; worktreeGitDir: string } {
  const main = scratch.repo('main')
  const worktree = join(scratch.tempDir('linked'), 'wt')
  gitSays(main, 'worktree', 'add', '-q', '-b', branch, worktree)
  return { main, worktree, worktreeGitDir: join(main, '.git', 'worktrees', 'wt') }
}

function withSubmodule(): { outer: string; inner: string } {
  const library = scratch.repo('library')
  const outer = scratch.repo('outer')
  gitSays(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'mods/lib')
  return { outer, inner: join(outer, 'mods', 'lib') }
}

describe('resolveGitDir: the git directory a path belongs to', () => {
  test('a repository root answers <root>/.git, the directory git reports', async () => {
    const repo = scratch.repo('plain')
    expect(await resolveGitDir(repo)).toBe(join(repo, '.git'))
    expect(await resolveGitDir(repo)).toBe(gitSays(repo, 'rev-parse', '--absolute-git-dir'))
  })

  test('a subdirectory, a file, and a path that does not exist all walk up to the same answer', async () => {
    const repo = scratch.repo('walk')
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    const expected = join(repo, '.git')
    expect(await resolveGitDir(join(repo, 'src', 'deep'))).toBe(expected)
    expect(await resolveGitDir(join(repo, 'notes.txt'))).toBe(expected)
    expect(await resolveGitDir(join(repo, 'no', 'such', 'place'))).toBe(expected)
    expect(gitSays(join(repo, 'src', 'deep'), 'rev-parse', '--absolute-git-dir')).toBe(expected)
  })

  test('with no argument it answers for the session working directory, runWithCwdOverride included', async () => {
    const repo = scratch.repo('ambient')
    mkdirSync(join(repo, 'pkg'))
    const answer = await runWithCwdOverride(join(repo, 'pkg'), () => resolveGitDir())
    expect(answer).toBe(join(repo, '.git'))
  })

  test('outside every repository the answer is null', async () => {
    expect(await resolveGitDir(scratch.tempDir('bare-dir'))).toBeNull()
  })

  test('the innermost repository wins when one sits inside another', async () => {
    const outer = scratch.repo('nest-outer')
    const inner = join(outer, 'vendor', 'inner')
    mkdirSync(inner, { recursive: true })
    gitSays(inner, 'init', '-q', '-b', 'main')
    expect(await resolveGitDir(inner)).toBe(join(inner, '.git'))
    expect(await resolveGitDir(outer)).toBe(join(outer, '.git'))
    expect(await resolveGitDir(inner)).toBe(gitSays(inner, 'rev-parse', '--absolute-git-dir'))
  })

  test('a linked worktree answers the directory named by its .git file, as git does', async () => {
    const { worktree, worktreeGitDir } = withLinkedWorktree()
    expect(await resolveGitDir(worktree)).toBe(worktreeGitDir)
    expect(await resolveGitDir(worktree)).toBe(gitSays(worktree, 'rev-parse', '--absolute-git-dir'))
  })

  test('a submodule answers its relative gitdir, resolved from the directory of its .git file', async () => {
    const { outer, inner } = withSubmodule()
    expect(await resolveGitDir(inner)).toBe(join(outer, '.git', 'modules', 'mods', 'lib'))
    expect(await resolveGitDir(inner)).toBe(gitSays(inner, 'rev-parse', '--absolute-git-dir'))
  })

  test('a repository made with --separate-git-dir answers the separate directory', async () => {
    const elsewhere = join(scratch.tempDir('separate'), 'store')
    const worktree = scratch.tempDir('separate-wt')
    gitSays(worktree, 'init', '-q', '-b', 'main', `--separate-git-dir=${elsewhere}`)
    expect(await resolveGitDir(worktree)).toBe(elsewhere)
    expect(await resolveGitDir(worktree)).toBe(gitSays(worktree, 'rev-parse', '--absolute-git-dir'))
  })

  test('the gitdir line may end in CRLF, which git accepts too', async () => {
    const target = scratch.repo('crlf-target')
    const pointer = scratch.tempDir('crlf-pointer')
    writeFileSync(join(pointer, '.git'), `gitdir: ${join(target, '.git')}\r\n`)
    expect(await resolveGitDir(pointer)).toBe(join(target, '.git'))
    expect(gitSays(pointer, 'rev-parse', '--absolute-git-dir')).toBe(join(target, '.git'))
  })

  test('laxer than git: no blank after "gitdir:" and blanks before it are accepted', async () => {
    const target = scratch.repo('lax-target')
    const tight = scratch.tempDir('lax-tight')
    writeFileSync(join(tight, '.git'), `gitdir:${join(target, '.git')}\n`)
    const indented = scratch.tempDir('lax-indented')
    writeFileSync(join(indented, '.git'), `  gitdir: ${join(target, '.git')}\n`)

    expect(await resolveGitDir(tight)).toBe(join(target, '.git'))
    expect(await resolveGitDir(indented)).toBe(join(target, '.git'))
    expect(scratch.attempt(tight, 'rev-parse', '--git-dir').ok).toBe(false)
    expect(scratch.attempt(indented, 'rev-parse', '--git-dir').ok).toBe(false)
  })

  test('symlinks on the way stay in the answer, where git reports the real path', async () => {
    const repo = scratch.repo('real')
    const link = join(scratch.tempDir('links'), 'alias')
    symlinkSync(repo, link)
    expect(await resolveGitDir(link)).toBe(join(link, '.git'))
    expect(gitSays(link, 'rev-parse', '--absolute-git-dir')).toBe(join(repo, '.git'))
  })

  test('a bare repository has no .git entry and is not recognised, although git works in it', async () => {
    const bare = scratch.tempDir('bare')
    gitSays(bare, 'init', '-q', '--bare')
    expect(await resolveGitDir(bare)).toBeNull()
    expect(gitSays(bare, 'rev-parse', '--absolute-git-dir')).toBe(bare)
  })

  test('answers are remembered per start path until clearResolveGitDirCache()', async () => {
    const first = scratch.repo('memo-first')
    const second = scratch.repo('memo-second')
    const pointer = scratch.tempDir('memo-pointer')
    mkdirSync(join(pointer, 'below'))
    writeFileSync(join(pointer, '.git'), `gitdir: ${join(first, '.git')}\n`)
    expect(await resolveGitDir(pointer)).toBe(join(first, '.git'))

    writeFileSync(join(pointer, '.git'), `gitdir: ${join(second, '.git')}\n`)
    expect(await resolveGitDir(pointer)).toBe(join(first, '.git'))
    expect(await resolveGitDir(join(pointer, 'below'))).toBe(join(second, '.git'))

    clearResolveGitDirCache()
    expect(await resolveGitDir(pointer)).toBe(join(second, '.git'))
  })

  test.skipIf(runningAsRoot)('a null answer is remembered as well: an unreadable .git file', async () => {
    const target = scratch.repo('locked-target')
    const pointer = scratch.tempDir('locked')
    const gitFile = join(pointer, '.git')
    writeFileSync(gitFile, `gitdir: ${join(target, '.git')}\n`)
    chmodSync(gitFile, 0o000)
    try {
      expect(await resolveGitDir(pointer)).toBeNull()
      chmodSync(gitFile, 0o644)
      expect(await resolveGitDir(pointer)).toBeNull()
      clearResolveGitDirCache()
      expect(await resolveGitDir(pointer)).toBe(join(target, '.git'))
    } finally {
      chmodSync(gitFile, 0o644)
    }
  })
})

describe('getCommonDir: where a linked worktree keeps its shared refs and config', () => {
  test('a linked worktree answers the main .git, as git --git-common-dir does', async () => {
    const { main, worktree, worktreeGitDir } = withLinkedWorktree()
    expect(await getCommonDir(worktreeGitDir)).toBe(join(main, '.git'))
    expect(gitSays(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(
      join(main, '.git'),
    )
  })

  test('a main repository and a submodule have no commondir file: null', async () => {
    const { outer, inner } = withSubmodule()
    expect(await getCommonDir(join(outer, '.git'))).toBeNull()
    expect(await getCommonDir((await resolveGitDir(inner))!)).toBeNull()
    expect(await getCommonDir(join(scratch.tempDir('nothing'), '.git'))).toBeNull()
  })

  test('an absolute commondir is taken as it is, blanks around it ignored', async () => {
    const gitDir = scratch.tempDir('abs-common')
    writeFileSync(join(gitDir, 'commondir'), '  /srv/shared/.git \n')
    expect(await getCommonDir(gitDir)).toBe('/srv/shared/.git')
  })
})

describe('resolveRef: a ref name to an object id', () => {
  test('a loose ref answers its id, as git rev-parse does: branches, light and annotated tags', async () => {
    const repo = scratch.repo('loose')
    gitSays(repo, 'tag', 'light')
    gitSays(repo, 'tag', '-a', 'heavy', '-m', 'annotated')
    const gitDir = join(repo, '.git')
    for (const ref of ['refs/heads/main', 'refs/tags/light', 'refs/tags/heavy']) {
      expect(await resolveRef(gitDir, ref)).toBe(gitSays(repo, 'rev-parse', ref))
    }
    expect(await resolveRef(gitDir, 'refs/tags/heavy')).not.toBe(gitSays(repo, 'rev-parse', 'HEAD'))
  })

  test('after git pack-refs the same refs resolve through packed-refs', async () => {
    const repo = scratch.repo('packed')
    gitSays(repo, 'branch', 'topic')
    gitSays(repo, 'tag', '-a', 'v2', '-m', 'annotated')
    gitSays(repo, 'pack-refs', '--all')
    const gitDir = join(repo, '.git')
    for (const ref of ['refs/heads/main', 'refs/heads/topic', 'refs/tags/v2']) {
      expect(await resolveRef(gitDir, ref)).toBe(gitSays(repo, 'rev-parse', ref))
    }
    expect(await getHeadForDir(repo)).toBe(gitSays(repo, 'rev-parse', 'HEAD'))
  })

  test('a loose ref wins over the packed entry of the same name', async () => {
    const repo = scratch.repo('shadow')
    const old = gitSays(repo, 'rev-parse', 'HEAD')
    gitSays(repo, 'pack-refs', '--all')
    const newer = scratch.commit(repo, 'after packing')
    expect(await resolveRef(join(repo, '.git'), 'refs/heads/main')).toBe(newer)
    expect(newer).not.toBe(old)
    expect(gitSays(repo, 'rev-parse', 'refs/heads/main')).toBe(newer)
  })

  test('symbolic refs are followed, through chains of up to four like git', async () => {
    const repo = scratch.repo('chain')
    const gitDir = join(repo, '.git')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    scratch.put(gitDir, 'refs/chain/level0', `${tip}\n`)
    for (let level = 1; level <= 4; level++) {
      scratch.put(gitDir, `refs/chain/level${level}`, `ref: refs/chain/level${level - 1}\n`)
    }
    for (let level = 1; level <= 4; level++) {
      const ref = `refs/chain/level${level}`
      expect(await resolveRef(gitDir, ref)).toBe(tip)
      expect(gitSays(repo, 'rev-parse', ref)).toBe(tip)
    }
  })

  test("from a linked worktree's git directory: its own refs first, then the shared ones", async () => {
    const { main, worktree, worktreeGitDir } = withLinkedWorktree('side')
    const mark = scratch.commit(worktree, 'on side')
    gitSays(worktree, 'update-ref', 'refs/worktree/mark', mark)

    expect(await resolveRef(worktreeGitDir, 'HEAD')).toBe(gitSays(worktree, 'rev-parse', 'HEAD'))
    expect(await resolveRef(worktreeGitDir, 'refs/worktree/mark')).toBe(mark)
    expect(await resolveRef(worktreeGitDir, 'refs/heads/main')).toBe(gitSays(main, 'rev-parse', 'main'))
    expect(await resolveRef(join(main, '.git'), 'refs/worktree/mark')).toBeNull()
    expect(scratch.attempt(main, 'rev-parse', '--verify', '-q', 'refs/worktree/mark').ok).toBe(false)
  })

  test('an unknown ref and a missing directory answer null', async () => {
    const repo = scratch.repo('unknown')
    expect(await resolveRef(join(repo, '.git'), 'refs/heads/nowhere')).toBeNull()
    expect(await resolveRef(join(repo, 'missing', '.git'), 'refs/heads/main')).toBeNull()
  })

  test('a loose ref must hold one full lowercase id: anything else answers null', async () => {
    const repo = scratch.repo('bad-loose')
    const gitDir = join(repo, '.git')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    const contents = {
      upper: tip.toUpperCase(),
      short: tip.slice(0, 12),
      long: `${tip}0`,
      trailing: `${tip} extra`,
      shell: '$(touch /tmp/owned)',
      empty: '',
    }
    for (const [name, text] of Object.entries(contents)) {
      scratch.put(gitDir, `refs/odd/${name}`, `${text}\n`)
      expect(await resolveRef(gitDir, `refs/odd/${name}`)).toBeNull()
    }
    scratch.put(gitDir, 'refs/odd/padded', `  ${tip} \r\n`)
    expect(await resolveRef(gitDir, 'refs/odd/padded')).toBe(tip)
  })

  test('a broken loose ref hides the packed entry of the same name, as git ignores both', async () => {
    const repo = scratch.repo('broken-loose')
    gitSays(repo, 'branch', 'side')
    gitSays(repo, 'pack-refs', '--all')
    scratch.put(join(repo, '.git'), 'refs/heads/side', 'garbage\n')
    expect(await resolveRef(join(repo, '.git'), 'refs/heads/side')).toBeNull()
    expect(scratch.attempt(repo, 'rev-parse', '--verify', '-q', 'refs/heads/side').ok).toBe(false)
  })

  test('a symbolic ref whose target is not a safe name is refused, even when that file holds an id', async () => {
    const repo = scratch.repo('evil-symref')
    const gitDir = join(repo, '.git')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    scratch.put(gitDir, 'planted', `${tip}\n`)
    scratch.put(gitDir, 'refs/heads/escape', 'ref: refs/heads/../../planted\n')
    expect(await resolveRef(gitDir, 'refs/heads/escape')).toBeNull()
    scratch.put(gitDir, 'refs/heads/fine', 'ref: planted\n')
    expect(await resolveRef(gitDir, 'refs/heads/fine')).toBe(tip)
  })

  test('a packed entry with an id that is not full lowercase hex answers null', async () => {
    const gitDir = scratch.tempDir('bad-packed')
    const tip = 'ab'.repeat(20)
    writeFileSync(
      join(gitDir, 'packed-refs'),
      `${tip.toUpperCase()} refs/heads/upper\n${tip.slice(0, 20)} refs/heads/short\n${tip} refs/heads/good\n`,
    )
    expect(await resolveRef(gitDir, 'refs/heads/upper')).toBeNull()
    expect(await resolveRef(gitDir, 'refs/heads/short')).toBeNull()
    expect(await resolveRef(gitDir, 'refs/heads/good')).toBe(tip)
  })

  test('SHA-256 repositories: 64-character ids are read, as git reports them', async () => {
    const repo = scratch.repo('sha256', 'main', '--object-format=sha256')
    const head = gitSays(repo, 'rev-parse', 'HEAD')
    expect(head).toHaveLength(64)
    expect(await resolveRef(join(repo, '.git'), 'refs/heads/main')).toBe(head)
    expect(await getHeadForDir(repo)).toBe(head)
  })
})

describe('getHeadForDir: the commit HEAD names, for any directory', () => {
  test('on a branch: the branch tip, as git rev-parse HEAD', async () => {
    const repo = scratch.repo('on-branch')
    scratch.commit(repo, 'second')
    expect(await getHeadForDir(repo)).toBe(gitSays(repo, 'rev-parse', 'HEAD'))
  })

  test('detached: the id written in HEAD', async () => {
    const repo = scratch.repo('detached')
    const first = gitSays(repo, 'rev-parse', 'HEAD')
    scratch.commit(repo, 'second')
    gitSays(repo, 'checkout', '-q', '--detach', first)
    expect(await getHeadForDir(repo)).toBe(first)
    expect(gitSays(repo, 'rev-parse', 'HEAD')).toBe(first)
  })

  test('a branch with no commit yet answers null, and git has no HEAD commit either', async () => {
    const repo = scratch.tempDir('unborn')
    gitSays(repo, 'init', '-q', '-b', 'trunk')
    expect(await getHeadForDir(repo)).toBeNull()
    expect(scratch.attempt(repo, 'rev-parse', '--verify', '-q', 'HEAD').ok).toBe(false)
  })

  test('outside a repository null; a missing directory inside one answers for that repository', async () => {
    const repo = scratch.repo('enclosing')
    expect(await getHeadForDir(scratch.tempDir('loose-dir'))).toBeNull()
    expect(await getHeadForDir(join(repo, 'not', 'created'))).toBe(gitSays(repo, 'rev-parse', 'HEAD'))
  })

  test('HEAD naming another kind of ref answers that ref: a remote-tracking branch, an annotated tag', async () => {
    const repo = scratch.repo('other-ref')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    gitSays(repo, 'update-ref', 'refs/remotes/origin/main', tip)
    gitSays(repo, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/main')
    expect(await getHeadForDir(repo)).toBe(tip)
    expect(gitSays(repo, 'rev-parse', 'HEAD')).toBe(tip)

    gitSays(repo, 'tag', '-a', 'v9', '-m', 'annotated')
    gitSays(repo, 'symbolic-ref', 'HEAD', 'refs/tags/v9')
    expect(await getHeadForDir(repo)).toBe(gitSays(repo, 'rev-parse', 'HEAD'))
    expect(await getHeadForDir(repo)).toBe(gitSays(repo, 'rev-parse', 'refs/tags/v9'))
  })

  test('"ref:" takes no blank or several before the name, and CRLF, as git does', async () => {
    const repo = scratch.repo('head-syntax')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    for (const text of ['ref:refs/heads/main\n', 'ref: \t refs/heads/main \r\n']) {
      writeFileSync(join(repo, '.git', 'HEAD'), text)
      expect(await getHeadForDir(repo)).toBe(tip)
      expect(gitSays(repo, 'rev-parse', 'HEAD')).toBe(tip)
    }
  })

  test('branch names git allows that the module accepts', async () => {
    const repo = scratch.repo('good-names')
    const names = [
      'feature/login',
      'release-1.2.3+build',
      'dependabot/npm_and_yarn/@types/node-18.0.0',
      'UP/Case_9',
      'user@host',
      'v1.x',
    ]
    for (const name of names) {
      gitSays(repo, 'checkout', '-q', '-b', name)
      const tip = scratch.commit(repo, `work on ${name}`)
      expect(await getHeadForDir(repo)).toBe(tip)
      expect(gitSays(repo, 'branch', '--show-current')).toBe(name)
    }
  })

  test('branch names git allows but the module refuses: characters outside [A-Za-z0-9/._+@-]', async () => {
    const repo = scratch.repo('refused-names')
    for (const name of ['fix/#123', 'feature/ação', 'a,b', "user's", 'x=y', '{x}']) {
      gitSays(repo, 'checkout', '-q', '-b', name)
      expect(await getHeadForDir(repo)).toBeNull()
      expect(gitSays(repo, 'branch', '--show-current')).toBe(name)
      expect(gitSays(repo, 'rev-parse', 'HEAD')).toHaveLength(40)
    }
  })

  test('tampered branch names in HEAD are refused even when the file they name holds an id', async () => {
    const repo = scratch.repo('tampered')
    const gitDir = join(repo, '.git')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')
    const planted: Record<string, string> = {
      '../../planted': 'planted',
      '-rf': 'refs/heads/-rf',
      '/rooted': 'refs/heads/rooted',
      'a//b': 'refs/heads/a/b',
      'a/./b': 'refs/heads/a/b',
      'a..b': 'refs/heads/a..b',
      '$(touch owned)': 'refs/heads/$(touch owned)',
      'a;b': 'refs/heads/a;b',
      'a b': 'refs/heads/a b',
      'a\tb': 'refs/heads/a\tb',
      'a\nb': 'refs/heads/a\nb',
      'a`b`': 'refs/heads/a`b`',
      'up@{1}': 'refs/heads/up@{1}',
    }
    for (const [name, file] of Object.entries(planted)) {
      scratch.put(gitDir, file, `${tip}\n`)
      writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${name}\n`)
      expect(await getHeadForDir(repo)).toBeNull()
    }
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/remotes/../../planted\n')
    expect(await getHeadForDir(repo)).toBeNull()
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    expect(await getHeadForDir(repo)).toBe(tip)
  })

  test('a detached HEAD must be one full lowercase id; git also takes uppercase, the module does not', async () => {
    const repo = scratch.repo('bad-detached')
    const head = join(repo, '.git', 'HEAD')
    const tip = gitSays(repo, 'rev-parse', 'HEAD')

    writeFileSync(head, `${tip.toUpperCase()}\n`)
    expect(await getHeadForDir(repo)).toBeNull()
    expect(gitSays(repo, 'rev-parse', 'HEAD')).toBe(tip)

    for (const text of [tip.slice(0, 39), `${tip}f`, `${tip} x`, '$(reboot)', '']) {
      writeFileSync(head, `${text}\n`)
      expect(await getHeadForDir(repo)).toBeNull()
    }
    writeFileSync(head, `${tip}\r\n`)
    expect(await getHeadForDir(repo)).toBe(tip)
  })

  test('a submodule: its own HEAD, reached through its gitfile', async () => {
    const { inner } = withSubmodule()
    const expected = gitSays(inner, 'rev-parse', 'HEAD')
    expect(await getHeadForDir(inner)).toBe(expected)
  })
})

describe('readWorktreeHeadSha: HEAD of a linked worktree, without walking up', () => {
  test('a linked worktree on a branch: its tip, found through the common dir', async () => {
    const { worktree } = withLinkedWorktree('lane')
    const tip = scratch.commit(worktree, 'lane work')
    expect(await readWorktreeHeadSha(worktree)).toBe(tip)
    expect(gitSays(worktree, 'rev-parse', 'HEAD')).toBe(tip)
  })

  test('a detached linked worktree: the id in its HEAD', async () => {
    const main = scratch.repo('detached-main')
    const first = gitSays(main, 'rev-parse', 'HEAD')
    scratch.commit(main, 'moves main on')
    const worktree = join(scratch.tempDir('detached-linked'), 'wt')
    gitSays(main, 'worktree', 'add', '-q', '--detach', worktree, first)
    expect(await readWorktreeHeadSha(worktree)).toBe(first)
    expect(gitSays(worktree, 'rev-parse', 'HEAD')).toBe(first)
  })

  test('no upward walk: the main worktree and a missing path inside a repository answer null', async () => {
    const repo = scratch.repo('no-walk')
    expect(await readWorktreeHeadSha(repo)).toBeNull()
    expect(await readWorktreeHeadSha(join(repo, 'wt-never-made'))).toBeNull()
    expect(await getHeadForDir(join(repo, 'wt-never-made'))).not.toBeNull()
  })

  test('a worktree whose git directory is gone answers null', async () => {
    const { worktree, worktreeGitDir } = withLinkedWorktree()
    rmSync(worktreeGitDir, { recursive: true, force: true })
    expect(await readWorktreeHeadSha(worktree)).toBeNull()
  })

  test('a .git file without the exact "gitdir:" prefix answers null, as git refuses it', async () => {
    const target = scratch.repo('prefix-target')
    const dir = scratch.tempDir('no-prefix')
    writeFileSync(join(dir, '.git'), `GITDIR: ${join(target, '.git')}\n`)
    expect(await readWorktreeHeadSha(dir)).toBeNull()
    expect(scratch.attempt(dir, 'rev-parse', '--git-dir').ok).toBe(false)
    writeFileSync(join(dir, '.git'), `gitdir: ${join(target, '.git')}\n`)
    expect(await readWorktreeHeadSha(dir)).toBe(gitSays(target, 'rev-parse', 'HEAD'))
  })

  test('a submodule is read through its relative gitdir', async () => {
    const { inner } = withSubmodule()
    expect(await readWorktreeHeadSha(inner)).toBe(gitSays(inner, 'rev-parse', 'HEAD'))
  })
})

describe("getRemoteUrlForDir: origin's url for any directory", () => {
  test('the url git config --get remote.origin.url prints', async () => {
    const repo = scratch.repo('with-origin')
    gitSays(repo, 'remote', 'add', 'origin', 'git@example.com:team/app.git')
    expect(await getRemoteUrlForDir(repo)).toBe('git@example.com:team/app.git')
    expect(gitSays(repo, 'config', '--get', 'remote.origin.url')).toBe('git@example.com:team/app.git')
  })

  test('a linked worktree reads the config of the main repository', async () => {
    const { main, worktree } = withLinkedWorktree()
    gitSays(main, 'remote', 'add', 'origin', 'https://example.com/shared.git')
    expect(await getRemoteUrlForDir(worktree)).toBe('https://example.com/shared.git')
    expect(gitSays(worktree, 'remote', 'get-url', 'origin')).toBe('https://example.com/shared.git')
  })

  test('a submodule reads its own config: its origin is the repository it was cloned from', async () => {
    const { inner } = withSubmodule()
    expect(await getRemoteUrlForDir(inner)).toBe(gitSays(inner, 'config', '--get', 'remote.origin.url'))
  })

  test('no remote called origin, or no repository at all: null', async () => {
    const repo = scratch.repo('upstream-only')
    gitSays(repo, 'remote', 'add', 'upstream', 'https://example.com/up.git')
    expect(await getRemoteUrlForDir(repo)).toBeNull()
    expect(await getRemoteUrlForDir(scratch.tempDir('no-repo'))).toBeNull()
  })

  test('several urls: the first, which git remote get-url prints (git config --get prints the last)', async () => {
    const repo = scratch.repo('two-urls')
    gitSays(repo, 'remote', 'add', 'origin', 'https://first.example/r.git')
    gitSays(repo, 'remote', 'set-url', '--add', 'origin', 'https://second.example/r.git')
    expect(await getRemoteUrlForDir(repo)).toBe('https://first.example/r.git')
    expect(gitSays(repo, 'remote', 'get-url', 'origin')).toBe('https://first.example/r.git')
    expect(gitSays(repo, 'config', '--get', 'remote.origin.url')).toBe('https://second.example/r.git')
  })

  test('insteadOf rewriting is not applied: the url as configured, like git config --get', async () => {
    const repo = scratch.repo('rewrite')
    gitSays(repo, 'config', 'url.https://github.com/.insteadOf', 'gh:')
    gitSays(repo, 'remote', 'add', 'origin', 'gh:team/app')
    expect(await getRemoteUrlForDir(repo)).toBe('gh:team/app')
    expect(gitSays(repo, 'config', '--get', 'remote.origin.url')).toBe('gh:team/app')
    expect(gitSays(repo, 'remote', 'get-url', 'origin')).toBe('https://github.com/team/app')
  })
})

describe('getWorktreeCountFromFs: how many worktrees the repository has', () => {
  test('the main worktree plus each linked one, as git worktree list, from any of them', async () => {
    const main = scratch.repo('counted')
    const inMain = () => runWithCwdOverride(main, () => getWorktreeCountFromFs())
    expect(await inMain()).toBe(1)

    const parent = scratch.tempDir('count-links')
    gitSays(main, 'worktree', 'add', '-q', '-b', 'one', join(parent, 'one'))
    gitSays(main, 'worktree', 'add', '-q', '--detach', join(parent, 'two'))
    expect(await inMain()).toBe(3)
    expect(listedWorktrees(main)).toBe(3)
    expect(await runWithCwdOverride(join(parent, 'two'), () => getWorktreeCountFromFs())).toBe(3)
  })

  test('a worktree deleted without prune still counts, as in git worktree list, until git worktree prune', async () => {
    const main = scratch.repo('stale')
    const gone = join(scratch.tempDir('stale-link'), 'gone')
    gitSays(main, 'worktree', 'add', '-q', '-b', 'gone', gone)
    rmSync(gone, { recursive: true, force: true })
    expect(await runWithCwdOverride(main, () => getWorktreeCountFromFs())).toBe(2)
    expect(listedWorktrees(main)).toBe(2)

    gitSays(main, 'worktree', 'prune')
    expect(await runWithCwdOverride(main, () => getWorktreeCountFromFs())).toBe(1)
    expect(listedWorktrees(main)).toBe(1)
  })

  test('outside a repository: 0', async () => {
    const plain = scratch.tempDir('count-none')
    expect(await runWithCwdOverride(plain, () => getWorktreeCountFromFs())).toBe(0)
  })
})

describe('on-disk formats, from files git 2.55.0 wrote (__fixtures__/rewrite)', () => {
  test('packed-refs: header and peeled lines skipped, a tag answers its tag object', async () => {
    const root = scratch.tempDir('fixture-packed')
    const gitDir = join(root, '.git')
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true })
    copyFileSync(join(FIXTURES, 'packed-refs'), join(gitDir, 'packed-refs'))
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')

    expect(await resolveRef(gitDir, 'refs/heads/main')).toBe(FIXTURE_SECOND_COMMIT)
    expect(await resolveRef(gitDir, 'refs/heads/feature/x')).toBe(FIXTURE_FIRST_COMMIT)
    expect(await resolveRef(gitDir, 'refs/remotes/origin/main')).toBe(FIXTURE_FIRST_COMMIT)
    expect(await resolveRef(gitDir, 'refs/tags/light')).toBe(FIXTURE_FIRST_COMMIT)
    expect(await resolveRef(gitDir, 'refs/tags/v1.0')).toBe(FIXTURE_TAG_OBJECT)
    expect(await resolveRef(gitDir, 'refs/heads/feature')).toBeNull()
    expect(await getHeadForDir(root)).toBe(FIXTURE_SECOND_COMMIT)

    scratch.put(gitDir, 'refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/main\n')
    expect(await resolveRef(gitDir, 'refs/remotes/origin/HEAD')).toBe(FIXTURE_FIRST_COMMIT)
  })

  test("a submodule's gitfile holds a path relative to the submodule directory", async () => {
    const outer = scratch.tempDir('fixture-super')
    const moduleGitDir = join(outer, '.git', 'modules', 'mods', 'lib')
    scratch.put(moduleGitDir, 'HEAD', 'ref: refs/heads/main\n')
    scratch.put(moduleGitDir, 'refs/heads/main', `${FIXTURE_FIRST_COMMIT}\n`)
    const inner = join(outer, 'mods', 'lib')
    mkdirSync(inner, { recursive: true })
    copyFileSync(join(FIXTURES, 'gitfile-submodule'), join(inner, '.git'))

    expect(await resolveGitDir(inner)).toBe(moduleGitDir)
    expect(await readWorktreeHeadSha(inner)).toBe(FIXTURE_FIRST_COMMIT)
    expect(await getHeadForDir(inner)).toBe(FIXTURE_FIRST_COMMIT)
  })

  test("a linked worktree's commondir points back at the main git directory", async () => {
    const main = scratch.tempDir('fixture-main')
    const mainGitDir = join(main, '.git')
    const linkedGitDir = join(mainGitDir, 'worktrees', 'wt')
    scratch.put(mainGitDir, 'refs/heads/wt', `${FIXTURE_SECOND_COMMIT}\n`)
    scratch.put(linkedGitDir, 'HEAD', 'ref: refs/heads/wt\n')
    mkdirSync(linkedGitDir, { recursive: true })
    copyFileSync(join(FIXTURES, 'commondir'), join(linkedGitDir, 'commondir'))
    const worktree = join(scratch.tempDir('fixture-linked'), 'wt')
    scratch.put(worktree, '.git', `gitdir: ${linkedGitDir}\n`)

    expect(await getCommonDir(linkedGitDir)).toBe(mainGitDir)
    expect(await readWorktreeHeadSha(worktree)).toBe(FIXTURE_SECOND_COMMIT)
    expect(await resolveGitDir(worktree)).toBe(linkedGitDir)
    expect(await runWithCwdOverride(worktree, () => getWorktreeCountFromFs())).toBe(2)
  })
})
