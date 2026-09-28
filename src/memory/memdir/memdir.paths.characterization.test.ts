/**
 * Characterization of where the memory lives and when it is on:
 * `paths.ts`, `teamMemPaths.ts` and `versions.ts`, through their exports only.
 *
 * Every case runs in its own temp world (`__testutils__/memdirWorld.ts`):
 * settings are real files in the layer the loader reads, repositories are real
 * `git init`s, and the session's directories are set through the bootstrap
 * state. Nothing is mocked.
 */
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { setIsInteractive, setProjectRoot } from 'src/platform/bootstrap/state.js'
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  getExtractionTurnInterval,
  getMemoryBaseDir,
  hasAutoMemPathOverride,
  isAutoMemoryEnabled,
  isAutoMemPath,
  isExtractMemoriesEnabled,
  isExtractModeActive,
} from 'src/memory/memdir/paths.js'
import {
  getTeamMemEntrypoint,
  getTeamMemPath,
  isTeamMemFile,
  isTeamMemLikelyGitIgnored,
  isTeamMemoryEnabled,
  isTeamMemPath,
} from 'src/memory/memdir/teamMemPaths.js'
import { projectIsInGitRepo } from 'src/memory/memdir/versions.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'

const world = useMemdirWorld()

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

/** The slug the legacy location uses: every byte but [A-Za-z0-9] becomes '-'. */
function slugOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function legacyDirFor(root: string): string {
  return join(world().configDir, 'projects', slugOf(root), 'memory') + sep
}

function projectLocalDirFor(root: string): string {
  return join(root, '.claudin', 'memory') + sep
}

/** A repository at <world>/<name>, entered as the session's project. */
function enterRepo(name = 'repo'): string {
  const w = world()
  const repo = w.repo(join(w.root, name))
  w.enter(repo)
  return repo
}

describe('isAutoMemoryEnabled', () => {
  test('is on when nothing says otherwise', () => {
    expect(isAutoMemoryEnabled()).toBe(true)
  })

  test.each(['1', 'true', 'yes', 'on', 'TRUE', ' On '])(
    'CLAUDIN_DISABLE_AUTO_MEMORY=%p turns it off',
    value => {
      process.env.CLAUDIN_DISABLE_AUTO_MEMORY = value
      expect(isAutoMemoryEnabled()).toBe(false)
    },
  )

  test.each(['0', 'false', 'no', 'off'])(
    'CLAUDIN_DISABLE_AUTO_MEMORY=%p forces it on over bare mode, remote mode and settings',
    value => {
      const w = world()
      process.env.CLAUDIN_DISABLE_AUTO_MEMORY = value
      process.env.CLAUDIN_SIMPLE = '1'
      process.env.CLAUDE_CODE_REMOTE = '1'
      w.settings('user', { autoMemoryEnabled: false })
      expect(isAutoMemoryEnabled()).toBe(true)
    },
  )

  test('a CLAUDIN_DISABLE_AUTO_MEMORY value that is neither on nor off decides nothing', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = 'later'
    expect(isAutoMemoryEnabled()).toBe(true)
    process.env.CLAUDIN_SIMPLE = '1'
    expect(isAutoMemoryEnabled()).toBe(false)
  })

  test('bare mode (CLAUDIN_SIMPLE) turns it off', () => {
    process.env.CLAUDIN_SIMPLE = 'true'
    expect(isAutoMemoryEnabled()).toBe(false)
  })

  test('a remote session is off without a memory mount and on with one', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(isAutoMemoryEnabled()).toBe(false)
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = world().mkdir('mount')
    expect(isAutoMemoryEnabled()).toBe(true)
  })

  test('autoMemoryEnabled in the merged settings decides next, the project file included', () => {
    const w = world()
    w.settings('user', { autoMemoryEnabled: false })
    expect(isAutoMemoryEnabled()).toBe(false)

    w.settings('local', { autoMemoryEnabled: true })
    expect(isAutoMemoryEnabled()).toBe(true)

    w.settings('project', { autoMemoryEnabled: false })
    w.settings('local', {})
    w.settings('user', {})
    expect(isAutoMemoryEnabled()).toBe(false)
  })
})

