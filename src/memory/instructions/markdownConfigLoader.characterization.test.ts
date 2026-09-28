/**
 * Characterization of `src/memory/instructions/markdownConfigLoader.ts`: the
 * reader behind every `.claudin/<subdir>` directory of markdown files (agents,
 * legacy commands, output styles, skills, workflows), and the frontmatter
 * helpers its callers share.
 *
 * Every test gets a fresh tree in the system temp directory:
 *   - `repo/`, a real git repository, stands for the project;
 *   - `config/` is the config home (`CLAUDIN_CONFIG_DIR`);
 *   - `managed/` is the managed directory. The platform path is not writable,
 *     so the memo of `getManagedFilePath` is seeded with it.
 * The setting sources, the session's project root and the managed policy are
 * process state. Each test sets them and puts them back.
 *
 * Two behaviours need a process of their own: Bun reads the home directory
 * once at startup, and the ripgrep lookup goes through PATH. Those tests run
 * the loader in a child `bun` that has its own HOME or PATH.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, relative, sep } from 'path'
// One line per import: the provenance measure skips import statements.
import { CLAUDE_CONFIG_DIRECTORIES, type ClaudeConfigDirectory, extractDescriptionFromMarkdown, getProjectDirsUpToHome, loadMarkdownFilesForSubdir, type MarkdownFile, parseAgentToolsFromFrontmatter, parseSlashCommandToolsFromFrontmatter } from 'src/memory/instructions/markdownConfigLoader.js'
import { getAdditionalDirectoriesForClaudeMd, getAllowedSettingSources, getProjectRoot, setAdditionalDirectoriesForClaudeMd, setAllowedSettingSources, setProjectRoot } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
// Every source switched on, as at startup. Set explicitly: another file in the
// same run may have narrowed them.
const EVERY_SOURCE: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
const ENV_WE_SET = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_USE_NATIVE_FILE_SEARCH'] as const
// A permission bit means nothing to root, so those two cases cannot be built.
const RUNNING_AS_ROOT = process.getuid?.() === 0

type Tree = { root: string; config: string; managed: string; repo: string }
let tree: Tree

const saved = {
  env: new Map<string, string | undefined>(),
  sources: [] as SettingSource[],
  addDirs: [] as string[],
  projectRoot: '',
}

function put(path: string, text = 'text\n'): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function folder(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

/** git, with the user's own and the system configuration shut out. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(tree.root, 'git-home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Characterization',
      GIT_AUTHOR_EMAIL: 'char@example.invalid',
      GIT_COMMITTER_NAME: 'Characterization',
      GIT_COMMITTER_EMAIL: 'char@example.invalid',
    },
  })
}

function repository(path: string): string {
  folder(path)
  git(path, 'init', '-q', '-b', 'main')
  return path
}

function repositoryWithCommit(path: string): string {
  repository(path)
  put(join(path, 'README'), 'readme\n')
  git(path, 'add', 'README')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

/** Every input, run through `fn`, gives the output written beside it. */
function eachGives<In, Out>(fn: (input: In) => Out, table: ReadonlyArray<readonly [In, Out]>): void {
  expect(table.map(([input]) => fn(input))).toEqual(table.map(([, output]) => output))
}

/** A path as the tests spell it: relative to the tree's root. */
const local = (path: string): string => relative(tree.root, path)
const claudin = (base: string, subdir: ClaudeConfigDirectory = 'agents'): string => join(base, '.claudin', subdir)
const walk = (cwd: string, subdir: ClaudeConfigDirectory = 'agents'): string[] => getProjectDirsUpToHome(subdir, cwd).map(local)

/** A loaded file as one line: its source, the directory searched, and the file's path inside that directory. */
const rowOf = (file: MarkdownFile): string => `${file.source} ${local(file.baseDir)} ${relative(file.baseDir, file.filePath)}`

async function rows(subdir: ClaudeConfigDirectory, cwd: string = tree.repo): Promise<string[]> {
  return (await loadMarkdownFilesForSubdir(subdir, cwd)).map(rowOf)
}

/** The order of files inside one directory is not part of the contract. */
async function filesFound(subdir: ClaudeConfigDirectory, cwd: string = tree.repo): Promise<string[]> {
  return (await loadMarkdownFilesForSubdir(subdir, cwd)).map(file => local(file.filePath)).sort()
}

async function onlyEntry(subdir: ClaudeConfigDirectory): Promise<MarkdownFile> {
  const found = await loadMarkdownFilesForSubdir(subdir, tree.repo)
  expect(found).toHaveLength(1)
  return found[0]!
}

function seedEverySource(subdir: ClaudeConfigDirectory): void {
  put(join(tree.managed, '.claudin', subdir, 'from-policy.md'))
  put(join(tree.config, subdir, 'from-user.md'))
  put(join(claudin(tree.repo, subdir), 'from-project.md'))
}

async function sourcesOf(subdir: ClaudeConfigDirectory): Promise<SettingSource[]> {
  return (await loadMarkdownFilesForSubdir(subdir, tree.repo)).map(file => file.source)
}

function lockToPlugins(value: unknown): void {
  put(join(tree.managed, 'managed-settings.json'), JSON.stringify({ strictPluginOnlyCustomization: value }))
  resetSettingsCache()
}

const forgetLoads = (): void => loadMarkdownFilesForSubdir.cache.clear?.()

