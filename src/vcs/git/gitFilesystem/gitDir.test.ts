import { describe, expect, test } from 'bun:test'
import { MemoryGitFiles } from 'src/vcs/git/__testutils__/memoryGitFiles.js'
import {
  createGitDirLocator,
  parseGitFile,
  readCommonDir,
  readGitFile,
} from 'src/vcs/git/gitFilesystem/gitDir.js'

describe('parseGitFile', () => {
  test('an absolute target as written, a relative one from the holding directory', () => {
    expect(parseGitFile('gitdir: /main/.git/worktrees/wt\n', '/wt')).toBe('/main/.git/worktrees/wt')
    expect(parseGitFile('gitdir: ../../.git/modules/lib\n', '/outer/mods/lib')).toBe('/outer/.git/modules/lib')
  })

  test('laxer than git: CRLF, no blank after the colon, blanks before gitdir:', () => {
    for (const text of ['gitdir: /g\r\n', 'gitdir:/g', '  gitdir: /g \n']) {
      expect(parseGitFile(text, '/w')).toBe('/g')
    }
  })

  // F5: git refuses each of these; the old reader answered a path anyway.
  test.each([
    ['no gitdir: prefix', '/elsewhere/.git\n'],
    ['the prefix in another case', 'GITDIR: /g\n'],
    ['nothing after the prefix', 'gitdir:   \n'],
    ['several lines', 'gitdir: /g\nextra\n'],
    ['a NUL in the path', 'gitdir: /g\0x\n'],
  ])('F5: %s names nothing', (_label, text) => {
    expect(parseGitFile(text, '/w')).toBeNull()
  })
})

describe('readGitFile', () => {
  test('F5: a target that is not an existing directory names nothing', async () => {
    const files = new MemoryGitFiles({
      '/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
      '/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/x\n',
    })
    expect(await readGitFile('/wt', files)).toBe('/main/.git/worktrees/wt')
    files.remove('/main/.git/worktrees/wt/HEAD')
    expect(await readGitFile('/wt', files)).toBeNull()
  })

  test('no .git file: null', async () => {
    expect(await readGitFile('/nowhere', new MemoryGitFiles())).toBeNull()
  })
})

describe('readCommonDir', () => {
  test('relative from the git directory, absolute as written, empty as none', async () => {
    const files = new MemoryGitFiles({
      '/m/.git/worktrees/a/commondir': '../..\n',
      '/m/.git/worktrees/b/commondir': ' /srv/shared/.git \n',
      '/m/.git/worktrees/c/commondir': '  \n',
    })
    expect(await readCommonDir('/m/.git/worktrees/a', files)).toBe('/m/.git')
    expect(await readCommonDir('/m/.git/worktrees/b', files)).toBe('/srv/shared/.git')
    expect(await readCommonDir('/m/.git/worktrees/c', files)).toBeNull()
    expect(await readCommonDir('/m/.git', files)).toBeNull()
  })
})

describe('createGitDirLocator', () => {
  function locatorOver(files: MemoryGitFiles, roots: Record<string, string>, maxRemembered = 10) {
    const walked: string[] = []
    const locator = createGitDirLocator({
      files,
      findRoot: start => {
        walked.push(start)
        return roots[start] ?? null
      },
      defaultStart: () => '/cwd',
      maxRemembered,
    })
    return { locator, walked }
  }

  test('a .git directory, a gitfile, and no repository', async () => {
    const files = new MemoryGitFiles({
      '/plain/.git/HEAD': 'ref: refs/heads/main\n',
      '/linked/.git': 'gitdir: /plain/.git\n',
    })
    const { locator } = locatorOver(files, { '/plain/src': '/plain', '/linked': '/linked' })
    expect(await locator.locate('/plain/src')).toBe('/plain/.git')
    expect(await locator.locate('/linked')).toBe('/plain/.git')
    expect(await locator.locate('/outside')).toBeNull()
  })

  test('without a path it starts from the default start, resolved', async () => {
    const files = new MemoryGitFiles({ '/cwd/.git/HEAD': 'x' })
    const { locator, walked } = locatorOver(files, { '/cwd': '/cwd' })
    expect(await locator.locate()).toBe('/cwd/.git')
    expect(walked).toEqual(['/cwd'])
  })

  test('answers, a null among them, are remembered until forget()', async () => {
    const files = new MemoryGitFiles()
    const { locator, walked } = locatorOver(files, {})
    expect(await locator.locate('/a')).toBeNull()
    expect(await locator.locate('/a/')).toBeNull()
    expect(walked).toEqual(['/a'])
    locator.forget()
    await locator.locate('/a')
    expect(walked).toEqual(['/a', '/a'])
  })

  test('the memory is bounded: the least recently asked path is looked up again', async () => {
    const { locator, walked } = locatorOver(new MemoryGitFiles(), {}, 2)
    for (const start of ['/a', '/b', '/c', '/a']) await locator.locate(start)
    expect(walked).toEqual(['/a', '/b', '/c', '/a'])
  })
})
