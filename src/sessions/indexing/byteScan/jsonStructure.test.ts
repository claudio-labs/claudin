import { describe, expect, test } from 'bun:test'

import {
  firstTopLevelMember,
  occurrences,
  stringEnd,
} from 'src/sessions/indexing/byteScan/jsonStructure.js'

describe('stringEnd', () => {
  test.each([
    { text: '"plain" rest', close: 6 },
    { text: '"a \\" quote" rest', close: 11 },
    { text: '"ends in C:\\\\" rest', close: 13 },
    { text: '"three \\\\\\" then" x', close: 16 },
    { text: '"never closed', close: -1 },
  ])('$text closes at $close', ({ text, close }) => {
    const buf = Buffer.from(text)
    expect(stringEnd(buf, 0, buf.length)).toBe(close)
  })

  test('a quote at or past the end does not count', () => {
    const buf = Buffer.from('"abc"')
    expect(stringEnd(buf, 0, 4)).toBe(-1)
  })
})

describe('occurrences', () => {
  test('finds overlapping hits inside the range only', () => {
    const buf = Buffer.from('aaXaaaXaa')
    expect(occurrences(buf, Buffer.from('aa'), 2, 7)).toEqual([3, 4])
  })
})

describe('firstTopLevelMember', () => {
  const at = (line: string, member: string) => {
    const buf = Buffer.from(line)
    return firstTopLevelMember(buf, 0, occurrences(buf, Buffer.from(member), 0, buf.length))
  }

  test.each([
    { line: '{"a":{"k":1},"k":2}', expected: 13 },
    { line: '{"a":[{"k":1}],"k":2}', expected: 15 },
    { line: '{"a":"{{[","k":2}', expected: 11 },
    { line: '{"a":{"k":1}}', expected: -1 },
    { line: '{"a":1}', expected: -1 },
  ])('$line: $expected', ({ line, expected }) => {
    expect(at(line, '"k":')).toBe(expected)
  })

  test('a line that starts at an offset is walked from there', () => {
    const buf = Buffer.from('{"x":{\n{"k":1}')
    expect(firstTopLevelMember(buf, 7, [8])).toBe(8)
  })
})
