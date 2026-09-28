// Characterization of everything in the unit that reads the session's cached
// git state, written for the clean-base rewrite (docs/tech/rewrite/vcs/git.md):
// getHead, getBranch() without a directory, getDefaultBranch, getRemoteUrl,
// getGitState, getGithubRepo, detectCurrentRepository(+WithHost) and
// updateGithubRepoPathMapping.
//
// Those values come from one cache per process that the first read binds to the
// session repository and that nothing can reset. So:
//   - every scenario is also run in a fresh `bun` process, with its own cache,
//     HOME and config directory (the second describe);
//   - the in-process cases run only when this file made the first read itself,
//     which a targeted run guarantees. In a whole-suite run another file may
//     have bound the cache first, and they are skipped rather than lying.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, onGlobalConfigChange, saveGlobalConfig } from 'src/platform/config/config.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  detectCurrentRepository,
  detectCurrentRepositoryWithHost,
} from 'src/vcs/git/detectRepository.js'
import {
  getBranch,
  getDefaultBranch,
  getGitState,
  getGithubRepo,
  getHead,
  getRemoteUrl,
} from 'src/vcs/git/git.js'
import {
  getKnownPathsForRepo,
  updateGithubRepoPathMapping,
} from 'src/vcs/git/githubRepoPathMapping.js'

const SIGNATURE = {
  GIT_AUTHOR_NAME: 'Session Fixture',
  GIT_AUTHOR_EMAIL: 'session@fixture.invalid',
  GIT_COMMITTER_NAME: 'Session Fixture',
  GIT_COMMITTER_EMAIL: 'session@fixture.invalid',
}
const FOREIGN_GIT_STATE = [
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
const RESULT_MARK = '@@session-result@@'

const scratchDirs: string[] = []
const envSnapshot: Record<string, string | undefined> = {}

function scratch(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `char-session-${tag}-`)))
  scratchDirs.push(dir)
  return dir
}

function putEnv(key: string, value: string | undefined): void {
  if (!(key in envSnapshot)) envSnapshot[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// The in-process cache binds at load time (below), so git is isolated here
// rather than in a beforeAll.
const fakeHome = scratch('home')
for (const key of FOREIGN_GIT_STATE) putEnv(key, undefined)
putEnv('HOME', fakeHome)
putEnv('GIT_CONFIG_GLOBAL', '/dev/null')
putEnv('GIT_CONFIG_NOSYSTEM', '1')
putEnv('GIT_TERMINAL_PROMPT', '0')
putEnv('CLAUDIN_CONFIG_DIR', join(fakeHome, '.claudin'))
for (const [key, value] of Object.entries(SIGNATURE)) putEnv(key, value)

const launchCwd = getOriginalCwd()
const pathsBefore = getGlobalConfig().githubRepoPaths

afterAll(() => {
  setOriginalCwd(launchCwd)
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: pathsBefore }))
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

function gitIn(cwd: string, ...args: string[]): string {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}

function startRepo(dir: string, branch: string): string {
  mkdirSync(dir, { recursive: true })
  gitIn(dir, 'init', '--quiet', `--initial-branch=${branch}`)
  return dir
}

function commitAll(repo: string, message: string): string {
  gitIn(repo, 'add', '--all')
  gitIn(repo, 'commit', '--quiet', '--allow-empty', '-m', message)
  return gitIn(repo, 'rev-parse', 'HEAD')
}

type SessionRepo = {
  base: string
  root: string
  head: string
  branch: string
  remoteUrl: string
  defaultBranch: string
}

/**
 * The repository this file's in-process cases read: a github.com origin, an
 * upstream for the current branch, a remote default branch, one linked
 * worktree, and a symlink to the root.
 */
function buildSessionRepo(): SessionRepo {
  const base = scratch('repo')
  const root = startRepo(join(base, 'session-root'), 'session/trunk')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'kept.txt'), 'kept\n')
  const head = commitAll(root, 'session seed')
  const remoteUrl = 'git@github.com:Char-Org/Session-Repo.git'
  gitIn(root, 'remote', 'add', 'origin', remoteUrl)
  gitIn(root, 'update-ref', 'refs/remotes/origin/session/trunk', head)
  gitIn(root, 'update-ref', 'refs/remotes/origin/session-default', head)
  gitIn(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/session-default')
  gitIn(root, 'branch', '--quiet', '--set-upstream-to=origin/session/trunk')
  gitIn(root, 'worktree', 'add', '--quiet', '-b', 'session-side', join(base, 'session-side'))
  symlinkSync(root, join(base, 'session-alias'))
  return { base, root, head, branch: 'session/trunk', remoteUrl, defaultBranch: 'session-default' }
}

