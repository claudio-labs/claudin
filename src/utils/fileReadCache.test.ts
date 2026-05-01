import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Controllable fake fs — tests override these per-describe as needed
let fakeStatMtime = 1000
let fakeContent = 'hello world'
let readFileSyncCallCount = 0

mock.module('./fsOperations.js', () => ({
  getFsImplementation: () => ({
    statSync: (_path: string) => ({ mtimeMs: fakeStatMtime, mode: 0o644 }),
    readFileSync: (_path: string, _opts: unknown) => {
      readFileSyncCallCount++
      return fakeContent
    },
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

mock.module('./debug.js', () => ({
  logForDebugging: () => {},
}))

mock.module('./log.js', () => ({
  logError: () => {},
}))

mock.module('../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))

mock.module('../services/analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('./cwd.js', () => ({
  getCwd: () => '/fake/cwd',
}))

mock.module('./path.js', () => ({
  expandPath: (p: string) => p,
}))

mock.module('./platform.js', () => ({
  getPlatform: () => 'linux',
}))

mock.module('./errors.js', () => ({
  isENOENT: (e: unknown) =>
    (e as NodeJS.ErrnoException)?.code === 'ENOENT',
  isFsInaccessible: () => false,
}))

const { fileReadCache } = await import('./fileReadCache.js')

beforeEach(() => {
  fileReadCache.clear()
  readFileSyncCallCount = 0
  fakeStatMtime = 1000
  fakeContent = 'hello world'
})

afterEach(() => {
  mock.restore()
})

describe('FileReadCache.readFile', () => {
  test('returns content on first read (cache miss)', () => {
    const result = fileReadCache.readFile('/tmp/test.ts')
    expect(result.content).toBe('hello world')
    expect(result.encoding).toBe('utf8')
  })

  test('returns cache hit when mtime unchanged (no second readFileSync)', () => {
    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncCallCount).toBe(1)

    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncCallCount).toBe(1) // still 1 — served from cache
  })

  test('re-reads file when mtime changes (stale cache)', () => {
    fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncCallCount).toBe(1)

    fakeStatMtime = 2000
    fakeContent = 'updated content'
    const result = fileReadCache.readFile('/tmp/test.ts')
    expect(readFileSyncCallCount).toBe(2)
    expect(result.content).toBe('updated content')
  })

  test('does NOT cache files above maxEntryBytes (256KB)', () => {
    fakeContent = 'x'.repeat(256 * 1024 + 1) // 1 byte over limit
    fileReadCache.readFile('/tmp/large.ts')
    expect(fileReadCache.getStats().size).toBe(0)
  })

  test('large files are still returned correctly even without caching', () => {
    const bigContent = 'x'.repeat(256 * 1024 + 1)
    fakeContent = bigContent
    const result = fileReadCache.readFile('/tmp/large.ts')
    expect(result.content).toBe(bigContent)
  })

  test('caches files exactly at the limit (256KB)', () => {
    fakeContent = 'x'.repeat(256 * 1024) // exactly at limit
    fileReadCache.readFile('/tmp/exact.ts')
    expect(fileReadCache.getStats().size).toBe(1)
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
