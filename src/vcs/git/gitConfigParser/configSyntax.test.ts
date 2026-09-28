import { describe, expect, test } from 'bun:test'
import { type ConfigKey, findConfigValue } from 'src/vcs/git/gitConfigParser/configSyntax.js'

const ORIGIN_URL: ConfigKey = { section: 'remote', subsection: 'origin', key: 'url' }
const HOOKS_PATH: ConfigKey = { section: 'core', subsection: null, key: 'hooksPath' }

function underOrigin(...lines: string[]): string {
  return `[remote "origin"]\n${lines.map(line => `\t${line}\n`).join('')}`
}

describe('F6: escapes outside quotes are decoded as inside them', () => {
  test.each([
    ['an escaped quote, as git writes x"y', 'url = x\\"y', 'x"y'],
    ['tab, newline and backspace', 'url = a\\tb\\nc\\bd', 'a\tb\nc\bd'],
    ['an escaped backslash', 'url = C:\\\\x', 'C:\\x'],
    ['an unknown escape stands for its character', 'url = a\\qb', 'aqb'],
  ])('%s', (_label, line, expected) => {
    expect(findConfigValue(underOrigin(line), ORIGIN_URL)).toBe(expected)
  })
})

describe('F7: blanks inside quotes are kept, at the end of a quoted part too', () => {
  test.each([
    ['trailing blanks inside quotes', 'url = "abc  "', 'abc  '],
    ['leading blanks inside quotes', 'url = "  abc"', '  abc'],
    ['a quoted part then more text', 'url = "a  " b', 'a   b'],
    ['unquoted trailing blanks still go', 'url = abc  ', 'abc'],
  ])('%s', (_label, line, expected) => {
    expect(findConfigValue(underOrigin(line), ORIGIN_URL)).toBe(expected)
  })
})

describe('F8: a backslash at the end of a line continues the value', () => {
  test.each([
    ['unquoted', '[remote "origin"]\n\turl = abc\\\ndef\n', 'abcdef'],
    ['quoted', '[remote "origin"]\n\turl = "abc\\\ndef"\n', 'abcdef'],
    ['with CRLF line ends', '[remote "origin"]\r\n\turl = abc\\\r\ndef\r\n', 'abcdef'],
    ['keeping the blanks that start the next line', '[remote "origin"]\n\turl = abc\\\n  def\n', 'abc  def'],
    ['at the very end of the file', '[remote "origin"]\n\turl = abc\\', 'abc'],
  ])('%s', (_label, text, expected) => {
    expect(findConfigValue(text, ORIGIN_URL)).toBe(expected)
  })

  test('a comment ends the value even after a continuation', () => {
    expect(findConfigValue('[remote "origin"]\n\turl = a\\\n# b\n', ORIGIN_URL)).toBe('a')
  })
})

describe('F9: the old [section.subsection] header', () => {
  test('is read, with the subsection in lower case', () => {
    expect(findConfigValue('[remote.origin]\n\turl = x\n', ORIGIN_URL)).toBe('x')
    expect(findConfigValue('[Remote.Origin]\n\turl = x\n', ORIGIN_URL)).toBe('x')
    expect(findConfigValue('[remote.Origin]\n\turl = x\n', { ...ORIGIN_URL, subsection: 'Origin' })).toBeNull()
  })

  test('a plain section name has no subsection', () => {
    expect(findConfigValue('[core]\n\thooksPath = /h\n', HOOKS_PATH)).toBe('/h')
  })
})

describe("F10: a key on its section's header line", () => {
  test.each([
    ['after a blank', '[core] hooksPath = /x\n'],
    ['with no blank', '[core]hooksPath = /x\n'],
    ['after a subsection header', '[remote "origin"] url = /x\n'],
  ])('is read %s', (label, text) => {
    const wanted = label.includes('subsection') ? ORIGIN_URL : HOOKS_PATH
    expect(findConfigValue(text, wanted)).toBe('/x')
  })
})

describe('lenient where git refuses the file', () => {
  test('a bad header never swallows the line after it', () => {
    expect(findConfigValue('[remote "origin"\n[core]\n\thooksPath = /h\n', HOOKS_PATH)).toBe('/h')
    expect(findConfigValue('[remote \n[core]\n\thooksPath = /h\n', HOOKS_PATH)).toBe('/h')
  })

  test('keys under a header that could not be read match nothing', () => {
    expect(findConfigValue('[remote "origin" ]\n\turl = x\n', ORIGIN_URL)).toBeNull()
    expect(findConfigValue('[]\n\turl = x\n', ORIGIN_URL)).toBeNull()
    expect(findConfigValue('url = x\n', ORIGIN_URL)).toBeNull()
  })

  test('a key followed by something other than = or the line end is skipped', () => {
    expect(findConfigValue(underOrigin('url # x', 'url x', 'url = y'), ORIGIN_URL)).toBe('y')
  })
})
