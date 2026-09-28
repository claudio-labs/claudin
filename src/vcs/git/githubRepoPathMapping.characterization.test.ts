// Characterization of the known-clone bookkeeping in
// src/vcs/git/githubRepoPathMapping.ts, written for the clean-base rewrite
// (docs/tech/rewrite/vcs/git.md). updateGithubRepoPathMapping reads the
// session's cached git state and is pinned in git.session.characterization.test.ts.
//
// Under `bun test` the global config is an in-memory object (NODE_ENV=test), so
// the mapping is seeded and read back through getGlobalConfig/saveGlobalConfig.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getGlobalConfig, onGlobalConfigChange, saveGlobalConfig } from 'src/platform/config/config.js'
import {
  filterExistingPaths,
  getKnownPathsForRepo,
  removePathFromRepo,
  validateRepoAtPath,
} from 'src/vcs/git/githubRepoPathMapping.js'

const COMMITTER = {
  GIT_AUTHOR_NAME: 'Mapping Fixture',
  GIT_AUTHOR_EMAIL: 'mapping@fixture.invalid',
  GIT_COMMITTER_NAME: 'Mapping Fixture',
  GIT_COMMITTER_EMAIL: 'mapping@fixture.invalid',
}
const OUTSIDE_GIT_SETTINGS = [
  'XDG_CONFIG_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]

const tempRoots: string[] = []
const envKept = new Map<string, string | undefined>()
let mappingKept: Record<string, string[]> | undefined

function tempRoot(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `char-mapping-${tag}-`)))
  tempRoots.push(dir)
  return dir
}

function env(key: string, value: string | undefined): void {
  if (!envKept.has(key)) envKept.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  mappingKept = getGlobalConfig().githubRepoPaths
  const home = tempRoot('home')
  for (const key of OUTSIDE_GIT_SETTINGS) env(key, undefined)
  env('HOME', home)
  env('GIT_CONFIG_GLOBAL', '/dev/null')
  env('GIT_CONFIG_NOSYSTEM', '1')
  env('GIT_TERMINAL_PROMPT', '0')
  env('CLAUDIN_CONFIG_DIR', join(home, '.claudin'))
  for (const [key, value] of Object.entries(COMMITTER)) env(key, value)
})

afterAll(() => {
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: mappingKept }))
  for (const [key, value] of envKept) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
})

function seed(mapping: Record<string, string[]> | undefined): void {
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: mapping }))
}