describe('the background extraction switches', () => {
  test('extraction is enabled unless CLAUDIN_EXTRACT_MEMORIES is an off value', () => {
    expect(isExtractMemoriesEnabled()).toBe(true)
    for (const off of ['0', 'false', 'no', 'off']) {
      process.env.CLAUDIN_EXTRACT_MEMORIES = off
      expect(isExtractMemoriesEnabled()).toBe(false)
    }
    for (const other of ['1', 'yes', '', 'sometimes']) {
      process.env.CLAUDIN_EXTRACT_MEMORIES = other
      expect(isExtractMemoriesEnabled()).toBe(true)
    }
  })

  test('the extraction mode needs an interactive session as well', () => {
    setIsInteractive(true)
    expect(isExtractModeActive()).toBe(true)
    setIsInteractive(false)
    expect(isExtractModeActive()).toBe(false)
    setIsInteractive(true)
    process.env.CLAUDIN_EXTRACT_MEMORIES = 'off'
    expect(isExtractModeActive()).toBe(false)
  })

  test.each([
    [undefined, 15],
    ['3', 3],
    ['1', 1],
    ['1000', 1000],
    ['5000', 1000],
    ['7.9', 7],
    ['12 turns', 12],
    ['0', 15],
    ['-4', 15],
    ['soon', 15],
    ['', 15],
  ])('CLAUDIN_EXTRACT_MEMORIES_EVERY=%p gives an interval of %p turns', (value, turns) => {
    if (value !== undefined) process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = value
    expect(getExtractionTurnInterval()).toBe(turns)
  })
})

describe('getMemoryBaseDir', () => {
  test('is the config home, or the remote memory mount when one is set', () => {
    const w = world()
    expect(getMemoryBaseDir()).toBe(w.configDir)
    const mount = w.mkdir('remote-mount')
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = mount
    expect(getMemoryBaseDir()).toBe(mount)
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = ''
    expect(getMemoryBaseDir()).toBe(w.configDir)
  })

  test('the legacy location follows the remote mount too', () => {
    const w = world()
    const mount = w.mkdir('remote-mount')
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = mount
    w.refresh()
    expect(getAutoMemPath()).toBe(
      join(mount, 'projects', slugOf(w.project), 'memory') + sep,
    )
  })
})

