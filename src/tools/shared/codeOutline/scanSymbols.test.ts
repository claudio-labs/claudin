import { describe, expect, test } from 'bun:test'

import { detectOutlineLang, scanSymbols } from './scanSymbols.js'
import { OUTLINE_MAX_TOKENS, renderOutline } from './renderOutline.js'

describe('detectOutlineLang', () => {
  test('maps known extensions, with or without a leading dot', () => {
    expect(detectOutlineLang('ts')).toBe('typescript')
    expect(detectOutlineLang('.tsx')).toBe('typescript')
    expect(detectOutlineLang('MTS')).toBe('typescript')
    expect(detectOutlineLang('js')).toBe('javascript')
    expect(detectOutlineLang('.jsx')).toBe('javascript')
    expect(detectOutlineLang('py')).toBe('python')
    expect(detectOutlineLang('go')).toBe('go')
  })

  test('returns null for unsupported extensions', () => {
    expect(detectOutlineLang('rs')).toBeNull()
    expect(detectOutlineLang('json')).toBeNull()
    expect(detectOutlineLang('')).toBeNull()
  })
})

describe('scanSymbols — TypeScript', () => {
  test('top-level function with a multi-line signature', () => {
    const src = [
      'export function translate(',
      '  msg: string,',
      '  opts: Options,',
      '): Result {',
      '  return { msg }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms).toHaveLength(1)
    expect(syms[0]).toMatchObject({
      name: 'translate',
      kind: 'function',
      startLine: 1,
      endLine: 6,
      depth: 0,
    })
  })

  test('class with nested methods at depth 1', () => {
    const src = [
      'class Widget {',
      '  private id = 1',
      '  render(): string {',
      '    return "x"',
      '  }',
      '  async load() {',
      '    await fetch("/")',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Widget).toMatchObject({
      kind: 'class',
      startLine: 1,
      endLine: 9,
      depth: 0,
    })
    expect(byName.render).toMatchObject({
      kind: 'method',
      startLine: 3,
      endLine: 5,
      depth: 1,
    })
    expect(byName.load).toMatchObject({
      kind: 'method',
      startLine: 6,
      endLine: 8,
      depth: 1,
    })
  })

  test('arrow const at top level', () => {
    const src = [
      'export const handler = async (req: Req) => {',
      '  return req.body',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms).toHaveLength(1)
    expect(syms[0]).toMatchObject({
      name: 'handler',
      kind: 'const',
      startLine: 1,
      endLine: 3,
    })
  })

  test('type and interface without a brace body', () => {
    const src = [
      'export type Id = string | number;',
      'export interface Point { x: number; y: number }',
      'const inert = 1;',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Id).toMatchObject({ kind: 'type', startLine: 1, endLine: 1 })
    expect(byName.Point).toMatchObject({ kind: 'interface', startLine: 2 })
    expect(byName.inert).toMatchObject({ kind: 'const', startLine: 3, endLine: 3 })
  })

  test('captures a JSDoc block as docLine', () => {
    const src = [
      '/**',
      ' * Adds two numbers.',
      ' */',
      'export function add(a: number, b: number) {',
      '  return a + b',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms[0]).toMatchObject({
      name: 'add',
      startLine: 4,
      docLine: 1,
    })
  })

  test('signature is trimmed at the opening brace', () => {
    const src = 'function noisy(a: number) { return a }'
    const syms = scanSymbols(src, 'typescript')

    expect(syms[0]!.signature).toBe('function noisy(a: number)')
  })

  test('a function nested in another body is not emitted as a symbol', () => {
    const src = [
      'export function outer() {',
      '  function inner() {',
      '    return 1',
      '  }',
      '  const local = 2',
      '  class LocalClass {}',
      '  return inner() + local',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    // Only the top-level `outer` — inner/local/LocalClass are body noise.
    expect(syms.map(s => s.name)).toEqual(['outer'])
  })
})

describe('scanSymbols — masking edge cases', () => {
  test('braces inside strings do not corrupt bounds', () => {
    const src = [
      'function f() {',
      '  const s = "a } b { c"',
      "  const t = 'another } brace'",
      '  return s + t',
      '}',
      'function g() {',
      '  return 2',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['f', 'g'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 5 })
    expect(syms[1]).toMatchObject({ startLine: 6, endLine: 8 })
  })

  test('braces inside template literals do not corrupt bounds', () => {
    const src = [
      'function tpl() {',
      '  return `value is ${ obj }`',
      '}',
      'function after() {',
      '  return 0',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['tpl', 'after'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 3 })
  })

  test('braces inside comments do not corrupt bounds', () => {
    const src = [
      'function commented() {',
      '  // a stray } brace in a line comment',
      '  /* and { another } in a block */',
      '  return 1',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms).toHaveLength(1)
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 5 })
  })

  test('braces inside a regex literal do not corrupt bounds', () => {
    const src = [
      'function withRegex() {',
      '  const re = /a{2,3}/g',
      '  const re2 = /[{}]+/',
      '  return re.test("aa") && re2.test("x")',
      '}',
      'function plain() {',
      '  return 0',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['withRegex', 'plain'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 5 })
  })

  test('JSX closing tags are not mistaken for regex literals', () => {
    const src = [
      'function Panel() {',
      '  return (',
      '    <Box>',
      '      <Text>{ "label" }</Text>',
      '    </Box>',
      '  )',
      '}',
      'function Footer() {',
      '  return null',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Panel', 'Footer'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 7 })
  })

  test('unbalanced braces fail open with an empty table', () => {
    const src = 'function broken() {\n  return 1\n'
    expect(scanSymbols(src, 'typescript')).toEqual([])
  })

  test('empty source yields an empty table', () => {
    expect(scanSymbols('', 'typescript')).toEqual([])
  })

  test('a file with no symbols yields an empty table', () => {
    const src = 'const a = 1\nconsole.log(a)\n'
    // `const a` IS a symbol; a truly symbol-free file is e.g. only calls.
    const onlyCalls = 'doThing()\nlogOther()\n'
    expect(scanSymbols(onlyCalls, 'typescript')).toEqual([])
    expect(scanSymbols(src, 'typescript').map(s => s.name)).toEqual(['a'])
  })
})

describe('scanSymbols — Go', () => {
  test('func, method with a receiver, and a struct type', () => {
    const src = [
      'type Server struct {',
      '\tAddr string',
      '}',
      '',
      'func New() *Server {',
      '\treturn &Server{}',
      '}',
      '',
      'func (s *Server) Start() error {',
      '\treturn nil',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'go')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Server).toMatchObject({ kind: 'struct', startLine: 1, endLine: 3 })
    expect(byName.New).toMatchObject({ kind: 'function', startLine: 5, endLine: 7 })
    expect(byName.Start).toMatchObject({
      kind: 'function',
      startLine: 9,
      endLine: 11,
    })
  })
})

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

