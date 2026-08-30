import { describe, expect, test } from 'bun:test'

import type { GlobalConfig } from 'src/platform/config/config.js'
import {
  nextFavorites,
  readFavorites,
} from 'src/providers/favorites/favorites.js'

// Only the pure halves are exercised here. getFavorites/toggleFavorite read
// through config.js, which sibling suites mock.module — asserting on the real
// exports of that module is the documented cross-file leak.
function config(partial: Partial<GlobalConfig>): GlobalConfig {
  return partial as GlobalConfig
}

describe('nextFavorites', () => {
  test('appends an unstarred id to the end, keeping oldest-first order', () => {
    expect(nextFavorites(['opus', 'haiku'], 'sonnet')).toEqual([
      'opus',
      'haiku',
      'sonnet',
    ])
  })

  test('removes an already-starred id', () => {
    expect(nextFavorites(['opus', 'haiku'], 'opus')).toEqual(['haiku'])
  })

  test('does not mutate the input', () => {
    const current = ['opus']
    nextFavorites(current, 'haiku')
    expect(current).toEqual(['opus'])
  })
})

describe('readFavorites', () => {
  test('reads the model namespace', () => {
    expect(
      readFavorites(config({ favoriteModels: ['opus'] }), 'model'),
    ).toEqual(['opus'])
  })

  test('reads the provider-profile namespace', () => {
    expect(
      readFavorites(
        config({ favoriteProviderProfiles: ['abc123'] }),
        'providerProfile',
      ),
    ).toEqual(['abc123'])
  })

  test('namespaces do not bleed into each other', () => {
    expect(readFavorites(config({ favoriteModels: ['opus'] }), 'providerProfile')).toEqual([])
  })

  test('an absent key reads as empty', () => {
    expect(readFavorites(config({}), 'model')).toEqual([])
  })

  test('a hand-edited config that is not an array reads as empty', () => {
    expect(
      readFavorites(
        config({ favoriteModels: 'opus' as unknown as string[] }),
        'model',
      ),
    ).toEqual([])
  })

  test('non-string entries are dropped', () => {
    expect(
      readFavorites(
        config({ favoriteModels: ['opus', 7 as unknown as string] }),
        'model',
      ),
    ).toEqual(['opus'])
  })
})