beforeAll(() => {
  for (const key of ENV_WE_SET) saved.env.set(key, process.env[key])
  saved.sources = [...getAllowedSettingSources()]
  saved.addDirs = [...getAdditionalDirectoriesForClaudeMd()]
  saved.projectRoot = getProjectRoot()
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdcfg-char-')))
  tree = { root, config: join(root, 'config'), managed: join(root, 'managed'), repo: join(root, 'repo') }
  repository(tree.repo)
  process.env.CLAUDIN_CONFIG_DIR = tree.config
  delete process.env.CLAUDIN_USE_NATIVE_FILE_SEARCH
  getManagedFilePath.cache.set(undefined, tree.managed)
  getManagedSettingsDropInDir.cache.delete(undefined)
  setAllowedSettingSources([...EVERY_SOURCE])
  setAdditionalDirectoriesForClaudeMd([])
  // The session is anchored at the tree's root, which is no repository.
  setProjectRoot(root)
  resetSettingsCache()
  forgetLoads()
})

afterEach(() => {
  forgetLoads()
  setAllowedSettingSources([...saved.sources])
  setAdditionalDirectoriesForClaudeMd([...saved.addDirs])
  setProjectRoot(saved.projectRoot)
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  resetSettingsCache()
  for (const [key, value] of saved.env) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tree.root, { recursive: true, force: true })
})

describe('CLAUDE_CONFIG_DIRECTORIES', () => {
  test('names the five markdown subdirectories of .claudin, in this order', () => {
    expect([...CLAUDE_CONFIG_DIRECTORIES]).toEqual(['commands', 'agents', 'output-styles', 'skills', 'workflows'])
  })
})

describe('extractDescriptionFromMarkdown', () => {
  const described = (text: string): string => extractDescriptionFromMarkdown(text)

  test('is the first line that has text on it, trimmed; later lines do not count', () => {
    eachGives(described, [['\n   \n\t  Deploys the staging stack.  \nSecond line\n', 'Deploys the staging stack.']])
  })

  test('loses a heading marker of any level when whitespace follows it', () => {
    eachGives(described, [
      ['# Release checklist', 'Release checklist'],
      ['###\tNested heading', 'Nested heading'],
      ['#hashtag-style', '#hashtag-style'],
      ['#', '#'],
      ['## # still text', '# still text'],
    ])
  })

  test('keeps 100 characters whole and cuts a longer line to 97 plus "...", counted after the marker', () => {
    eachGives(described, [
      ['x'.repeat(100), 'x'.repeat(100)],
      ['y'.repeat(101), `${'y'.repeat(97)}...`],
      [`## ${'z'.repeat(100)}`, 'z'.repeat(100)],
    ])
  })

  test('falls back to "Custom item", or to the default given, when no line has text', () => {
    eachGives(described, [['', 'Custom item'], [' \n\t\n', 'Custom item']])
    eachGives((text: string) => extractDescriptionFromMarkdown(text, 'Custom command'), [['\n\n', 'Custom command']])
  })

  test('reads CRLF text, and does not skip frontmatter: callers hand it the body', () => {
    eachGives(described, [['\r\n# Title\r\nnext line\r\n', 'Title'], ['---\ndescription: from yaml\n---\nBody', '---']])
  })
})

describe('parseSlashCommandToolsFromFrontmatter', () => {
  const slash = (value: unknown): string[] => parseSlashCommandToolsFromFrontmatter(value)

  test('reads no tools from an absent, null, empty, false or zero value', () => {
    eachGives(slash, [[undefined, []], [null, []], ['', []], [false, []], [0, []]])
  })

  test('splits a string on commas and spaces, except inside parentheses', () => {
    eachGives(slash, [
      ['Read, Grep  Glob', ['Read', 'Grep', 'Glob']],
      ['Bash(git status:*), Bash(git add, git commit) Read', ['Bash(git status:*)', 'Bash(git add, git commit)', 'Read']],
    ])
  })

  test('takes the strings of a list, splits each the same way, and drops what is not a string', () => {
    eachGives(slash, [
      [['Read', 'Edit, Write', 'Bash(npm run build)'], ['Read', 'Edit', 'Write', 'Bash(npm run build)']],
      [['Read', 7, null, { Grep: true }, 'Glob'], ['Read', 'Glob']],
      [[7, false], []],
      [[], []],
    ])
  })

  test('reads true, a non-zero number, a mapping or blank text as no tools', () => {
    eachGives(slash, [[true, []], [12, []], [{ Read: true }, []], ['   ', []]])
  })

  test('collapses to ["*"] when any entry is the bare wildcard, and keeps repeats otherwise', () => {
    eachGives(slash, [
      ['Read, *, Grep', ['*']],
      [['Grep', '*'], ['*']],
      ['Bash(*)', ['Bash(*)']],
      ['Grep Read Grep', ['Grep', 'Read', 'Grep']],
    ])
  })
})