const SESSION = buildSessionRepo()

const ownsSessionCache = await runWithCwdOverride(SESSION.root, async () => {
  const [head, branch, remoteUrl, defaultBranch] = await Promise.all([
    getHead(),
    getBranch(),
    getRemoteUrl(),
    getDefaultBranch(),
  ])
  return (
    head === SESSION.head &&
    branch === SESSION.branch &&
    remoteUrl === SESSION.remoteUrl &&
    defaultBranch === SESSION.defaultBranch
  )
})

function inSession<T>(action: () => Promise<T>): Promise<T> {
  return runWithCwdOverride(SESSION.root, action)
}

async function withProcessDir<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await action()
  } finally {
    process.chdir(previous)
  }
}

function storeRepoPaths(paths: Record<string, string[]> | undefined): void {
  saveGlobalConfig(current => ({ ...current, githubRepoPaths: paths }))
}

describe('the session repository, read in this process', () => {
  afterEach(() => {
    setOriginalCwd(launchCwd)
  })

  test.skipIf(!ownsSessionCache)('the cached getters describe the session repository', async () => {
    expect(await inSession(() => getHead())).toBe(SESSION.head)
    expect(await inSession(() => getBranch())).toBe(SESSION.branch)
    expect(await inSession(() => getRemoteUrl())).toBe(SESSION.remoteUrl)
    expect(await inSession(() => getDefaultBranch())).toBe(SESSION.defaultBranch)
  })

  test.skipIf(!ownsSessionCache)('getGitState gathers commit, branch, remote, upstream, cleanliness and worktree count', async () => {
    const state = await withProcessDir(SESSION.root, () => inSession(() => getGitState()))
    expect(state).toEqual({
      commitHash: SESSION.head,
      branchName: SESSION.branch,
      remoteUrl: SESSION.remoteUrl,
      isHeadOnRemote: true,
      isClean: true,
      worktreeCount: 2,
    })
  })

  test.skipIf(!ownsSessionCache)('a github.com origin gives owner/name, and the host-aware variant adds the host', async () => {
    expect(await inSession(() => getGithubRepo())).toBe('Char-Org/Session-Repo')
    expect(await inSession(() => detectCurrentRepository())).toBe('Char-Org/Session-Repo')
    expect(await inSession(() => detectCurrentRepositoryWithHost())).toEqual({
      host: 'github.com',
      owner: 'Char-Org',
      name: 'Session-Repo',
    })
  })

  test.skipIf(!ownsSessionCache)('updateGithubRepoPathMapping records the real path of the repository root under a lower-cased key', async () => {
    storeRepoPaths(undefined)
    setOriginalCwd(join(SESSION.base, 'session-alias', 'sub'))
    let writes = 0
    const stop = onGlobalConfigChange(() => writes++)
    try {
      await inSession(() => updateGithubRepoPathMapping())
    } finally {
      stop()
    }
    expect(getGlobalConfig().githubRepoPaths).toEqual({ 'char-org/session-repo': [SESSION.root] })
    expect(getKnownPathsForRepo('CHAR-ORG/Session-Repo')).toEqual([SESSION.root])
    expect(writes).toBe(1)
  })

  test.skipIf(!ownsSessionCache)('a known path moves to the front without being duplicated; one already in front changes nothing', async () => {
    storeRepoPaths({ 'char-org/session-repo': ['/elsewhere/a', SESSION.root, '/elsewhere/b'], 'other/repo': ['/o'] })
    setOriginalCwd(SESSION.root)
    await inSession(() => updateGithubRepoPathMapping())
    expect(getGlobalConfig().githubRepoPaths).toEqual({
      'char-org/session-repo': [SESSION.root, '/elsewhere/a', '/elsewhere/b'],
      'other/repo': ['/o'],
    })
    let writes = 0
    const stop = onGlobalConfigChange(() => writes++)
    try {
      await inSession(() => updateGithubRepoPathMapping())
    } finally {
      stop()
    }
    expect(writes).toBe(0)
    expect(getKnownPathsForRepo('char-org/session-repo')).toEqual([SESSION.root, '/elsewhere/a', '/elsewhere/b'])
  })

  test.skipIf(!ownsSessionCache)('a launch directory outside any repository is recorded itself, resolved when it exists and as given when not', async () => {
    const outside = scratch('launch')
    mkdirSync(join(outside, 'real'))
    symlinkSync(join(outside, 'real'), join(outside, 'alias'))
    storeRepoPaths(undefined)
    setOriginalCwd(join(outside, 'alias'))
    await inSession(() => updateGithubRepoPathMapping())
    expect(getKnownPathsForRepo('char-org/session-repo')).toEqual([join(outside, 'real')])
    storeRepoPaths(undefined)
    setOriginalCwd(join(outside, 'never-created'))
    await inSession(() => updateGithubRepoPathMapping())
    expect(getKnownPathsForRepo('char-org/session-repo')).toEqual([join(outside, 'never-created')])
  })
})

