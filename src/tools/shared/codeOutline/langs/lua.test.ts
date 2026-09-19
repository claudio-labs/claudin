import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — Lua', () => {
  test('named, table, colon, and assigned functions with nested blocks', () => {
    const src = [
      'local M = {}',
      '',
      'function M.new(x)',
      '  return setmetatable({}, M)',
      'end',
      '',
      'function greet(name)',
      '  if name then',
      '    return "hi"',
      '  end',
      'end',
      '',
      'local adder = function(a, b)',
      '  return a + b',
      'end',
      '',
      'function M:run()',
      '  for i = 1, 10 do',
      '    print(i)',
      '  end',
      'end',
      '',
      'return M',
    ].join('\n')
    const syms = scanSymbols(src, 'lua')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // Dotted / colon paths reduce to the last segment.
    expect(byName.new).toMatchObject({
      kind: 'function',
      startLine: 3,
      endLine: 5,
    })
    // The inner `if … end` balances without ending the function.
    expect(byName.greet).toMatchObject({ startLine: 7, endLine: 11 })
    expect(byName.adder).toMatchObject({ startLine: 13, endLine: 15 })
    // The inner `for … do … end` balances.
    expect(byName.run).toMatchObject({ startLine: 17, endLine: 21 })
  })

  test('repeat/until closes and one-liners work', () => {
    const src = [
      'function poll()',
      '  repeat',
      '    step()',
      '  until done()',
      'end',
      '',
      'function tiny() return 1 end',
    ].join('\n')
    const syms = scanSymbols(src, 'lua')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.poll).toMatchObject({ startLine: 1, endLine: 5 })
    expect(byName.tiny).toMatchObject({ startLine: 7, endLine: 7 })
  })

  test('function/end inside comments and long strings are ignored', () => {
    const src = [
      '-- function ghost()',
      '-- end',
      '--[[',
      'function alsoGhost()',
      'end',
      ']]',
      'local s = [[ function notReal() end ]]',
      'function live()',
      '  return 1',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'lua')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('empty Lua fails open', () => {
    expect(scanSymbols('', 'lua')).toEqual([])
    expect(scanSymbols('print("hi")\n', 'lua')).toEqual([])
  })
})
