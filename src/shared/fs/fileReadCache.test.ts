import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture real modules before mocking so afterAll can restore them
const realFsOperations = { ...(await import('src/shared/fs/fsOperations.js')) }
const realFileRead = { ...(await import('src/shared/fs/fileRead.js')) }
const realDebug = { ...(await import('src/shared/debug.js')) }
const realLog = { ...(await import('src/shared/log.js')) }
const realGrowthbook = { ...(await import('src/services/analytics/growthbook.js')) }
const realAnalytics = { ...(await import('src/services/analytics/index.js')) }
const realCwd = { ...(await import('src/shared/fs/cwd.js')) }
const realPath = { ...(await import('src/shared/fs/path.js')) }
const realPlatform = { ...(await import('src/shared/proc/platform.js')) }
const realErrors = { ...(await import('src/shared/errors.js')) }

// Controllable fake fs — tests mutate these per-test via beforeEach
let fakeStatMtime = 1000
let fakeStatSize = 100
let fakeContent = 'hello world'
const readFileSyncSpy = mock((_path: string, _opts: unknown): string => fakeContent)

mock.module('./fsOperations.js', () => ({
  getFsImplementation: () => ({
    statSync: (_path: string) => ({
      mtimeMs: fakeStatMtime,
      size: fakeStatSize,
      mode: 0o644,
    }),
    readFileSync: readFileSyncSpy,
    readlinkSync: (_path: string) => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    },
    renameSync: (_src: string, _dst: string) => {},
    writeFileSync: (_path: string, _content: string, _opts: unknown) => {},
  }),
  safeResolvePath: (_fs: unknown, p: string) => ({ resolvedPath: p }),
}))

mock.module('./fileRead.js', () => ({
  detectEncodingForResolvedPath: () => 'utf8',
  detectLineEndingsForString: () => 'LF',
}))

mock.module('src/shared/debug.js', () => ({
  logForDebugging: () => {},
}))

mock.module('src/shared/log.js', () => ({
  logError: () => {},
}))

mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('./cwd.js', () => ({
  getCwd: () => '/fake/cwd',
}))

mock.module('./path.js', () => ({
  expandPath: (p: string) => p,
}))

mock.module('src/shared/proc/platform.js', () => ({
  getPlatform: () => 'linux',
}))

mock.module('src/shared/errors.js', () => ({
  isENOENT: (e: unknown) =>
    (e as NodeJS.ErrnoException)?.code === 'ENOENT',
  isFsInaccessible: () => false,
}))

const { fileReadCache } = await import('src/shared/fs/fileReadCache.js')

beforeEach(() => {
  fileReadCache.clear()
  readFileSyncSpy.mockReset()
  readFileSyncSpy.mockImplementation((_path: string, _opts: unknown) => fakeContent)
  fakeStatMtime = 1000
  fakeStatSize = 100
  fakeContent = 'hello world'
})

