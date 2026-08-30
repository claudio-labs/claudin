import { describe, expect, test } from 'bun:test'

import {
  FAVORITE_PREFIX,
  filterOptions,
  matchesQuery,
  sortFavoritesFirst,
  starLabel,
} from 'src/terminal/custom-select/favoritesFilter.js'

const OPTIONS = [
  { value: 'opus', label: 'Opus 5', description: 'Most capable' },
  { value: 'sonnet', label: 'Sonnet 5', description: 'Balanced default' },
  { value: 'haiku', label: 'Haiku 4.5', description: 'Fast and cheap' },
  { value: 'kimi', label: 'Kimi K2', description: 'Moonshot coding plan' },
]

describe('matchesQuery', () => {
  test('matches the label case-insensitively', () => {
    expect(matchesQuery(OPTIONS[0]!, 'OPUS')).toBe(true)
  })

  test('matches the description too, so "cheap" finds Haiku', () => {
    expect(matchesQuery(OPTIONS[2]!, 'cheap')).toBe(true)
  })

  test('an empty query matches everything', () => {
    expect(matchesQuery(OPTIONS[0]!, '')).toBe(true)
  })

  test('a non-string label contributes no text instead of being stringified', () => {
    const option = { label: { type: 'div' } as unknown as string, description: 'x' }
    expect(matchesQuery(option, 'div')).toBe(false)
    expect(matchesQuery(option, 'x')).toBe(true)
  })
})

describe('filterOptions', () => {
  test('keeps only matching rows, in the original order', () => {
    expect(filterOptions(OPTIONS, 'k').map(o => o.value)).toEqual([
      'haiku',
      'kimi',
    ])
  })

  test('returns the same array reference for an empty query', () => {
    expect(filterOptions(OPTIONS, '')).toBe(OPTIONS)
  })
})

describe('sortFavoritesFirst', () => {
  test('pins favorites to the top and keeps both halves stable', () => {
    const result = sortFavoritesFirst(OPTIONS, o =>
      o.value === 'haiku' || o.value === 'kimi',
    )
    expect(result.map(o => o.value)).toEqual([
      'haiku',
      'kimi',
      'opus',
      'sonnet',
    ])
  })

  test('returns the same array reference when nothing is starred', () => {
    expect(sortFavoritesFirst(OPTIONS, () => false)).toBe(OPTIONS)
  })

  test('returns the same array reference when everything is starred', () => {
    expect(sortFavoritesFirst(OPTIONS, () => true)).toBe(OPTIONS)
  })
})

describe('starLabel', () => {
  test('prefixes a starred string label', () => {
    expect(starLabel('Opus 5', true)).toBe(`${FAVORITE_PREFIX}Opus 5`)
  })

  test('leaves an unstarred label untouched', () => {
    expect(starLabel('Opus 5', false)).toBe('Opus 5')
  })

  test('leaves a non-string label untouched even when starred', () => {
    const node = { type: 'div' } as unknown as string
    expect(starLabel(node, true)).toBe(node)
  })

  test('the prefix keeps a query matchable by plain indexOf, which is what Select highlightText uses', () => {
    const starred = starLabel('Haiku 4.5', true) as string
    expect(starred.indexOf('Haiku')).toBeGreaterThan(-1)
  })
})