describe('getAutoMemPath: the default locations', () => {
  test('outside a repository it is <config>/projects/<slug of the project root>/memory/', () => {
    const w = world()
    expect(getAutoMemPath()).toBe(legacyDirFor(w.project))
    expect(getAutoMemEntrypoint()).toBe(legacyDirFor(w.project) + 'MEMORY.md')
  })

  test('in a repository it is <root>/.claudin/memory/, created private (0700)', () => {
    const repo = enterRepo()
    const dir = getAutoMemPath()
    expect(dir).toBe(projectLocalDirFor(repo))
    expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
    expect(getAutoMemEntrypoint()).toBe(join(repo, '.claudin', 'memory', 'MEMORY.md'))
  })

  test('an existing memory directory with open permissions is tightened to 0700', () => {
    if (process.platform === 'win32') return
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const dir = join(repo, '.claudin', 'memory')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o755)
    w.enter(repo)
    getAutoMemPath()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('a project root below the repository root still resolves to the repository root', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const nested = join(repo, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    w.enter(nested)
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })

  test('every worktree of a repository shares the main checkout directory', () => {
    const w = world()
    const main = w.repo(join(w.root, 'main'))
    const worktree = join(w.root, 'feature-tree')
    w.git(main, 'worktree', 'add', '-q', worktree)
    w.enter(worktree)
    expect(getAutoMemPath()).toBe(projectLocalDirFor(main))
  })

  test('the legacy slug of a worktree or a subdirectory is the main checkout root', () => {
    const w = world()
    const main = w.repo(join(w.root, 'main'))
    const worktree = join(w.root, 'feature-tree')
    w.git(main, 'worktree', 'add', '-q', worktree)
    const sub = join(main, 'services', 'api')
    mkdirSync(sub, { recursive: true })
    w.settings('user', { autoMemoryProjectLocal: false })
    w.enter(worktree)
    expect(getAutoMemPath()).toBe(legacyDirFor(main))
    w.enter(sub)
    expect(getAutoMemPath()).toBe(legacyDirFor(main))
  })

  test('the result is memoized per project root, and clearing its cache recomputes', () => {
    const w = world()
    const first = getAutoMemPath()
    expect(first).toBe(legacyDirFor(w.project))
    const other = w.mkdir('other-project')
    setProjectRoot(other)
    expect(getAutoMemPath()).toBe(legacyDirFor(other))

    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = w.mkdir('late-override')
    expect(getAutoMemPath()).toBe(legacyDirFor(other))
    getAutoMemPath.cache.clear?.()
    expect(getAutoMemPath()).toBe(join(w.root, 'late-override') + sep)
  })
})

describe('getAutoMemPath: autoMemoryProjectLocal', () => {
  test('false in a trusted layer forces the legacy location in a repository', () => {
    const w = world()
    const repo = enterRepo()
    w.settings('user', { autoMemoryProjectLocal: false })
    expect(getAutoMemPath()).toBe(legacyDirFor(repo))
    expect(existsSync(join(repo, '.claudin', 'memory'))).toBe(false)
  })

  test('the project settings file cannot set it', () => {
    const w = world()
    const repo = enterRepo()
    w.settings('project', { autoMemoryProjectLocal: false })
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })

  test('the first layer that sets it wins: policy, then flag, then local, then user', () => {
    const w = world()
    const repo = enterRepo()
    const local = projectLocalDirFor(repo)
    const legacy = legacyDirFor(repo)

    w.settings('user', { autoMemoryProjectLocal: false })
    expect(getAutoMemPath()).toBe(legacy)
    w.settings('local', { autoMemoryProjectLocal: true })
    expect(getAutoMemPath()).toBe(local)
    w.settings('flag', { autoMemoryProjectLocal: false })
    expect(getAutoMemPath()).toBe(legacy)
    w.settings('policy', { autoMemoryProjectLocal: true })
    expect(getAutoMemPath()).toBe(local)
  })
})

describe('getAutoMemPath: the autoMemoryDirectory setting', () => {
  test('an absolute directory wins over the defaults, with one trailing separator', () => {
    const w = world()
    enterRepo()
    const chosen = join(w.root, 'chosen')
    w.settings('user', { autoMemoryDirectory: `${chosen}${sep}${sep}` })
    expect(getAutoMemPath()).toBe(chosen + sep)
    expect(getAutoMemEntrypoint()).toBe(join(chosen, 'MEMORY.md'))
    expect(hasAutoMemPathOverride()).toBe(false)
  })

  test('the path is normalized: dot segments resolved, Unicode composed (NFC)', () => {
    const w = world()
    w.settings('user', { autoMemoryDirectory: join(w.root, 'a', '..', 'b', '.', 'mem') })
    expect(getAutoMemPath()).toBe(join(w.root, 'b', 'mem') + sep)

    w.settings('user', { autoMemoryDirectory: join(w.root, 'cafe\u0301') })
    expect(getAutoMemPath()).toBe(join(w.root, 'caf\u00e9') + sep)
  })

  test('the project settings file cannot set it', () => {
    const w = world()
    const repo = enterRepo()
    w.settings('project', { autoMemoryDirectory: join(w.root, 'planted') })
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })

  test('the first layer that sets it wins: policy, then flag, then local, then user', () => {
    const w = world()
    const pick = (name: string) => join(w.root, name)
    w.settings('user', { autoMemoryDirectory: pick('from-user') })
    expect(getAutoMemPath()).toBe(pick('from-user') + sep)
    w.settings('local', { autoMemoryDirectory: pick('from-local') })
    expect(getAutoMemPath()).toBe(pick('from-local') + sep)
    w.settings('flag', { autoMemoryDirectory: pick('from-flag') })
    expect(getAutoMemPath()).toBe(pick('from-flag') + sep)
    w.settings('policy', { autoMemoryDirectory: pick('from-policy') })
    expect(getAutoMemPath()).toBe(pick('from-policy') + sep)
  })

  test('~/ expands to the home directory', () => {
    const w = world()
    w.settings('user', { autoMemoryDirectory: '~/memdir-suite-not-created/mem' })
    expect(getAutoMemPath()).toBe(
      join(homedir(), 'memdir-suite-not-created', 'mem') + sep,
    )
    w.settings('user', { autoMemoryDirectory: '~\\memdir-suite-not-created' })
    expect(getAutoMemPath()).toBe(join(homedir(), 'memdir-suite-not-created') + sep)
  })

  test.each([
    ['a relative path', 'relative/mem'],
    ['the filesystem root', '/'],
    ['a path shorter than three characters', '/a'],
    ['a bare tilde', '~'],
    ['the home directory itself', '~/'],
    ['the home directory with a dot', '~/.'],
    ['the parent of the home directory', '~/..'],
    ['a tilde path that folds back to home', '~/inner/..'],
    ['a backslash UNC path', '\\\\server\\share\\mem'],
    ['a path with a NUL byte', '/tmp/mem\0dir'],
    ['an empty string', ''],
  ])('%s is rejected, and the default applies', (_label, value) => {
    const w = world()
    const repo = enterRepo()
    w.settings('user', { autoMemoryDirectory: value })
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })

  test('a rejected value in a higher layer hides a valid one below it', () => {
    const w = world()
    const repo = enterRepo()
    w.settings('user', { autoMemoryDirectory: join(w.root, 'valid-user-dir') })
    w.settings('local', { autoMemoryDirectory: 'not/absolute' })
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })

  test('an empty value in the local layer switches a user-level directory off for this project', () => {
    const w = world()
    const repo = enterRepo()
    w.settings('user', { autoMemoryDirectory: join(w.root, 'valid-user-dir') })
    expect(getAutoMemPath()).toBe(join(w.root, 'valid-user-dir') + sep)
    w.settings('local', { autoMemoryDirectory: '' })
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
  })
})

describe('getAutoMemPath: the CLAUDE_COWORK_MEMORY_PATH_OVERRIDE variable', () => {
  test('wins over every setting and the defaults, and reports itself', () => {
    const w = world()
    enterRepo()
    w.settings('policy', { autoMemoryDirectory: join(w.root, 'policy-dir') })
    const mount = join(w.root, 'space-mount')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = mount
    w.refresh()
    expect(getAutoMemPath()).toBe(mount + sep)
    expect(hasAutoMemPathOverride()).toBe(true)
  })

  test('~ is not expanded there, so a tilde value is rejected and the settings apply', () => {
    const w = world()
    w.settings('user', { autoMemoryDirectory: join(w.root, 'from-user') })
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = '~/memdir-suite-not-created'
    w.refresh()
    expect(getAutoMemPath()).toBe(join(w.root, 'from-user') + sep)
    expect(hasAutoMemPathOverride()).toBe(false)
  })

  test('an invalid override does not count as one', () => {
    for (const value of ['relative/dir', '/', '']) {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = value
      expect(hasAutoMemPathOverride()).toBe(false)
    }
  })
})

describe('getAutoMemPath: a project-local directory it cannot trust', () => {
  test('a .claudin symlink that leaves the repository falls back to the legacy location', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const outside = w.mkdir('outside')
    symlinkSync(outside, join(repo, '.claudin'), 'dir')
    w.enter(repo)
    expect(getAutoMemPath()).toBe(legacyDirFor(repo))
  })

  test('a .claudin/memory symlink that leaves the repository falls back too', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const outside = w.mkdir('outside-memory')
    mkdirSync(join(repo, '.claudin'))
    symlinkSync(outside, join(repo, '.claudin', 'memory'), 'dir')
    w.enter(repo)
    expect(getAutoMemPath()).toBe(legacyDirFor(repo))
  })

  test('a symlink that stays inside the repository is kept, under its lexical name', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    mkdirSync(join(repo, 'agent-state'))
    symlinkSync(join(repo, 'agent-state'), join(repo, '.claudin'), 'dir')
    w.enter(repo)
    expect(getAutoMemPath()).toBe(projectLocalDirFor(repo))
    expect(existsSync(join(repo, 'agent-state', 'memory'))).toBe(true)
  })

  test('a .claudin that is a file falls back to the legacy location', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    writeFileSync(join(repo, '.claudin'), 'not a directory\n')
    w.enter(repo)
    expect(getAutoMemPath()).toBe(legacyDirFor(repo))
  })
})

