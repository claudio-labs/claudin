import { describe, expect, test } from 'bun:test'
import wrapAnsiNpm from 'wrap-ansi'

// `wrapAnsi.ts` takes Bun.wrapAnsi when it exists and the npm package
// otherwise, so the bundle run under Node (`bin/claudin` → `dist/cli.mjs`)
// wraps with the npm one. The two must agree: Cursor.ts looks every wrapped
// line up in the original text and throws when it is not there, which is how
// wrap-ansi 10 expanding a tab into spaces exited the session on Tab.
const CASES: Array<[label: string, input: string, columns: number]> = [
  ['a tab inside a short line', 'a\tb', 80],
  ['a tab before a hard wrap', 'x\tyyyyyyyyyy', 6],
  ['a leading tab', '\tindented', 20],
  ['plain words wrapping', 'the quick brown fox jumps over the lazy dog', 10],
  ['a coloured word wrapping', '\u001B[31mredredredred\u001B[39m tail', 5],
  ['wide characters', '日本語のテキスト', 5],
]

describe('the npm wrap-ansi wraps like Bun.wrapAnsi', () => {
  for (const [label, input, columns] of CASES) {
    test(label, () => {
      const options = { hard: true, trim: false }
      expect(wrapAnsiNpm(input, columns, options)).toBe(
        Bun.wrapAnsi(input, columns, options),
      )
    })
  }
})
