import { afterAll, describe, expect, test } from 'bun:test'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { resolveWorkspaceRoots } from 'src/vcs/git/repository/canonicalRoot.js'
import { keepFirstGitLookup } from 'src/vcs/git/repository/gitExecutable.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

describe('resolveWorkspaceRoots', () => {
  test("the cwd's root comes before the additional directories' roots", () => {
    const first = scratch.repo('workspace-first')
    const second = scratch.repo('workspace-second')
    expect(resolveWorkspaceRoots(second, [first])).toEqual([second, first])
    expect(resolveWorkspaceRoots(first, [second])).toEqual([first, second])
  })
})

describe('keepFirstGitLookup', () => {
  test('looks git up once and keeps that answer, even when a later lookup would differ', () => {
    const answers = ['/opt/first/bin/git', '/opt/second/bin/git']
    let lookups = 0
    const exe = keepFirstGitLookup(() => {
      lookups++
      return answers.shift() ?? null
    })
    expect([exe(), exe(), exe()]).toEqual([
      '/opt/first/bin/git',
      '/opt/first/bin/git',
      '/opt/first/bin/git',
    ])
    expect(lookups).toBe(1)
  })

  test('plain git when the lookup finds nothing', () => {
    expect(keepFirstGitLookup(() => null)()).toBe('git')
  })
})
