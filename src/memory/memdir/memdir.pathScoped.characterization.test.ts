/**
 * Characterization of `pathScopedMemories.ts`: a memory whose frontmatter has
 * `paths:` is attached the first time a Read touches a matching file.
 *
 * Covers where the globs are anchored, how a target is matched, which files the
 * index holds and when it is rebuilt, and what a lookup returns. The memory
 * trees are copies of `__fixtures__/rewrite/memory`, a private index and topic
 * file plus a team directory with one memory in each category.
 */
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import {
  defaultPathScopedScanFs,
  findPathScopedMemoryFiles,
  getPathScopedIndex,
  getPathScopedMemoryFiles,
  matchesPathScope,
  type PathScopedEntry,
  type PathScopedScanFs,
  resetPathScopedMemoryCache,
  resolveGlobBaseDir,
} from 'src/memory/memdir/pathScopedMemories.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'

const world = useMemdirWorld()

const FIXTURE_TREE = join(import.meta.dir, '__fixtures__', 'rewrite', 'memory')

/** The fixture tree copied to `dir`; returns `dir` with a trailing separator. */
function plantTree(dir: string): string {
  cpSync(FIXTURE_TREE, dir, { recursive: true })
  return dir.endsWith(sep) ? dir : dir + sep
}

/** A repository whose memory directory holds the fixture tree. */
function repoWithMemory(): { repo: string; memDir: string } {
  const w = world()
  const repo = w.mkdir('repo')
  const memDir = plantTree(join(repo, '.claudin', 'memory'))
  return { repo, memDir }
}

function memoryFile(fields: Record<string, string>, body = 'the fact\n'): string {
  const head = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return ['---', ...head, '---', '', body].join('\n')
}

function sorted(entries: PathScopedEntry[]): PathScopedEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path))
}

/** The real scan filesystem, counting the file heads it reads. */
function countingScan(): PathScopedScanFs & { heads: string[] } {
  const heads: string[] = []
  return {
    heads,
    readdir: dir => defaultPathScopedScanFs.readdir(dir),
    readHead: path => {
      heads.push(path)
      return defaultPathScopedScanFs.readHead(path)
    },
    dirMtimeMs: dir => defaultPathScopedScanFs.dirMtimeMs(dir),
  }
}

/** Moves a directory's mtime visibly forward, whatever the filesystem's resolution. */
function touchDir(dir: string): void {
  const later = new Date(Date.now() + 60_000)
  utimesSync(dir, later, later)
}

describe('resolveGlobBaseDir', () => {
  test('a memory directory inside a .claudin directory anchors at the directory holding .claudin', () => {
    expect(resolveGlobBaseDir('/work/app/.claudin/memory/', '/elsewhere')).toBe('/work/app')
    expect(resolveGlobBaseDir('/work/app/.claudin/memory', '/elsewhere')).toBe('/work/app')
    expect(resolveGlobBaseDir('/work/app/.claudin/memory///', '/elsewhere')).toBe('/work/app')
    expect(resolveGlobBaseDir('/work/app/.claudin/mem-other/', '/elsewhere')).toBe('/work/app')
  })

  test('any other location anchors at the original cwd', () => {
    expect(resolveGlobBaseDir('/home/u/.claudin/projects/-work-app/memory/', '/work/app')).toBe('/work/app')
    expect(resolveGlobBaseDir('/srv/shared-memory/', '/work/app')).toBe('/work/app')
    expect(resolveGlobBaseDir('/work/app/.claudin/memory/team/', '/launch')).toBe('/launch')
  })
})

describe('matchesPathScope', () => {
  test('globs are rule globs, matched on the path relative to the base directory', () => {
    expect(matchesPathScope(['src/locks'], '/repo', '/repo/src/locks/fileLock.ts')).toBe(true)
    expect(matchesPathScope(['src/locks'], '/repo', '/repo/src/locksmith/a.ts')).toBe(false)
    expect(matchesPathScope(['*.md'], '/repo', '/repo/docs/deep/notes.md')).toBe(true)
    expect(matchesPathScope(['docs/*.md'], '/repo', '/repo/docs/deep/notes.md')).toBe(false)
    expect(matchesPathScope(['src/**/*.test.ts'], '/repo', '/repo/src/a/b/c.test.ts')).toBe(true)
    expect(matchesPathScope(['src/**/*.test.ts'], '/repo', '/repo/src/a/b/c.ts')).toBe(false)
  })

  test('any one glob of the list is enough', () => {
    expect(matchesPathScope(['src/memory', 'docs/memory'], '/repo', '/repo/docs/memory/x.md')).toBe(true)
    expect(matchesPathScope([], '/repo', '/repo/docs/memory/x.md')).toBe(false)
  })

  test('the base itself, a path outside it, and a relative path leaving it never match', () => {
    expect(matchesPathScope(['**/*'], '/repo', '/repo')).toBe(false)
    expect(matchesPathScope(['**/*.ts'], '/repo', '/other/src/a.ts')).toBe(false)
    expect(matchesPathScope(['**/*.ts'], '/repo', '/repository/src/a.ts')).toBe(false)
    expect(matchesPathScope(['**/*.ts'], '/repo', '../repo/src/a.ts')).toBe(false)
    expect(matchesPathScope(['**/*.ts'], '/repo', '')).toBe(false)
  })

  test('a relative target is taken as already relative to the base', () => {
    expect(matchesPathScope(['docs'], '/repo', 'docs/guide.md')).toBe(true)
    expect(matchesPathScope(['docs'], '/repo', 'src/guide.md')).toBe(false)
  })
})