describe('parseAgentToolsFromFrontmatter', () => {
  const agentTools = (value: unknown): string[] | undefined => parseAgentToolsFromFrontmatter(value)

  test('undefined, meaning every tool, for an absent key or a bare wildcard anywhere', () => {
    eachGives(agentTools, [[undefined, undefined], ['*', undefined], ['Read, *', undefined], [['*'], undefined]])
  })

  test('no tool for a value that is present but empty: null (a bare `tools:`), "", false, 0 or []', () => {
    eachGives(agentTools, [[null, []], ['', []], [false, []], [0, []], [[], []]])
  })

  test('strings and lists split as the slash-command reader splits them', () => {
    eachGives(agentTools, [
      ['Read Grep, Bash(git log:*)', ['Read', 'Grep', 'Bash(git log:*)']],
      [['Edit, Write', 3], ['Edit', 'Write']],
    ])
  })

  test('no tool for true, a number, a mapping or a list without strings', () => {
    eachGives(agentTools, [[true, []], [5, []], [{ Read: true }, []], [[1, 2], []]])
  })

  test('through a loaded file: `tools:` with nothing after it gives no tool, a missing key gives every tool', async () => {
    put(join(claudin(tree.repo), 'bare.md'), '---\nname: bare\ntools:\n---\nPrompt.\n')
    put(join(claudin(tree.repo), 'open.md'), '---\nname: open\n---\nPrompt.\n')
    const byName = new Map((await loadMarkdownFilesForSubdir('agents', tree.repo)).map(file => [file.frontmatter.name, file]))
    expect(agentTools(byName.get('bare')?.frontmatter.tools)).toEqual([])
    expect(agentTools(byName.get('open')?.frontmatter.tools)).toBeUndefined()
  })
})

describe('getProjectDirsUpToHome', () => {
  test('inside a repository: from the cwd up to and including its root, nearest first', () => {
    const cwd = folder(join(tree.repo, 'pkg', 'app'))
    for (const base of [cwd, join(tree.repo, 'pkg'), tree.repo, tree.root]) folder(claudin(base))
    expect(walk(cwd)).toEqual(['repo/pkg/app/.claudin/agents', 'repo/pkg/.claudin/agents', 'repo/.claudin/agents'])
  })

  test('lists a directory only where .claudin/<subdir> exists, for the subdir asked', () => {
    const cwd = folder(join(tree.repo, 'a', 'b'))
    folder(claudin(cwd, 'commands'))
    folder(join(tree.repo, 'a', '.claudin'))
    folder(claudin(tree.repo, 'agents'))
    expect(walk(cwd, 'agents')).toEqual(['repo/.claudin/agents'])
    expect(walk(cwd, 'commands')).toEqual(['repo/a/b/.claudin/commands'])
    expect(walk(cwd, 'workflows')).toEqual([])
  })

  test('with the cwd at the repository root, only the root is looked at', () => {
    folder(claudin(tree.repo))
    folder(claudin(tree.root))
    expect(walk(tree.repo)).toEqual(['repo/.claudin/agents'])
  })

  test('follows a symlinked .claudin/<subdir>, and passes over a dangling one, a looping one and a .claudin that is a file', () => {
    const linked = join(tree.repo, 'l')
    const dangling = join(linked, 'd')
    const looping = join(dangling, 'o')
    const withFile = join(looping, 'f')
    folder(join(linked, '.claudin'))
    symlinkSync(folder(join(tree.root, 'shared-agents')), claudin(linked))
    folder(join(dangling, '.claudin'))
    symlinkSync(join(tree.root, 'nowhere'), claudin(dangling))
    folder(join(looping, '.claudin'))
    symlinkSync(claudin(looping), claudin(looping))
    put(join(withFile, '.claudin'), 'a file, not a directory\n')
    expect(walk(withFile)).toEqual(['repo/l/.claudin/agents'])
  })

  test.skipIf(RUNNING_AS_ROOT)('passes over a .claudin it may not enter', () => {
    const cwd = folder(join(tree.repo, 'locked'))
    folder(claudin(cwd))
    folder(claudin(tree.repo))
    chmodSync(join(cwd, '.claudin'), 0o000)
    try {
      expect(walk(cwd)).toEqual(['repo/.claudin/agents'])
    } finally {
      chmodSync(join(cwd, '.claudin'), 0o755)
    }
  })

  test('resolves the cwd first: dot segments and a trailing separator change nothing', () => {
    const cwd = folder(join(tree.repo, 'x', 'y'))
    folder(claudin(cwd))
    expect(getProjectDirsUpToHome('agents', `${tree.repo}/x/./z/../y/`)).toEqual([claudin(cwd)])
  })

  test('outside any repository the walk goes on past the tree, towards the filesystem root', () => {
    const cwd = folder(join(tree.root, 'loose', 'a', 'b'))
    folder(claudin(join(tree.root, 'loose')))
    folder(claudin(tree.root))
    // Whatever the machine holds above the tree is not ours to pin.
    const inTree = getProjectDirsUpToHome('agents', cwd).filter(path => path.startsWith(tree.root + sep))
    expect(inTree.map(local)).toEqual(['loose/.claudin/agents', '.claudin/agents'])
  })

  test('a repository nested in the session\'s project repository does not stop the walk', () => {
    const outer = repository(join(tree.root, 'outer'))
    const nested = repository(join(outer, 'vendor', 'lib'))
    const cwd = folder(join(nested, 'src'))
    for (const base of [cwd, nested, join(outer, 'vendor'), outer, tree.root]) folder(claudin(base))
    setProjectRoot(outer)
    expect(walk(cwd)).toEqual(['outer/vendor/lib/src/.claudin/agents', 'outer/vendor/lib/.claudin/agents', 'outer/vendor/.claudin/agents', 'outer/.claudin/agents'])
  })

  test('the same nested repository stops the walk when the session is not anchored in a repository', () => {
    const outer = repository(join(tree.root, 'outer'))
    const nested = repository(join(outer, 'vendor', 'lib'))
    const cwd = folder(join(nested, 'src'))
    for (const base of [cwd, nested, outer]) folder(claudin(base))
    expect(walk(cwd)).toEqual(['outer/vendor/lib/src/.claudin/agents', 'outer/vendor/lib/.claudin/agents'])
  })

  test('a sibling repository stops the walk, even when its path starts with the project root\'s', () => {
    const project = repository(join(tree.root, 'app'))
    const sibling = repository(join(tree.root, 'app-tools'))
    const cwd = folder(join(sibling, 'bin'))
    for (const base of [cwd, sibling, tree.root]) folder(claudin(base))
    setProjectRoot(project)
    expect(walk(cwd)).toEqual(['app-tools/bin/.claudin/agents', 'app-tools/.claudin/agents'])
  })

  test('a git submodule is walked past like any nested repository', () => {
    const library = repositoryWithCommit(join(tree.root, 'library'))
    const outer = repositoryWithCommit(join(tree.root, 'outer'))
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'deps/library')
    const cwd = join(outer, 'deps', 'library')
    for (const base of [cwd, outer]) folder(claudin(base))
    setProjectRoot(outer)
    expect(walk(cwd)).toEqual(['outer/deps/library/.claudin/agents', 'outer/.claudin/agents'])
  })

  test('a worktree of the session\'s repository stops at its own root, even inside the main checkout', () => {
    const main = repositoryWithCommit(join(tree.root, 'main'))
    const worktree = join(main, '.claudin', 'worktrees', 'topic')
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'topic')
    const cwd = folder(join(worktree, 'pkg'))
    for (const base of [cwd, worktree, main]) folder(claudin(base))
    setProjectRoot(main)
    expect(walk(cwd)).toEqual(['main/.claudin/worktrees/topic/pkg/.claudin/agents', 'main/.claudin/worktrees/topic/.claudin/agents'])
  })

  test('an error other than "missing or out of reach" is thrown, not passed over', () => {
    let code: unknown
    try {
      getProjectDirsUpToHome('agents', join(tree.root, 'n'.repeat(300)))
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENAMETOOLONG')
  })
})