describe('renderOutline', () => {
  test('renders header, indented signatures, and a drill-in hint', () => {
    const src = [
      'export function first() {',
      '  return 1',
      '}',
      'class Box {',
      '  open() {',
      '    return true',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')
    const out = renderOutline(syms, 'demo.ts', 8, { overCap: true })

    expect(out).toContain('<system-reminder>')
    expect(out).toContain("exceeds the read cap")
    expect(out).toContain("Read(file_path, symbol='first')")
    expect(out).toContain('1-3')
    expect(out).toContain('function first()')
    // Method is indented one level deeper than its class.
    expect(out).toMatch(/\n {4}\d+-\d+ +open\(\)/)
  })

  test('non-over-cap header uses neutral wording', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const out = renderOutline(syms, 'demo.ts', 3)

    expect(out).toContain('Structural outline')
    expect(out).not.toContain('exceeds the read cap')
  })

  test('auto-cap truncates a pathological symbol count with a trailer', () => {
    // Enough symbols that the rendered body blows OUTLINE_MAX_TOKENS.
    const lines: string[] = []
    for (let i = 0; i < 6000; i++) {
      lines.push(`function symbolNumber${i}() { return ${i} }`)
    }
    const syms = scanSymbols(lines.join('\n'), 'typescript')
    expect(syms.length).toBe(6000)

    const out = renderOutline(syms, 'huge.ts', 6000, { overCap: true })
    expect(out).toMatch(/… \(\+\d+ more symbols/)

    const bodyTokens = out.length / 4 // crude upper bound
    expect(bodyTokens).toBeLessThan(OUTLINE_MAX_TOKENS * 2)
  })
})
