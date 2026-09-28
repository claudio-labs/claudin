// The pure readers of git's machine output: status, ahead/behind counts and
// the worktree list.
import { describe, expect, test } from 'bun:test'
import { parseAheadBehind } from 'src/vcs/git/repository/aheadBehind.js'
import { parseStatusPorcelain } from 'src/vcs/git/repository/statusPorcelain.js'
import { currentWorktreeFirst, parseWorktreeList } from 'src/vcs/git/repository/worktreeList.js'

const nulTerminated = (...fields: string[]): string => `${fields.join('\0')}\0`

describe('parseStatusPorcelain', () => {
  test('names come through as written: spaces, quotes, backslashes, newlines and non-ASCII are not quoted', () => {
    const output = nulTerminated(
      ' M sp ace.txt',
      '?? caf\u00e9.txt',
      '?? quote"d.txt',
      '?? back\\slash.txt',
      'A  new\nline.txt',
    )
    expect(parseStatusPorcelain(output)).toEqual({
      tracked: ['sp ace.txt', 'new\nline.txt'],
      untracked: ['caf\u00e9.txt', 'quote"d.txt', 'back\\slash.txt'],
    })
  })

  test('a rename or a copy is one tracked entry under its new name, whichever column carries it', () => {
    const output = nulTerminated(
      'R  new-name.txt',
      'old-name.txt',
      'C  copy.txt',
      'original.txt',
      ' R moved.txt',
      'was-here.txt',
      '?? d',
    )
    expect(parseStatusPorcelain(output)).toEqual({
      tracked: ['new-name.txt', 'copy.txt', 'moved.txt'],
      untracked: ['d'],
    })
  })

  test('nothing to report gives two empty lists', () => {
    expect(parseStatusPorcelain('')).toEqual({ tracked: [], untracked: [] })
  })
})

describe('parseAheadBehind', () => {
  test("HEAD's side first, then the upstream's", () => {
    expect(parseAheadBehind('3\t1\n')).toEqual({ ahead: 3, behind: 1 })
  })

  test('anything else counts as zeros', () => {
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 })
    expect(parseAheadBehind('fatal: no upstream')).toEqual({ ahead: 0, behind: 0 })
  })
})

const LISTING = [
  'worktree /repo/main',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/main/.claudin/worktrees/task',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/task',
  '',
  'worktree /repo/other',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n')

describe('parseWorktreeList', () => {
  test("takes every worktree path in git's order, NFC, tolerating CRLF", () => {
    expect(parseWorktreeList(LISTING)).toEqual([
      '/repo/main',
      '/repo/main/.claudin/worktrees/task',
      '/repo/other',
    ])
    expect(parseWorktreeList('worktree /w/nai\u0308ve\r\nbare\r\n')).toEqual(['/w/na\u00efve'])
  })
})

describe('currentWorktreeFirst', () => {
  const paths = parseWorktreeList(LISTING)

  test('a worktree nested in the main tree comes first when cwd is inside it', () => {
    expect(currentWorktreeFirst(paths, '/repo/main/.claudin/worktrees/task/src')).toEqual([
      '/repo/main/.claudin/worktrees/task',
      '/repo/main',
      '/repo/other',
    ])
  })

  test('from the main tree itself, the main tree comes first', () => {
    expect(currentWorktreeFirst(paths, '/repo/main/lib')).toEqual([
      '/repo/main',
      '/repo/main/.claudin/worktrees/task',
      '/repo/other',
    ])
  })

  test('a sibling that only shares a name prefix does not hold cwd', () => {
    expect(currentWorktreeFirst(['/r/a', '/r/wt'], '/r/wt2/x')).toEqual(['/r/a', '/r/wt'])
    expect(currentWorktreeFirst(['/r/wt', '/r/wt2'], '/r/wt2/x')).toEqual(['/r/wt2', '/r/wt'])
  })

  test('with no tree holding cwd, all come back in localeCompare order', () => {
    expect(currentWorktreeFirst(['/r/b', '/r/C', '/r/a'], '/elsewhere')).toEqual([
      '/r/a',
      '/r/b',
      '/r/C',
    ])
  })
})