describe('loadMarkdownFilesForSubdir: sources and their order', () => {
  test('managed, then user, then the project directories nearest first, each with its source and searched directory', async () => {
    const cwd = folder(join(tree.repo, 'svc', 'api'))
    put(join(tree.managed, '.claudin', 'agents', 'from-policy.md'))
    put(join(tree.config, 'agents', 'from-user.md'))
    put(join(claudin(tree.repo), 'from-root.md'))
    put(join(claudin(join(tree.repo, 'svc')), 'from-svc.md'))
    put(join(claudin(cwd), 'from-cwd.md'))
    expect(await rows('agents', cwd)).toEqual([
      'policySettings managed/.claudin/agents from-policy.md',
      'userSettings config/agents from-user.md',
      'projectSettings repo/svc/api/.claudin/agents from-cwd.md',
      'projectSettings repo/svc/.claudin/agents from-svc.md',
      'projectSettings repo/.claudin/agents from-root.md',
    ])
  })

  test('each of the five subdirectories is read the same way, from every source', async () => {
    for (const subdir of CLAUDE_CONFIG_DIRECTORIES) seedEverySource(subdir)
    for (const subdir of CLAUDE_CONFIG_DIRECTORIES) {
      expect(await rows(subdir)).toEqual([
        `policySettings managed/.claudin/${subdir} from-policy.md`,
        `userSettings config/${subdir} from-user.md`,
        `projectSettings repo/.claudin/${subdir} from-project.md`,
      ])
    }
  })

  test('an entry keeps the directory that was searched, however deep the file sits', async () => {
    put(join(claudin(tree.repo), 'team', 'backend', 'db.md'))
    expect(await rows('agents')).toEqual(['projectSettings repo/.claudin/agents team/backend/db.md'])
  })

  test('directories that do not exist contribute nothing, and raise nothing', async () => {
    expect(await rows('workflows')).toEqual([])
  })

  test('the user directory is <CLAUDIN_CONFIG_DIR>/<subdir>, as the variable reads when the load runs', async () => {
    const elsewhere = join(tree.root, 'other-config')
    put(join(elsewhere, 'commands', 'mine.md'))
    put(join(tree.config, 'commands', 'not-read.md'))
    process.env.CLAUDIN_CONFIG_DIR = elsewhere
    expect(await rows('commands')).toEqual(['userSettings other-config/commands mine.md'])
  })

  test('--add-dir directories are not read', async () => {
    const extra = folder(join(tree.root, 'extra'))
    put(join(claudin(extra), 'extra.md'))
    setAdditionalDirectoriesForClaudeMd([extra])
    expect(await rows('agents')).toEqual([])
  })
})

