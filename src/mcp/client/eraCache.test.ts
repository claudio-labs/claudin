import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscoverResult } from '@modelcontextprotocol/client'
import {
  dropEraVerdict,
  getEraCacheKey,
  readEraVerdict,
  saveEraVerdict,
  setEraCacheDirForTests,
} from 'src/mcp/client/eraCache.js'
import type { EraVerdict } from 'src/mcp/client/negotiation.js'
import type { McpServerConfig } from 'src/mcp/types.js'

let dir = ''
const file = () => join(dir, 'mcp-era-cache.json')
const legacy = (ttlMs = 60_000): EraVerdict => ({ kind: 'legacy', savedAt: Date.now(), ttlMs })
const modern: EraVerdict = {
  kind: 'modern',
  discover: { supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: true } }, ttlMs: 0 } as DiscoverResult,
  savedAt: Date.now(),
  ttlMs: 60_000,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'era-cache-'))
  setEraCacheDirForTests(dir)
})

afterEach(() => {
  setEraCacheDirForTests(undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('getEraCacheKey', () => {
  const http: McpServerConfig = { type: 'http', url: 'https://a.example/mcp', headers: { 'X-K': '1' } }
  const stdio: McpServerConfig = { command: 'srv', args: ['--x'], env: { A: '1' }, cwd: 'sub' }

  test('the name and a hash of the fields that decide who answers', () => {
    expect(getEraCacheKey('srv', http)).toMatch(/^srv\|[0-9a-f]{16}$/)
    expect(getEraCacheKey('srv', http)).toBe(getEraCacheKey('srv', { ...http }))
    expect(getEraCacheKey('srv', stdio)).toBe(getEraCacheKey('srv', { ...stdio, type: 'stdio' }))
  })

  test('changes with any of them, and with the name', () => {
    const base = getEraCacheKey('srv', http)
    expect(getEraCacheKey('other', http)).not.toBe(base)
    expect(getEraCacheKey('srv', { ...http, url: 'https://b.example/mcp' })).not.toBe(base)
    expect(getEraCacheKey('srv', { ...http, headers: { 'X-K': '2' } })).not.toBe(base)
    const local = getEraCacheKey('srv', stdio)
    for (const changed of [
      { ...stdio, command: 'srv2' },
      { ...stdio, args: ['--y'] },
      { ...stdio, env: { A: '2' } },
      { ...stdio, cwd: 'elsewhere' },
    ]) {
      expect(getEraCacheKey('srv', changed)).not.toBe(local)
    }
  })

  test('ignores the fields that do not change the server, the protocol switch included', () => {
    expect(getEraCacheKey('srv', { ...http, startupTimeout: 1000, protocol: 'legacy' })).toBe(getEraCacheKey('srv', http))
  })
})

describe('read, save, drop', () => {
  test('a saved verdict reads back, and survives a JSON round trip', async () => {
    await saveEraVerdict('a', modern)
    await saveEraVerdict('b', legacy())
    expect(await readEraVerdict('a')).toEqual(modern)
    expect((await readEraVerdict('b'))?.kind).toBe('legacy')
    expect(await readEraVerdict('missing')).toBeUndefined()
  })

  test('drop removes one entry', async () => {
    await saveEraVerdict('a', modern)
    await saveEraVerdict('b', legacy())
    await dropEraVerdict('a')
    expect(await readEraVerdict('a')).toBeUndefined()
    expect(await readEraVerdict('b')).toBeDefined()
  })

  test('concurrent saves keep each other, and leave no temp file', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => saveEraVerdict(`k${i}`, legacy())))
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8'))).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `k${i}`).sort(),
    )
    expect(readdirSync(dir)).toEqual(['mcp-era-cache.json'])
  })

  test('a write drops expired entries', async () => {
    await saveEraVerdict('old', { kind: 'legacy', savedAt: Date.now() - 10_000, ttlMs: 1000 })
    await saveEraVerdict('new', legacy())
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')))).toEqual(['new'])
  })

  test('a corrupt file or entry is ignored, not trusted', async () => {
    writeFileSync(file(), '{not json')
    expect(await readEraVerdict('a')).toBeUndefined()
    writeFileSync(file(), '[1,2]')
    expect(await readEraVerdict('a')).toBeUndefined()
    writeFileSync(
      file(),
      JSON.stringify({ a: { kind: 'modern', savedAt: 1 }, b: { kind: 'legacy', savedAt: Date.now(), ttlMs: 5 } }),
    )
    expect(await readEraVerdict('a')).toBeUndefined()
    expect(await readEraVerdict('b')).toMatchObject({ kind: 'legacy' })
  })

  test('a failed write is logged, and the next one still works', async () => {
    // A directory where the cache file should be makes the rename fail.
    rmSync(dir, { recursive: true, force: true })
    const blocked = join(dir, 'mcp-era-cache.json')
    await import('node:fs').then(fs => fs.mkdirSync(blocked, { recursive: true }))
    await saveEraVerdict('a', legacy())
    expect(readdirSync(dir)).toEqual(['mcp-era-cache.json'])
    rmSync(blocked, { recursive: true, force: true })
    await saveEraVerdict('a', legacy())
    expect(await readEraVerdict('a')).toBeDefined()
  })
})

describe('under bun test with no directory set', () => {
  test('reads nothing and writes nothing', async () => {
    setEraCacheDirForTests(undefined)
    await saveEraVerdict('a', legacy())
    expect(await readEraVerdict('a')).toBeUndefined()
    await dropEraVerdict('a')
    expect(existsSync(file())).toBe(false)
  })
})