/** Counts global-config writes made while `action` runs. */
function countWrites(action: () => void): number {
  let writes = 0
  const stop = onGlobalConfigChange(() => writes++)
  try {
    action()
  } finally {
    stop()
  }
  return writes
}

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${done.stderr.toString()}`)
}

function cloneWithOrigin(dir: string, origin?: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '--initial-branch=main')
  if (origin) git(dir, 'remote', 'add', 'origin', origin)
  return dir
}

describe('getKnownPathsForRepo', () => {
  beforeEach(() => seed(undefined))

  test('reads the list kept under the lower-cased owner/name', () => {
    seed({ 'acme/widgets': ['/work/widgets', '/tmp/widgets-2'] })
    expect(getKnownPathsForRepo('Acme/Widgets')).toEqual(['/work/widgets', '/tmp/widgets-2'])
    expect(getKnownPathsForRepo('acme/widgets')).toEqual(['/work/widgets', '/tmp/widgets-2'])
  })

  test('an unknown repository, or no mapping at all, gives an empty list', () => {
    expect(getKnownPathsForRepo('acme/widgets')).toEqual([])
    seed({ 'acme/widgets': ['/work/widgets'] })
    expect(getKnownPathsForRepo('acme/gadgets')).toEqual([])
  })
})

describe('filterExistingPaths', () => {
  test('keeps the paths that exist, files and directories alike, in order and with repeats', async () => {
    const base = tempRoot('exists')
    const dir = join(base, 'dir')
    const file = join(base, 'file.txt')
    mkdirSync(dir)
    writeFileSync(file, '')
    symlinkSync(join(base, 'missing-target'), join(base, 'dangling'))
    symlinkSync(dir, join(base, 'dir-alias'))
    const kept = await filterExistingPaths([
      join(base, 'missing'),
      dir,
      join(base, 'dangling'),
      file,
      join(base, 'dir-alias'),
      dir,
    ])
    expect(kept).toEqual([dir, file, join(base, 'dir-alias'), dir])
  })

  test('an empty list stays empty', async () => {
    expect(await filterExistingPaths([])).toEqual([])
  })
})

describe('validateRepoAtPath', () => {
  test('true when the origin of the repository at the path is that github.com repository, in any letter case', async () => {
    const repo = cloneWithOrigin(join(tempRoot('valid'), 'repo'), 'git@github.com:Acme/Widgets.git')
    mkdirSync(join(repo, 'deep', 'er'), { recursive: true })
    expect(await validateRepoAtPath(repo, 'acme/widgets')).toBe(true)
    expect(await validateRepoAtPath(join(repo, 'deep', 'er'), 'ACME/WIDGETS')).toBe(true)
  })

  test('a linked worktree is judged by the origin it shares with its main repository', async () => {
    const base = tempRoot('valid-wt')
    const main = cloneWithOrigin(join(base, 'main'), 'https://github.com/acme/widgets.git')
    git(main, 'commit', '--quiet', '--allow-empty', '-m', 'seed')
    git(main, 'worktree', 'add', '--quiet', '-b', 'side', join(base, 'side'))
    expect(await validateRepoAtPath(join(base, 'side'), 'acme/widgets')).toBe(true)
  })

  test('false for another repository, another host, no origin, no repository or a missing path', async () => {
    const base = tempRoot('invalid')
    const other = cloneWithOrigin(join(base, 'other'), 'https://github.com/acme/gadgets.git')
    const enterprise = cloneWithOrigin(join(base, 'enterprise'), 'git@ghe.corp.example:acme/widgets.git')
    const noOrigin = cloneWithOrigin(join(base, 'no-origin'))
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await validateRepoAtPath(other, 'acme/widgets')).toBe(false)
    expect(await validateRepoAtPath(enterprise, 'acme/widgets')).toBe(false)
    expect(await validateRepoAtPath(noOrigin, 'acme/widgets')).toBe(false)
    expect(await validateRepoAtPath(plain, 'acme/widgets')).toBe(false)
    expect(await validateRepoAtPath(join(base, 'gone'), 'acme/widgets')).toBe(false)
  })
})

describe('removePathFromRepo', () => {
  beforeEach(() => seed(undefined))

  test('drops one path from the list under the lower-cased key and leaves other repositories alone', () => {
    seed({ 'acme/widgets': ['/a', '/b', '/c'], 'acme/gadgets': ['/g'] })
    const writes = countWrites(() => removePathFromRepo('ACME/Widgets', '/b'))
    expect(writes).toBe(1)
    expect(getGlobalConfig().githubRepoPaths).toEqual({ 'acme/widgets': ['/a', '/c'], 'acme/gadgets': ['/g'] })
  })

  test('removing the last path removes the repository entry', () => {
    seed({ 'acme/widgets': ['/only'], 'acme/gadgets': ['/g'] })
    removePathFromRepo('acme/widgets', '/only')
    expect(getGlobalConfig().githubRepoPaths).toEqual({ 'acme/gadgets': ['/g'] })
    expect(getKnownPathsForRepo('acme/widgets')).toEqual([])
  })

  test('a path that is not listed, or a repository that is not known, writes nothing', () => {
    seed({ 'acme/widgets': ['/a'] })
    const writes = countWrites(() => {
      removePathFromRepo('acme/widgets', '/not-there')
      removePathFromRepo('acme/unknown', '/a')
    })
    expect(writes).toBe(0)
    expect(getGlobalConfig().githubRepoPaths).toEqual({ 'acme/widgets': ['/a'] })
  })

  test('every copy of a repeated path goes', () => {
    seed({ 'acme/widgets': ['/a', '/b', '/a'] })
    removePathFromRepo('acme/widgets', '/a')
    expect(getKnownPathsForRepo('acme/widgets')).toEqual(['/b'])
  })
})