describe('loadMarkdownFilesForSubdir: settings sources and the plugin-only policy', () => {
  test('with user settings off, the user directory is not read', async () => {
    seedEverySource('commands')
    setAllowedSettingSources(EVERY_SOURCE.filter(source => source !== 'userSettings'))
    expect(await sourcesOf('commands')).toEqual(['policySettings', 'projectSettings'])
  })

  test('with project settings off, no project directory is read', async () => {
    seedEverySource('output-styles')
    setAllowedSettingSources(EVERY_SOURCE.filter(source => source !== 'projectSettings'))
    expect(await sourcesOf('output-styles')).toEqual(['policySettings', 'userSettings'])
  })

  test('the managed directory is read even with both of them off', async () => {
    seedEverySource('skills')
    setAllowedSettingSources(['localSettings'])
    expect(await sourcesOf('skills')).toEqual(['policySettings'])
  })

  test('a plugin-only lock on agents, as true or as a list naming them, leaves only the managed agents', async () => {
    seedEverySource('agents')
    lockToPlugins(true)
    expect(await sourcesOf('agents')).toEqual(['policySettings'])
    forgetLoads()
    lockToPlugins(['agents'])
    expect(await sourcesOf('agents')).toEqual(['policySettings'])
  })

  test('a lock that names only other surfaces changes nothing for agents', async () => {
    seedEverySource('agents')
    lockToPlugins(['skills', 'hooks', 'mcp'])
    expect(await sourcesOf('agents')).toEqual(['policySettings', 'userSettings', 'projectSettings'])
  })

  test('the lock does not touch any other subdirectory here', async () => {
    const others: ClaudeConfigDirectory[] = ['commands', 'output-styles', 'skills', 'workflows']
    for (const subdir of others) seedEverySource(subdir)
    lockToPlugins(true)
    for (const subdir of others) expect(await sourcesOf(subdir)).toEqual(['policySettings', 'userSettings', 'projectSettings'])
  })
})

describe('loadMarkdownFilesForSubdir: git worktrees', () => {
  const TOPIC = 'main/.claudin/worktrees/topic'

  /** A worktree made inside the main checkout, where --worktree puts one. */
  function mainWithWorktree(beforeBranching?: (main: string) => void): { main: string; worktree: string } {
    const main = repositoryWithCommit(join(tree.root, 'main'))
    beforeBranching?.(main)
    const worktree = join(main, '.claudin', 'worktrees', 'topic')
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'topic')
    setProjectRoot(main)
    return { main, worktree }
  }

  test('a worktree whose root lacks .claudin/<subdir> also reads the main checkout\'s, after its own walk', async () => {
    const { main, worktree } = mainWithWorktree()
    put(join(claudin(main), 'shared.md'))
    const cwd = folder(join(worktree, 'pkg'))
    // A nested directory does not count as the worktree's own.
    put(join(claudin(cwd), 'local.md'))
    expect(await rows('agents', cwd)).toEqual([
      `projectSettings ${TOPIC}/pkg/.claudin/agents local.md`,
      'projectSettings main/.claudin/agents shared.md',
    ])
  })

  test('a worktree with its own .claudin/<subdir> does not read the main checkout\'s', async () => {
    const { main, worktree } = mainWithWorktree()
    put(join(claudin(main), 'shared.md'))
    put(join(claudin(worktree), 'own.md'))
    expect(await rows('agents', worktree)).toEqual([`projectSettings ${TOPIC}/.claudin/agents own.md`])
  })

  test('a committed .claudin/<subdir> is read once, from the worktree\'s own checkout', async () => {
    const { worktree } = mainWithWorktree(main => {
      put(join(claudin(main), 'tracked.md'))
      git(main, 'add', '.claudin/agents')
      git(main, 'commit', '-q', '-m', 'agents')
    })
    expect(await rows('agents', worktree)).toEqual([`projectSettings ${TOPIC}/.claudin/agents tracked.md`])
  })

  test('the main checkout\'s copy is a project directory: with project settings off it is not read', async () => {
    const { main, worktree } = mainWithWorktree()
    put(join(claudin(main), 'shared.md'))
    setAllowedSettingSources(EVERY_SOURCE.filter(source => source !== 'projectSettings'))
    expect(await rows('agents', worktree)).toEqual([])
  })
})

const SEARCHES = [
  { label: 'the default search', nativeSwitch: undefined },
  { label: 'CLAUDIN_USE_NATIVE_FILE_SEARCH=1', nativeSwitch: '1' },
] as const

