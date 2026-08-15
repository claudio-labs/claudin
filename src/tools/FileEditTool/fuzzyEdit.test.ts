import { describe, expect, test } from 'bun:test'
import { resolveFuzzyEdit } from 'src/tools/FileEditTool/utils.js'

describe('resolveFuzzyEdit', () => {
  test('matches despite trailing whitespace drift', () => {
    // File line carries trailing whitespace the model did not include.
    const file = 'const a = 1   \nconst b = 2\n'
    const res = resolveFuzzyEdit(file, 'const a = 1', 'const a = 42')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    // Real file bytes (with the trailing spaces) so a literal replace works.
    expect(res.matchedOldString).toBe('const a = 1   ')
    expect(file.includes(res.matchedOldString)).toBe(true)
    expect(res.adjustedNewString).toBe('const a = 42')
  })

  test('matches tab↔space leading-indent drift and re-indents new_string', () => {
    // File is tab-indented; old_string uses two spaces.
    const file = 'function f() {\n\treturn 1\n}\n'
    const res = resolveFuzzyEdit(file, '  return 1', '  return 2')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    expect(res.matchedOldString).toBe('\treturn 1')
    // new_string re-indented from 2-space frame to the file's tab.
    expect(res.adjustedNewString).toBe('\treturn 2')
  })

  test('preserves relative indentation across a multi-line block', () => {
    const file = ['function f() {', '\tif (x) {', '\t\tg()', '\t}', '}'].join(
      '\n',
    )
    const oldStr = ['  if (x) {', '    g()', '  }'].join('\n')
    const newStr = ['  if (x) {', '    h()', '    k()', '  }'].join('\n')
    const res = resolveFuzzyEdit(file, oldStr, newStr)
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    expect(res.matchedOldString).toBe(['\tif (x) {', '\t\tg()', '\t}'].join('\n'))
    // The assumed base indent ('  ') is swapped for the file's ('\t') on every
    // line; nested relative indentation keeps its original units after the base.
    expect(res.adjustedNewString).toBe(
      ['\tif (x) {', '\t  h()', '\t  k()', '\t}'].join('\n'),
    )
  })

  test('prepends file indent when the model assumed no indent', () => {
    const file = 'obj = {\n    key: 1,\n}\n'
    const res = resolveFuzzyEdit(file, 'key: 1,', 'key: 2,')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    expect(res.matchedOldString).toBe('    key: 1,')
    expect(res.adjustedNewString).toBe('    key: 2,')
  })

  test('reports ambiguity instead of guessing', () => {
    // Two lines match once trailing whitespace is ignored.
    const file = 'x = 1  \ny = 0\nx = 1\n'
    const res = resolveFuzzyEdit(file, 'x = 1', 'x = 9')
    expect(res.kind).toBe('ambiguous')
    if (res.kind !== 'ambiguous') return
    expect(res.count).toBe(2)
  })

  test('returns real CRLF bytes for a CRLF file', () => {
    const file = 'a = 1\r\n  b = 2\r\nc = 3\r\n'
    // old_string with LF + different indent; file uses CRLF and 4 spaces.
    const res = resolveFuzzyEdit(file, 'b = 2', 'b = 22')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    expect(res.matchedOldString).toBe('  b = 2\r')
    expect(file.includes(res.matchedOldString)).toBe(true)
  })

  test('honors a trailing newline in old_string', () => {
    const file = 'foo\n  bar\nbaz\n'
    const res = resolveFuzzyEdit(file, 'bar\n', 'BAR\n')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    expect(res.matchedOldString).toBe('  bar\n')
    expect(file.includes(res.matchedOldString)).toBe(true)
  })

  test('leaves markdown hard-break trailing spaces intact in new_string', () => {
    const file = '# Title\n\tline one\n'
    const res = resolveFuzzyEdit(file, '  line one', '  line one  ')
    expect(res.kind).toBe('match')
    if (res.kind !== 'match') return
    // Re-indent only touches the leading prefix, never trailing whitespace.
    expect(res.adjustedNewString).toBe('\tline one  ')
  })

  test('bails when the matched line bytes recur mid-line elsewhere', () => {
    // The line "ab" matches uniquely line-based, but its bytes also occur inside
    // "xaby". A bare substring replace/count would be wrong, so degrade to none
    // (→ "not found") instead of a false-ambiguous or wrong-location edit.
    const file = 'xaby\nab\ndone\n'
    expect(resolveFuzzyEdit(file, 'ab ', 'CD').kind).toBe('none')
  })

  test('skips the empty old_string (file-creation path)', () => {
    expect(resolveFuzzyEdit('anything\n', '', 'new').kind).toBe('none')
  })

  test('returns none when nothing matches even loosely', () => {
    expect(resolveFuzzyEdit('a\nb\nc\n', 'zzz', 'q').kind).toBe('none')
  })
})
