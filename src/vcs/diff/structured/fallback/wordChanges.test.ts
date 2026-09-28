import { describe, expect, test } from 'bun:test'
import { pairChangedLines, wordByWordSpans } from 'src/vcs/diff/structured/fallback/wordChanges.js'
import type { HunkLine, LineKind } from 'src/vcs/diff/structured/hunk/lines.js'

const line = (kind: LineKind): HunkLine => ({ kind, code: kind, number: kind === 'note' ? null : 1 })

const pair = (before: string, after: string) =>
  wordByWordSpans([
    { kind: 'removed', code: before, number: 1 },
    { kind: 'added', code: after, number: 1 },
  ])

describe('pairChangedLines', () => {
  test('pairs a run of removals with the additions right after it, in order; the leftovers stay single', () => {
    const lines = [line('removed'), line('removed'), line('removed'), line('added'), line('added')]
    expect(pairChangedLines(lines)).toEqual([
      [0, 3],
      [1, 4],
    ])
  })

  test('a context line between the two runs means no pairing', () => {
    expect(pairChangedLines([line('removed'), line('context'), line('added')])).toEqual([])
  })

  test('additions with no removal before them pair with nothing, and a later removal starts new runs', () => {
    const lines = [line('added'), line('removed'), line('added'), line('removed'), line('added')]
    expect(pairChangedLines(lines)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  test('a no-newline note between the runs does not keep them apart', () => {
    expect(pairChangedLines([line('removed'), line('note'), line('added'), line('note')])).toEqual([[0, 2]])
  })
})

describe('wordByWordSpans', () => {
  test('a pair that changed little is drawn word by word: kept words plain, and each side its changed words', () => {
    expect(pair('const value = computeThing(alpha);', 'const value = computeThing(beta);')).toEqual(
      new Map([
        [
          0,
          [
            { text: 'const value = computeThing(', tag: 'plain' },
            { text: 'alpha', tag: 'changed' },
            { text: ');', tag: 'plain' },
          ],
        ],
        [
          1,
          [
            { text: 'const value = computeThing(', tag: 'plain' },
            { text: 'beta', tag: 'changed' },
            { text: ');', tag: 'plain' },
          ],
        ],
      ]),
    )
  })

  test('exactly 40% changed is still word by word; just over it, both lines are drawn whole', () => {
    expect([...pair('let ab = oldval', 'let ab = newval').keys()]).toEqual([0, 1])
    expect(pair('let a = oldval', 'let a = newval').size).toBe(0)
  })

  test('whitespace and case are compared too', () => {
    expect(pair('let total = a  + b', 'let total = a + b').get(0)).toContainEqual({ text: '  ', tag: 'changed' })
    expect(pair('let Total = 1', 'let total = 1').get(1)).toContainEqual({ text: 'total', tag: 'changed' })
  })

  test('two empty lines compare without dividing by zero', () => {
    expect(pair('', '')).toEqual(
      new Map([
        [0, []],
        [1, []],
      ]),
    )
  })
})
