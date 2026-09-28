import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  inProcessDir,
  type IsolatedGitEnv,
  isolateGitEnv,
} from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { getFileStatus, stashToCleanState } from 'src/vcs/git/repository/workingTree.js'

const scratch = new ScratchGit()
let env: IsolatedGitEnv

beforeAll(() => {
  env = isolateGitEnv(scratch.tempDir('home'))
})

afterAll(() => {
  env.restore()
  scratch.cleanup()
})

describe('stashToCleanState run from a subdirectory', () => {
  test('stashes tracked edits and untracked files above and below it', async () => {
    const repo = scratch.repo('stash-sub')
    scratch.put(repo, 'src/kept.ts', 'kept\n')
    scratch.run(repo, 'add', 'src/kept.ts')
    scratch.run(repo, 'commit', '-q', '-m', 'add src')
    scratch.put(repo, 'src/kept.ts', 'edited\n')
    scratch.put(repo, 'root-draft.txt', 'root\n')
    scratch.put(repo, 'src/draft.ts', 'draft\n')
    expect(await inProcessDir(join(repo, 'src'), () => stashToCleanState('from src'))).toBe(true)
    expect(scratch.run(repo, 'status', '--porcelain')).toBe('')
    expect(scratch.run(repo, 'stash', 'list')).toContain('from src')
    scratch.run(repo, 'stash', 'pop', '--quiet')
    expect(readFileSync(join(repo, 'root-draft.txt'), 'utf8')).toBe('root\n')
    expect(readFileSync(join(repo, 'src', 'draft.ts'), 'utf8')).toBe('draft\n')
    expect(readFileSync(join(repo, 'src', 'kept.ts'), 'utf8')).toBe('edited\n')
  })
})

describe('names git would quote in its default output', () => {
  const NAMES = ['sp ace.txt', 'caf\u00e9.txt', 'quote"d.txt', 'back\\slash.txt']

  test('getFileStatus returns them as they are on disk', async () => {
    const repo = scratch.repo('quoted-status')
    scratch.put(repo, 'tracked name.txt', 'one\n')
    scratch.run(repo, 'add', '--', 'tracked name.txt')
    scratch.run(repo, 'commit', '-q', '-m', 'spaced name')
    scratch.put(repo, 'tracked name.txt', 'two\n')
    for (const name of NAMES) scratch.put(repo, name, 'x\n')
    const status = await getFileStatus(repo)
    expect(status.tracked).toEqual(['tracked name.txt'])
    expect([...status.untracked].sort()).toEqual([...NAMES].sort())
  })

  test('stashToCleanState stashes them', async () => {
    const repo = scratch.repo('quoted-stash')
    for (const name of NAMES) scratch.put(repo, name, 'x\n')
    expect(await inProcessDir(repo, () => stashToCleanState('quoted names'))).toBe(true)
    expect(scratch.run(repo, 'status', '--porcelain')).toBe('')
  })
})