for (const search of SEARCHES) {
  describe(`loadMarkdownFilesForSubdir: which files count, with ${search.label}`, () => {
    beforeEach(() => {
      if (search.nativeSwitch !== undefined) process.env.CLAUDIN_USE_NATIVE_FILE_SEARCH = search.nativeSwitch
    })

    const underAgents = (names: string[]): string[] => names.map(name => `repo/.claudin/agents/${name}`).sort()

    test('every *.md at any depth, with the extension in lower case only', async () => {
      const base = claudin(tree.repo)
      const names = ['top.md', 'team/review.md', 'a/b/c/deep.md', 'notes.md/inside.md', '.md', 'SHOUT.MD', 'Mixed.Md', 'page.markdown', 'readme.txt', 'no-extension', 'doc.mdx']
      for (const name of names) put(join(base, name))
      expect(await filesFound('agents')).toEqual(underAgents(['top.md', 'team/review.md', 'a/b/c/deep.md', 'notes.md/inside.md', '.md']))
    })

    test('hidden files and directories count, and no ignore file is honoured', async () => {
      const base = claudin(tree.repo)
      const kept = ['.draft.md', '.private/kept.md', 'plain.md', 'drafts/wip.md', 'archive/old.md', 'vendored/third.md']
      for (const name of kept) put(join(base, name))
      put(join(base, '.gitignore'), '*.md\ndrafts/\n')
      put(join(base, '.ignore'), '*.md\narchive/\n')
      put(join(base, '.rgignore'), '*.md\nvendored/\n')
      put(join(tree.repo, '.gitignore'), '.claudin/\n')
      expect(await filesFound('agents')).toEqual(underAgents(kept))
    })

    test('symlinks to directories and files are followed, the path runs through the link, and the link\'s name decides', async () => {
      const base = folder(claudin(tree.repo))
      put(join(tree.root, 'elsewhere', 'reached.md'))
      put(join(tree.root, 'target.txt'))
      put(join(tree.root, 'target.md'))
      symlinkSync(join(tree.root, 'elsewhere'), join(base, 'shared'))
      symlinkSync(join(tree.root, 'target.txt'), join(base, 'alias.md'))
      symlinkSync(join(tree.root, 'target.md'), join(base, 'named.txt'))
      expect(await filesFound('agents')).toEqual(underAgents(['alias.md', 'shared/reached.md']))
    })

    test('dangling links are passed over, and a symlink loop ends the search without repeats', async () => {
      const base = claudin(tree.repo)
      put(join(base, 'inner', 'only.md'))
      symlinkSync(base, join(base, 'inner', 'back-to-top'))
      symlinkSync(join(tree.root, 'gone.md'), join(base, 'dangling.md'))
      symlinkSync(join(tree.root, 'gone-dir'), join(base, 'dangling-dir'))
      expect(await filesFound('agents')).toEqual(underAgents(['inner/only.md']))
    })

    test.skipIf(RUNNING_AS_ROOT)('an unreadable file or directory is left out and the rest still load', async () => {
      const base = claudin(tree.repo)
      put(join(base, 'fine.md'))
      const secret = put(join(base, 'secret.md'))
      const vault = folder(join(base, 'vault'))
      put(join(vault, 'inside.md'))
      chmodSync(secret, 0o000)
      chmodSync(vault, 0o000)
      try {
        expect(await filesFound('agents')).toEqual(underAgents(['fine.md']))
      } finally {
        chmodSync(secret, 0o644)
        chmodSync(vault, 0o755)
      }
    })

    test('files with one name in several sources keep the managed, user, project order', async () => {
      put(join(tree.managed, '.claudin', 'commands', 'deploy.md'))
      put(join(tree.config, 'commands', 'deploy.md'))
      put(join(claudin(tree.repo, 'commands'), 'deploy.md'))
      expect(await sourcesOf('commands')).toEqual(['policySettings', 'userSettings', 'projectSettings'])
    })
  })
}

describe('loadMarkdownFilesForSubdir: what an entry carries', () => {
  const AGENT_FRONTMATTER = {
    name: 'release-notes-writer',
    description: 'Use when a release branch is cut.\\nDrafts the notes from merged PR titles.',
    tools: 'Read, Grep, Bash(git log:*)',
    effort: 'medium',
    color: 'green',
  }
  const AGENT_BODY_LINES = ['# Release notes', '', 'Group the merged pull requests by type and write one line for each.', '']

  test('an agent file as the /agents editor writes it: its frontmatter, and the body after it', async () => {
    put(join(claudin(tree.repo), 'release-notes-writer.md'), readFileSync(join(FIXTURES, 'agent.md'), 'utf8'))
    const agent = await onlyEntry('agents')
    expect(agent.frontmatter).toEqual(AGENT_FRONTMATTER)
    expect(agent.content).toBe(AGENT_BODY_LINES.join('\n'))
    expect(parseAgentToolsFromFrontmatter(agent.frontmatter.tools)).toEqual(['Read', 'Grep', 'Bash(git log:*)'])
    expect(extractDescriptionFromMarkdown(agent.content)).toBe('Release notes')
  })

  test('the same agent file with CRLF line endings', async () => {
    const crlf = readFileSync(join(FIXTURES, 'agent.md'), 'utf8').replaceAll('\n', '\r\n')
    put(join(claudin(tree.repo), 'release-notes-writer.md'), crlf)
    const agent = await onlyEntry('agents')
    expect(agent.frontmatter).toEqual(AGENT_FRONTMATTER)
    expect(agent.content).toBe(AGENT_BODY_LINES.join('\r\n'))
  })

  test('a legacy command whose values only parse once they are quoted', async () => {
    put(join(tree.config, 'commands', 'pr', 'summary.md'), readFileSync(join(FIXTURES, 'command.md'), 'utf8'))
    const command = await onlyEntry('commands')
    expect(command.frontmatter).toEqual({
      description: 'Summarise an open pull request',
      'argument-hint': '[pr-number] [--with-comments]',
      'allowed-tools': 'Bash(gh pr view:*), Bash(gh pr diff:*), Read',
      model: 'sonnet',
    })
    expect(command.content).toBe('Fetch pull request $ARGUMENTS and summarise what it changes, file by file.\n')
    expect(parseSlashCommandToolsFromFrontmatter(command.frontmatter['allowed-tools'])).toEqual(['Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Read'])
  })

  test('without frontmatter: an empty mapping, and the whole text as the body', async () => {
    put(join(claudin(tree.repo, 'output-styles'), 'terse.md'), 'Answer in one sentence.\n---\nnot: frontmatter\n')
    const style = await onlyEntry('output-styles')
    expect(style.frontmatter).toEqual({})
    expect(style.content).toBe('Answer in one sentence.\n---\nnot: frontmatter\n')
  })

  test('frontmatter that is not YAML: an empty mapping, and the body after the closing line', async () => {
    put(join(claudin(tree.repo, 'workflows'), 'broken.md'), '---\nname: "unterminated\nsteps: [\n---\nStill loaded.\n')
    const workflow = await onlyEntry('workflows')
    expect(workflow.frontmatter).toEqual({})
    expect(workflow.content).toBe('Still loaded.\n')
  })

  test('an empty file loads, with nothing in it', async () => {
    put(join(claudin(tree.repo, 'skills'), 'empty.md'), '')
    const empty = await onlyEntry('skills')
    expect(empty.frontmatter).toEqual({})
    expect(empty.content).toBe('')
  })
})

