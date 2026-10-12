import { describe, expect, test } from 'bun:test'
import { describeDivergence, excerpt } from 'src/tools/shared/blockMismatch.js'

const FILE = ['import a', 'import b', 'import c']

describe('describeDivergence', () => {
  test('names the line of the block that diverges and the file line there, for the noun given', () => {
    expect(describeDivergence(FILE, ['import a', 'import c'], 0, 'old_string')).toBe(
      'line(s) 1-1 of your old_string match starting at line 1, then line 2 diverges.\n' +
        '  your line 2: import c\n' +
        '  file line 2: import b\n' +
        'Re-read that region and copy every line in between — a dropped intervening line is the usual cause.',
    )
  })

  test('null when not even the first line is in the file', () => {
    expect(describeDivergence(FILE, ['nope', 'import a'], 0, 'hunk')).toBeNull()
  })

  test('null when nothing diverges: the block matches once punctuation is normalized', () => {
    // An en dash in the file, a hyphen in the block: only the loosest pass
    // matches, so there is no line to point at.
    expect(describeDivergence(['a \u2013 b'], ['a - b'], 0, 'old_string')).toBeNull()
  })

  test('only looks at or after the search start', () => {
    expect(describeDivergence(FILE, ['import a', 'x'], 1, 'hunk')).toBeNull()
  })
})

describe('excerpt', () => {
  test('cuts a line past 200 chars and marks the cut', () => {
    expect(excerpt('x'.repeat(201))).toBe(`${'x'.repeat(200)}\u2026`)
    expect(excerpt('short')).toBe('short')
  })
})
