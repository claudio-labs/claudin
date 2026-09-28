import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { type IsolatedGitEnv, isolateGitEnv } from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { getWorktreePaths } from 'src/vcs/git/repository/worktrees.js'

const scratch = new ScratchGit()
let env: IsolatedGitEnv

beforeAll(() => {
  env = isolateGitEnv(scratch.tempDir('home'))
})

afterAll(() => {
  env.restore()
  scratch.cleanup()
})

describe('getWorktreePaths', () => {
  test('from a worktree nested in the main tree, that worktree comes first', async () => {
    const main = scratch.repo('nested-order')
    const nested = join(main, '.claudin', 'worktrees', 'task')
    scratch.run(main, 'worktree', 'add', '-q', '-b', 'task', nested)
    mkdirSync(join(nested, 'src'))
    expect(await getWorktreePaths(join(nested, 'src'))).toEqual([nested, main])
    expect(await getWorktreePaths(main)).toEqual([main, nested])
  })
})
