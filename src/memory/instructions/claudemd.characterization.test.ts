/**
 * Characterization of the instruction loader as a session sees it:
 * `getMemoryFiles`, its cache and its InstructionsLoaded reports, the text
 * `getClaudeMds` hands the model, and the external-include warning.
 *
 * Each test builds its own tree under the system temp directory:
 *
 *   <root>/config           CLAUDIN_CONFIG_DIR, the user's files
 *   <root>/managed          the managed directory (its memo is seeded)
 *   <root>/memory           the auto-memory directory, by its override variable
 *   <root>/outer            a plain directory holding the repository
 *   <root>/outer/repo       a git repository
 *   <root>/outer/repo/pkg/app   the session's original cwd
 *
 * The loader walks every ancestor of the cwd, so it also looks at the temp
 * directory itself and above. Only entries inside <root> are asserted on: what
 * other processes leave in /tmp is not this suite's business.
 *
 * `feature('TEAMMEM')` is off under `bun test`; the shipped-flag behaviour is in
 * `claudemd.teamMemory.characterization.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, sep } from 'path'
// One line per import: the provenance measure skips import statements.
import * as loader from 'src/memory/instructions/claudemd.js'
import { clearMemoryFileCaches, getClaudeMds, getExternalClaudeMdIncludes, getMemoryFiles, type MemoryFileInfo, resetGetMemoryFilesCache, shouldShowClaudeMdExternalIncludesWarning } from 'src/memory/instructions/claudemd.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { clearRegisteredHooks, getAdditionalDirectoriesForClaudeMd, getAllowedSettingSources, getIsInteractive, getOriginalCwd, getProjectRoot, getRegisteredHooks, registerHookCallbacks, setAdditionalDirectoriesForClaudeMd, setAllowedSettingSources, setIsInteractive, setOriginalCwd, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from 'src/platform/config/config.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { HookInput } from 'src/platform/entrypoints/agentSdkTypes.js'

type Tree = { root: string; config: string; managed: string; memory: string; outer: string; repo: string; cwd: string }
let t: Tree

const ALL_SOURCES: SettingSource[] = ['policySettings', 'flagSettings', 'userSettings', 'projectSettings', 'localSettings']
const TOUCHED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_AUTO_MEMORY', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD'] as const

const before = {
  env: {} as Record<string, string | undefined>,
  cwd: '',
  projectRoot: '',
  sources: [] as SettingSource[],
  addDirs: [] as string[],
  interactive: false,
  hooks: null as ReturnType<typeof getRegisteredHooks>,
  approved: false as boolean | undefined,
  shown: false as boolean | undefined,
}

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(t.root, 'git-home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'loader char',
      GIT_AUTHOR_EMAIL: 'loader@example.invalid',
      GIT_COMMITTER_NAME: 'loader char',
      GIT_COMMITTER_EMAIL: 'loader@example.invalid',
    },
  })
}

function initRepo(dir: string, withCommit = false): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'trunk')
  if (withCommit) {
    write(join(dir, '.gitkeep'), '')
    git(dir, 'add', '.gitkeep')
    git(dir, 'commit', '-q', '-m', 'seed')
  }
}

const inTree = (path: string): boolean => path.startsWith(t.root + sep)
const short = (path: string): string => relative(t.root, path)

/** Each loaded entry inside the tree, as "<type> <path from root>". */
function describeLoad(files: MemoryFileInfo[]): string[] {
  return files.filter(f => inTree(f.path)).map(f => `${f.type} ${short(f.path)}`)
}

async function freshLoad(forceIncludeExternal?: boolean): Promise<MemoryFileInfo[]> {
  clearMemoryFileCaches()
  return getMemoryFiles(forceIncludeExternal)
}

function userSettings(json: Record<string, unknown>): void {
  write(join(t.config, 'settings.json'), JSON.stringify(json))
  resetSettingsCache()
}

function projectFlags(approved: boolean, shown: boolean): void {
  saveCurrentProjectConfig(c => ({ ...c, hasClaudeMdExternalIncludesApproved: approved, hasClaudeMdExternalIncludesWarningShown: shown }))
}

/** Writes one file at every place the loader reads, each saying where it is. */
function seedEveryPlace(): void {
  const places = [
    join(t.managed, 'CLAUDE.md'),
    join(t.managed, '.claudin', 'rules', 'policy.md'),
    join(t.config, 'CLAUDE.md'),
    join(t.config, 'rules', 'mine.md'),
    join(t.outer, 'AGENTS.md'),
    join(t.repo, 'AGENTS.md'),
    join(t.repo, '.claudin', 'CLAUDE.md'),
    join(t.repo, '.claudin', 'rules', 'style.md'),
    join(t.repo, 'CLAUDE.local.md'),
    join(t.repo, 'pkg', 'CLAUDE.md'),
    join(t.cwd, 'AGENTS.md'),
    join(t.cwd, 'CLAUDE.local.md'),
  ]
  for (const place of places) write(place, `from ${short(place)}\n`)
}