describe('getPathScopedIndex', () => {
  test('holds the files that declare paths:, with their globs, and nothing else', async () => {
    const { memDir } = repoWithMemory()
    const entries = await getPathScopedIndex(memDir)
    expect(sorted(entries)).toEqual(
      sorted([
        {
          path: join(memDir, 'team', 'bugs', 'flaky-lock.md'),
          globs: ['src/locks', 'test/locks/lock.test.ts'],
        },
        {
          path: join(memDir, 'team', 'decisions', 'git-is-the-sync.md'),
          globs: ['src/memory', 'docs/memory'],
        },
        { path: join(memDir, 'team', 'docs', 'provider-docs.md'), globs: ['src/providers'] },
      ]),
    )
  })

  test('an index file never enters it, whatever its frontmatter says', async () => {
    const w = world()
    const memDir = w.mkdir('mem') + sep
    w.put(join(memDir, 'MEMORY.md'), memoryFile({ paths: 'src/**' }))
    w.put(join(memDir, 'team', 'MEMORY.md'), memoryFile({ paths: 'src/**' }))
    expect(await getPathScopedIndex(memDir)).toEqual([])
  })

  test('a match-all paths:, a non-markdown file and a file without frontmatter stay out', async () => {
    const w = world()
    const memDir = w.mkdir('mem') + sep
    w.put(join(memDir, 'everywhere.md'), memoryFile({ name: 'everywhere', paths: '"**"' }))
    w.put(join(memDir, 'notes.txt'), memoryFile({ paths: 'src/**' }))
    w.put(join(memDir, 'plain.md'), 'just a body, paths: src/**\n')
    w.put(join(memDir, 'scoped.md'), memoryFile({ paths: 'lib/**' }))
    expect(await getPathScopedIndex(memDir)).toEqual([
      { path: join(memDir, 'scoped.md'), globs: ['lib'] },
    ])
  })

  test('the walk goes two directories down, and no further', async () => {
    const w = world()
    const memDir = w.mkdir('mem') + sep
    w.put(join(memDir, 'a', 'b', 'two-down.md'), memoryFile({ paths: 'src/**' }))
    w.put(join(memDir, 'a', 'b', 'c', 'three-down.md'), memoryFile({ paths: 'src/**' }))
    expect((await getPathScopedIndex(memDir)).map(e => e.path)).toEqual([
      join(memDir, 'a', 'b', 'two-down.md'),
    ])
  })

  test('symlinked files and directories are not followed', async () => {
    const w = world()
    const memDir = w.mkdir('mem') + sep
    const outside = w.put(join(w.root, 'outside', 'secret.md'), memoryFile({ paths: 'src/**' }))
    symlinkSync(outside, join(memDir, 'linked.md'))
    symlinkSync(join(w.root, 'outside'), join(memDir, 'linked-dir'), 'dir')
    expect(await getPathScopedIndex(memDir)).toEqual([])
  })

  test('an unreadable subdirectory or file is skipped and the rest still indexed', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const w = world()
    const memDir = w.mkdir('mem') + sep
    w.put(join(memDir, 'locked', 'hidden.md'), memoryFile({ paths: 'src/**' }))
    const sealed = w.put(join(memDir, 'sealed.md'), memoryFile({ paths: 'lib/**' }))
    w.put(join(memDir, 'open.md'), memoryFile({ paths: 'docs/**' }))
    chmodSync(join(memDir, 'locked'), 0o000)
    chmodSync(sealed, 0o000)
    try {
      expect((await getPathScopedIndex(memDir)).map(e => e.path)).toEqual([join(memDir, 'open.md')])
    } finally {
      chmodSync(join(memDir, 'locked'), 0o755)
      chmodSync(sealed, 0o644)
    }
  })

  test('a missing directory gives an empty index and is looked at again next time', async () => {
    const w = world()
    const memDir = join(w.root, 'not-yet') + sep
    expect(await getPathScopedIndex(memDir)).toEqual([])
    w.put(join(memDir, 'late.md'), memoryFile({ paths: 'src/**' }))
    expect((await getPathScopedIndex(memDir)).map(e => e.path)).toEqual([join(memDir, 'late.md')])
  })

  test('it is kept between calls while no walked directory changed', async () => {
    const { memDir } = repoWithMemory()
    const scan = countingScan()
    const first = await getPathScopedIndex(memDir, scan)
    const readsAfterFirst = scan.heads.length
    // Five topic files; the two MEMORY.md indexes are skipped unread.
    expect(readsAfterFirst).toBe(5)
    expect(scan.heads.some(path => path.endsWith('MEMORY.md'))).toBe(false)
    const second = await getPathScopedIndex(memDir, scan)
    expect(scan.heads.length).toBe(readsAfterFirst)
    expect(sorted(second)).toEqual(sorted(first))
  })

  test('a new file in any walked directory makes the next call rescan', async () => {
    const { memDir } = repoWithMemory()
    const scan = countingScan()
    await getPathScopedIndex(memDir, scan)
    const bugs = join(memDir, 'team', 'bugs')
    writeFileSync(join(bugs, 'late-bug.md'), memoryFile({ paths: 'src/late/**' }))
    touchDir(bugs)
    const entries = await getPathScopedIndex(memDir, scan)
    expect(entries.map(e => e.path)).toContain(join(bugs, 'late-bug.md'))
  })

  test('a walked directory that disappeared makes it rescan instead of failing', async () => {
    const { memDir } = repoWithMemory()
    await getPathScopedIndex(memDir)
    rmSync(join(memDir, 'team', 'decisions'), { recursive: true, force: true })
    const paths = (await getPathScopedIndex(memDir)).map(e => e.path)
    expect(paths).not.toContain(join(memDir, 'team', 'decisions', 'git-is-the-sync.md'))
    expect(paths).toHaveLength(2)
  })

  test('another directory, or a reset, means a fresh scan', async () => {
    const { memDir } = repoWithMemory()
    const w = world()
    const other = w.mkdir('other-mem') + sep
    w.put(join(other, 'only.md'), memoryFile({ paths: 'x/**' }))
    const scan = countingScan()
    await getPathScopedIndex(memDir, scan)
    expect((await getPathScopedIndex(other, scan)).map(e => e.path)).toEqual([join(other, 'only.md')])
    const before = scan.heads.length
    resetPathScopedMemoryCache()
    await getPathScopedIndex(other, scan)
    expect(scan.heads.length).toBeGreaterThan(before)
  })
})

