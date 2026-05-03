import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, readdir, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { gcV8Cache } from './v8cache-gc.mjs'

let cacheDir

beforeEach(async () => {
  cacheDir = join(tmpdir(), `v8cache-gc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(cacheDir, { recursive: true })
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

async function makeEntry(relPath, ageDays) {
  const full = join(cacheDir, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, 'x'.repeat(100))
  if (ageDays != null) {
    const t = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000
    await utimes(full, t, t)
  }
  return full
}

describe('gcV8Cache', () => {
  it('removes entries older than ttlDays', async () => {
    await makeEntry('v25-x64-aaa-1000/old1', 30)
    await makeEntry('v25-x64-aaa-1000/old2', 20)
    await makeEntry('v25-x64-aaa-1000/fresh', 1)

    const stats = await gcV8Cache(cacheDir, { ttlDays: 14 })

    expect(stats.removedFiles).toBe(2)
    expect(stats.errors).toBe(0)
    expect(stats.removedBytes).toBe(200)
    const remaining = await readdir(join(cacheDir, 'v25-x64-aaa-1000'))
    expect(remaining).toEqual(['fresh'])
  })

  it('removes empty fingerprint subdirs after sweeping', async () => {
    await makeEntry('v25-x64-old-1000/a', 30)
    await makeEntry('v25-x64-old-1000/b', 30)
    await makeEntry('v25-x64-new-1000/c', 1)

    const stats = await gcV8Cache(cacheDir, { ttlDays: 14 })

    expect(stats.removedFiles).toBe(2)
    expect(stats.removedDirs).toBe(1)
    const top = await readdir(cacheDir)
    expect(top).toEqual(['v25-x64-new-1000'])
  })

  it('preserves all entries when ttlDays exceeds entry age', async () => {
    await makeEntry('v25-x64-aaa-1000/x', 5)
    await makeEntry('v25-x64-aaa-1000/y', 10)

    const stats = await gcV8Cache(cacheDir, { ttlDays: 30 })

    expect(stats.removedFiles).toBe(0)
    expect(stats.removedDirs).toBe(0)
  })

  it('returns zero stats when cache dir is missing', async () => {
    const missing = join(cacheDir, 'does-not-exist')
    const stats = await gcV8Cache(missing, { ttlDays: 14 })
    expect(stats).toEqual({ removedFiles: 0, removedDirs: 0, removedBytes: 0, errors: 0 })
  })

  it('respects injected `now` for deterministic cutoff', async () => {
    await makeEntry('v25-x64-aaa-1000/borderline', 14)
    const future = Date.now() + 24 * 60 * 60 * 1000 // +1 day
    const stats = await gcV8Cache(cacheDir, { ttlDays: 14, now: future })
    expect(stats.removedFiles).toBe(1)
  })

  it('handles stray files at root respecting TTL', async () => {
    await makeEntry('stray-old', 30)
    await makeEntry('stray-fresh', 1)

    const stats = await gcV8Cache(cacheDir, { ttlDays: 14 })

    expect(stats.removedFiles).toBe(1)
    const top = await readdir(cacheDir)
    expect(top.sort()).toEqual(['stray-fresh'])
  })
})
