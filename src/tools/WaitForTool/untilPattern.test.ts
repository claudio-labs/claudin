import { describe, expect, test } from 'bun:test'
import { compileUntil, untilMatches } from 'src/tools/WaitForTool/untilPattern.js'

describe('compileUntil', () => {
  test('anchors lines by default', () => {
    expect(compileUntil('^exit \\d+').flags).toBe('m')
    expect(compileUntil('stream ended[\\s\\S]*❯\\s*$').flags).toBe('m')
  })

  test('a ^ that opens a lookaround keeps the whole output', () => {
    expect(compileUntil('^(?![\\s\\S]*(Clauding|esc to interrupt))[\\s\\S]*$').flags).toBe('')
    expect(compileUntil('(?s)^(?=.*A=completed)(?=.*B=completed)').flags).toBe('s')
    expect(compileUntil('checks: ^(?!.*pending)').flags).toBe('')
  })

  test('an empty-output test keeps the whole output', () => {
    expect(compileUntil('^$').flags).toBe('')
    expect(compileUntil('^\\s*$').flags).toBe('')
    expect(compileUntil('^$|done').flags).toBe('m')
  })

  test('a leading flag group becomes flags, m once', () => {
    expect(compileUntil('(?i)ready').flags).toBe('im')
    expect(compileUntil('(?im)ready').flags).toBe('im')
    expect(compileUntil('(?m)^ready').source).toBe('^ready')
  })

  test('what JavaScript cannot compile still throws', () => {
    expect(() => compileUntil('(')).toThrow(SyntaxError)
    expect(() => compileUntil('(?x) READY # spaced')).toThrow(SyntaxError)
  })
})

describe('untilMatches', () => {
  const matches = (until: string, output: string) => untilMatches(compileUntil(until), output)

  test('a line anywhere in the output', () => {
    expect(matches('^exit \\d+', 'Ran 19315 tests across 1248 files. [421.18s]\nexit 0\n')).toBe(true)
    expect(matches('^(200|30\\d|401)$', '200\nlog line\n')).toBe(true)
  })

  test('$ at the end of the last line, past trailing newlines of either kind', () => {
    expect(matches('READY$', 'READY\n')).toBe(true)
    expect(matches('READY$', 'READY\r\n\n')).toBe(true)
  })

  test('the whole-output shapes read as before', () => {
    const notBusy = '^(?![\\s\\S]*(Clauding|esc to interrupt))[\\s\\S]*$'
    expect(matches(notBusy, 'Clauding… (esc to interrupt)\nmore\nlast\n')).toBe(false)
    expect(matches(notBusy, 'done\nmore\n')).toBe(true)
    expect(matches('^$', '123\n\n456\n')).toBe(false)
    expect(matches('^$', '\n')).toBe(true)
  })

  test('a compiled pattern carries no state between polls', () => {
    const until = compileUntil('^ok$')
    expect([untilMatches(until, 'ok\n'), untilMatches(until, 'ok\n')]).toEqual([true, true])
  })
})