describe('getAutoMemPath: moving legacy memory into the repository', () => {
  function seedLegacy(repo: string): string {
    const legacy = legacyDirFor(repo)
    cpSync(join(FIXTURES, 'memory'), legacy, { recursive: true })
    return legacy
  }

  test('the first resolution copies the legacy memory in and leaves the original', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const legacy = seedLegacy(repo)
    w.enter(repo)

    const dir = getAutoMemPath()
    expect(dir).toBe(projectLocalDirFor(repo))
    for (const file of ['MEMORY.md', 'prefers-terse-replies.md', join('team', 'bugs', 'flaky-lock.md')]) {
      expect(readFileSync(join(dir, file), 'utf8')).toBe(readFileSync(join(legacy, file), 'utf8'))
      expect(existsSync(join(legacy, file))).toBe(true)
    }
  })

  test('a repository that already holds memory is left alone', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    seedLegacy(repo)
    w.put(join(repo, '.claudin', 'memory', 'already-here.md'), 'kept\n')
    w.enter(repo)

    const dir = getAutoMemPath()
    expect(existsSync(join(dir, 'prefers-terse-replies.md'))).toBe(false)
    expect(readFileSync(join(dir, 'already-here.md'), 'utf8')).toBe('kept\n')
  })

  test('a legacy directory with only a blank index has nothing to move', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    w.put(legacyDirFor(repo) + 'MEMORY.md', '  \n\n')
    w.put(legacyDirFor(repo) + 'notes.txt', 'not a memory\n')
    w.enter(repo)
    expect(existsSync(join(getAutoMemPath(), 'notes.txt'))).toBe(false)
  })
})