// ---------------------------------------------------------------------------
// Fresh processes: each scenario gets its own cache.
// ---------------------------------------------------------------------------

const driverDir = scratch('drivers')
let driverCount = 0

function driverSource(body: string): string {
  return [
    `const unit = ${JSON.stringify(import.meta.dir)}`,
    `const git = await import(unit + '/git.ts')`,
    `const detect = await import(unit + '/detectRepository.ts')`,
    `const mapping = await import(unit + '/githubRepoPathMapping.ts')`,
    `const config = await import(unit + '/../../platform/config/config.ts')`,
    `const cwdScope = await import(unit + '/../../shared/fs/cwd.ts')`,
    'const out = {}',
    'const snapshot = async () => ({',
    '  head: await git.getHead(), branch: await git.getBranch(),',
    '  defaultBranch: await git.getDefaultBranch(), remoteUrl: await git.getRemoteUrl(),',
    '  state: await git.getGitState(), githubRepo: await git.getGithubRepo(),',
    '  repository: await detect.detectCurrentRepository(),',
    '  withHost: await detect.detectCurrentRepositoryWithHost(),',
    '})',
    'const sh = (...args) => {',
    "  const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })",
    '  if (r.exitCode !== 0) throw new Error(r.stderr.toString())',
    '  return r.stdout.toString().trim()',
    '}',
    'const eventually = async (read, want) => {',
    '  for (let i = 0; i < 400; i++) { if ((await read()) === want) return true; await Bun.sleep(10) }',
    '  return false',
    '}',
    body,
    `process.stdout.write('\\n${RESULT_MARK}' + JSON.stringify(out))`,
    'process.exit(0)',
  ].join('\n')
}