describe('findPathScopedMemoryFiles', () => {
  test('a Read under a memory globs returns that memory, frontmatter stripped', async () => {
    const { repo, memDir } = repoWithMemory()
    const files = await findPathScopedMemoryFiles({
      targetPath: join(repo, 'src', 'locks', 'fileLock.ts'),
      memoryDir: memDir,
      originalCwd: '/not/used/for/project-local',
      processedPaths: new Set(),
    })
    expect(files).toHaveLength(1)
    const [file] = files
    expect(file!.path).toBe(join(memDir, 'team', 'bugs', 'flaky-lock.md'))
    expect(file!.type).toBe('AutoMem')
    expect(file!.globs).toEqual(['src/locks', 'test/locks/lock.test.ts'])
    expect(file!.content.startsWith('---')).toBe(false)
    expect(file!.content).not.toContain('paths:')
    expect(file!.content).toContain('**Symptom:**')
  })

  test('each category memory answers to its own globs; unrelated reads get nothing', async () => {
    const { repo, memDir } = repoWithMemory()
    const lookup = async (...segments: string[]) =>
      (
        await findPathScopedMemoryFiles({
          targetPath: join(repo, ...segments),
          memoryDir: memDir,
          originalCwd: '/unused',
          processedPaths: new Set(),
        })
      ).map(file => file.path)
    expect(await lookup('docs', 'memory', 'design.md')).toEqual([
      join(memDir, 'team', 'decisions', 'git-is-the-sync.md'),
    ])
    expect(await lookup('src', 'providers', 'openai', 'client.ts')).toEqual([
      join(memDir, 'team', 'docs', 'provider-docs.md'),
    ])
    expect(await lookup('test', 'locks', 'lock.test.ts')).toEqual([
      join(memDir, 'team', 'bugs', 'flaky-lock.md'),
    ])
    expect(await lookup('README.md')).toEqual([])
    expect(await lookup('src', 'index.ts')).toEqual([])
  })

  test('a Read matching several memories returns all of them', async () => {
    const { repo, memDir } = repoWithMemory()
    writeFileSync(join(memDir, 'broad.md'), memoryFile({ name: 'broad', paths: 'src/**' }, 'broad fact\n'))
    const files = await findPathScopedMemoryFiles({
      targetPath: join(repo, 'src', 'memory', 'paths.ts'),
      memoryDir: memDir,
      originalCwd: '/unused',
      processedPaths: new Set(),
    })
    expect(files.map(f => f.path).sort()).toEqual(
      [join(memDir, 'broad.md'), join(memDir, 'team', 'decisions', 'git-is-the-sync.md')].sort(),
    )
  })

  test('outside a .claudin directory the globs anchor at the original cwd', async () => {
    const w = world()
    const memDir = plantTree(join(w.configDir, 'projects', '-work-app', 'memory'))
    const launch = w.mkdir('launch')
    const lookup = async (target: string) =>
      (
        await findPathScopedMemoryFiles({
          targetPath: target,
          memoryDir: memDir,
          originalCwd: launch,
          processedPaths: new Set(),
        })
      ).map(file => file.path)
    expect(await lookup(join(launch, 'src', 'locks', 'a.ts'))).toEqual([
      join(memDir, 'team', 'bugs', 'flaky-lock.md'),
    ])
    expect(await lookup(join(w.root, 'other-checkout', 'src', 'locks', 'a.ts'))).toEqual([])
  })

  test('the caller set dedupes: a memory it already holds is not returned again', async () => {
    const { repo, memDir } = repoWithMemory()
    const processedPaths = new Set<string>()
    const target = join(repo, 'src', 'locks', 'fileLock.ts')
    const call = () =>
      findPathScopedMemoryFiles({ targetPath: target, memoryDir: memDir, originalCwd: '/unused', processedPaths })
    expect(await call()).toHaveLength(1)
    expect(processedPaths.has(join(memDir, 'team', 'bugs', 'flaky-lock.md'))).toBe(true)
    expect(await call()).toEqual([])
  })

  test('a directory with no scoped memory returns nothing and leaves the set alone', async () => {
    const w = world()
    const memDir = w.mkdir('mem') + sep
    w.put(join(memDir, 'plain.md'), memoryFile({ name: 'plain', type: 'user' }))
    const processedPaths = new Set<string>()
    expect(
      await findPathScopedMemoryFiles({
        targetPath: join(w.root, 'src', 'a.ts'),
        memoryDir: memDir,
        originalCwd: w.root,
        processedPaths,
      }),
    ).toEqual([])
    expect(processedPaths.size).toBe(0)
  })
})