describe('isAutoMemPath', () => {
  test('is true for anything below the directory and false for the directory itself', () => {
    const repo = enterRepo()
    const dir = getAutoMemPath()
    expect(isAutoMemPath(join(dir, 'a.md'))).toBe(true)
    expect(isAutoMemPath(join(dir, 'team', 'bugs', 'b.md'))).toBe(true)
    expect(isAutoMemPath(dir)).toBe(true)
    expect(isAutoMemPath(join(repo, '.claudin', 'memory'))).toBe(false)
  })

  test('a sibling that shares the prefix is outside', () => {
    const repo = enterRepo()
    expect(isAutoMemPath(join(repo, '.claudin', 'memory-old', 'a.md'))).toBe(false)
  })

  test('dot segments are resolved before the check', () => {
    const repo = enterRepo()
    const dir = getAutoMemPath()
    expect(isAutoMemPath(`${dir}..${sep}settings.json`)).toBe(false)
    expect(isAutoMemPath(`${dir}..${sep}..${sep}..${sep}etc${sep}passwd`)).toBe(false)
    expect(isAutoMemPath(`${dir}team${sep}..${sep}kept.md`)).toBe(true)
    expect(isAutoMemPath(join(repo, 'src', 'a.ts'))).toBe(false)
  })

  test('a relative path is never inside', () => {
    enterRepo()
    expect(isAutoMemPath(join('.claudin', 'memory', 'a.md'))).toBe(false)
  })
})

