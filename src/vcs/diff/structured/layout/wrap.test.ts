import { describe, expect, test } from 'bun:test'
import { cellsOf, digitCount, effectiveWidth } from 'src/vcs/diff/structured/layout/width.js'
import { type Span, wrapSpans } from 'src/vcs/diff/structured/layout/wrap.js'

type Emphasis = 'plain' | 'changed'

const plain = (text: string): Span<Emphasis>[] => [{ text, tag: 'plain' }]
const rowTexts = (text: string, width: number): string[] =>
  wrapSpans(plain(text), width).map(row => row.spans.map(span => span.text).join(''))

describe('effectiveWidth and digitCount', () => {
  test('a width is rounded down, and anything under one column is one', () => {
    expect([40.9, 40, 1, 0.5, 0, -7, Number.NaN].map(effectiveWidth)).toEqual([40, 40, 1, 1, 1, 1, 1])
  })

  test('a line number prints with as many digits as it has', () => {
    expect([0, 9, 10, 99, 101].map(digitCount)).toEqual([1, 1, 2, 2, 3])
  })
})

describe('cellsOf', () => {
  test('a wide character takes two columns, and an emoji with its modifier stays one cell', () => {
    expect(cellsOf('a日👋🏽')).toEqual([
      { text: 'a', columns: 1 },
      { text: '日', columns: 2 },
      { text: '👋🏽', columns: 2 },
    ])
  })
})

describe('wrapSpans', () => {
  test('text that fits stays on one row', () => {
    expect(wrapSpans(plain('let a = 1'), 9)).toEqual([{ spans: [{ text: 'let a = 1', tag: 'plain' }], columns: 9 }])
  })

  test('breaks at spaces, each row taking as many words as fit', () => {
    expect(rowTexts('the quick brown fox jumps', 10)).toEqual(['the quick ', 'brown fox ', 'jumps'])
  })

  test('a word that ends exactly at the edge stays on the row', () => {
    expect(rowTexts('abcdefgh ijklmno pq', 16)).toEqual(['abcdefgh ijklmno', 'pq'])
  })

  test('the spaces at a break that no longer fit are dropped, and never make a row of their own', () => {
    expect(rowTexts('aaaa     bbbb', 6)).toEqual(['aaaa  ', 'bbbb'])
    expect(rowTexts('foo      ', 4)).toEqual(['foo '])
  })

  test('a word wider than a row is broken where it meets the edge', () => {
    expect(rowTexts('ab verylongword', 6)).toEqual(['ab ver', 'ylongw', 'ord'])
  })

  test('wide characters count for their columns, and one wider than the row gets a row of its own', () => {
    expect(rowTexts('日本語テキスト', 5)).toEqual(['日本', '語テ', 'キス', 'ト'])
    expect(rowTexts('日本', 1)).toEqual(['日', '本'])
  })

  test('at one column every character has a row of its own', () => {
    expect(rowTexts('abc', 1)).toEqual(['a', 'b', 'c'])
  })

  test('an empty line is one empty row', () => {
    expect(wrapSpans(plain(''), 10)).toEqual([{ spans: [], columns: 0 }])
  })

  test('a change of tag inside a word is no place to break, and every piece keeps its tag', () => {
    const spans: Span<Emphasis>[] = [
      { text: 'let value = compute(', tag: 'plain' },
      { text: 'alpha', tag: 'changed' },
      { text: ') + 1', tag: 'plain' },
    ]
    expect(wrapSpans(spans, 20)).toEqual([
      { spans: [{ text: 'let value = ', tag: 'plain' }], columns: 12 },
      {
        spans: [
          { text: 'compute(', tag: 'plain' },
          { text: 'alpha', tag: 'changed' },
          { text: ') + 1', tag: 'plain' },
        ],
        columns: 18,
      },
    ])
  })

  test('a tagged word broken at the edge keeps its tag on both rows', () => {
    const spans: Span<Emphasis>[] = [
      { text: 'x = ', tag: 'plain' },
      { text: 'abcdefghij', tag: 'changed' },
    ]
    expect(wrapSpans(spans, 8)).toEqual([
      {
        spans: [
          { text: 'x = ', tag: 'plain' },
          { text: 'abcd', tag: 'changed' },
        ],
        columns: 8,
      },
      { spans: [{ text: 'efghij', tag: 'changed' }], columns: 6 },
    ])
  })
})
