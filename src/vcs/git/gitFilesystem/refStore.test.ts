import { describe, expect, test } from 'bun:test'
import { MemoryGitFiles } from 'src/vcs/git/__testutils__/memoryGitFiles.js'
import {
  filesRefStore,
  findPackedRef,
  MAX_REF_READS,
  parseLooseRef,
  type RefStore,
  resolveRefToId,
} from 'src/vcs/git/gitFilesystem/refStore.js'

const GIT_DIR = '/repo/.git'
const TIP = 'ab'.repeat(20)

function storeOf(files: Record<string, string>): { store: RefStore; disk: MemoryGitFiles } {
  const disk = new MemoryGitFiles(files)
  return { store: filesRefStore(GIT_DIR, disk), disk }
}

function looseReads(disk: MemoryGitFiles): string[] {
  return disk.reads.filter(path => path.includes('/refs/'))
}

describe('F1: symbolic ref chains are bounded like git', () => {
  test('a two-ref cycle answers null after a bounded number of lookups', async () => {
    const { store, disk } = storeOf({
      [`${GIT_DIR}/refs/heads/a`]: 'ref: refs/heads/b\n',
      [`${GIT_DIR}/refs/heads/b`]: 'ref: refs/heads/a\n',
    })
    expect(await resolveRefToId(store, 'refs/heads/a')).toBeNull()
    expect(looseReads(disk)).toHaveLength(MAX_REF_READS)
  })

  test('a ref that names itself answers null', async () => {
    const { store } = storeOf({ [`${GIT_DIR}/refs/heads/self`]: 'ref: refs/heads/self\n' })
    expect(await resolveRefToId(store, 'refs/heads/self')).toBeNull()
  })

  test('four hops resolve and five do not, where git stops too', async () => {
    const files: Record<string, string> = { [`${GIT_DIR}/refs/chain/0`]: `${TIP}\n` }
    for (let level = 1; level <= 5; level++) {
      files[`${GIT_DIR}/refs/chain/${level}`] = `ref: refs/chain/${level - 1}\n`
    }
    const { store } = storeOf(files)
    expect(await resolveRefToId(store, 'refs/chain/4')).toBe(TIP)
    expect(await resolveRefToId(store, 'refs/chain/5')).toBeNull()
  })

  test('a caller can spend part of the budget elsewhere', async () => {
    const { store } = storeOf({
      [`${GIT_DIR}/refs/heads/one`]: 'ref: refs/heads/two\n',
      [`${GIT_DIR}/refs/heads/two`]: `${TIP}\n`,
    })
    expect(await resolveRefToId(store, 'refs/heads/one', 2)).toBe(TIP)
    expect(await resolveRefToId(store, 'refs/heads/one', 1)).toBeNull()
  })
})

describe('filesRefStore: where a name is looked up', () => {
  test('a linked worktree git directory: its own refs, then the common dir', async () => {
    const worktreeGitDir = '/main/.git/worktrees/wt'
    const disk = new MemoryGitFiles({
      [`${worktreeGitDir}/commondir`]: '../..\n',
      [`${worktreeGitDir}/refs/bisect/bad`]: `${TIP}\n`,
      '/main/.git/refs/heads/main': `${'cd'.repeat(20)}\n`,
    })
    const store = filesRefStore(worktreeGitDir, disk)
    expect(await resolveRefToId(store, 'refs/bisect/bad')).toBe(TIP)
    expect(await resolveRefToId(store, 'refs/heads/main')).toBe('cd'.repeat(20))
    expect(await resolveRefToId(store, 'refs/heads/none')).toBeNull()
  })

  test('a broken loose ref is final: neither packed-refs nor the common dir is asked', async () => {
    const worktreeGitDir = '/main/.git/worktrees/wt'
    const disk = new MemoryGitFiles({
      [`${worktreeGitDir}/commondir`]: '../..\n',
      [`${worktreeGitDir}/refs/heads/x`]: 'garbage\n',
      [`${worktreeGitDir}/packed-refs`]: `${TIP} refs/heads/x\n`,
      '/main/.git/refs/heads/x': `${TIP}\n`,
    })
    expect(await resolveRefToId(filesRefStore(worktreeGitDir, disk), 'refs/heads/x')).toBeNull()
  })

  test('a commondir naming the git directory itself is not searched twice', async () => {
    const disk = new MemoryGitFiles({ [`${GIT_DIR}/commondir`]: '.\n' })
    expect(await resolveRefToId(filesRefStore(GIT_DIR, disk), 'refs/heads/none')).toBeNull()
    expect(disk.reads.filter(path => path.endsWith('/refs/heads/none'))).toHaveLength(1)
  })
})

describe('parseLooseRef', () => {
  test('ref: with any blanks after the colon, or none, is symbolic', () => {
    for (const text of ['ref: refs/heads/main\n', 'ref:refs/heads/main', 'ref: \t refs/heads/main \r\n']) {
      expect(parseLooseRef(text)).toEqual({ kind: 'symbolic', target: 'refs/heads/main' })
    }
  })

  test('one full id, surrounding blanks ignored; anything else is broken', () => {
    expect(parseLooseRef(`  ${TIP} \r\n`)).toEqual({ kind: 'object', id: TIP })
    for (const text of [TIP.toUpperCase(), TIP.slice(0, 12), `${TIP} extra`, '']) {
      expect(parseLooseRef(text)).toEqual({ kind: 'broken' })
    }
  })
})

describe('findPackedRef', () => {
  const packed = [
    '# pack-refs with: peeled fully-peeled sorted ',
    `${TIP} refs/heads/main`,
    `${'cd'.repeat(20)} refs/tags/v1`,
    `^${'ef'.repeat(20)}`,
    `${'AB'.repeat(20)} refs/heads/upper`,
    '',
  ].join('\n')

  test('the entry whose name is exactly the one asked for', () => {
    expect(findPackedRef(packed, 'refs/heads/main')).toEqual({ kind: 'object', id: TIP })
    expect(findPackedRef(packed, 'refs/tags/v1')).toEqual({ kind: 'object', id: 'cd'.repeat(20) })
    expect(findPackedRef(packed, 'refs/heads/mai')).toEqual({ kind: 'missing' })
  })

  test('the header and peeled lines are never entries', () => {
    expect(findPackedRef(packed, 'pack-refs with: peeled fully-peeled sorted ')).toEqual({ kind: 'missing' })
    expect(findPackedRef(packed, `^${'ef'.repeat(20)}`)).toEqual({ kind: 'missing' })
  })

  test('an entry whose id is not full lowercase hex is broken', () => {
    expect(findPackedRef(packed, 'refs/heads/upper')).toEqual({ kind: 'broken' })
  })

  test('CRLF line ends are read too', () => {
    expect(findPackedRef(`${TIP} refs/heads/main\r\n`, 'refs/heads/main')).toEqual({ kind: 'object', id: TIP })
  })
})