describe('team memory paths', () => {
  test('team memory is on exactly when auto memory is', () => {
    expect(isTeamMemoryEnabled()).toBe(true)
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(isTeamMemoryEnabled()).toBe(false)
  })

  test('the team directory is team/ inside the auto-memory directory, wherever that is', () => {
    const w = world()
    const repo = enterRepo()
    expect(getTeamMemPath()).toBe(join(repo, '.claudin', 'memory', 'team') + sep)
    expect(getTeamMemEntrypoint()).toBe(join(repo, '.claudin', 'memory', 'team', 'MEMORY.md'))

    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(w.root, 'mount')
    w.refresh()
    expect(getTeamMemPath()).toBe(join(w.root, 'mount', 'team') + sep)
    expect(getTeamMemEntrypoint()).toBe(join(w.root, 'mount', 'team', 'MEMORY.md'))
  })

  test('isTeamMemPath: below team/ only, after resolving dot segments', () => {
    enterRepo()
    const team = getTeamMemPath()
    expect(isTeamMemPath(join(team, 'conventions.md'))).toBe(true)
    expect(isTeamMemPath(join(team, 'decisions', 'git-is-the-sync.md'))).toBe(true)
    expect(isTeamMemPath(team)).toBe(false)
    expect(isTeamMemPath(team.slice(0, -1))).toBe(false)
    expect(isTeamMemPath(join(getAutoMemPath(), 'private.md'))).toBe(false)
    expect(isTeamMemPath(`${team}..${sep}private.md`)).toBe(false)
    expect(isTeamMemPath(`${team}bugs${sep}..${sep}root.md`)).toBe(true)
  })

  test('isTeamMemFile also needs team memory to be on', () => {
    enterRepo()
    const file = join(getTeamMemPath(), 'conventions.md')
    expect(isTeamMemFile(file)).toBe(true)
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(isTeamMemFile(file)).toBe(false)
  })
})

describe('isTeamMemLikelyGitIgnored', () => {
  function rootWithIgnore(fixture: string | null): string {
    const w = world()
    const root = w.mkdir(`ignore-${fixture ?? 'none'}-${Math.random().toString(36).slice(2)}`)
    if (fixture !== null) {
      cpSync(join(FIXTURES, 'gitignore', fixture), join(root, '.gitignore'))
    }
    return root
  }

  test.each([
    ['blanket.gitignore', true],
    ['blanket-no-slash.gitignore', true],
    ['carved-out.gitignore', false],
    ['negated-then-blanket.gitignore', true],
    ['star-only.gitignore', false],
    ['unrelated.gitignore', false],
  ])('%s → %p', (fixture, ignored) => {
    expect(isTeamMemLikelyGitIgnored(rootWithIgnore(fixture))).toBe(ignored)
  })

  test('no .gitignore at the root fails open', () => {
    expect(isTeamMemLikelyGitIgnored(rootWithIgnore(null))).toBe(false)
  })

  test('the shapes it recognizes, one line at a time', () => {
    const w = world()
    const verdict = (text: string): boolean => {
      const root = w.mkdir(`shape-${Math.random().toString(36).slice(2)}`)
      writeFileSync(join(root, '.gitignore'), text)
      return isTeamMemLikelyGitIgnored(root)
    }
    for (const blanket of ['.claudin', '/.claudin', '.claudin/', '/.claudin/', '  /.claudin  ']) {
      expect(verdict(`${blanket}\n`)).toBe(true)
    }
    for (const other of ['.claudin/*', '.claudin/**', '# /.claudin', 'src/.claudin', '.claudin-cache']) {
      expect(verdict(`${other}\n`)).toBe(false)
    }
    expect(verdict('/.claudin\n!.claudin/memory/team\n')).toBe(false)
    expect(verdict('/.claudin\r\n')).toBe(true)
  })
})

describe('projectIsInGitRepo', () => {
  test('true at a repository root and anywhere below it, false elsewhere', () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    const deep = join(repo, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    expect(projectIsInGitRepo(repo)).toBe(true)
    expect(projectIsInGitRepo(deep)).toBe(true)
    expect(projectIsInGitRepo(w.mkdir('plain'))).toBe(false)
  })

  test('a worktree, whose .git is a file, counts', () => {
    const w = world()
    const main = w.repo(join(w.root, 'main'))
    const worktree = join(w.root, 'wt')
    w.git(main, 'worktree', 'add', '-q', worktree)
    expect(projectIsInGitRepo(worktree)).toBe(true)
  })
})