async function inFreshProcess(
  cwd: string,
  body: string,
  extraEnv: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const script = join(driverDir, `scenario-${++driverCount}.mjs`)
  writeFileSync(script, driverSource(body))
  const home = scratch('child-home')
  const child = Bun.spawn([process.execPath, script], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmpdir(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      CLAUDIN_CONFIG_DIR: join(home, '.claudin'),
      NODE_ENV: 'test',
      ...SIGNATURE,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const at = stdout.lastIndexOf(RESULT_MARK)
  if (code !== 0 || at < 0) throw new Error(`scenario process failed (${code}): ${stderr}`)
  return JSON.parse(stdout.slice(at + RESULT_MARK.length)) as Record<string, unknown>
}

describe('the session repository, read by a fresh process', () => {
  test('an Enterprise origin with a port, a detached HEAD, and only origin/master to fall back on', async () => {
    const repo = startRepo(join(scratch('ghe'), 'repo'), 'trunk')
    writeFileSync(join(repo, 'a.txt'), 'a')
    const head = commitAll(repo, 'one')
    const remoteUrl = 'https://ghe.corp.example:8443/Platform/Tooling.git'
    gitIn(repo, 'remote', 'add', 'origin', remoteUrl)
    gitIn(repo, 'update-ref', 'refs/remotes/origin/master', head)
    gitIn(repo, 'checkout', '--quiet', '--detach')
    const out = await inFreshProcess(repo, 'out.facts = await snapshot()')
    expect(out.facts).toEqual({
      head,
      branch: 'HEAD',
      defaultBranch: 'master',
      remoteUrl,
      state: { commitHash: head, branchName: 'HEAD', remoteUrl, isHeadOnRemote: false, isClean: true, worktreeCount: 1 },
      githubRepo: null,
      repository: null,
      withHost: { host: 'ghe.corp.example:8443', owner: 'Platform', name: 'Tooling' },
    })
  }, 20_000)

  test('an unborn branch without a remote', async () => {
    const repo = startRepo(join(scratch('unborn'), 'repo'), 'trunk')
    const out = await inFreshProcess(repo, 'out.facts = await snapshot()')
    expect(out.facts).toEqual({
      head: '',
      branch: 'trunk',
      defaultBranch: 'main',
      remoteUrl: null,
      state: { commitHash: '', branchName: 'trunk', remoteUrl: null, isHeadOnRemote: false, isClean: true, worktreeCount: 1 },
      githubRepo: null,
      repository: null,
      withHost: null,
    })
  }, 20_000)

  test('outside any repository', async () => {
    const out = await inFreshProcess(scratch('nowhere'), 'out.facts = await snapshot()')
    expect(out.facts).toEqual({
      head: '',
      branch: 'HEAD',
      defaultBranch: 'main',
      remoteUrl: null,
      state: { commitHash: '', branchName: 'HEAD', remoteUrl: null, isHeadOnRemote: false, isClean: true, worktreeCount: 0 },
      githubRepo: null,
      repository: null,
      withHost: null,
    })
  }, 20_000)

  test('inside a linked worktree: its own branch and commit, the shared origin, origin/main preferred over origin/master', async () => {
    const base = scratch('linked')
    const main = startRepo(join(base, 'main'), 'main')
    writeFileSync(join(main, 'a.txt'), 'a')
    const seed = commitAll(main, 'seed')
    gitIn(main, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets')
    gitIn(main, 'update-ref', 'refs/remotes/origin/master', seed)
    gitIn(main, 'update-ref', 'refs/remotes/origin/main', seed)
    const linked = join(base, 'linked')
    gitIn(main, 'worktree', 'add', '--quiet', '-b', 'linked-work', linked)
    const head = commitAll(linked, 'linked commit')
    mkdirSync(join(linked, 'sub'))
    const out = await inFreshProcess(join(linked, 'sub'), 'out.facts = await snapshot()')
    expect(out.facts).toEqual({
      head,
      branch: 'linked-work',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/Acme/Widgets',
      state: {
        commitHash: head,
        branchName: 'linked-work',
        remoteUrl: 'https://github.com/Acme/Widgets',
        isHeadOnRemote: false,
        isClean: true,
        worktreeCount: 2,
      },
      githubRepo: 'Acme/Widgets',
      repository: 'Acme/Widgets',
      withHost: { host: 'github.com', owner: 'Acme', name: 'Widgets' },
    })
  }, 20_000)

  test('the cached values follow commits, branch switches and remote changes', async () => {
    const repo = startRepo(join(scratch('follow'), 'repo'), 'first')
    writeFileSync(join(repo, 'a.txt'), 'a')
    commitAll(repo, 'one')
    gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:acme/before.git')
    const out = await inFreshProcess(repo, [
      'out.start = { branch: await git.getBranch(), head: await git.getHead(), remote: await git.getRemoteUrl() }',
      "sh('commit', '--quiet', '--allow-empty', '-m', 'two')",
      "out.headFollows = await eventually(() => git.getHead(), sh('rev-parse', 'HEAD'))",
      "sh('checkout', '--quiet', '-b', 'second')",
      "out.branchFollows = await eventually(() => git.getBranch(), 'second')",
      "sh('remote', 'set-url', 'origin', 'https://github.com/acme/after.git')",
      "out.remoteFollows = await eventually(() => git.getRemoteUrl(), 'https://github.com/acme/after.git')",
    ].join('\n'))
    expect(out.start).toEqual({
      branch: 'first',
      head: gitIn(repo, 'rev-parse', 'HEAD~1'),
      remote: 'git@github.com:acme/before.git',
    })
    expect(out).toMatchObject({ headFollows: true, branchFollows: true, remoteFollows: true })
  }, 20_000)

  test('detectCurrentRepositoryWithHost remembers its answer per session cwd until clearRepositoryCaches', async () => {
    const repo = startRepo(join(scratch('remember'), 'repo'), 'main')
    mkdirSync(join(repo, 'sub'))
    gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
    const out = await inFreshProcess(repo, [
      'out.first = await detect.detectCurrentRepositoryWithHost()',
      "sh('remote', 'set-url', 'origin', 'https://ghe.corp.example/platform/tooling.git')",
      "out.seen = await eventually(() => git.getRemoteUrl(), 'https://ghe.corp.example/platform/tooling.git')",
      'out.sameCwd = await detect.detectCurrentRepositoryWithHost()',
      'out.sameCwdShort = await detect.detectCurrentRepository()',
      "out.otherCwd = await cwdScope.runWithCwdOverride(process.cwd() + '/sub', () => detect.detectCurrentRepositoryWithHost())",
      'detect.clearRepositoryCaches()',
      'out.cleared = await detect.detectCurrentRepositoryWithHost()',
      'out.clearedShort = await detect.detectCurrentRepository()',
    ].join('\n'))
    const github = { host: 'github.com', owner: 'acme', name: 'widgets' }
    const enterprise = { host: 'ghe.corp.example', owner: 'platform', name: 'tooling' }
    expect(out).toEqual({
      first: github,
      seen: true,
      sameCwd: github,
      sameCwdShort: 'acme/widgets',
      otherCwd: enterprise,
      cleared: enterprise,
      clearedShort: null,
    })
  }, 20_000)

  test('updateGithubRepoPathMapping records a github.com clone by its root and ignores other hosts', async () => {
    const base = scratch('mapping')
    const hub = startRepo(join(base, 'hub'), 'main')
    mkdirSync(join(hub, 'pkg', 'deep'), { recursive: true })
    gitIn(hub, 'remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git')
    const corp = startRepo(join(base, 'corp'), 'main')
    gitIn(corp, 'remote', 'add', 'origin', 'git@ghe.corp.example:acme/widgets.git')
    const record = [
      'await mapping.updateGithubRepoPathMapping()',
      'out.paths = config.getGlobalConfig().githubRepoPaths ?? null',
      "out.known = mapping.getKnownPathsForRepo('ACME/WIDGETS')",
    ].join('\n')
    const [fromHub, fromCorp] = await Promise.all([
      inFreshProcess(join(hub, 'pkg', 'deep'), record),
      inFreshProcess(corp, record),
    ])
    expect(fromHub).toEqual({ paths: { 'acme/widgets': [hub] }, known: [hub] })
    expect(fromCorp).toEqual({ paths: null, known: [] })
  }, 20_000)

  test('gitExe falls back to the bare name when git is not on PATH', async () => {
    const out = await inFreshProcess(scratch('no-git'), 'out.exe = git.gitExe()', { PATH: scratch('empty-path') })
    expect(out.exe).toBe('git')
  }, 20_000)
})
