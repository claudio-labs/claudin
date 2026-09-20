import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — Ruby', () => {
  test('class/module methods, top-level def, and end-block nesting', () => {
    const src = [
      'class Greeter',
      '  # sets up the greeter',
      '  def initialize(name)',
      '    @name = name',
      '  end',
      '',
      '  def greeting',
      '    if @name',
      '      "hi"',
      '    else',
      '      "hey"',
      '    end',
      '  end',
      'end',
      '',
      'def standalone',
      '  [1, 2].each do |i|',
      '    puts i',
      '  end',
      'end',
      '',
      'module Helpers',
      '  def util; 1; end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Greeter).toMatchObject({
      kind: 'class',
      startLine: 1,
      endLine: 14,
      depth: 0,
    })
    expect(byName.initialize).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 3,
      endLine: 5,
      docLine: 2,
    })
    // The inner if/else consumes its own `end` without ending the method.
    expect(byName.greeting).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 7,
      endLine: 13,
    })
    // A top-level def is a function; the `.each do … end` block balances.
    expect(byName.standalone).toMatchObject({
      kind: 'function',
      depth: 0,
      startLine: 16,
      endLine: 20,
    })
    expect(byName.Helpers).toMatchObject({ kind: 'module' })
    // One-liner `def util; 1; end`.
    expect(byName.util).toMatchObject({
      kind: 'method',
      startLine: 23,
      endLine: 23,
    })
  })

  test('def/end inside comments, strings, and heredocs are ignored', () => {
    const src = [
      'class Cfg',
      '  # def ghost',
      '  # end',
      '  QUERY = "def notReal\\nend"',
      '  TEMPLATE = <<~SQL',
      '    def alsoNotReal',
      '    end',
      '  SQL',
      '  def real',
      '    1',
      '  end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(syms.map(s => s.name).sort()).toEqual(['Cfg', 'real'])
    expect(byName.Cfg).toMatchObject({ endLine: 12 })
  })

  test('modifier if/while do not open a block', () => {
    const src = [
      'def guard(x)',
      '  return 0 if x.nil?',
      '  x += 1 while x < 10',
      '  x',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')

    expect(syms.map(s => s.name)).toEqual(['guard'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 5 })
  })
  test(':end symbol literal is not counted as the `end` keyword', () => {
    // `:end` is a Ruby Symbol, not the block-closing `end` keyword. Counting
    // it would inflate the close count, imbalance the stack, and make scanRuby
    // silently return [] (the whole outline disappears).
    const src = [
      'def uses_symbol',
      '  status = :end',
      '  status',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    expect(syms.map(s => s.name)).toEqual(['uses_symbol'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 4 })
  })

  test('empty and heading-free Ruby fails open', () => {
    expect(scanSymbols('', 'ruby')).toEqual([])
    expect(scanSymbols('puts "hi"\nx = 1\n', 'ruby')).toEqual([])
  })
})
