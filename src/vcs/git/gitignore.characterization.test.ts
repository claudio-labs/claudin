// Characterization of src/vcs/git/gitignore.ts, written for the clean-base
// rewrite (docs/tech/rewrite/vcs/git.md), against real ignore files: the
// repository's .gitignore files, info/exclude, and the global excludes file.
//
// The home directory is a boundary: Bun fixes os.homedir() when the process
// starts, so the writer is pointed at a temp home by spying on it (and HOME is
// set to the same directory for the git processes). Every write goes through a
// guard that refuses to run unless the redirection took effect, and one case
// runs a fresh process started with HOME at a temp directory, with no spy at all.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import * as os from 'os'
import { join } from 'path'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  addFileGlobRuleToGitignore,
  getGlobalGitignorePath,
  isPathGitignored,
} from 'src/vcs/git/gitignore.js'

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Ignore Fixture',
  GIT_AUTHOR_EMAIL: 'ignore@fixture.invalid',
  GIT_COMMITTER_NAME: 'Ignore Fixture',
  GIT_COMMITTER_EMAIL: 'ignore@fixture.invalid',
}
const AMBIENT_GIT_KEYS = [
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
const OUTPUT_MARK = '@@ignore-result@@'
// The exact bytes of the global ignore file, captured from the real writer.
const FORMAT_DIR = join(import.meta.dir, '__fixtures__', 'rewrite')
const expectedFile = (name: string): string => readFileSync(join(FORMAT_DIR, name), 'utf8')

const toRemove: string[] = []
const envOriginal = new Map<string, string | undefined>()
let suiteHome = ''

function mkTemp(tag: string): string {
  const dir = realpathSync(mkdtempSync(join(os.tmpdir(), `char-ignore-${tag}-`)))
  toRemove.push(dir)
  return dir
}

function setVar(key: string, value: string | undefined): void {
  if (!envOriginal.has(key)) envOriginal.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  suiteHome = mkTemp('home')
  for (const key of AMBIENT_GIT_KEYS) setVar(key, undefined)
  setVar('HOME', suiteHome)
  setVar('GIT_CONFIG_GLOBAL', '/dev/null')
  setVar('GIT_CONFIG_NOSYSTEM', '1')
  setVar('GIT_TERMINAL_PROMPT', '0')
  setVar('CLAUDIN_CONFIG_DIR', join(suiteHome, '.claudin'))
  for (const [key, value] of Object.entries(GIT_IDENTITY)) setVar(key, value)
})

