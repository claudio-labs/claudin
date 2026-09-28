import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  inProcessDir,
  type IsolatedGitEnv,
  isolateGitEnv,
} from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { findRemoteBase } from 'src/vcs/git/repository/branches.js'

const scratch = new ScratchGit()
let env: IsolatedGitEnv

beforeAll(() => {
  env = isolateGitEnv(scratch.tempDir('home'))
})

afterAll(() => {
  env.restore()
  scratch.cleanup()
})

describe('findRemoteBase', () => {
  test('never contacts origin, even with no upstream and no fetched base to fall back on', async () => {
    const repo = scratch.repo('offline-base')
    const marker = join(scratch.tempDir('contact'), 'origin-was-contacted')
    scratch.run(repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/widgets.git')
    // Any ssh transport to origin runs this command first, leaving the marker.
    scratch.run(repo, 'config', 'core.sshCommand', `touch '${marker}'; false`)
    expect(await inProcessDir(repo, () => findRemoteBase())).toBeNull()
    expect(existsSync(marker)).toBe(false)
  })
})