describe('FileReadCache.readFile', () => {
  test('returns content on first read (cache miss)', () => {
    const result = fileReadCache.readFile('/tmp/test.ts')
    expect(result.content).toBe('hello world')
    expect(result.encoding).toBe('utf8')
  })

  test('returns cache hit when mtime unchanged (no second readFileSync)', () => {
    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1)

    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1) // still 1 — served from cache
  })

  test('re-reads file when mtime changes (stale cache)', () => {
    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1)

    fakeStatMtime = 2000
    fakeContent = 'updated content'
    const result = fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncSpy).toHaveBeenCalledTimes(2)
    expect(result.content).toBe('updated content')
  })

  test('does NOT cache files above maxEntryBytes (256KB)', () => {
    fakeStatSize = 256 * 1024 + 1
    fakeContent = 'x'.repeat(256 * 1024 + 1)
    fileReadCache.readFile('/tmp/large.ts')
    expect(fileReadCache.getStats().size).toBe(0)
  })

  test('large files are still returned correctly even without caching', () => {
    const bigContent = 'x'.repeat(256 * 1024 + 1)
    fakeStatSize = bigContent.length
    fakeContent = bigContent
    const result = fileReadCache.readFile('/tmp/large.ts')
    expect(result.content).toBe(bigContent)
  })

  test('large files skip the readFileSync allocation via stats.size pre-check', () => {
    fakeStatSize = 256 * 1024 + 1
    fakeContent = 'x'.repeat(256 * 1024 + 1)
    fileReadCache.readFile('/tmp/large.ts')
    // readFileSync called once (to return content), but not cached
    expect(readFileSyncSpy).toHaveBeenCalledTimes(1)
    expect(fileReadCache.getStats().size).toBe(0)
    // second read also hits disk (no cache entry)
    fileReadCache.readFile('/tmp/large.ts')
    expect(readFileSyncSpy).toHaveBeenCalledTimes(2)
  })

  test('caches files exactly at the limit (256KB)', () => {
    fakeStatSize = 256 * 1024
    fakeContent = 'x'.repeat(256 * 1024)
    fileReadCache.readFile('/tmp/exact.ts')
    expect(fileReadCache.getStats().size).toBe(1)
  })

  test('normalizes CRLF line endings to LF in returned content', () => {
    fakeContent = 'line1\r\nline2\r\nline3'
    const result = fileReadCache.readFile('/tmp/crlf.ts')
    expect(result.content).toBe('line1\nline2\nline3')
  })


  test('evicts oldest entry when cache exceeds 1000 entries', () => {
    for (let i = 0; i < 1001; i++) {
      fileReadCache.readFile(`/tmp/file-${i}.ts`)
    }
    const stats = fileReadCache.getStats()
    expect(stats.size).toBe(1000)
    expect(stats.entries).not.toContain('/tmp/file-0.ts') // first evicted
    expect(stats.entries).toContain('/tmp/file-1000.ts') // last added
  })
})

describe('FileReadCache.invalidate', () => {
  test('removes a specific entry from cache', () => {
    fileReadCache.readFile('/tmp/test.ts')
    expect(fileReadCache.getStats().size).toBe(1)

    fileReadCache.invalidate('/tmp/test.ts')
    expect(fileReadCache.getStats().size).toBe(0)
  })

  test('invalidating a non-existent path is a no-op', () => {
    fileReadCache.readFile('/tmp/test.ts')
    fileReadCache.invalidate('/tmp/other.ts')
    expect(fileReadCache.getStats().size).toBe(1)
  })
})

describe('FileReadCache.clear', () => {
  test('empties the entire cache', () => {
    fileReadCache.readFile('/tmp/a.ts')
    fileReadCache.readFile('/tmp/b.ts')
    expect(fileReadCache.getStats().size).toBe(2)

    fileReadCache.clear()
    expect(fileReadCache.getStats().size).toBe(0)
  })
})

describe('writeTextContent + fileReadCache integration', () => {
  test('writeTextContent invalidates cache for written path', async () => {
    // Pre-populate cache for the path
    fileReadCache.readFile('/tmp/target.ts')
    expect(fileReadCache.getStats().size).toBe(1)

    const { writeTextContent } = await import(
      `./file.js?ts=${Date.now()}-${Math.random()}`
    )

    writeTextContent('/tmp/target.ts', 'new content', 'utf8', 'LF')

    expect(fileReadCache.getStats().size).toBe(0)
  })
})

afterAll(() => {
  mock.module('./fsOperations.js', () => realFsOperations)
  mock.module('src/shared/fs/fsOperations.js', () => realFsOperations)
  mock.module('./fileRead.js', () => realFileRead)
  mock.module('src/shared/fs/fileRead.js', () => realFileRead)
  mock.module('src/shared/debug.js', () => realDebug)
  mock.module('src/shared/debug.js', () => realDebug)
  mock.module('src/shared/log.js', () => realLog)
  mock.module('src/shared/log.js', () => realLog)
  mock.module('src/services/analytics/growthbook.js', () => realGrowthbook)
  mock.module('src/services/analytics/growthbook.js', () => realGrowthbook)
  mock.module('src/services/analytics/index.js', () => realAnalytics)
  mock.module('src/services/analytics/index.js', () => realAnalytics)
  mock.module('./cwd.js', () => realCwd)
  mock.module('src/shared/fs/cwd.js', () => realCwd)
  mock.module('./path.js', () => realPath)
  mock.module('src/shared/fs/path.js', () => realPath)
  mock.module('src/shared/proc/platform.js', () => realPlatform)
  mock.module('src/shared/proc/platform.js', () => realPlatform)
  mock.module('src/shared/errors.js', () => realErrors)
  mock.module('src/shared/errors.js', () => realErrors)
})