afterAll(() => {
  for (const [key, value] of envOriginal) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of toRemove) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${done.stderr.toString()}`)
}

function repoWith(files: Record<string, string> = {}): string {
  const repo = join(mkTemp('repo'), 'repo')
  mkdirSync(repo)
  git(repo, 'init', '--quiet', '--initial-branch=main')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true })
    writeFileSync(join(repo, name), body)
  }
  return repo
}

function writeFileDeep(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

/**
 * Points both the module's home directory and git's HOME at a fresh directory
 * for the length of `action`. Refuses to go on if the module still sees the
 * real home, so nothing can ever be written there.
 */
async function withTempHome(action: (globalIgnore: string, home: string) => Promise<void>): Promise<void> {
  const home = mkTemp('user-home')
  const globalIgnore = join(home, '.config', 'git', 'ignore')
  const spy = spyOn(os, 'homedir').mockReturnValue(home)
  const gitHome = process.env.HOME
  process.env.HOME = home
  try {
    if (getGlobalGitignorePath() !== globalIgnore) {
      throw new Error('home redirection did not take effect; refusing to touch the global ignore file')
    }
    await action(globalIgnore, home)
  } finally {
    spy.mockRestore()
    if (gitHome === undefined) delete process.env.HOME
    else process.env.HOME = gitHome
  }
}

describe('isPathGitignored', () => {
  test("true for what the repository's .gitignore ignores; negated patterns and tracked files are not ignored", async () => {
    const repo = repoWith({ '.gitignore': '*.log\n!keep.log\nbuild/\n', 'tracked.log': 't' })
    git(repo, 'add', '--force', 'tracked.log')
    const ask = (path: string): Promise<boolean> => isPathGitignored(path, repo)
    expect(await ask('debug.log')).toBe(true)
    expect(await ask('keep.log')).toBe(false)
    expect(await ask('tracked.log')).toBe(false)
    expect(await ask('build/out.js')).toBe(true)
    expect(await ask('src/index.ts')).toBe(false)
  })

  test('a nested .gitignore applies below its own directory only', async () => {
    const repo = repoWith({ 'sub/.gitignore': '*.tmp\n' })
    expect(await isPathGitignored('sub/a.tmp', repo)).toBe(true)
    expect(await isPathGitignored('sub/deeper/b.tmp', repo)).toBe(true)
    expect(await isPathGitignored('a.tmp', repo)).toBe(false)
  })

  test('info/exclude and the global excludes file under HOME count', async () => {
    const repo = repoWith()
    writeFileDeep(join(repo, '.git', 'info', 'exclude'), 'secret.env\n')
    writeFileDeep(join(suiteHome, '.config', 'git', 'ignore'), 'from-home.txt\n')
    try {
      expect(await isPathGitignored('secret.env', repo)).toBe(true)
      expect(await isPathGitignored('from-home.txt', repo)).toBe(true)
      expect(await isPathGitignored('nested/from-home.txt', repo)).toBe(true)
    } finally {
      rmSync(join(suiteHome, '.config'), { recursive: true, force: true })
    }
  })

  test('git decides which global file applies: XDG_CONFIG_HOME or core.excludesFile replace ~/.config/git/ignore', async () => {
    const repo = repoWith()
    writeFileDeep(join(suiteHome, '.config', 'git', 'ignore'), 'home-rule.txt\n')
    const xdg = mkTemp('xdg')
    writeFileDeep(join(xdg, 'git', 'ignore'), 'xdg-rule.txt\n')
    const coreFile = join(mkTemp('core'), 'excludes')
    writeFileSync(coreFile, 'core-rule.txt\n')
    try {
      process.env.XDG_CONFIG_HOME = xdg
      expect(await isPathGitignored('xdg-rule.txt', repo)).toBe(true)
      expect(await isPathGitignored('home-rule.txt', repo)).toBe(false)
      delete process.env.XDG_CONFIG_HOME
      git(repo, 'config', 'core.excludesFile', coreFile)
      expect(await isPathGitignored('core-rule.txt', repo)).toBe(true)
      expect(await isPathGitignored('home-rule.txt', repo)).toBe(false)
    } finally {
      delete process.env.XDG_CONFIG_HOME
      rmSync(join(suiteHome, '.config'), { recursive: true, force: true })
    }
  })

  test('a relative path is read from the given directory; an absolute path works from anywhere in the repository', async () => {
    const repo = repoWith({ 'sub/.gitignore': '*.tmp\n' })
    expect(await isPathGitignored('a.tmp', join(repo, 'sub'))).toBe(true)
    expect(await isPathGitignored('a.tmp', repo)).toBe(false)
    expect(await isPathGitignored(join(repo, 'sub', 'a.tmp'), repo)).toBe(true)
  })

  test('false outside a repository, for a path outside the repository, and when the directory does not exist', async () => {
    const plain = mkTemp('plain')
    writeFileSync(join(plain, '.gitignore'), '*\n')
    const repo = repoWith({ '.gitignore': '*.log\n' })
    expect(await isPathGitignored('x.log', plain)).toBe(false)
    expect(await isPathGitignored(join(plain, 'x.log'), repo)).toBe(false)
    expect(await isPathGitignored('x.log', join(repo, 'missing-dir'))).toBe(false)
  })
})

describe('getGlobalGitignorePath', () => {
  test('is .config/git/ignore under the home directory when git is left at its defaults', () => {
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined()
    expect(getGlobalGitignorePath()).toBe(join(os.homedir(), '.config', 'git', 'ignore'))
  })
})

describe('addFileGlobRuleToGitignore', () => {
  test('creates the global ignore file with one **/ rule, after which git ignores the file anywhere', async () => {
    await withTempHome(async globalIgnore => {
      const repo = repoWith()
      await addFileGlobRuleToGitignore('.claudin/settings.local.json', repo)
      expect(readFileSync(globalIgnore, 'utf8')).toBe(expectedFile('global-ignore.created.txt'))
      expect(await isPathGitignored('.claudin/settings.local.json', repo)).toBe(true)
      expect(await isPathGitignored('pkg/.claudin/settings.local.json', repo)).toBe(true)
    })
  })

  test('appends to an existing global file, always starting a new line', async () => {
    await withTempHome(async globalIgnore => {
      writeFileDeep(globalIgnore, 'node_modules')
      await addFileGlobRuleToGitignore('cache.bin', repoWith())
      expect(readFileSync(globalIgnore, 'utf8')).toBe(expectedFile('global-ignore.appended-to-unterminated.txt'))
    })
    await withTempHome(async globalIgnore => {
      writeFileDeep(globalIgnore, '*.swp\n')
      await addFileGlobRuleToGitignore('cache.bin', repoWith())
      expect(readFileSync(globalIgnore, 'utf8')).toBe(expectedFile('global-ignore.appended-to-terminated.txt'))
    })
  })

  test('a directory rule is checked through a file inside it and written with its trailing slash', async () => {
    await withTempHome(async globalIgnore => {
      const repo = repoWith()
      await addFileGlobRuleToGitignore('.claudin/plans/', repo)
      expect(readFileSync(globalIgnore, 'utf8')).toBe(expectedFile('global-ignore.directory-rule.txt'))
      expect(await isPathGitignored('.claudin/plans/draft.md', repo)).toBe(true)
    })
    await withTempHome(async globalIgnore => {
      const repo = repoWith({ '.gitignore': 'plans/\n' })
      await addFileGlobRuleToGitignore('plans/', repo)
      expect(existsSync(join(globalIgnore, '..'))).toBe(false)
    })
  })

  test('nothing is written when git already ignores the path, through the repository or through the global file', async () => {
    await withTempHome(async (globalIgnore, home) => {
      await addFileGlobRuleToGitignore('x.local.json', repoWith({ '.gitignore': '*.local.json\n' }))
      expect(existsSync(join(home, '.config'))).toBe(false)
      writeFileDeep(globalIgnore, '**/y.bin\n')
      await addFileGlobRuleToGitignore('y.bin', repoWith())
      expect(readFileSync(globalIgnore, 'utf8')).toBe('**/y.bin\n')
    })
  })

  test('nothing is written when the rule is already in the global file, even if git does not apply it', async () => {
    await withTempHome(async globalIgnore => {
      writeFileDeep(globalIgnore, '**/pinned.json\n')
      const repo = repoWith({ '.gitignore': '!pinned.json\n' })
      expect(await isPathGitignored('pinned.json', repo)).toBe(false)
      await addFileGlobRuleToGitignore('pinned.json', repo)
      expect(readFileSync(globalIgnore, 'utf8')).toBe('**/pinned.json\n')
    })
  })

  test('nothing is written outside a git repository', async () => {
    await withTempHome(async (_globalIgnore, home) => {
      await addFileGlobRuleToGitignore('anything.json', mkTemp('no-repo'))
      expect(existsSync(join(home, '.config'))).toBe(false)
    })
  })

  test('the path is judged from the given directory, which defaults to the session cwd', async () => {
    await withTempHome(async (globalIgnore, home) => {
      const repo = repoWith({ 'sub/.gitignore': 'only-here.cfg\n' })
      await addFileGlobRuleToGitignore('only-here.cfg', join(repo, 'sub'))
      expect(existsSync(join(home, '.config'))).toBe(false)
      await runWithCwdOverride(repo, () => addFileGlobRuleToGitignore('only-here.cfg'))
      expect(readFileSync(globalIgnore, 'utf8')).toBe('**/only-here.cfg\n')
    })
  })

  test('a failure is swallowed: a directory where the global file belongs is left as it was', async () => {
    await withTempHome(async globalIgnore => {
      mkdirSync(globalIgnore, { recursive: true })
      await expect(addFileGlobRuleToGitignore('z.json', repoWith())).resolves.toBeUndefined()
      expect(statSync(globalIgnore).isDirectory()).toBe(true)
    })
  })

  test('in a process started with HOME at a temp directory, the rule lands in <HOME>/.config/git/ignore and git honours it', async () => {
    const repo = repoWith()
    const childHome = mkTemp('child-home')
    const script = join(mkTemp('driver'), 'add-rule.mjs')
    writeFileSync(script, [
      `const ignore = await import(${JSON.stringify(join(import.meta.dir, 'gitignore.ts'))})`,
      `const repo = ${JSON.stringify(repo)}`,
      "await ignore.addFileGlobRuleToGitignore('.claudin/settings.local.json', repo)",
      "const out = { path: ignore.getGlobalGitignorePath(), ignored: await ignore.isPathGitignored('.claudin/settings.local.json', repo) }",
      `process.stdout.write('\\n${OUTPUT_MARK}' + JSON.stringify(out))`,
      'process.exit(0)',
    ].join('\n'))
    const child = Bun.spawn([process.execPath, script], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: childHome,
        TMPDIR: os.tmpdir(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        CLAUDIN_CONFIG_DIR: join(childHome, '.claudin'),
        NODE_ENV: 'test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const at = stdout.lastIndexOf(OUTPUT_MARK)
    if (code !== 0 || at < 0) throw new Error(`driver failed (${code}): ${stderr}`)
    const expectedPath = join(childHome, '.config', 'git', 'ignore')
    expect(JSON.parse(stdout.slice(at + OUTPUT_MARK.length))).toEqual({ path: expectedPath, ignored: true })
    expect(readFileSync(expectedPath, 'utf8')).toBe(expectedFile('global-ignore.created.txt'))
  }, 20_000)
})
