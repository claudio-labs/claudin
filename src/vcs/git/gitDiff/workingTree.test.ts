/**
 * fetchGitDiff and fetchGitDiffHunks, for the fixes the characterization suite
 * leaves open (docs/tech/rewrite/vcs/gitDiff.md, findings 3, 5, 6, 7 and 8),
 * against real repositories.
 *
 * ScratchGit keeps its own git away from the machine's configuration. The git
 * the fetchers run inherits this process's environment, so that is pointed
 * away from the global and system files for the length of the suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { fetchGitDiff, fetchGitDiffHunks } from 'src/vcs/git/gitDiff.js'

const GIT_TIMEOUT = 60_000

let scratch: ScratchGit
const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  scratch = new ScratchGit()
  const home = scratch.tempDir('fetch-home')
  for (const key of Object.keys(process.env).filter(name => name.startsWith('GIT_'))) setEnv(key, undefined)
  setEnv('HOME', home)
  setEnv('XDG_CONFIG_HOME', join(home, '.config'))
  setEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  setEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  scratch.cleanup()
})

function commitAll(root: string, message: string): void {
  scratch.run(root, 'add', '-A')
  scratch.run(root, 'commit', '-q', '-m', message)
}

const keysOf = (map: ReadonlyMap<string, unknown> | undefined): string[] => [...(map?.keys() ?? [])]

describe('a name git would quote for its non-ASCII letters', () => {
  test('is the name on disk in the numbers, the hunks and the untracked list', async () => {
    const root = scratch.repo('accents')
    scratch.put(root, 'café.txt', 'accent\n')
    commitAll(root, 'base')
    scratch.put(root, 'café.txt', 'accent grave\n')
    scratch.put(root, 'naïve.txt', 'not added yet\n')
    const numbers = await fetchGitDiff(root)
    expect(keysOf(numbers?.perFileStats)).toEqual(['café.txt', 'naïve.txt'])
    expect(numbers?.perFileStats.get('naïve.txt')).toStrictEqual({ added: 0, removed: 0, isBinary: false, isUntracked: true })
    expect(existsSync(join(root, 'naïve.txt'))).toBe(true)
    expect(keysOf(await fetchGitDiffHunks(root))).toEqual(['café.txt'])
  }, GIT_TIMEOUT)
})

describe('the count of files changed', () => {
  test('counts every untracked file, including those the tracked files left no entry for', async () => {
    const root = scratch.repo('crowded')
    const tracked = Array.from({ length: 50 }, (_, i) => `t-${String(i).padStart(2, '0')}.txt`)
    for (const name of tracked) scratch.put(root, name, 'v1\n')
    commitAll(root, 'base')
    for (const name of tracked) scratch.put(root, name, 'v2\n')
    for (const name of ['u-a.txt', 'u-b.txt', 'u-c.txt']) scratch.put(root, name, 'new\n')
    const result = await fetchGitDiff(root)
    expect(result?.stats).toStrictEqual({ filesCount: 53, linesAdded: 50, linesRemoved: 50 })
    expect(keysOf(result?.perFileStats)).toEqual(tracked)
  }, GIT_TIMEOUT)
})

describe('without a root: the repository around the session directory', () => {
  test('is the one git reads, not the one the process sits in', async () => {
    const session = scratch.repo('session')
    scratch.put(session, 'notes.txt', 'edited in the session repository\n')
    const elsewhere = scratch.repo('process')
    scratch.put(elsewhere, 'stray.txt', 'untracked where the process sits\n')
    const processDir = process.cwd()
    process.chdir(elsewhere)
    try {
      expect(keysOf((await runWithCwdOverride(session, () => fetchGitDiff()))?.perFileStats)).toEqual(['notes.txt'])
      expect(keysOf(await runWithCwdOverride(session, () => fetchGitDiffHunks()))).toEqual(['notes.txt'])
    } finally {
      process.chdir(processDir)
    }
  }, GIT_TIMEOUT)

  test('is looked for again at every call', async () => {
    const outside = scratch.tempDir('no-repo')
    const repo = scratch.repo('found-later')
    scratch.put(repo, 'notes.txt', 'changed\n')
    expect(await runWithCwdOverride(outside, () => fetchGitDiff())).toBeNull()
    expect((await runWithCwdOverride(repo, () => fetchGitDiff()))?.stats.filesCount).toBe(1)
  }, GIT_TIMEOUT)
})

describe('from a subdirectory: names from the repository root, over the whole repository', () => {
  test('tracked and untracked alike, with a root or from the session directory', async () => {
    const root = scratch.repo('nested')
    scratch.put(root, 'top.txt', 'top\n')
    scratch.put(root, 'sub/inner.txt', 'inner\n')
    commitAll(root, 'base')
    scratch.put(root, 'top.txt', 'top, edited\n')
    scratch.put(root, 'sub/inner.txt', 'inner, edited\n')
    scratch.put(root, 'sub/new.txt', 'new beside it\n')
    scratch.put(root, 'other/loose.txt', 'new elsewhere\n')
    const sub = join(root, 'sub')
    const everyName = ['sub/inner.txt', 'top.txt', 'other/loose.txt', 'sub/new.txt']
    const numbers = await fetchGitDiff(sub)
    expect(keysOf(numbers?.perFileStats)).toEqual(everyName)
    expect(numbers?.stats.filesCount).toBe(4)
    expect(keysOf(await fetchGitDiffHunks(sub))).toEqual(['sub/inner.txt', 'top.txt'])
    expect(keysOf((await runWithCwdOverride(sub, () => fetchGitDiff()))?.perFileStats)).toEqual(everyName)
  }, GIT_TIMEOUT)
})

describe("the repository's own diff settings do not reach the hunks", () => {
  test.each([
    ['color.ui', 'always'],
    ['color.diff', 'always'],
  ])('%s=%s: the hunks still parse', async (key, value) => {
    const root = scratch.repo('colored')
    scratch.put(root, 'notes.txt', 'edited\n')
    scratch.run(root, 'config', key, value)
    const hunks = await fetchGitDiffHunks(root)
    expect(keysOf(hunks)).toEqual(['notes.txt'])
    expect(hunks.get('notes.txt')?.[0]?.lines.at(-1)).toBe('+edited')
  }, GIT_TIMEOUT)

  test('diff.external: the hunks come back, and the program never runs', async () => {
    const root = scratch.repo('external')
    const tools = scratch.tempDir('external-tool')
    const marker = join(tools, 'ran')
    const program = scratch.put(tools, 'fake-diff.sh', `#!/bin/sh\necho ran > '${marker}'\n`)
    chmodSync(program, 0o755)
    scratch.run(root, 'config', 'diff.external', program)
    scratch.put(root, 'notes.txt', 'edited\n')
    expect(keysOf(await fetchGitDiffHunks(root))).toEqual(['notes.txt'])
    expect(existsSync(marker)).toBe(false)
  }, GIT_TIMEOUT)
})

describe('a file named HEAD in the working tree', () => {
  test('is an untracked file, not a reason for git to refuse', async () => {
    const root = scratch.repo('head-file')
    scratch.put(root, 'notes.txt', 'edited\n')
    scratch.put(root, 'HEAD', 'a file, not a revision\n')
    expect(keysOf((await fetchGitDiff(root))?.perFileStats)).toEqual(['notes.txt', 'HEAD'])
    expect(keysOf(await fetchGitDiffHunks(root))).toEqual(['notes.txt'])
  }, GIT_TIMEOUT)
})
