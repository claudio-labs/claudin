import { describe, expect, test } from 'bun:test'
import { MemoryGitFiles } from 'src/vcs/git/__testutils__/memoryGitFiles.js'
import { headCommit, parseHead, resolveHead } from 'src/vcs/git/gitFilesystem/head.js'

const GIT_DIR = '/repo/.git'
const TIP = 'ab'.repeat(20)

function repoWith(head: string, refs: Record<string, string> = {}): MemoryGitFiles {
  const files: Record<string, string> = { [`${GIT_DIR}/HEAD`]: head }
  for (const [name, text] of Object.entries(refs)) files[`${GIT_DIR}/${name}`] = text
  return new MemoryGitFiles(files)
}

describe('parseHead', () => {
  test('a branch, another ref, a detached id', () => {
    expect(parseHead('ref: refs/heads/feature/x\n')).toEqual({ kind: 'branch', branch: 'feature/x' })
    expect(parseHead('ref: refs/tags/v1\n')).toEqual({ kind: 'ref', ref: 'refs/tags/v1' })
    expect(parseHead(`${TIP}\r\n`)).toEqual({ kind: 'detached', id: TIP })
  })

  test('no file, a refused name, a bad id: unreadable', () => {
    for (const text of [null, 'ref: refs/heads/a b\n', 'ref: refs/remotes/../../x\n', 'ref: refs/heads/\n', `${TIP} x\n`, '']) {
      expect(parseHead(text)).toEqual({ kind: 'unreadable' })
    }
  })

  test("F3: a reftable repository's placeholder branch is unreadable, not a branch called .invalid", () => {
    expect(parseHead('ref: refs/heads/.invalid\n')).toEqual({ kind: 'unreadable' })
  })
})

describe('resolveHead', () => {
  test('a branch with its tip, and a branch with no commit yet', async () => {
    const files = repoWith('ref: refs/heads/main\n', { 'refs/heads/main': `${TIP}\n` })
    expect(await resolveHead(GIT_DIR, files)).toEqual({ kind: 'branch', branch: 'main', id: TIP })
    const unborn = repoWith('ref: refs/heads/fresh\n')
    expect(await resolveHead(GIT_DIR, unborn)).toEqual({ kind: 'branch', branch: 'fresh', id: null })
    expect(headCommit(await resolveHead(GIT_DIR, unborn))).toBeNull()
  })

  test('HEAD on another ref reads as detached at that ref', async () => {
    const files = repoWith('ref: refs/remotes/origin/main\n', { 'refs/remotes/origin/main': `${TIP}\n` })
    expect(await resolveHead(GIT_DIR, files)).toEqual({ kind: 'detached', id: TIP })
  })

  test('F4: HEAD on another ref that resolves to nothing is unreadable, and has no commit', async () => {
    const head = await resolveHead(GIT_DIR, repoWith('ref: refs/remotes/origin/gone\n'))
    expect(head).toEqual({ kind: 'unreadable' })
    expect(headCommit(head)).toBeNull()
  })

  test('F1: a branch caught in a cycle keeps its name but has no commit', async () => {
    const files = repoWith('ref: refs/heads/a\n', {
      'refs/heads/a': 'ref: refs/heads/b\n',
      'refs/heads/b': 'ref: refs/heads/a\n',
    })
    expect(await resolveHead(GIT_DIR, files)).toEqual({ kind: 'branch', branch: 'a', id: null })
  })

  test("HEAD counts as the first of git's five reads", async () => {
    const refs: Record<string, string> = { 'refs/chain/0': `${TIP}\n` }
    for (let level = 1; level <= 4; level++) refs[`refs/chain/${level}`] = `ref: refs/chain/${level - 1}\n`
    expect(headCommit(await resolveHead(GIT_DIR, repoWith('ref: refs/chain/3\n', refs)))).toBe(TIP)
    expect(headCommit(await resolveHead(GIT_DIR, repoWith('ref: refs/chain/4\n', refs)))).toBeNull()
  })
})
