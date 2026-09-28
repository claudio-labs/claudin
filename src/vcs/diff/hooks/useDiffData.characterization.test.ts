/**
 * Characterization of `gitDiffResultToFiles`, which turns a repository's diff
 * numbers and hunks into the /diff reviewer's (and the explorer's) file list.
 *
 * Every case is a real repository in a temp directory, read with the real
 * `fetchGitDiff` and `fetchGitDiffHunks`, with git kept away from the user's
 * configuration. The `useDiffData` hook in the same file has no caller and is
 * not pinned (spec, finding 1).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync } from 'fs'
import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'
import { gitDiffResultToFiles } from 'src/vcs/diff/hooks/useDiffData.js'
import { isolateGitEnv, type IsolatedGitEnv } from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { fetchGitDiff, fetchGitDiffHunks } from 'src/vcs/git/gitDiff.js'

let scratch: ScratchGit
let env: IsolatedGitEnv

beforeEach(() => {
  scratch = new ScratchGit()
  env = isolateGitEnv(scratch.tempDir('home'))
  env.set('CLAUDIN_CONFIG_DIR', scratch.tempDir('config'))
})

afterEach(() => {
  env.restore()
  scratch.cleanup()
})

const numbered = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'

async function reviewerFiles(root: string): Promise<DiffFile[]> {
  const [numbers, hunks] = await Promise.all([fetchGitDiff(root), fetchGitDiffHunks(root)])
  if (!numbers) throw new Error(`no diff numbers for ${root}`)
  return gitDiffResultToFiles(numbers, hunks)
}

/** A plain entry, with the defaults a tracked text file gets. */
function entry(path: string, added: number, removed: number, extra: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    linesAdded: added,
    linesRemoved: removed,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
    isUntracked: false,
    ...extra,
  }
}

describe('the file list for a working tree', () => {
  test('every kind of change, with its flags, in case-insensitive name order', async () => {
    const root = scratch.repo('files')
    const seed: Record<string, string> = {
      'a.ts': 'const a = 1\nconst b = 2\n',
      'B.ts': 'export {}\nexport const B = 1\n',
      'img.bin': 'PNG\u0000\u0001\u0002\u0003 header\n',
      'old.ts': numbered(6, 'kept'),
      'r1.ts': numbered(10, 'mostly kept'),
      'script.sh': '#!/bin/sh\necho hi\n',
      'big.ts': numbered(201, 'before'),
      'edge.ts': numbered(200, 'before'),
    }
    for (const [path, text] of Object.entries(seed)) scratch.put(root, path, text)
    scratch.run(root, 'add', '.')
    scratch.run(root, 'commit', '-q', '-m', 'seed')

    scratch.put(root, 'a.ts', 'const a = 1\nconst b = 3\n')
    scratch.put(root, 'B.ts', 'export {}\nexport const B = 2\n')
    scratch.put(root, 'img.bin', 'PNG\u0000\u0009\u0008\u0007 header\n')
    scratch.run(root, 'mv', 'old.ts', 'moved.ts')
    scratch.run(root, 'mv', 'r1.ts', 'r2.ts')
    scratch.put(root, 'r2.ts', numbered(10, 'mostly kept').replace('line 3', 'line three'))
    scratch.run(root, 'add', 'r2.ts')
    chmodSync(`${root}/script.sh`, 0o755)
    scratch.put(root, 'big.ts', numbered(201, 'after'))
    scratch.put(root, 'edge.ts', numbered(200, 'after'))
    scratch.put(root, 'empty.ts', '')
    scratch.run(root, 'add', 'empty.ts')
    scratch.put(root, 'untracked.ts', 'new\nfile\n')

    const files = await reviewerFiles(root)

    expect(files).toStrictEqual([
      entry('a.ts', 1, 1),
      entry('B.ts', 1, 1),
      entry('big.ts', 201, 201, { isTruncated: true }),
      entry('edge.ts', 200, 200),
      entry('empty.ts', 0, 0, { isLargeFile: true }),
      entry('img.bin', 0, 0, { isBinary: true }),
      entry('moved.ts', 0, 0, { renamedFrom: 'old.ts' }),
      entry('r2.ts', 1, 1, { renamedFrom: 'r1.ts' }),
      entry('script.sh', 0, 0, { isLargeFile: true }),
      entry('untracked.ts', 0, 0, { isUntracked: true }),
    ])
  })

  test('a clean repository gives an empty list', async () => {
    const root = scratch.repo('clean')
    expect(await reviewerFiles(root)).toStrictEqual([])
  })

  test('when the hunks are too big to fetch, every tracked text file reads as large', async () => {
    const root = scratch.repo('huge')
    scratch.put(root, 'huge.txt', 'seed\n')
    scratch.put(root, 'small.ts', 'one\n')
    scratch.put(root, 'pic.bin', 'GIF\u0000\u0001\n')
    scratch.run(root, 'add', '.')
    scratch.run(root, 'commit', '-q', '-m', 'seed')

    scratch.put(root, 'huge.txt', numbered(20_000, 'a fairly long filler text to pass one megabyte'))
    scratch.put(root, 'small.ts', 'two\n')
    scratch.put(root, 'pic.bin', 'GIF\u0000\u0002\n')
    scratch.put(root, 'loose.txt', 'untracked\n')

    const files = await reviewerFiles(root)

    expect(files).toStrictEqual([
      entry('huge.txt', 20_000, 1, { isLargeFile: true }),
      entry('loose.txt', 0, 0, { isUntracked: true }),
      entry('pic.bin', 0, 0, { isBinary: true }),
      entry('small.ts', 1, 1, { isLargeFile: true }),
    ])
  })
})