beforeAll(() => {
  for (const key of TOUCHED_ENV) before.env[key] = process.env[key]
  before.cwd = getOriginalCwd()
  before.projectRoot = getProjectRoot()
  before.sources = [...getAllowedSettingSources()]
  before.addDirs = [...getAdditionalDirectoriesForClaudeMd()]
  before.interactive = getIsInteractive()
  before.hooks = getRegisteredHooks()
  const config = getCurrentProjectConfig()
  before.approved = config.hasClaudeMdExternalIncludesApproved
  before.shown = config.hasClaudeMdExternalIncludesWarningShown
})

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-load-')))
  const outer = join(root, 'outer')
  const repo = join(outer, 'repo')
  t = { root, config: join(root, 'config'), managed: join(root, 'managed'), memory: join(root, 'memory'), outer, repo, cwd: join(repo, 'pkg', 'app') }
  initRepo(repo)
  mkdirSync(t.cwd, { recursive: true })
  mkdirSync(t.config, { recursive: true })
  mkdirSync(t.memory, { recursive: true })

  process.env.CLAUDIN_CONFIG_DIR = t.config
  process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = t.memory
  delete process.env.CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD
  getManagedFilePath.cache.set(undefined, t.managed)
  setOriginalCwd(t.cwd)
  setProjectRoot(t.repo)
  setAllowedSettingSources(ALL_SOURCES)
  setAdditionalDirectoriesForClaudeMd([])
  setIsInteractive(false)
  clearRegisteredHooks()
  projectFlags(false, false)
  getAutoMemPath.cache.clear?.()
  resetSettingsCache()
  clearMemoryFileCaches()
})

afterAll(() => {
  for (const key of TOUCHED_ENV) {
    if (before.env[key] === undefined) delete process.env[key]
    else process.env[key] = before.env[key]
  }
  getManagedFilePath.cache.clear?.()
  setOriginalCwd(before.cwd)
  setProjectRoot(before.projectRoot)
  setAllowedSettingSources(before.sources)
  setAdditionalDirectoriesForClaudeMd(before.addDirs)
  setIsInteractive(before.interactive)
  clearRegisteredHooks()
  if (before.hooks) registerHookCallbacks(before.hooks)
  projectFlags(before.approved ?? false, before.shown ?? false)
  getAutoMemPath.cache.clear?.()
  resetSettingsCache()
  // Leave the one-shot report armed, as a fresh process has it.
  resetGetMemoryFilesCache()
  if (t) rmSync(t.root, { recursive: true, force: true })
})