describe('loadMarkdownFilesForSubdir: each file once', () => {
  test('a config directory linked into the project gives each file once, from the user source', async () => {
    put(join(claudin(tree.repo), 'shared.md'))
    folder(tree.config)
    symlinkSync(claudin(tree.repo), join(tree.config, 'agents'))
    expect(await rows('agents')).toEqual(['userSettings config/agents shared.md'])
  })

  test('a hard link is the same file: the copy in the earlier source wins, whatever its name', async () => {
    const original = put(join(claudin(tree.repo), 'policy.md'))
    folder(join(tree.managed, '.claudin', 'agents'))
    linkSync(original, join(tree.managed, '.claudin', 'agents', 'policy-copy.md'))
    expect(await rows('agents')).toEqual(['policySettings managed/.claudin/agents policy-copy.md'])
  })

  test('two paths to one file inside the same directory give one entry', async () => {
    const base = claudin(tree.repo)
    put(join(base, 'real', 'one.md'))
    symlinkSync(join(base, 'real'), join(base, 'alias'))
    const found = await rows('agents')
    expect(found).toHaveLength(1)
    expect(['projectSettings repo/.claudin/agents real/one.md', 'projectSettings repo/.claudin/agents alias/one.md']).toContain(found[0]!)
  })

  test('a symlinked file is an entry of its own, beside the file it points to', async () => {
    const target = put(join(claudin(tree.repo), 'reviewer.md'))
    folder(join(tree.config, 'agents'))
    symlinkSync(target, join(tree.config, 'agents', 'reviewer.md'))
    expect(await rows('agents')).toEqual(['userSettings config/agents reviewer.md', 'projectSettings repo/.claudin/agents reviewer.md'])
  })

  test('distinct files are all kept, with the same name or the same content', async () => {
    put(join(tree.config, 'agents', 'twin.md'), 'identical\n')
    put(join(claudin(tree.repo), 'twin.md'), 'identical\n')
    put(join(claudin(tree.repo), 'copy.md'), 'identical\n')
    expect(await filesFound('agents')).toEqual(['config/agents/twin.md', 'repo/.claudin/agents/copy.md', 'repo/.claudin/agents/twin.md'])
  })
})

describe('loadMarkdownFilesForSubdir: the cache', () => {
  test('a second load for the same subdirectory and cwd does not look at the disk again', async () => {
    put(join(claudin(tree.repo), 'first.md'))
    expect(await filesFound('agents')).toEqual(['repo/.claudin/agents/first.md'])
    put(join(claudin(tree.repo), 'second.md'))
    expect(await filesFound('agents')).toEqual(['repo/.claudin/agents/first.md'])
  })

  test('cache.clear() drops every cached load, so the next one reads again', async () => {
    expect(typeof loadMarkdownFilesForSubdir.cache.clear).toBe('function')
    put(join(claudin(tree.repo), 'first.md'))
    put(join(claudin(tree.repo, 'commands'), 'one.md'))
    await filesFound('agents')
    await filesFound('commands')
    put(join(claudin(tree.repo), 'second.md'))
    put(join(claudin(tree.repo, 'commands'), 'two.md'))
    loadMarkdownFilesForSubdir.cache.clear?.()
    expect(await filesFound('agents')).toEqual(['repo/.claudin/agents/first.md', 'repo/.claudin/agents/second.md'])
    expect(await filesFound('commands')).toEqual(['repo/.claudin/commands/one.md', 'repo/.claudin/commands/two.md'])
  })

  test('another cwd, or another subdirectory, is a load of its own', async () => {
    put(join(claudin(tree.repo), 'first.md'))
    await filesFound('agents')
    put(join(claudin(tree.repo), 'second.md'))
    put(join(claudin(tree.repo, 'commands'), 'cmd.md'))
    const below = folder(join(tree.repo, 'below'))
    expect(await filesFound('agents', below)).toEqual(['repo/.claudin/agents/first.md', 'repo/.claudin/agents/second.md'])
    expect(await filesFound('commands')).toEqual(['repo/.claudin/commands/cmd.md'])
  })
})

