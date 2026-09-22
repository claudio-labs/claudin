import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  defaultPathScopedScanFs,
  findPathScopedMemoryFiles,
  getPathScopedIndex,
  matchesPathScope,
  type PathScopedScanFs,
  resetPathScopedMemoryCache,
  resolveGlobBaseDir,
} from 'src/memory/memdir/pathScopedMemories.js'

/**
 * Wraps the real scan fs and counts the calls, so a test can tell "served from
 * the memoized index" (no readHead) from "rescanned" without mocking modules.
 */
function countingFs(): PathScopedScanFs & { reads: number; stats: number } {
  const counting = {
    reads: 0,
    stats: 0,
    readdir: (dir: string) => defaultPathScopedScanFs.readdir(dir),
    readHead: (filePath: string) => {
      counting.reads++
      return defaultPathScopedScanFs.readHead(filePath)
    },
    dirMtimeMs: (dir: string) => {
      counting.stats++
      return defaultPathScopedScanFs.dirMtimeMs(dir)
    },
  }
  return counting
}

function memory(
  frontmatter: Record<string, string>,
  body = 'the fact\n',
): string {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

describe('resolveGlobBaseDir', () => {
  test('a project-local memdir anchors at the directory containing .claudin', () => {
    expect(resolveGlobBaseDir('/repo/.claudin/memory/', '/elsewhere')).toBe(
      '/repo',
    )
    expect(resolveGlobBaseDir('/repo/.claudin/memory', '/elsewhere')).toBe(
      '/repo',
    )
  })

  test('any other memdir location anchors at the original cwd', () => {
    expect(
      resolveGlobBaseDir(
        '/home/u/.claudin/projects/-repo/memory/',
        '/repo/checkout',
      ),
    ).toBe('/repo/checkout')
    expect(resolveGlobBaseDir('/srv/shared-memory/', '/repo')).toBe('/repo')
  })
})

describe('matchesPathScope', () => {
  test('matches a base-relative glob against an absolute target', () => {
    expect(
      matchesPathScope(['src/tools/**'], '/repo', '/repo/src/tools/a.ts'),
    ).toBe(true)
    expect(matchesPathScope(['src/tools'], '/repo', '/repo/src/tools/a.ts')).toBe(
      true,
    )
    expect(matchesPathScope(['src/tools/**'], '/repo', '/repo/src/agent/a.ts')).toBe(
      false,
    )
  })

  test('a target outside the base dir never matches', () => {
    expect(matchesPathScope(['**/*.ts'], '/repo', '/other/src/a.ts')).toBe(false)
    expect(matchesPathScope(['**/*.ts'], '/repo', '/repo')).toBe(false)
  })

  test('a relative target is taken as already base-relative', () => {
    expect(matchesPathScope(['docs/**'], '/repo', 'docs/x.md')).toBe(true)
  })
})

describe('findPathScopedMemoryFiles', () => {
  let root: string
  let memoryDir: string

  beforeEach(async () => {
    resetPathScopedMemoryCache()
    root = await mkdtemp(join(tmpdir(), 'path-scoped-mem-'))
    memoryDir = join(root, '.claudin', 'memory')
    await mkdir(join(memoryDir, 'team', 'bugs'), { recursive: true })
    await mkdir(join(memoryDir, 'team', 'decisions'), { recursive: true })
    await mkdir(join(memoryDir, 'team', 'deep', 'deeper'), { recursive: true })

    // The index carries a match-all `paths:` on purpose: it must be skipped by
    // name, never matched.
    await writeFile(
      join(memoryDir, 'MEMORY.md'),
      memory({ paths: 'src/**' }, '- [x](x.md)\n'),
    )
    await writeFile(
      join(memoryDir, 'no-paths.md'),
      memory({ name: 'no-paths', type: 'feedback' }),
    )
    await writeFile(
      join(memoryDir, 'team', 'bugs', 'sleep-gap.md'),
      memory(
        { name: 'sleep-gap', type: 'project', paths: 'src/tools/BashTool/**' },
        'isAutobackgroundingAllowed misses `sleep N`\n',
      ),
    )
    await writeFile(
      join(memoryDir, 'team', 'decisions', 'git-is-the-sync.md'),
      memory(
        { name: 'git-is-the-sync', type: 'project', paths: 'src/memory/**, docs/**' },
        'team memory is git-tracked\n',
      ),
    )
    // Three levels below the memdir — past the scan depth, like scanMemoryFiles.
    await writeFile(
      join(memoryDir, 'team', 'deep', 'deeper', 'too-deep.md'),
      memory({ paths: 'src/**' }),
    )
  })

  afterEach(async () => {
    resetPathScopedMemoryCache()
    await rm(root, { recursive: true, force: true })
  })

  test('the index holds only files with paths, never MEMORY.md, within depth', async () => {
    const entries = await getPathScopedIndex(memoryDir)
    expect(entries.map(e => e.path).sort()).toEqual([
      join(memoryDir, 'team', 'bugs', 'sleep-gap.md'),
      join(memoryDir, 'team', 'decisions', 'git-is-the-sync.md'),
    ])
    expect(entries.find(e => e.path.endsWith('sleep-gap.md'))?.globs).toEqual([
      'src/tools/BashTool',
    ])
    expect(
      entries.find(e => e.path.endsWith('git-is-the-sync.md'))?.globs,
    ).toEqual(['src/memory', 'docs'])
  })

  test('a Read under a matching glob yields that memory, frontmatter stripped', async () => {
    const files = await findPathScopedMemoryFiles({
      targetPath: join(root, 'src', 'tools', 'BashTool', 'x.ts'),
      memoryDir,
      originalCwd: '/unused',
      processedPaths: new Set(),
    })
    expect(files).toHaveLength(1)
    const [file] = files
    expect(file!.path).toBe(join(memoryDir, 'team', 'bugs', 'sleep-gap.md'))
    expect(file!.type).toBe('AutoMem')
    expect(file!.globs).toEqual(['src/tools/BashTool'])
    expect(file!.content).not.toContain('paths:')
    expect(file!.content.trim()).toBe(
      'isAutobackgroundingAllowed misses `sleep N`',
    )
    expect(file!.contentDiffersFromDisk).toBe(true)
    expect(file!.rawContent).toContain('paths: src/tools/BashTool/**')
  })

  test('a comma-separated paths list matches any of its globs', async () => {
    const forDocs = await findPathScopedMemoryFiles({
      targetPath: join(root, 'docs', 'tech', 'memory.md'),
      memoryDir,
      originalCwd: '/unused',
      processedPaths: new Set(),
    })
    expect(forDocs.map(f => f.path)).toEqual([
      join(memoryDir, 'team', 'decisions', 'git-is-the-sync.md'),
    ])
  })

  test('a Read that matches nothing yields nothing', async () => {
    const files = await findPathScopedMemoryFiles({
      targetPath: join(root, 'README.md'),
      memoryDir,
      originalCwd: '/unused',
      processedPaths: new Set(),
    })
    expect(files).toEqual([])
  })

  test('a target outside the base dir yields nothing even when a glob is broad', async () => {
    const files = await findPathScopedMemoryFiles({
      targetPath: '/somewhere/else/src/memory/x.ts',
      memoryDir,
      originalCwd: '/unused',
      processedPaths: new Set(),
    })
    expect(files).toEqual([])
  })

  test('processedPaths dedupes across calls within one trigger', async () => {
    const processedPaths = new Set<string>()
    const targetPath = join(root, 'src', 'memory', 'memdir', 'paths.ts')
    const first = await findPathScopedMemoryFiles({
      targetPath,
      memoryDir,
      originalCwd: '/unused',
      processedPaths,
    })
    expect(first).toHaveLength(1)
    const second = await findPathScopedMemoryFiles({
      targetPath,
      memoryDir,
      originalCwd: '/unused',
      processedPaths,
    })
    expect(second).toEqual([])
  })

  test('the index is served from the memo while no directory mtime changed', async () => {
    const fs = countingFs()
    await getPathScopedIndex(memoryDir, fs)
    const readsAfterScan = fs.reads
    // no-paths, sleep-gap, git-is-the-sync. MEMORY.md is skipped by name and
    // too-deep.md sits past the scan depth, so neither costs a read.
    expect(readsAfterScan).toBe(3)
    fs.stats = 0

    const again = await getPathScopedIndex(memoryDir, fs)
    expect(fs.reads).toBe(readsAfterScan)
    expect(fs.stats).toBeGreaterThan(0)
    expect(again).toHaveLength(2)
  })

  test('a new file in a walked directory invalidates the memo', async () => {
    const fs = countingFs()
    await getPathScopedIndex(memoryDir, fs)
    const readsAfterScan = fs.reads

    const bugsDir = join(memoryDir, 'team', 'bugs')
    await writeFile(
      join(bugsDir, 'another.md'),
      memory({ paths: 'src/vcs/**' }),
    )
    // Force a visibly different directory mtime — a coarse filesystem could
    // land the write in the same tick as the scan.
    const later = new Date(Date.now() + 10_000)
    await utimes(bugsDir, later, later)

    const entries = await getPathScopedIndex(memoryDir, fs)
    expect(fs.reads).toBeGreaterThan(readsAfterScan)
    expect(entries.map(e => e.path)).toContain(join(bugsDir, 'another.md'))
  })

  test('a walked directory disappearing forces a rescan instead of throwing', async () => {
    await getPathScopedIndex(memoryDir)
    await rm(join(memoryDir, 'team', 'decisions'), {
      recursive: true,
      force: true,
    })
    const entries = await getPathScopedIndex(memoryDir)
    expect(entries.map(e => e.path)).toEqual([
      join(memoryDir, 'team', 'bugs', 'sleep-gap.md'),
    ])
  })

  test('a memdir that does not exist yet is not pinned as empty', async () => {
    // With no directory walked, the mtime map is empty and "nothing changed"
    // is vacuously true — so an empty scan must not be memoized, or the
    // directory is never noticed for the rest of the process.
    const fs = countingFs()
    const lateDir = join(root, 'late', '.claudin', 'memory')
    expect(await getPathScopedIndex(lateDir, fs)).toEqual([])

    await mkdir(lateDir, { recursive: true })
    await writeFile(join(lateDir, 'scoped.md'), memory({ paths: 'src/**' }))
    const entries = await getPathScopedIndex(lateDir, fs)
    expect(entries.map(e => e.path)).toEqual([join(lateDir, 'scoped.md')])
  })
})