describe('getMemoryFiles: where it reads, and in what order', () => {
  test('managed, then user, then every directory from the top down to the cwd', async () => {
    seedEveryPlace()

    expect(describeLoad(await freshLoad())).toEqual([
      'Managed managed/CLAUDE.md',
      'Managed managed/.claudin/rules/policy.md',
      'User config/CLAUDE.md',
      'User config/rules/mine.md',
      'Project outer/AGENTS.md',
      'Project outer/repo/AGENTS.md',
      'Project outer/repo/.claudin/CLAUDE.md',
      'Project outer/repo/.claudin/rules/style.md',
      'Local outer/repo/CLAUDE.local.md',
      'Project outer/repo/pkg/CLAUDE.md',
      'Project outer/repo/pkg/app/AGENTS.md',
      'Local outer/repo/pkg/app/CLAUDE.local.md',
    ])
  })

  test('each entry carries the text of its file', async () => {
    write(join(t.repo, 'AGENTS.md'), '# Repo\n\nRun the linter.\n')

    const [entry] = (await freshLoad()).filter(f => inTree(f.path))

    expect(entry).toMatchObject({ path: join(t.repo, 'AGENTS.md'), type: 'Project', content: '# Repo\n\nRun the linter.\n' })
    expect(entry?.parent).toBeUndefined()
  })

  test('the walk does not stop at the repository root: a directory above it is read too', async () => {
    write(join(t.outer, 'CLAUDE.md'), 'above the repository\n')
    write(join(t.outer, 'CLAUDE.local.md'), 'private, above the repository\n')
    write(join(t.outer, '.claudin', 'rules', 'shared.md'), 'a rule above the repository\n')
    write(join(t.root, 'AGENTS.md'), 'two levels above\n')

    expect(describeLoad(await freshLoad())).toEqual([
      'Project AGENTS.md',
      'Project outer/CLAUDE.md',
      'Project outer/.claudin/rules/shared.md',
      'Local outer/CLAUDE.local.md',
    ])
  })

  const choices: Array<{ name: string; agents?: 'file' | 'empty' | 'dir'; claude: boolean; loaded: string[] }> = [
    { name: 'AGENTS.md wins over CLAUDE.md', agents: 'file', claude: true, loaded: ['Project outer/repo/AGENTS.md'] },
    { name: 'CLAUDE.md is the fallback', claude: true, loaded: ['Project outer/repo/CLAUDE.md'] },
    { name: 'an empty AGENTS.md still hides CLAUDE.md', agents: 'empty', claude: true, loaded: [] },
    { name: 'a directory named AGENTS.md still hides CLAUDE.md', agents: 'dir', claude: true, loaded: [] },
    { name: 'neither file', claude: false, loaded: [] },
  ]
  test.each(choices)('the root instruction file of a directory: $name', async ({ agents, claude, loaded }) => {
    if (agents === 'file') write(join(t.repo, 'AGENTS.md'), 'agents\n')
    if (agents === 'empty') write(join(t.repo, 'AGENTS.md'), '  \n')
    if (agents === 'dir') mkdirSync(join(t.repo, 'AGENTS.md'))
    if (claude) write(join(t.repo, 'CLAUDE.md'), 'claude\n')

    expect(describeLoad(await freshLoad())).toEqual(loaded)
  })

  test('.claudin/CLAUDE.md is read beside AGENTS.md, not instead of it', async () => {
    write(join(t.repo, 'AGENTS.md'), 'root file\n')
    write(join(t.repo, 'CLAUDE.md'), 'never read\n')
    write(join(t.repo, '.claudin', 'CLAUDE.md'), 'dot-dir file\n')

    expect(describeLoad(await freshLoad())).toEqual(['Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/CLAUDE.md'])
  })

  test('rules: only unconditional .md files, at any depth, hidden ones included', async () => {
    const rules = join(t.repo, '.claudin', 'rules')
    write(join(rules, 'plain.md'), 'always on\n')
    write(join(rules, 'nested', 'deeper', 'deep.md'), 'always on, deep\n')
    write(join(rules, '.hidden.md'), 'hidden but counted\n')
    write(join(rules, 'scoped.md'), '---\npaths: src/**\n---\nonly for src\n')
    write(join(rules, 'notes.txt'), 'not markdown\n')
    write(join(rules, 'SHOUT.MD'), 'upper-case extension\n')
    write(join(rules, 'folder.md', 'inside.md'), 'a directory named like a file is searched\n')
    write(join(rules, 'blank.md'), '\n   \n')

    const found = describeLoad(await freshLoad()).sort()

    expect(found).toEqual([
      'Project outer/repo/.claudin/rules/.hidden.md',
      'Project outer/repo/.claudin/rules/folder.md/inside.md',
      'Project outer/repo/.claudin/rules/nested/deeper/deep.md',
      'Project outer/repo/.claudin/rules/plain.md',
    ])
  })

  test('a root instruction file with paths: frontmatter is loaded anyway, and keeps its globs', async () => {
    write(join(t.repo, 'AGENTS.md'), '---\npaths: src/**\n---\nscoped root file\n')

    const [entry] = (await freshLoad()).filter(f => inTree(f.path))

    expect(entry).toMatchObject({ type: 'Project', content: 'scoped root file\n', globs: ['src'] })
  })

  test('a file reached twice is loaded once', async () => {
    write(join(t.repo, 'AGENTS.md'), 'repo\n\n@./.claudin/rules/style.md\n')
    write(join(t.repo, '.claudin', 'rules', 'style.md'), 'style rule\n')
    projectFlags(true, false)

    expect(describeLoad(await freshLoad())).toEqual(['Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md'])
    const [, rule] = (await getMemoryFiles()).filter(f => inTree(f.path))
    expect(rule?.parent).toBe(join(t.repo, 'AGENTS.md'))
  })
})