describe('getPathScopedMemoryFiles (the session memory directory)', () => {
  test('uses the session memory directory, anchored at the repository', async () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    w.enter(repo)
    const memDir = getAutoMemPath()
    plantTree(memDir)
    const files = await getPathScopedMemoryFiles(join(repo, 'src', 'providers', 'a.ts'), new Set())
    expect(files.map(f => f.path)).toEqual([join(memDir, 'team', 'docs', 'provider-docs.md')])
  })

  test('with an override directory the globs anchor at the original cwd', async () => {
    const w = world()
    const mount = plantTree(w.mkdir('space-mount'))
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = mount
    w.refresh()
    const files = await getPathScopedMemoryFiles(join(w.project, 'src', 'memory', 'x.ts'), new Set())
    expect(files.map(f => f.path)).toEqual([join(mount, 'team', 'decisions', 'git-is-the-sync.md')])
  })

  test('nothing while auto memory is off', async () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    w.enter(repo)
    plantTree(getAutoMemPath())
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(await getPathScopedMemoryFiles(join(repo, 'src', 'providers', 'a.ts'), new Set())).toEqual([])
  })
})

describe('the default scan filesystem', () => {
  test('reads a directory, the head of a file and a directory mtime', async () => {
    const w = world()
    const dir = w.mkdir('scan')
    mkdirSync(join(dir, 'sub'))
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
    w.put(join(dir, 'long.md'), long)
    const names = (await defaultPathScopedScanFs.readdir(dir)).map(d => [d.name, d.isFile(), d.isDirectory()])
    expect(names.sort()).toEqual([
      ['long.md', true, false],
      ['sub', false, true],
    ])
    const head = await defaultPathScopedScanFs.readHead(join(dir, 'long.md'))
    expect(head.startsWith('line 0\n')).toBe(true)
    expect(head).not.toContain('line 79')
    expect(typeof (await defaultPathScopedScanFs.dirMtimeMs(dir))).toBe('number')
  })
})
