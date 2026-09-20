import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — Python', () => {
  test('class with methods, plain function, and decorator docLine', () => {
    const src = [
      'class Greeter:',
      '    def __init__(self, name):',
      '        self.name = name',
      '',
      '    @property',
      '    def greeting(self):',
      '        return "hi " + self.name',
      '',
      'def standalone():',
      '    return 1',
    ].join('\n')
    const syms = scanSymbols(src, 'python')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Greeter).toMatchObject({
      kind: 'class',
      startLine: 1,
      depth: 0,
    })
    expect(byName.__init__).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 2,
      endLine: 3,
    })
    expect(byName.greeting).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 6,
      docLine: 5,
    })
    expect(byName.standalone).toMatchObject({
      kind: 'function',
      depth: 0,
      startLine: 9,
      endLine: 10,
    })
  })

  test('a brace inside a Python string does not affect indentation bounds', () => {
    const src = [
      'def f():',
      '    s = "a } weird { string"',
      '    return s',
      'def g():',
      '    return 2',
    ].join('\n')
    const syms = scanSymbols(src, 'python')

    expect(syms.map(s => s.name)).toEqual(['f', 'g'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 3 })
  })
})