describe('getMemoryFiles: setting sources', () => {
  const cases: Array<{ name: string; sources: SettingSource[]; loaded: string[] }> = [
    {
      name: 'user settings off: no user file and no user rules',
      sources: ['projectSettings', 'localSettings'],
      loaded: ['Managed managed/CLAUDE.md', 'Managed managed/.claudin/rules/policy.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'project settings off: the walk keeps only local files',
      sources: ['userSettings', 'localSettings'],
      loaded: ['Managed managed/CLAUDE.md', 'Managed managed/.claudin/rules/policy.md', 'User config/CLAUDE.md', 'User config/rules/mine.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'local settings off: no CLAUDE.local.md',
      sources: ['userSettings', 'projectSettings'],
      loaded: ['Managed managed/CLAUDE.md', 'Managed managed/.claudin/rules/policy.md', 'User config/CLAUDE.md', 'User config/rules/mine.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md'],
    },
    {
      name: 'every source off: the managed files still load',
      sources: [],
      loaded: ['Managed managed/CLAUDE.md', 'Managed managed/.claudin/rules/policy.md'],
    },
  ]
  test.each(cases)('$name', async ({ sources, loaded }) => {
    write(join(t.managed, 'CLAUDE.md'), 'policy\n')
    write(join(t.managed, '.claudin', 'rules', 'policy.md'), 'policy rule\n')
    write(join(t.config, 'CLAUDE.md'), 'user\n')
    write(join(t.config, 'rules', 'mine.md'), 'user rule\n')
    write(join(t.repo, 'AGENTS.md'), 'project\n')
    write(join(t.repo, '.claudin', 'rules', 'style.md'), 'project rule\n')
    write(join(t.repo, 'CLAUDE.local.md'), 'local\n')
    setAllowedSettingSources(sources)

    expect(describeLoad(await freshLoad())).toEqual(loaded)
  })
})

describe('getMemoryFiles: claudeMdExcludes', () => {
  function seed(): void {
    write(join(t.managed, 'CLAUDE.md'), 'policy\n')
    write(join(t.config, 'CLAUDE.md'), 'user\n')
    write(join(t.repo, 'AGENTS.md'), 'project\n')
    write(join(t.repo, 'CLAUDE.md'), 'fallback\n')
    write(join(t.repo, '.claudin', 'rules', 'style.md'), 'rule\n')
    write(join(t.repo, 'CLAUDE.local.md'), 'local\n')
  }

  const cases: Array<{ name: string; patterns: (tree: Tree) => string[]; loaded: string[] }> = [
    {
      name: 'no pattern excludes nothing',
      patterns: () => [],
      loaded: ['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'an absolute path; the fallback CLAUDE.md does not come back',
      patterns: tree => [join(tree.repo, 'AGENTS.md')],
      loaded: ['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'a glob over local files, and a rules glob whose ** has to cross the .claudin directory',
      patterns: () => ['**/CLAUDE.local.md', '**/rules/*.md'],
      loaded: ['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/AGENTS.md'],
    },
    {
      name: 'the user file can be excluded, the managed file cannot',
      patterns: tree => [join(tree.config, 'CLAUDE.md'), join(tree.managed, 'CLAUDE.md')],
      loaded: ['Managed managed/CLAUDE.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'an empty pattern matches nothing',
      patterns: () => [''],
      loaded: ['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
    {
      name: 'a pattern for a directory that does not exist matches nothing here',
      patterns: tree => [join(tree.root, 'gone', 'AGENTS.md')],
      loaded: ['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/AGENTS.md', 'Project outer/repo/.claudin/rules/style.md', 'Local outer/repo/CLAUDE.local.md'],
    },
  ]
  test.each(cases)('$name', async ({ patterns, loaded }) => {
    seed()
    userSettings({ claudeMdExcludes: patterns(t) })

    expect(describeLoad(await freshLoad())).toEqual(loaded)
  })

  test('a pattern written through a linked directory matches the real path', async () => {
    seed()
    const alias = join(t.root, 'alias')
    symlinkSync(t.outer, alias)
    userSettings({ claudeMdExcludes: [join(alias, 'repo', 'AGENTS.md'), `${join(alias, 'repo')}/**/CLAUDE.local.md`] })

    expect(describeLoad(await freshLoad())).toEqual(['Managed managed/CLAUDE.md', 'User config/CLAUDE.md', 'Project outer/repo/.claudin/rules/style.md'])
  })

  test('an included file is excluded under the type of the file that includes it', async () => {
    write(join(t.cwd, 'AGENTS.md'), 'app\n\n@./kept.md\n\n@./dropped.md\n')
    write(join(t.cwd, 'kept.md'), 'kept\n')
    write(join(t.cwd, 'dropped.md'), 'dropped\n')
    userSettings({ claudeMdExcludes: ['**/dropped.md'] })

    expect(describeLoad(await freshLoad())).toEqual(['Project outer/repo/pkg/app/AGENTS.md', 'Project outer/repo/pkg/app/kept.md'])
  })
})

describe('getMemoryFiles: @include and the external-include approval', () => {
  function seed(): void {
    // The repository root is above the cwd, so for the loader it is "outside".
    write(join(t.repo, 'AGENTS.md'), 'repo\n\n@./docs/guide.md\n\n@./pkg/app/near.md\n')
    write(join(t.repo, 'docs', 'guide.md'), 'guide\n')
    write(join(t.cwd, 'near.md'), 'near\n')
    write(join(t.config, 'CLAUDE.md'), 'user\n\n@../elsewhere/personal.md\n')
    write(join(t.root, 'elsewhere', 'personal.md'), 'personal\n')
  }

  test('not approved: a project file only includes files under the cwd; the user file includes anything', async () => {
    seed()

    expect(describeLoad(await freshLoad())).toEqual([
      'User config/CLAUDE.md',
      'User elsewhere/personal.md',
      'Project outer/repo/AGENTS.md',
      'Project outer/repo/pkg/app/near.md',
    ])
  })

  test('approved in the project config: the external include loads, after its includer', async () => {
    seed()
    projectFlags(true, false)

    const files = (await freshLoad()).filter(f => inTree(f.path))

    expect(describeLoad(files)).toEqual([
      'User config/CLAUDE.md',
      'User elsewhere/personal.md',
      'Project outer/repo/AGENTS.md',
      'Project outer/repo/docs/guide.md',
      'Project outer/repo/pkg/app/near.md',
    ])
    expect(files.map(f => (f.parent ? short(f.parent) : '-'))).toEqual(['-', 'config/CLAUDE.md', '-', 'outer/repo/AGENTS.md', 'outer/repo/AGENTS.md'])
  })

  test('getMemoryFiles(true) loads external includes without the approval', async () => {
    seed()

    expect(describeLoad(await freshLoad(true))).toContain('Project outer/repo/docs/guide.md')
  })

  test('getExternalClaudeMdIncludes names each project include outside the cwd, never a user one', async () => {
    seed()

    const externals = getExternalClaudeMdIncludes(await freshLoad(true)).filter(e => inTree(e.path))

    expect(externals.map(e => `${short(e.path)} <- ${short(e.parent)}`)).toEqual(['outer/repo/docs/guide.md <- outer/repo/AGENTS.md'])
  })

  const warnings: Array<{ name: string; external: boolean; approved: boolean; shown: boolean; warn: boolean }> = [
    { name: 'an external include, neither approved nor warned', external: true, approved: false, shown: false, warn: true },
    { name: 'an external include, already approved', external: true, approved: true, shown: false, warn: false },
    { name: 'an external include, warning already shown', external: true, approved: false, shown: true, warn: false },
    { name: 'no external include', external: false, approved: false, shown: false, warn: false },
  ]
  test.each(warnings)('shouldShowClaudeMdExternalIncludesWarning: $name', async ({ external, approved, shown, warn }) => {
    write(join(t.repo, 'AGENTS.md'), external ? 'repo\n\n@./docs/guide.md\n' : 'repo\n')
    write(join(t.repo, 'docs', 'guide.md'), 'guide\n')
    projectFlags(approved, shown)

    expect(await shouldShowClaudeMdExternalIncludesWarning()).toBe(warn)
  })
})

describe('getMemoryFiles: --add-dir directories', () => {
  function seed(): string {
    const extra = join(t.root, 'extra')
    write(join(extra, 'CLAUDE.md'), 'extra root file\n')
    write(join(extra, '.claudin', 'CLAUDE.md'), 'extra dot-dir file\n')
    write(join(extra, '.claudin', 'rules', 'extra-rule.md'), 'extra rule\n')
    write(join(extra, '.claudin', 'rules', 'extra-scoped.md'), '---\npaths: lib/**\n---\nscoped\n')
    write(join(extra, 'CLAUDE.local.md'), 'never read from an added directory\n')
    write(join(extra, 'sub', 'AGENTS.md'), 'below the added directory, never read\n')
    write(join(t.repo, 'AGENTS.md'), 'repo\n')
    setAdditionalDirectoriesForClaudeMd([extra])
    return extra
  }

  test('with CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD on, they are read after the walk, as project files', async () => {
    seed()
    process.env.CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'

    expect(describeLoad(await freshLoad())).toEqual([
      'Project outer/repo/AGENTS.md',
      'Project extra/CLAUDE.md',
      'Project extra/.claudin/CLAUDE.md',
      'Project extra/.claudin/rules/extra-rule.md',
    ])
  })

  test('they are read even with project settings off', async () => {
    seed()
    process.env.CLAUDIN_ADDITIONAL_DIRECTORIES_CLAUDE_MD = 'true'
    setAllowedSettingSources(['userSettings', 'localSettings'])

    expect(describeLoad(await freshLoad())).toEqual(['Project extra/CLAUDE.md', 'Project extra/.claudin/CLAUDE.md', 'Project extra/.claudin/rules/extra-rule.md'])
  })

  test('with the variable unset they are not read', async () => {
    seed()

    expect(describeLoad(await freshLoad())).toEqual(['Project outer/repo/AGENTS.md'])
  })
})

describe('getMemoryFiles: worktrees', () => {
  test('a worktree nested in its main checkout skips the checkout\'s checked-in files, keeps its local ones', async () => {
    initRepo(t.repo, true)
    const worktree = join(t.repo, '.claudin', 'worktrees', 'feature')
    git(t.repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    write(join(t.outer, 'AGENTS.md'), 'above the checkout\n')
    write(join(t.repo, 'AGENTS.md'), 'main checkout\n')
    write(join(t.repo, '.claudin', 'CLAUDE.md'), 'main checkout dot-dir\n')
    write(join(t.repo, '.claudin', 'rules', 'main-rule.md'), 'main checkout rule\n')
    write(join(t.repo, 'CLAUDE.local.md'), 'main checkout local\n')
    write(join(worktree, 'AGENTS.md'), 'the worktree\n')
    write(join(worktree, 'CLAUDE.local.md'), 'the worktree local\n')
    const cwd = join(worktree, 'src')
    mkdirSync(cwd)
    setOriginalCwd(cwd)

    expect(describeLoad(await freshLoad())).toEqual([
      'Project outer/AGENTS.md',
      'Local outer/repo/CLAUDE.local.md',
      'Project outer/repo/.claudin/worktrees/feature/AGENTS.md',
      'Local outer/repo/.claudin/worktrees/feature/CLAUDE.local.md',
    ])
  })

  test('a separate repository inside the checkout still reads the checkout\'s files', async () => {
    const inner = join(t.repo, 'vendor', 'lib')
    initRepo(inner)
    write(join(t.repo, 'AGENTS.md'), 'outer repository\n')
    write(join(inner, 'AGENTS.md'), 'inner repository\n')
    setOriginalCwd(inner)

    expect(describeLoad(await freshLoad())).toEqual(['Project outer/repo/AGENTS.md', 'Project outer/repo/vendor/lib/AGENTS.md'])
  })
})

describe('getMemoryFiles: the auto-memory index', () => {
  function memoryOn(): void {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '0'
    getAutoMemPath.cache.clear?.()
  }

  test('with auto memory on, MEMORY.md comes last, typed AutoMem', async () => {
    write(join(t.repo, 'AGENTS.md'), 'repo\n')
    write(join(t.memory, 'MEMORY.md'), '\n- [Tabs](tabs.md) — prefers tabs\n\n')
    memoryOn()

    const files = (await freshLoad()).filter(f => inTree(f.path))

    expect(describeLoad(files)).toEqual(['Project outer/repo/AGENTS.md', 'AutoMem memory/MEMORY.md'])
    expect(files[1]).toMatchObject({ content: '- [Tabs](tabs.md) — prefers tabs', contentDiffersFromDisk: true, rawContent: '\n- [Tabs](tabs.md) — prefers tabs\n\n' })
  })

  test('an empty index still gives an entry, with no text', async () => {
    write(join(t.memory, 'MEMORY.md'), '  \n')
    memoryOn()

    const files = (await freshLoad()).filter(f => inTree(f.path))

    expect(files.map(f => [f.type, f.content])).toEqual([['AutoMem', '']])
  })

  test('its @include lines are not followed', async () => {
    write(join(t.memory, 'MEMORY.md'), 'index\n\n@./topic.md\n')
    write(join(t.memory, 'topic.md'), 'topic\n')
    memoryOn()

    expect(describeLoad(await freshLoad())).toEqual(['AutoMem memory/MEMORY.md'])
  })

  test('the index is cut at 200 lines, with a warning that names the cap', async () => {
    const lines = Array.from({ length: 230 }, (_, i) => `- entry ${i + 1}`)
    write(join(t.memory, 'MEMORY.md'), `${lines.join('\n')}\n`)
    memoryOn()

    const index = (await freshLoad()).find(f => f.type === 'AutoMem')
    const content = index?.content ?? ''

    expect(content).toContain('- entry 200\n')
    expect(content).not.toContain('- entry 201')
    expect(content).toMatch(/\b200\b/)
  })

  test('a missing index, or auto memory off, gives no entry', async () => {
    memoryOn()
    expect((await freshLoad()).filter(f => f.type === 'AutoMem')).toEqual([])

    write(join(t.memory, 'MEMORY.md'), 'index\n')
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect((await freshLoad()).filter(f => f.type === 'AutoMem')).toEqual([])
  })

  test('an index already reached through an include is not added twice', async () => {
    write(join(t.config, 'CLAUDE.md'), 'user\n\n@../memory/MEMORY.md\n')
    write(join(t.memory, 'MEMORY.md'), 'index\n')
    memoryOn()

    expect(describeLoad(await freshLoad())).toEqual(['User config/CLAUDE.md', 'User memory/MEMORY.md'])
  })
})

describe('getMemoryFiles: the cache', () => {
  test('a second call returns the same result, even after the disk changed', async () => {
    write(join(t.repo, 'AGENTS.md'), 'first\n')
    const first = await freshLoad()
    write(join(t.cwd, 'AGENTS.md'), 'added later\n')

    expect(await getMemoryFiles()).toBe(first)
  })

  test.each([
    ['clearMemoryFileCaches', () => clearMemoryFileCaches()],
    ['resetGetMemoryFilesCache', () => resetGetMemoryFilesCache('compact')],
  ] as const)('%s makes the next call read the disk again', async (_name, clear) => {
    write(join(t.repo, 'AGENTS.md'), 'first\n')
    await freshLoad()
    write(join(t.cwd, 'AGENTS.md'), 'added later\n')
    clear()

    expect(describeLoad(await getMemoryFiles())).toEqual(['Project outer/repo/AGENTS.md', 'Project outer/repo/pkg/app/AGENTS.md'])
  })

  test('the forced-external load is cached apart from the normal one', async () => {
    write(join(t.repo, 'AGENTS.md'), 'repo\n')
    const normal = await freshLoad()
    const forced = await getMemoryFiles(true)

    expect(forced).not.toBe(normal)
    expect(await getMemoryFiles()).toBe(normal)
    expect(await getMemoryFiles(true)).toBe(forced)
  })

  test('the memo exposes a map-like cache that callers seed, probe and clear', () => {
    const cache = getMemoryFiles.cache
    cache.set('probe-key', Promise.resolve([]))

    expect(cache.has('probe-key')).toBe(true)
    expect(cache.get('probe-key')).toBeInstanceOf(Promise)
    clearMemoryFileCaches()
    expect(cache.has('probe-key')).toBe(false)
  })
})

describe('getMemoryFiles: InstructionsLoaded reports', () => {
  type Report = { file: string; type: MemoryType; reason: string; parent?: string; globs?: string[] }
  let heard: Report[]

  function listen(): void {
    registerHookCallbacks({
      InstructionsLoaded: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async (input: HookInput) => {
                const event = input as unknown as { file_path: string; memory_type: MemoryType; load_reason: string; parent_file_path?: string; globs?: string[] }
                if (inTree(event.file_path)) {
                  heard.push({ file: short(event.file_path), type: event.memory_type, reason: event.load_reason, parent: event.parent_file_path && short(event.parent_file_path), globs: event.globs })
                }
                return {}
              },
            },
          ],
        },
      ],
    })
  }

  /** The reports are fire-and-forget: give them time to land, then read them in a stable order. */
  async function reports(): Promise<string[]> {
    await Bun.sleep(150)
    return heard.map(r => `${r.reason} ${r.type} ${r.file}${r.parent ? ` <- ${r.parent}` : ''}`).sort()
  }

  beforeEach(() => {
    heard = []
    write(join(t.managed, 'CLAUDE.md'), 'policy\n')
    write(join(t.config, 'CLAUDE.md'), 'user\n')
    write(join(t.repo, 'AGENTS.md'), 'repo\n\n@./pkg/app/near.md\n')
    write(join(t.cwd, 'near.md'), 'near\n')
    write(join(t.repo, 'CLAUDE.local.md'), 'local\n')
    write(join(t.memory, 'MEMORY.md'), 'index\n')
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '0'
    getAutoMemPath.cache.clear?.()
  })

  test('the first load of a session reports every instruction file once; the memory index is not reported', async () => {
    listen()
    resetGetMemoryFilesCache()

    await getMemoryFiles()

    expect(await reports()).toEqual([
      'include Project outer/repo/pkg/app/near.md <- outer/repo/AGENTS.md',
      'session_start Local outer/repo/CLAUDE.local.md',
      'session_start Managed managed/CLAUDE.md',
      'session_start Project outer/repo/AGENTS.md',
      'session_start User config/CLAUDE.md',
    ])
  })

  test('a load after a plain cache clear reports nothing', async () => {
    listen()
    resetGetMemoryFilesCache()
    await getMemoryFiles()
    await reports()
    heard = []

    clearMemoryFileCaches()
    await getMemoryFiles()

    expect(await reports()).toEqual([])
  })

  test('a reset names its reason, once', async () => {
    listen()
    resetGetMemoryFilesCache('compact')
    await getMemoryFiles()
    expect((await reports()).filter(r => r.startsWith('compact'))).toHaveLength(4)

    heard = []
    resetGetMemoryFilesCache()
    await getMemoryFiles()
    expect((await reports()).filter(r => r.startsWith('session_start'))).toHaveLength(4)
  })

  test('the forced-external load neither reports nor uses up the pending report', async () => {
    listen()
    resetGetMemoryFilesCache('compact')

    await getMemoryFiles(true)
    expect(await reports()).toEqual([])

    await getMemoryFiles()
    expect((await reports()).filter(r => r.startsWith('compact'))).toHaveLength(4)
  })

  test('the pending report is used up by a load even when nobody listens', async () => {
    resetGetMemoryFilesCache()
    await getMemoryFiles()
    listen()

    clearMemoryFileCaches()
    await getMemoryFiles()

    expect(await reports()).toEqual([])
  })

  test('a report carries the globs of the file', async () => {
    write(join(t.repo, 'AGENTS.md'), '---\npaths: src/**\n---\nrepo\n')
    listen()
    resetGetMemoryFilesCache()

    await getMemoryFiles()
    await reports()

    expect(heard.find(r => r.file === 'outer/repo/AGENTS.md')?.globs).toEqual(['src'])
  })
})

describe('getClaudeMds: the text the model is given', () => {
  const entry = (type: MemoryType, path: string, content: string): MemoryFileInfo => ({ type, path, content })

  test('nothing to show gives an empty string', () => {
    expect(getClaudeMds([])).toBe('')
    expect(getClaudeMds([entry('Project', '/r/AGENTS.md', ''), entry('AutoMem', '/m/MEMORY.md', '')])).toBe('')
  })

  test('a preamble, then one block per file: its path, a label, and its trimmed text', () => {
    const text = getClaudeMds([entry('Project', '/r/AGENTS.md', '\n  Use bun.  \n'), entry('Local', '/r/CLAUDE.local.md', 'My notes')])
    const blocks = text.split('\n\n')

    expect(blocks).toHaveLength(5)
    expect(blocks[1]).toMatch(/^Contents of \/r\/AGENTS\.md \([^)]+\):$/)
    expect(blocks[2]).toBe('Use bun.')
    expect(blocks[3]).toMatch(/^Contents of \/r\/CLAUDE\.local\.md \([^)]+\):$/)
    expect(blocks[4]).toBe('My notes')
  })

  test('the preamble says these are instructions that override the default behaviour and must be followed exactly', () => {
    const [preamble] = getClaudeMds([entry('Project', '/r/AGENTS.md', 'x')]).split('\n\n')

    for (const fact of [/instructions/i, /codebase/i, /user/i, /override/i, /default behavio/i, /exactly/i]) {
      expect(preamble).toMatch(fact)
    }
  })

  const labels: Array<{ type: MemoryType; facts: RegExp[] }> = [
    { type: 'Project', facts: [/project instructions/, /checked into the codebase/] },
    { type: 'Local', facts: [/private/, /project instructions/, /not checked in/] },
    { type: 'User', facts: [/private/, /global/, /all projects/] },
    { type: 'AutoMem', facts: [/auto-memory/, /across conversations/] },
  ]
  test.each(labels)('the $type label', ({ type, facts }) => {
    const label = /^Contents of \/f\.md \((.+)\):$/m.exec(getClaudeMds([entry(type, '/f.md', 'x')]))?.[1] ?? ''

    for (const fact of facts) expect(label).toMatch(fact)
  })

  test('the filter drops the types it refuses', () => {
    const files = [entry('Project', '/r/AGENTS.md', 'project'), entry('AutoMem', '/m/MEMORY.md', 'index')]

    const text = getClaudeMds(files, type => type !== 'AutoMem')

    expect(text).toContain('project')
    expect(text).not.toContain('/m/MEMORY.md')
    expect(getClaudeMds(files, () => false)).toBe('')
  })
})

describe('the module surface', () => {
  test('the barrel exports these runtime names', () => {
    expect(Object.keys(loader).sort()).toEqual([
      'MAX_MEMORY_CHARACTER_COUNT',
      'clearMemoryFileCaches',
      'getClaudeMds',
      'getConditionalRulesForCwdLevelDirectory',
      'getExternalClaudeMdIncludes',
      'getLargeMemoryFiles',
      'getManagedAndUserConditionalRules',
      'getMemoryFiles',
      'getMemoryFilesForNestedDirectory',
      'hasExternalClaudeMdIncludes',
      'isMemoryFilePath',
      'processConditionedMdRules',
      'processMdRules',
      'processMemoryFile',
      'resetGetMemoryFilesCache',
      'shouldShowClaudeMdExternalIncludesWarning',
    ])
  })
})
