import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  applyPatchCacheInvalidationPaths,
  resolveApplyPatchPaths,
} from 'src/tools/ApplyPatchTool/applyPatch.js'
import {
  CACHE_WHITELIST,
  __resetForTests,
  getCached,
  getStats,
  invalidateAll,
  invalidateForPath,
  isCacheDisabled,
  isCacheableTool,
  setCached,
} from 'src/agent/tools/toolResultCache.js'

let tmp: string
beforeEach(() => {
  __resetForTests()
  delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
  tmp = mkdtempSync(join(tmpdir(), 'tool-result-cache-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('whitelist', () => {
  test('exposes Read/Glob/Grep/LSP and only those', () => {
    expect(isCacheableTool('Read')).toBe(true)
    expect(isCacheableTool('Glob')).toBe(true)
    expect(isCacheableTool('Grep')).toBe(true)
    expect(isCacheableTool('LSP')).toBe(true)
    expect([...CACHE_WHITELIST].sort()).toEqual(['Glob', 'Grep', 'LSP', 'Read'])
  })

  test('rejects other read-only tools that have UI/external side effects', () => {
    expect(isCacheableTool('AskUserQuestion')).toBe(false)
    expect(isCacheableTool('EnterPlanMode')).toBe(false)
    expect(isCacheableTool('Agent')).toBe(false)
    expect(isCacheableTool('WebFetch')).toBe(false)
  })
})

describe('opt-out', () => {
  test('respects CLAUDIN_DISABLE_TOOL_RESULT_CACHE=1', () => {
    expect(isCacheDisabled()).toBe(false)
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
    expect(isCacheDisabled()).toBe(true)
  })
})

describe('hit/miss', () => {
  test('Glob: same input hits, different input misses', () => {
    setCached('Glob', { pattern: '**/*.ts' }, { numFiles: 3, filenames: ['a', 'b', 'c'] })
    const hit = getCached('Glob', { pattern: '**/*.ts' })
    expect(hit?.data).toEqual({ numFiles: 3, filenames: ['a', 'b', 'c'] })
    expect(getCached('Glob', { pattern: '**/*.tsx' })).toBeUndefined()
    const s = getStats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
  })

  test('key is stable across object key order', () => {
    setCached('Grep', { pattern: 'foo', path: '/a' }, { results: 1 })
    expect(getCached('Grep', { path: '/a', pattern: 'foo' })?.data).toEqual({
      results: 1,
    })
  })

  test('different tool names do not collide on equal input', () => {
    setCached('Glob', { pattern: 'x' }, { source: 'glob' })
    setCached('Grep', { pattern: 'x' }, { source: 'grep' })
    expect(getCached('Glob', { pattern: 'x' })?.data).toEqual({ source: 'glob' })
    expect(getCached('Grep', { pattern: 'x' })?.data).toEqual({ source: 'grep' })
  })
})

describe('Read mtime invalidation', () => {
  test('hit when file unchanged', () => {
    const f = join(tmp, 'a.txt')
    writeFileSync(f, 'hello')
    setCached('Read', { file_path: f }, { content: 'hello' })
    expect(getCached('Read', { file_path: f })?.data).toEqual({ content: 'hello' })
  })

  test('miss when mtime advances past storedAt', () => {
    const f = join(tmp, 'a.txt')
    writeFileSync(f, 'v1')
    setCached('Read', { file_path: f }, { content: 'v1' })
    // Bump mtime far into the future to defeat coarse FS timestamp resolution.
    const future = new Date(Date.now() + 60_000)
    utimesSync(f, future, future)
    expect(getCached('Read', { file_path: f })).toBeUndefined()
  })

  test('miss when file is deleted', () => {
    const f = join(tmp, 'a.txt')
    writeFileSync(f, 'v1')
    setCached('Read', { file_path: f }, { content: 'v1' })
    rmSync(f)
    expect(getCached('Read', { file_path: f })).toBeUndefined()
  })
})

describe('invalidation', () => {
  test('invalidateForPath removes entries for matching path', () => {
    // Read entries need real files on disk because getCached checks mtime.
    const a = join(tmp, 'a.ts')
    const b = join(tmp, 'b.ts')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    setCached('Read', { file_path: a }, { content: 'a' })
    setCached('Read', { file_path: b }, { content: 'b' })
    setCached('Glob', { pattern: '**/*.ts', path: tmp }, { n: 2 })
    invalidateForPath(a)
    // The exact-match Read goes; sibling Read remains.
    // Glob keyed on the parent dir matches because a.startsWith(tmp+'/') -> also evicted.
    expect(getCached('Read', { file_path: a })).toBeUndefined()
    expect(getCached('Read', { file_path: b })?.data).toEqual({ content: 'b' })
    expect(getCached('Glob', { pattern: '**/*.ts', path: tmp })).toBeUndefined()
  })

  test('invalidateAll empties the cache', () => {
    setCached('Glob', { pattern: 'x' }, { n: 1 })
    setCached('Grep', { pattern: 'y' }, { n: 1 })
    expect(invalidateAll()).toBeGreaterThanOrEqual(2)
    expect(getCached('Glob', { pattern: 'x' })).toBeUndefined()
    expect(getCached('Grep', { pattern: 'y' })).toBeUndefined()
  })

  test('apply_patch paths invalidate both relative- and absolute-keyed searches', () => {
    // Mirrors invalidateCacheForWrite's apply_patch branch: feeding every path
    // from applyPatchCacheInvalidationPaths through invalidateForPath must drop
    // a search cached on the relative dir the model used AND one cached on the
    // absolute resolved dir (Grep/Glob skip the Read mtime re-check).
    const patchText = '*** Begin Patch\n*** Update File: rel/foo.ts\n@@\n-a\n+b\n*** End Patch'
    const absFile = resolveApplyPatchPaths({ patchText })[0]
    const absDir = dirname(absFile)

    setCached('Grep', { pattern: 'x', path: 'rel' }, { n: 1 })
    setCached('Grep', { pattern: 'y', path: absDir }, { n: 2 })

    for (const p of applyPatchCacheInvalidationPaths({ patchText })) {
      invalidateForPath(p)
    }

    expect(getCached('Grep', { pattern: 'x', path: 'rel' })).toBeUndefined()
    expect(getCached('Grep', { pattern: 'y', path: absDir })).toBeUndefined()
  })
})

describe('stats', () => {
  test('counters reflect hits, misses and stored bytes', () => {
    expect(getStats()).toEqual({ hits: 0, misses: 0, evictions: 0, bytesStored: 0 })
    setCached('Glob', { pattern: 'x' }, { content: 'abcdef' })
    getCached('Glob', { pattern: 'x' })
    getCached('Glob', { pattern: 'never-set' })
    const s = getStats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.bytesStored).toBeGreaterThan(0)
  })
})
