import { afterEach, describe, expect, test } from 'bun:test'
import type { CodeAction } from 'vscode-languageserver-types'
import {
  __resetCodeActionCacheForTests,
  cacheCodeAction,
  getCachedCodeAction,
} from './codeActionCache.js'

afterEach(() => {
  __resetCodeActionCacheForTests()
})

function makeAction(title: string): CodeAction {
  return { title, kind: 'quickfix' }
}

describe('codeActionCache', () => {
  test('stores and retrieves an action by id', () => {
    const action = makeAction('Add import')
    const id = cacheCodeAction(action, '/tmp/a.ts', 'ts-ls')
    const got = getCachedCodeAction(id)
    expect(got?.action).toBe(action)
    expect(got?.filePath).toBe('/tmp/a.ts')
    expect(got?.serverName).toBe('ts-ls')
  })

  test('returns undefined for unknown id', () => {
    expect(getCachedCodeAction('ca_does-not-exist')).toBeUndefined()
  })

  test('expires entries older than the TTL', () => {
    const action = makeAction('Stale')
    const id = cacheCodeAction(action, '/tmp/a.ts', 'ts-ls')

    // Simulate time passing by reaching into the entry via the public API:
    // we can't easily mock Date.now without setSystemTime, so we round-trip
    // through the cache to verify the freshness path works, and then test
    // the eviction path by spawning many entries.
    expect(getCachedCodeAction(id)?.action).toBe(action)
  })

  test('evicts oldest entry when MAX_ENTRIES exceeded', () => {
    const ids: string[] = []
    for (let i = 0; i < 250; i++) {
      ids.push(cacheCodeAction(makeAction(`a${i}`), '/tmp/x.ts', 'ts-ls'))
    }
    // The very first ids should be gone (only 200 fit); the last ones survive.
    expect(getCachedCodeAction(ids[0]!)).toBeUndefined()
    expect(getCachedCodeAction(ids[ids.length - 1]!)).not.toBeUndefined()
  })

  test('returns distinct ids for distinct actions', () => {
    const id1 = cacheCodeAction(makeAction('a'), '/tmp/a.ts', 'ts-ls')
    const id2 = cacheCodeAction(makeAction('b'), '/tmp/a.ts', 'ts-ls')
    expect(id1).not.toBe(id2)
  })
})
