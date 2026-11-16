import { describe, expect, test } from 'bun:test'
import wrapAnsiNpm from 'wrap-ansi'
import { wrapAnsiNode } from 'src/terminal/ink/wrapAnsi.js'

// `wrapAnsi.ts` takes Bun.wrapAnsi when it exists and the npm package
// otherwise, so the bundle run under Node (`bin/claudin` → `dist/cli.mjs`)
// wraps with the npm one. The two must agree where Cursor depends on it:
// Cursor.ts looks every wrapped line up in the original text and throws when it
// is not there, which is how wrap-ansi 10 expanding a tab into spaces exited
// the session on Tab.
const OPTIONS = { hard: true, trim: false }

const CASES: Array<[label: string, input: string, columns: number]> = [
  ['a tab inside a short line', 'a\tb', 80],
  ['a tab before a hard wrap', 'x\tyyyyyyyyyy', 6],
  ['a leading tab', '\tindented', 20],
  ['a tab between words that wrap', 'foo\tbar baz\tqux', 10],
  ['consecutive tabs', 'a\t\tb\tc', 3],
  ['a tab on each of two lines', 'hello\tworld\nfoo\tbar', 7],
  ['a trailing tab', 'tab at end\t', 8],
  ['a tab inside a coloured run', '\u001B[31mred\tred\tred\u001B[39m tail\ttail', 5],
  ['a tab beside wide characters', '日本\t語のテキスト', 5],
  ['plain words wrapping', 'the quick brown fox jumps over the lazy dog', 10],
  ['a coloured word wrapping', '\u001B[31mredredredred\u001B[39m tail', 5],
  ['wide characters', '日本語のテキスト', 5],
]

describe('the npm wrap-ansi wraps like Bun.wrapAnsi', () => {
  for (const [label, input, columns] of CASES) {
    test(label, () => {
      expect(wrapAnsiNode(input, columns, OPTIONS)).toBe(
        Bun.wrapAnsi(input, columns, OPTIONS),
      )
    })
  }
})

describe('wrapAnsiNode keeps every line a piece of the original', () => {
  // The contract Cursor.measureWrappedText relies on, for inputs it can get.
  const walk = (input: string, columns: number): boolean => {
    let from = 0
    for (const line of wrapAnsiNode(input, columns, OPTIONS).split('\n')) {
      const at = input.indexOf(line, from)
      if (at === -1) return false
      from = at + line.length
    }
    return true
  }

  for (const columns of [1, 2, 3, 5, 8, 13, 80]) {
    test(`tabs, spaces and newlines at ${columns} columns`, () => {
      expect(walk('\tone\ttwo  three\n\t\tfour\tfive six\t', columns)).toBe(true)
      expect(walk('a\tb\tc\td\te\tf\tg\th', columns)).toBe(true)
    })
  }

  test('wrap-ansi itself still expands a tab, which is why the wrapper exists', () => {
    // When this goes red wrap-ansi grew a way to keep the tab: drop the
    // sentinel in wrapAnsi.ts and use the option instead.
    expect(wrapAnsiNpm('a\tb', 80, OPTIONS)).toBe('a       b')
  })

  test('an input that already holds a sentinel keeps it and keeps its tab', () => {
    const input = 'a\u2060b\tc\u0001d\te'
    expect(wrapAnsiNode(input, 80, OPTIONS)).toBe(
      Bun.wrapAnsi(input, 80, OPTIONS),
    )
    expect(wrapAnsiNode(input, 80, OPTIONS)).toBe(input)
  })
})