describe('loadMarkdownFilesForSubdir: errors', () => {
  test('an unexpected file-system error in the walk rejects the load', async () => {
    const outcome = await loadMarkdownFilesForSubdir('agents', join(tree.root, 'n'.repeat(300))).then(
      () => 'resolved',
      (error: NodeJS.ErrnoException) => error.code,
    )
    expect(outcome).toBe('ENAMETOOLONG')
  })
})

describe('in a process of its own', () => {
  const LOADER = join(import.meta.dir, 'markdownConfigLoader.ts')
  const MANAGED_PATH = Bun.resolveSync('src/platform/settings/managedPath.ts', import.meta.dir)
  const PRELOAD = Bun.resolveSync('src/stubs/test-preload.ts', import.meta.dir)
  const CHILD_SCRIPT = [
    'const input = JSON.parse(process.env.CHAR_INPUT ?? "{}")',
    'const loader = await import(input.loader)',
    'const { getManagedFilePath } = await import(input.managedPath)',
    'getManagedFilePath.cache.set(undefined, input.managed)',
    'const walks = input.walkFrom.map(cwd => loader.getProjectDirsUpToHome("agents", cwd))',
    'const loaded = await loader.loadMarkdownFilesForSubdir(input.subdir, input.loadFrom)',
    'const files = loaded.map(file => file.source + " " + file.filePath)',
    'process.stdout.write(JSON.stringify({ walks, files }))',
    'process.exit(0)',
  ].join('\n')

  type ChildInput = { walkFrom: string[]; loadFrom: string; subdir: ClaudeConfigDirectory }

  /** Runs the loader in a fresh `bun` with exactly the environment given. */
  function inChild(env: Record<string, string>, input: ChildInput): { walks: string[][]; files: string[] } {
    const script = put(join(tree.root, 'child.ts'), CHILD_SCRIPT)
    const payload = JSON.stringify({ ...input, loader: LOADER, managedPath: MANAGED_PATH, managed: tree.managed })
    const run = spawnSync(process.execPath, ['run', '--preload', PRELOAD, script], {
      cwd: tree.root,
      env: { ...env, CHAR_INPUT: payload },
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (run.status !== 0) throw new Error(`child exited with ${run.status}: ${run.stderr}`)
    const output = JSON.parse(run.stdout) as { walks: string[][]; files: string[] }
    return {
      walks: output.walks.map(found => found.map(local)),
      files: output.files.map(line => line.replace(tree.root + sep, '')),
    }
  }

  test('outside a repository the walk stops below HOME, and HOME\'s own .claudin is read only as the user directory', () => {
    const home = folder(join(tree.root, 'home'))
    const site = folder(join(home, 'work', 'site'))
    for (const base of [site, join(home, 'work'), home, tree.root]) put(join(claudin(base), `${basename(base)}.md`))
    const seen = inChild({ HOME: home, PATH: process.env.PATH ?? '' }, { walkFrom: [site, home], loadFrom: site, subdir: 'agents' })
    expect(seen.walks).toEqual([['home/work/site/.claudin/agents', 'home/work/.claudin/agents'], []])
    expect(seen.files).toEqual([
      'userSettings home/.claudin/agents/home.md',
      'projectSettings home/work/site/.claudin/agents/site.md',
      'projectSettings home/work/.claudin/agents/work.md',
    ])
  }, 40_000)

  test('HOME ends the walk even inside a repository whose root lies above it', () => {
    const dotfiles = repository(join(tree.root, 'dotfiles'))
    const home = folder(join(dotfiles, 'home'))
    const project = folder(join(home, 'project'))
    const beside = folder(join(dotfiles, 'beside'))
    for (const base of [project, home, beside, dotfiles]) folder(claudin(base))
    const seen = inChild({ HOME: home, PATH: process.env.PATH ?? '' }, { walkFrom: [project, beside], loadFrom: project, subdir: 'agents' })
    expect(seen.walks).toEqual([['dotfiles/home/project/.claudin/agents'], ['dotfiles/beside/.claudin/agents', 'dotfiles/.claudin/agents']])
  }, 40_000)

  test('when the ripgrep binary cannot be started, the files still load', () => {
    // The system ripgrep is chosen (USE_BUILTIN_RIPGREP=0) and is broken: it
    // is found on PATH, but its interpreter does not exist, so exec fails.
    const brokenBin = folder(join(tree.root, 'broken-bin'))
    const brokenRg = put(join(brokenBin, 'rg'), '#!/nonexistent/interpreter\n')
    chmodSync(brokenRg, 0o755)
    expect(Bun.which('rg', { PATH: brokenBin })).toBe(brokenRg)
    expect((spawnSync(brokenRg).error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
    put(join(tree.config, 'agents', 'mine.md'))
    put(join(claudin(tree.repo), 'found.md'))
    put(join(claudin(tree.repo), 'nested', 'deeper.md'))
    const env = { HOME: join(tree.root, 'home'), PATH: brokenBin, USE_BUILTIN_RIPGREP: '0', CLAUDIN_CONFIG_DIR: tree.config }
    const seen = inChild(env, { walkFrom: [], loadFrom: tree.repo, subdir: 'agents' })
    expect(seen.files[0]).toBe('userSettings config/agents/mine.md')
    expect(seen.files.slice(1).sort()).toEqual(['projectSettings repo/.claudin/agents/found.md', 'projectSettings repo/.claudin/agents/nested/deeper.md'])
  }, 40_000)
})
