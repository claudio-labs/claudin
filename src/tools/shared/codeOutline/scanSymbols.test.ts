import { describe, expect, test } from 'bun:test'

import {
  detectOutlineLang,
  detectOutlineLangFromPath,
  maskSourceForLang,
  scanSymbols,
} from 'src/tools/shared/codeOutline/scanSymbols.js'
import type { OutlineLang } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { OUTLINE_MAX_TOKENS, renderOutline } from 'src/tools/shared/codeOutline/renderOutline.js'

describe('detectOutlineLang', () => {
  test('maps known extensions, with or without a leading dot', () => {
    expect(detectOutlineLang('ts')).toBe('typescript')
    expect(detectOutlineLang('.tsx')).toBe('typescript')
    expect(detectOutlineLang('MTS')).toBe('typescript')
    expect(detectOutlineLang('js')).toBe('javascript')
    expect(detectOutlineLang('.jsx')).toBe('javascript')
    expect(detectOutlineLang('py')).toBe('python')
    expect(detectOutlineLang('go')).toBe('go')
    expect(detectOutlineLang('java')).toBe('java')
    expect(detectOutlineLang('kt')).toBe('kotlin')
    expect(detectOutlineLang('.kts')).toBe('kotlin')
    expect(detectOutlineLang('cs')).toBe('csharp')
    expect(detectOutlineLang('rs')).toBe('rust')
    expect(detectOutlineLang('md')).toBe('markdown')
    expect(detectOutlineLang('.markdown')).toBe('markdown')
  })

  test('maps the newly-added language extensions (case-insensitive)', () => {
    // C / C++ — a single 'c' language for every dialect extension.
    for (const ext of ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', '.CPP']) {
      expect(detectOutlineLang(ext)).toBe('c')
    }
    expect(detectOutlineLang('php')).toBe('php')
    expect(detectOutlineLang('.PHP')).toBe('php')
    expect(detectOutlineLang('swift')).toBe('swift')
    expect(detectOutlineLang('scala')).toBe('scala')
    expect(detectOutlineLang('rb')).toBe('ruby')
    expect(detectOutlineLang('lua')).toBe('lua')
    expect(detectOutlineLang('sh')).toBe('bash')
    expect(detectOutlineLang('bash')).toBe('bash')
    expect(detectOutlineLang('sql')).toBe('sql')
    expect(detectOutlineLang('.SQL')).toBe('sql')
    expect(detectOutlineLang('css')).toBe('css')
    expect(detectOutlineLang('scss')).toBe('css')
    expect(detectOutlineLang('html')).toBe('html')
    expect(detectOutlineLang('htm')).toBe('html')
    // Config / markup / build extensions
    expect(detectOutlineLang('yaml')).toBe('yaml')
    expect(detectOutlineLang('.YML')).toBe('yaml')
    expect(detectOutlineLang('xml')).toBe('xml')
    expect(detectOutlineLang('properties')).toBe('properties')
    expect(detectOutlineLang('env')).toBe('env')
    expect(detectOutlineLang('ini')).toBe('properties')
    expect(detectOutlineLang('toml')).toBe('toml')
    expect(detectOutlineLang('graphql')).toBe('graphql')
    expect(detectOutlineLang('gql')).toBe('graphql')
    expect(detectOutlineLang('mk')).toBe('makefile')
    expect(detectOutlineLang('tf')).toBe('terraform')
    expect(detectOutlineLang('hcl')).toBe('terraform')
    // Extensionless filenames
    expect(detectOutlineLang('dockerfile')).toBe('dockerfile')
    expect(detectOutlineLang('containerfile')).toBe('dockerfile')
    expect(detectOutlineLang('makefile')).toBe('makefile')
  })

  test('detectOutlineLangFromPath handles extensionless filenames', () => {
    expect(detectOutlineLangFromPath('Dockerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Dockerfile.dev')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('/path/to/Dockerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Containerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Makefile')).toBe('makefile')
    expect(detectOutlineLangFromPath('Makefile.am')).toBe('makefile')
    expect(detectOutlineLangFromPath('/repo/Makefile')).toBe('makefile')
    // Regular extensions still work
    expect(detectOutlineLangFromPath('config.yaml')).toBe('yaml')
    expect(detectOutlineLangFromPath('/app/src/schema.graphql')).toBe('graphql')
    expect(detectOutlineLangFromPath('main.tf')).toBe('terraform')
    // Unknown → null
    expect(detectOutlineLangFromPath('readme.txt')).toBeNull()
    // Extension-only keys (env, properties, ini, xml, …) must NOT match a
    // basename prefix — otherwise `env.log` / `properties.txt` get routed to
    // the config scanner and produce a garbage key outline. Only the true
    // extensionless basenames (dockerfile/containerfile/makefile) match.
    expect(detectOutlineLangFromPath('env.log')).toBeNull()
    expect(detectOutlineLangFromPath('properties.txt')).toBeNull()
    expect(detectOutlineLangFromPath('ini.settings')).toBeNull()
    expect(detectOutlineLangFromPath('xml.data')).toBeNull()
    expect(detectOutlineLangFromPath('toml.notes.md')).toBe('markdown')
  })

  test('returns null for unsupported extensions', () => {
    expect(detectOutlineLang('json')).toBeNull()
    expect(detectOutlineLang('txt')).toBeNull()
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

  test('object-literal members are emitted as methods of their const', () => {
    const src = [
      'export const Tool = buildTool({',
      "  name: 'grep',",
      '  async description() {',
      "    return 'd'",
      '  },',
      '  get inputSchema(): Schema {',
      '    return schema()',
      '  },',
      '  validate: async ({ path }) => {',
      '    return path',
      '  },',
      '})',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual([
      'Tool',
      'description',
      'inputSchema',
      'validate',
    ])
    expect(syms[1]).toMatchObject({ kind: 'method', depth: 1 })
  })

  test('data properties of an object literal are not symbols', () => {
    const src = [
      'export const config = {',
      '  timeout: 30_000,',
      "  name: 'x',",
      '  nested: { deep: true },',
      '  handler: () => run(),',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    // `handler` matches the member regex but has an expression body, so the
    // requiresBody gate drops it — same as any other property.
    expect(syms.map(s => s.name)).toEqual(['config'])
  })

  test('a function nested inside an object-literal method stays body noise', () => {
    const src = [
      'export const Tool = {',
      '  call() {',
      '    function helper() {',
      '      return 1',
      '    }',
      '    return helper()',
      '  },',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Tool', 'call'])
  })

  test('a member of a nested object literal is kept, at its own depth', () => {
    const src = [
      'export const handlers = {',
      '  fs: {',
      '    read() {',
      '      return 1',
      '    },',
      '  },',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    // TS sets strictMethodDepth: false, so a member deeper than one level
    // inside its container still resolves to it.
    expect(syms.map(s => s.name)).toEqual(['handlers', 'read'])
    expect(syms[1]).toMatchObject({ kind: 'method', depth: 2 })
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

  // The three cases below all shipped as the SAME user-visible failure: the
  // masked copy lost a brace, scanCLike hit its balance gate and returned [],
  // and Read(view='outline') silently degraded to dumping the whole file. 220
  // of 3,236 files in this repo were scanning to zero symbols when they were
  // found; the fixes took that to 198, all of the remainder being files that
  // genuinely declare nothing at top level.

  test('a nested template literal inside ${…} does not swallow the outer one', () => {
    // src/tools/GitTool/run.ts in miniature: a multi-line template whose
    // interpolation spans lines and holds another template with escaped
    // backticks. Without interpolation-aware masking the outer literal ends at
    // the INNER backtick and the tail leaks a `}`, which pops the top-level
    // frame — one extra enclosing block is enough to lose the whole file.
    const src = [
      'function report(result) {',
      '  if (result.notRun.length > 0) {',
      '    sections.push(',
      '      `Stopped — not run: ${result.notRun',
      '        .map(c => `\\`${oneLine(c)}\\``)',
      "        .join(', ')}.`,",
      '    )',
      '  }',
      '  return sections',
      '}',
      'function after() {',
      '  return 0',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['report', 'after'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 10 })
  })

  test('a regex literal inside ${…} does not open a string on its quotes', () => {
    // src/tools/TypecheckTool/run.ts in miniature. The `'` inside /'/g used to
    // open a literal that ran to the next apostrophe ANYWHERE later in the
    // file, blanking every brace in between.
    const src = [
      'function singleQuote(value) {',
      "  return `'${value.replace(/'/g, `'\\\\''`)}'`",
      '}',
      'function tail(text) {',
      '  return text',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['singleQuote', 'tail'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 3 })
  })

  test('an apostrophe in JSX prose is a contraction, not a string opener', () => {
    // src/permissions/ui/SkillPermissionRequest.tsx in miniature. JSX text is
    // scanned as code, so `don't` used to open a literal that swallowed the
    // component's closing braces.
    // One unpaired apostrophe is enough: the phantom literal it opens runs to
    // the next one anywhere later in the file — here, to the end — blanking
    // every brace after it. A fixture with two apostrophes on the same line
    // would pair them up and prove nothing.
    const src = [
      'function Prompt() {',
      '  return (',
      '    <Box>',
      "      <Text>Yes, and don't ask again for {name}</Text>",
      '    </Box>',
      '  )',
      '}',
      'function Other() {',
      '  return null',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Prompt', 'Other'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 7 })
  })

  test('the contraction guard leaves real single-quoted strings alone', () => {
    // Every shape where a `'` legitimately opens a string keeps a separator or
    // a keyword before it, which is exactly what the guard tests for. If any of
    // these started reading as code, its unbalanced brace would show up here as
    // an empty table.
    const src = [
      'function quotes(a, x) {',
      "  const r = a > 'b'",
      "  const k = x['a}']",
      "  if (r) return '{'",
      // No space before the quote — legal JS, and the only shape where the
      // guard's keyword lookup is load-bearing. The brace inside each literal
      // is what makes a wrong answer visible.
      "  switch (a) { case'}': break }",
      "  return typeof'{'",
      '}',
      'function next() {',
      '  return 1',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['quotes', 'next'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 7 })
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
  test('a nested no-body type decl is clamped to its enclosing block', () => {
    const src = [
      'func outer() {',
      '\ttype localID int',
      '}',
      '',
      'func next() {',
      '\treturn',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'go')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // Pre-spec scanner leaked localID's endLine past outer's `}` (line 4).
    expect(byName.localID).toMatchObject({ startLine: 2, endLine: 2 })
    expect(byName.outer).toMatchObject({ startLine: 1, endLine: 3 })
  })

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

describe('scanSymbols — Java', () => {
  test('class with constructor, methods, and a nested static class', () => {
    const src = [
      'package com.example;',
      '',
      '/** A widget. */',
      'public class Widget {',
      '  private final int id;',
      '',
      '  public Widget(int id) {',
      '    this.id = id;',
      '  }',
      '',
      '  @Override',
      '  public String render() {',
      '    return "w" + id;',
      '  }',
      '',
      '  public static class Builder {',
      '    public Widget build() {',
      '      return new Widget(1);',
      '    }',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // The constructor shares the class name — look the class up by kind.
    expect(syms.find(s => s.kind === 'class' && s.name === 'Widget')).toMatchObject({
      startLine: 4,
      endLine: 21,
      docLine: 3,
    })
    expect(
      syms.find(s => s.kind === 'method' && s.name === 'Widget'),
    ).toMatchObject({ startLine: 7, endLine: 9, depth: 1 })
    expect(byName.render).toMatchObject({
      kind: 'method',
      startLine: 12,
      endLine: 14,
      docLine: 11, // the @Override annotation
    })
    expect(byName.Builder).toMatchObject({ kind: 'class', depth: 1 })
    expect(byName.build).toMatchObject({ kind: 'method', depth: 2 })
    expect(syms.map(s => s.name)).not.toContain('id')
  })

  test('statements, field initializers, and anonymous classes are not methods', () => {
    const src = [
      'public class Svc {',
      '  private final Runnable r = new Runnable() {',
      '    public void run() {',
      '      tick();',
      '    }',
      '  };',
      '',
      '  public void start() {',
      '    if (ready()) {',
      '      r.run();',
      '    }',
      '    return helper(1);',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')

    // `run` lives two levels deep (anonymous class) — strict depth drops it;
    // `if (...)`, `r.run()`, `return helper(1)` are statements, not decls.
    expect(syms.map(s => s.name).sort()).toEqual(['Svc', 'start'])
  })

  test('commented-out declarations and text-block braces are ignored', () => {
    const src = [
      'public class Cfg {',
      '  /*',
      '  public void dead() {',
      '  }',
      '  */',
      '  private static final String Q = """',
      '      select { weird } braces',
      '      """;',
      '',
      '  public int live() {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')

    expect(syms.map(s => s.name).sort()).toEqual(['Cfg', 'live'])
    expect(syms.find(s => s.name === 'Cfg')).toMatchObject({ endLine: 13 })
  })

  test('interface and record declarations', () => {
    const src = [
      'public interface Shape {',
      '  double area();',
      '}',
      '',
      'public record Point(int x, int y) {',
      '  public double norm() {',
      '    return Math.sqrt(x * x + y * y);',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Shape).toMatchObject({ kind: 'interface' })
    expect(byName.Point).toMatchObject({ kind: 'record' })
    expect(byName.norm).toMatchObject({ kind: 'method', depth: 1 })
    // `double area();` has no body — heuristic method detection drops it.
    expect(byName.area).toBeUndefined()
  })
})

describe('scanSymbols — Kotlin', () => {
  test('class, expression-body fun, extension fun, object, and val', () => {
    const src = [
      'val retries = 3',
      '',
      'data class User(val name: String)',
      '',
      'class Repo {',
      '  fun save(u: User) {',
      '    persist(u)',
      '  }',
      '  fun count() = cache.size',
      '}',
      '',
      'fun String.titlecase(): String = replaceFirstChar { it.uppercase() }',
      '',
      'object Registry {',
      '  fun lookup(id: Int): User? {',
      '    return null',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'kotlin')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.retries).toMatchObject({ kind: 'const', startLine: 1 })
    expect(byName.User).toMatchObject({ kind: 'class', startLine: 3 })
    expect(byName.Repo).toMatchObject({ kind: 'class' })
    expect(byName.save).toMatchObject({ kind: 'method', depth: 1 })
    // Expression-bodied member — no braces, still kept.
    expect(byName.count).toMatchObject({ kind: 'method', startLine: 9 })
    expect(byName.titlecase).toMatchObject({ kind: 'function', depth: 0 })
    expect(byName.Registry).toMatchObject({ kind: 'object' })
    expect(byName.lookup).toMatchObject({ kind: 'method', depth: 1 })
  })

  test('companion object and raw-string braces', () => {
    const src = [
      'class Parser {',
      '  companion object {',
      '    fun default(): Parser {',
      '      return Parser()',
      '    }',
      '  }',
      '  val pattern = """\\d+ { not code }"""',
      '  fun parse(s: String) {',
      '    consume(s)',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'kotlin')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Parser).toMatchObject({ kind: 'class', endLine: 11 })
    expect(byName.companion).toMatchObject({ kind: 'object', depth: 1 })
    expect(byName.parse).toMatchObject({ kind: 'method', depth: 1 })
    // `default` sits inside the companion object (an allowed container).
    expect(byName.default).toMatchObject({ kind: 'method', depth: 2 })
  })
})

describe('scanSymbols — C#', () => {
  test('block namespace is depth-transparent for types and methods', () => {
    const src = [
      'namespace App.Core',
      '{',
      '  public class Service',
      '  {',
      '    public int Count { get; set; }',
      '',
      '    public string Render()',
      '    {',
      '      return "ok";',
      '    }',
      '',
      '    public int Total() => Count * 2;',
      '  }',
      '',
      '  public record Point(int X, int Y);',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'csharp')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['App.Core']).toMatchObject({ kind: 'module', startLine: 1 })
    expect(byName.Service).toMatchObject({ kind: 'class', depth: 1 })
    expect(byName.Render).toMatchObject({ kind: 'method', depth: 2 })
    // Expression-bodied method — no braces, still kept.
    expect(byName.Total).toMatchObject({ kind: 'method', startLine: 12 })
    expect(byName.Point).toMatchObject({ kind: 'record' })
    // The auto-property has no parentheses — never a method candidate.
    expect(byName.Count).toBeUndefined()
  })

  test('file-scoped namespace adds no depth', () => {
    const src = [
      'namespace App.Tools;',
      '',
      'public struct Span',
      '{',
      '  public int Length()',
      '  {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'csharp')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['App.Tools']).toMatchObject({ kind: 'module', endLine: 1 })
    expect(byName.Span).toMatchObject({ kind: 'struct', depth: 0 })
    expect(byName.Length).toMatchObject({ kind: 'method', depth: 1 })
  })

  test('conversion operators are not phantom methods', () => {
    const src = [
      'public class Money',
      '{',
      '  public static implicit operator int(Money m) => m.Cents;',
      '  public static explicit operator string(Money m) => m.ToString();',
      '',
      '  public int Cents()',
      '  {',
      '    return 100;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'csharp')

    // The operator's "method name" would be the target type — rejected.
    expect(syms.map(s => s.name).sort()).toEqual(['Cents', 'Money'])
  })

  test('verbatim string braces and attributes do not corrupt the table', () => {
    const src = [
      'public class Db',
      '{',
      '  private const string Sql = @"select { from } where ""x""";',
      '',
      '  [Obsolete("use QueryAsync")]',
      '  public int Query()',
      '  {',
      '    return 0;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'csharp')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Db).toMatchObject({ kind: 'class', endLine: 10 })
    expect(byName.Query).toMatchObject({
      kind: 'method',
      startLine: 6,
      docLine: 5, // the [Obsolete] attribute
    })
    expect(byName.Obsolete).toBeUndefined()
  })
})

describe('scanSymbols — Rust', () => {
  test('struct, trait, impl blocks, and methods', () => {
    const src = [
      '/// A counter.',
      '#[derive(Debug)]',
      'pub struct Counter {',
      '    count: u32,',
      '}',
      '',
      'pub trait Describe {',
      '    fn describe(&self) -> String;',
      '}',
      '',
      'impl Counter {',
      '    pub fn new() -> Self {',
      '        Counter { count: 0 }',
      '    }',
      '}',
      '',
      'impl Describe for Counter {',
      '    fn describe(&self) -> String {',
      '        format!("{}", self.count)',
      '    }',
      '}',
      '',
      'pub fn standalone() -> u32 {',
      '    42',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'rust')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // Two impl blocks share the struct's name — look the struct up by kind.
    expect(syms.find(s => s.kind === 'struct')).toMatchObject({
      name: 'Counter',
      startLine: 3,
      docLine: 1, // doc comment + attribute block
    })
    expect(byName.Describe).toMatchObject({ kind: 'trait', startLine: 7 })
    expect(byName.new).toMatchObject({ kind: 'method', startLine: 12 })
    expect(byName.standalone).toMatchObject({ kind: 'function', depth: 0 })
    // Both impl blocks resolve to the target type's name.
    const impls = syms.filter(s => s.kind === 'impl')
    expect(impls.map(s => s.name)).toEqual(['Counter', 'Counter'])
    // The trait's bodyless signature and the impl's body both survive.
    const describes = syms.filter(s => s.name === 'describe')
    expect(describes).toHaveLength(2)
  })

  test('lifetimes, raw strings, and nested comments do not corrupt masking', () => {
    const src = [
      "pub fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {",
      '    let re = r#"braces { in } raw"#;',
      '    /* outer /* nested } */ still comment */',
      "    let c = '}';",
      '    if x.len() > y.len() { x } else { y }',
      '}',
      '',
      'pub fn after() -> u8 {',
      '    1',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'rust')

    expect(syms.map(s => s.name)).toEqual(['longest', 'after'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 6 })
  })

  test('inline mod is depth-transparent; mod decl without body is one line', () => {
    const src = [
      'mod io;',
      '',
      'pub mod util {',
      '    pub fn helper() -> u8 {',
      '        0',
      '    }',
      '',
      '    pub struct Buf {',
      '        data: Vec<u8>,',
      '    }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'rust')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.io).toMatchObject({ kind: 'module', endLine: 1 })
    expect(byName.util).toMatchObject({ kind: 'module', endLine: 11 })
    // Inside the mod these still gate as top-level declarations.
    expect(byName.helper).toMatchObject({ kind: 'function' })
    expect(byName.Buf).toMatchObject({ kind: 'struct' })
  })
})

describe('scanSymbols — Markdown', () => {
  test('headings nest by level and bound their sections', () => {
    const src = [
      '# Guide',
      '',
      'Intro text.',
      '',
      '## Install',
      '',
      'Step one.',
      '',
      '### From source',
      '',
      'Build it.',
      '',
      '## Usage ##',
      '',
      'Run it.',
    ].join('\n')
    const syms = scanSymbols(src, 'markdown')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Guide).toMatchObject({
      kind: 'heading',
      depth: 0,
      startLine: 1,
      endLine: 15,
    })
    expect(byName.Install).toMatchObject({
      depth: 1,
      startLine: 5,
      endLine: 12,
    })
    expect(byName['From source']).toMatchObject({ depth: 2, endLine: 12 })
    // Trailing closing hashes are stripped from the name.
    expect(byName.Usage).toMatchObject({ depth: 1, endLine: 15 })
    expect(byName.Usage.signature).toBe('## Usage ##')
  })

  test('comment lines inside fenced code blocks are not headings', () => {
    const src = [
      '# Real',
      '',
      '```bash',
      '# not a heading',
      '~~~',
      '```',
      '',
      '~~~py',
      '# also not a heading',
      '~~~',
      '',
      '## Also real',
    ].join('\n')
    const syms = scanSymbols(src, 'markdown')

    expect(syms.map(s => s.name)).toEqual(['Real', 'Also real'])
  })

  test('empty or heading-free documents fail open', () => {
    expect(scanSymbols('', 'markdown')).toEqual([])
    expect(scanSymbols('just prose\nno headings\n', 'markdown')).toEqual([])
  })

  test('depth is normalized to the shallowest heading level', () => {
    const src = ['## Setup', '', 'text', '', '### Linux', '', '## Use'].join(
      '\n',
    )
    const syms = scanSymbols(src, 'markdown')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // An h2-only document renders flush, not pre-indented one level.
    expect(byName.Setup).toMatchObject({ depth: 0 })
    expect(byName.Linux).toMatchObject({ depth: 1 })
    expect(byName.Use).toMatchObject({ depth: 0 })
  })

  test('the drill-in hint skips heading names containing a quote', () => {
    const src = ["# Don't panic", '', 'text', '', '## Towel'].join('\n')
    const syms = scanSymbols(src, 'markdown')
    const out = renderOutline(syms, 'guide.md', 5)

    // `symbol='Don't panic'` would render with broken quoting — the hint
    // falls back to the first quote-free name; the entry itself remains.
    expect(out).toContain("symbol='Towel'")
    expect(out).toContain("# Don't panic")
  })
})

describe('scanSymbols — C / C++', () => {
  test('functions, struct/enum members, #define, and a typedef alias', () => {
    const src = [
      '#define MAX_ITEMS 100',
      '',
      '/* a point */',
      'struct Point {',
      '  int x;',
      '  int y;',
      '};',
      '',
      'enum Color { RED, GREEN, BLUE };',
      '',
      'int add(int a, int b) {',
      '  return a + b;',
      '}',
      '',
      'typedef struct Point Vec;',
    ].join('\n')
    const syms = scanSymbols(src, 'c')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // A no-body `#define` (like a Kotlin `val`) has no `;` to bound it, so its
    // endLine extends to just before the next symbol — only startLine/kind are
    // asserted here.
    expect(byName.MAX_ITEMS).toMatchObject({ kind: 'const', startLine: 1 })
    expect(byName.Point).toMatchObject({
      kind: 'struct',
      startLine: 4,
      endLine: 7,
    })
    expect(byName.Color).toMatchObject({ kind: 'enum', startLine: 9 })
    expect(byName.add).toMatchObject({
      kind: 'function',
      startLine: 11,
      endLine: 13,
      depth: 0,
    })
    // A one-line typedef names the alias, not the underlying tag.
    expect(byName.Vec).toMatchObject({ kind: 'type', startLine: 15 })
  })
  test('one-line anonymous-struct typedef names the alias, not a field', () => {
    // `typedef struct { int x; } Foo;` — the alias is `Foo`, NOT the field `x`.
    // The greedy regex backtracks to the final `ident;` before `;`.
    const src = 'typedef struct { int x; } Foo;\n'
    const syms = scanSymbols(src, 'c')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.Foo).toMatchObject({ kind: 'type', startLine: 1 })
    expect(byName.x).toBeUndefined()
  })

  test('C++ class method sits at depth 1 inside its class', () => {
    const src = [
      'class Widget {',
      'public:',
      '  int render() {',
      '    return 1;',
      '  }',
      '};',
    ].join('\n')
    const syms = scanSymbols(src, 'c')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Widget).toMatchObject({ kind: 'class', depth: 0 })
    expect(byName.render).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 3,
      endLine: 5,
    })
  })

  test('commented-out and string-literal declarations are not symbols', () => {
    const src = [
      '// int ghost() { return 0; }',
      '/* struct Fake { int z; }; */',
      'const char *s = "int notReal(void) {";',
      'int live(void) {',
      '  return 1;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'c')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('control-keyword shapes are not reported as functions', () => {
    const src = [
      'int run(void) {',
      '  if (ready()) {',
      '    work();',
      '  }',
      '  while (more()) {',
      '    step();',
      '  }',
      '  return 0;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'c')

    expect(syms.map(s => s.name)).toEqual(['run'])
  })

  test('a doc comment directly above is attached as docLine; blank-separated is not', () => {
    const src = [
      '/** Adds two integers. */',
      'int add(int a, int b) {',
      '  return a + b;',
      '}',
      '',
      '// This is far away.',
      '',
      'int sub(int a, int b) {',
      '  return a - b;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'c')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // C has docPrefixes: [] but RE_DOC_LINE still matches /** and //.
    expect(byName.add).toMatchObject({ startLine: 2, docLine: 1 })
    // Blank line between the // comment and `sub` breaks the doc chain.
    expect(byName.sub?.docLine).toBeUndefined()
  })

  test('empty and minified inputs fail open', () => {
    expect(scanSymbols('', 'c')).toEqual([])
    expect(scanSymbols('   \n\t\n', 'c')).toEqual([])
    expect(scanSymbols('int a=1;int b=2;', 'c')).toEqual([])
  })
})

describe('scanSymbols — PHP', () => {
  test('class with a method, standalone function, and heredoc braces', () => {
    const src = [
      '<?php',
      '',
      'class Widget {',
      '  public function render() {',
      '    $sql = <<<SQL',
      '      SELECT { weird } braces',
      '    SQL;',
      '    return $sql;',
      '  }',
      '  private $id = 1;',
      '}',
      '',
      'function helper($a) {',
      '  return $a;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'php')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Widget).toMatchObject({ kind: 'class', startLine: 3 })
    expect(byName.render).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 4,
      endLine: 9,
    })
    expect(byName.helper).toMatchObject({
      kind: 'function',
      depth: 0,
      startLine: 13,
    })
    // The `$id` property is not a method (no parentheses).
    expect(byName.id).toBeUndefined()
  })

  test('interface, trait, and a PHPDoc / attribute docLine', () => {
    const src = [
      '<?php',
      'interface Shape {',
      '  public function area(): float;',
      '}',
      '',
      'trait Loggable {',
      '  public function log() {',
      '    echo "x";',
      '  }',
      '}',
      '',
      '/** A service. */',
      'class Svc {',
      '  #[Route("/x")]',
      '  public function handle() {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'php')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Shape).toMatchObject({ kind: 'interface' })
    // Interface methods have no body → dropped by the brace-body filter.
    expect(byName.area).toBeUndefined()
    expect(byName.Loggable).toMatchObject({ kind: 'trait' })
    expect(byName.log).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.Svc).toMatchObject({ kind: 'class', docLine: 12 })
    expect(byName.handle).toMatchObject({ kind: 'method', docLine: 14 })
  })

  test('declarations inside comments and strings are ignored', () => {
    const src = [
      '<?php',
      '// function ghost() {}',
      '# class Fake {}',
      '$s = "function notReal() {";',
      'function live() {',
      '  return 1;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'php')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('empty and degenerate PHP fails open', () => {
    expect(scanSymbols('', 'php')).toEqual([])
    expect(scanSymbols('<?php $x = 1; echo $x;', 'php')).toEqual([])
  })
})

describe('scanSymbols — Swift', () => {
  test('class, struct, protocol, extension, and functions', () => {
    const src = [
      'protocol Describable {',
      '  func describe() -> String',
      '}',
      '',
      'class Repo {',
      '  func save(_ u: User) {',
      '    persist(u)',
      '  }',
      '  var count = 0',
      '}',
      '',
      'struct Point { }',
      '',
      'extension Repo {',
      '  func reset() {',
      '    count = 0',
      '  }',
      '}',
      '',
      'func standalone() -> Int {',
      '  return 1',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'swift')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.Describable).toMatchObject({ kind: 'interface' })
    // `extension Repo` shares the class's name — look the class up by kind.
    expect(syms.find(s => s.kind === 'class' && s.name === 'Repo')).toMatchObject(
      { startLine: 5 },
    )
    expect(byName.save).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 6,
      endLine: 8,
    })
    expect(byName.Point).toMatchObject({ kind: 'struct' })
    // `reset` lives inside an extension — kept as a method.
    expect(byName.reset).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.standalone).toMatchObject({ kind: 'function', depth: 0 })
  })

  test('attribute docLine and string/comment noise rejection', () => {
    const src = [
      '@objc',
      'func exported() {',
      '  let s = "func notReal() {"',
      '  // func ghost() {}',
      '  return',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'swift')

    expect(syms.map(s => s.name)).toEqual(['exported'])
    expect(syms[0]).toMatchObject({ docLine: 1 })
  })

  test('empty Swift fails open', () => {
    expect(scanSymbols('', 'swift')).toEqual([])
    expect(scanSymbols('let x = 1\nprint(x)\n', 'swift')).toEqual([])
  })
})

describe('scanSymbols — Scala', () => {
  test('class, object, trait, def (expression + block bodies), val', () => {
    const src = [
      'val retries = 3',
      '',
      'class Repo {',
      '  def save(u: User): Unit = {',
      '    persist(u)',
      '  }',
      '  def count = cache.size',
      '}',
      '',
      'object Registry {',
      '  def lookup(id: Int) = None',
      '}',
      '',
      'trait Describe {',
      '  def describe: String',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'scala')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.retries).toMatchObject({ kind: 'const', startLine: 1 })
    expect(byName.Repo).toMatchObject({ kind: 'class' })
    expect(byName.save).toMatchObject({
      kind: 'method',
      depth: 1,
      startLine: 4,
      endLine: 6,
    })
    // Expression-bodied member — no braces, still kept.
    expect(byName.count).toMatchObject({ kind: 'method', startLine: 7 })
    expect(byName.Registry).toMatchObject({ kind: 'object' })
    expect(byName.lookup).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.Describe).toMatchObject({ kind: 'trait' })
  })

  test('case class and comment/string rejection', () => {
    const src = [
      'case class User(name: String)',
      '',
      'object Svc {',
      '  // def ghost() = 1',
      '  val q = "def notReal = {"',
      '  def real() = {',
      '    1',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'scala')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.User).toMatchObject({ kind: 'class' })
    expect(syms.map(s => s.name).sort()).toEqual(['Svc', 'User', 'real'])
  })

  test('Scaladoc block and @annotation are attached as docLine; blank-separated is not', () => {
    const src = [
      '/**',
      ' * Processes an item.',
      ' */',
      'def process(item: Item): Unit = {',
      '  println(item)',
      '}',
      '',
      '@deprecated("use newApi")',
      'def oldApi(): Int = 1',
      '// This is separated by a blank line.',
      '',
      'def fresh(): Int = 1',
    ].join('\n')
    const syms = scanSymbols(src, 'scala')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    // Scaladoc /** ... */ block directly above → docLine points to the opening line.
    expect(byName.process).toMatchObject({ startLine: 4, docLine: 1 })
    // @annotation directly above → docLine points to the annotation line.
    expect(byName.oldApi).toMatchObject({ startLine: 9, docLine: 8 })
    // A blank line between the comment and the def breaks the doc chain.
    expect(byName.fresh?.docLine).toBeUndefined()
  })

  test('empty Scala fails open', () => {
    expect(scanSymbols('', 'scala')).toEqual([])
  })
})

describe('scanSymbols — Bash', () => {
  test('both function syntaxes, with braces in strings and heredocs', () => {
    const src = [
      '#!/bin/bash',
      '',
      'greet() {',
      '  echo "hi { there }"',
      '}',
      '',
      'function deploy {',
      '  cat <<MANIFEST',
      '  { not: code }',
      'MANIFEST',
      '  run',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'bash')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.greet).toMatchObject({
      kind: 'function',
      startLine: 3,
      endLine: 5,
    })
    expect(byName.deploy).toMatchObject({
      kind: 'function',
      startLine: 7,
      endLine: 12,
    })
  })

  test('a commented function definition is not a symbol', () => {
    const src = [
      '# ghost() {',
      '#   echo hi',
      '# }',
      'live() {',
      '  echo yes',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'bash')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('empty Bash fails open', () => {
    expect(scanSymbols('', 'bash')).toEqual([])
    expect(scanSymbols('echo hi\nls -la\n', 'bash')).toEqual([])
  })
})

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

describe('scanSymbols — SQL', () => {
  test('CREATE table/view/index/function with dollar-quoted body', () => {
    const src = [
      '-- schema',
      'CREATE TABLE users (',
      '  id INT PRIMARY KEY,',
      '  name TEXT',
      ');',
      '',
      'CREATE OR REPLACE VIEW active_users AS',
      'SELECT * FROM users WHERE active = 1;',
      '',
      'CREATE INDEX idx_name ON users (name);',
      '',
      'CREATE FUNCTION add(a int, b int) RETURNS int AS $body$',
      'BEGIN',
      '  RETURN a + b;',
      'END;',
      '$body$ LANGUAGE plpgsql;',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.users).toMatchObject({
      kind: 'table',
      startLine: 2,
      endLine: 5,
    })
    expect(byName.active_users).toMatchObject({
      kind: 'view',
      startLine: 7,
      endLine: 8,
    })
    expect(byName.idx_name).toMatchObject({ startLine: 10, endLine: 10 })
    // Dollar-quoting masks the inner `;` so the body span is correct.
    expect(byName.add).toMatchObject({
      kind: 'function',
      startLine: 12,
      endLine: 16,
    })
  })

  test('materialized view, trigger, quoted names, and IF NOT EXISTS', () => {
    const src = [
      'CREATE MATERIALIZED VIEW IF NOT EXISTS "public"."stats" AS',
      'SELECT 1;',
      'CREATE TRIGGER audit_ins AFTER INSERT ON users',
      'FOR EACH ROW EXECUTE FUNCTION log_it();',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['public.stats']).toMatchObject({ kind: 'view' })
    expect(byName.audit_ins).toMatchObject({ kind: 'trigger' })
  })

  test('CREATE in comments and strings is ignored', () => {
    const src = [
      "-- CREATE TABLE ghost (id int);",
      "/* CREATE VIEW fake AS SELECT 1; */",
      "INSERT INTO t VALUES ('CREATE TABLE notReal (x int)');",
      'CREATE TABLE live (id int);',
    ].join('\n')
    const syms = scanSymbols(src, 'sql')

    expect(syms.map(s => s.name)).toEqual(['live'])
  })

  test('empty SQL yields no symbols', () => {
    expect(scanSymbols('', 'sql')).toEqual([])
    expect(scanSymbols('SELECT * FROM users;\n', 'sql')).toEqual([])
  })
})

describe('scanSymbols — CSS / SCSS', () => {
  test('top-level selectors, at-rules, and SCSS mixin/function', () => {
    const src = [
      '.header {',
      '  color: red;',
      '}',
      '',
      '#main, .content {',
      '  padding: 0;',
      '}',
      '',
      '@media (max-width: 600px) {',
      '  .header { color: blue; }',
      '}',
      '',
      '@mixin flex($dir) {',
      '  display: flex;',
      '}',
      '',
      '@keyframes spin {',
      '  from { transform: rotate(0); }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['.header']).toMatchObject({
      kind: 'selector',
      startLine: 1,
      endLine: 3,
      depth: 0,
    })
    expect(byName['#main, .content']).toMatchObject({
      kind: 'selector',
      startLine: 5,
      endLine: 7,
    })
    // At-rule with a nested selector — the nested `.header` is NOT emitted.
    expect(byName['@media (max-width: 600px)']).toMatchObject({
      kind: 'selector',
      startLine: 9,
      endLine: 11,
    })
    expect(syms.filter(s => s.name === '.header')).toHaveLength(1)
    expect(byName.flex).toMatchObject({ kind: 'function', startLine: 13 })
    expect(byName.spin).toMatchObject({ kind: 'selector', startLine: 17 })
  })

  test('selectors inside comments are ignored; $variables are skipped', () => {
    const src = [
      '/* .ghost { color: red } */',
      '// .also-ghost { }',
      '$primary: #333;',
      '.real {',
      '  color: $primary;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')

    expect(syms.map(s => s.name)).toEqual(['.real'])
  })

  test('empty CSS yields no symbols', () => {
    expect(scanSymbols('', 'css')).toEqual([])
    expect(scanSymbols('/* just a comment */\n', 'css')).toEqual([])
  })
})

describe('scanSymbols — HTML', () => {
  test('headings, landmarks, and id-bearing elements with nesting depth', () => {
    const src = [
      '<!DOCTYPE html>',
      '<html>',
      '<head><title>x</title></head>',
      '<body>',
      '  <header>',
      '    <h1>Welcome</h1>',
      '    <nav id="mainnav">',
      '      <a href="#">Home</a>',
      '    </nav>',
      '  </header>',
      '  <section id="content">',
      '    <h2>Details</h2>',
      '  </section>',
      '</body>',
      '</html>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.header).toMatchObject({
      kind: 'element',
      startLine: 5,
      endLine: 10,
      depth: 0,
    })
    // Heading text becomes the name; nested one level inside <header>.
    expect(byName.Welcome).toMatchObject({
      kind: 'heading',
      depth: 1,
      startLine: 6,
    })
    expect(byName['nav#mainnav']).toMatchObject({
      kind: 'element',
      depth: 1,
      startLine: 7,
      endLine: 9,
    })
    expect(byName['section#content']).toMatchObject({
      kind: 'element',
      depth: 0,
      startLine: 11,
    })
    expect(byName.Details).toMatchObject({ kind: 'heading', depth: 1 })
  })

  test('commented-out and scripted markup is ignored', () => {
    const src = [
      '<!-- <section id="ghost"><h1>Nope</h1></section> -->',
      '<script>',
      '  var s = "<section id=\\"fake\\">"',
      '</script>',
      '<main id="real">',
      '  <h1>Live</h1>',
      '</main>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['main#real']).toMatchObject({ kind: 'element' })
    expect(byName.Live).toMatchObject({ kind: 'heading' })
    expect(byName['section#ghost']).toBeUndefined()
    expect(byName['section#fake']).toBeUndefined()
  })

  test('empty HTML yields no symbols', () => {
    expect(scanSymbols('', 'html')).toEqual([])
    expect(scanSymbols('<p>just text</p>\n', 'html')).toEqual([])
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
    const out = renderOutline(syms, 'demo.ts', 8, { reason: 'overcap' })

    expect(out).toContain('<system-reminder>')
    expect(out).toContain("exceeds the read cap")
    expect(out).toContain("Read(file_path, symbol='first')")
    expect(out).toContain('1-3')
    expect(out).toContain('function first()')
    // Method is indented one level deeper than its class.
    expect(out).toMatch(/\n {4}\d+-\d+ +open\(\)/)
  })

  test('truncated flag adds a scan-cap notice; absent by default', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const truncated = renderOutline(syms, 'big.ts', 3, { truncated: true })
    expect(truncated).toContain('exceeds the 10 MB scan cap')
    expect(truncated).toContain('deeper symbols are not listed')

    const normal = renderOutline(syms, 'big.ts', 3)
    expect(normal).not.toContain('scan cap')
  })

  test('non-over-cap header uses neutral wording', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const out = renderOutline(syms, 'demo.ts', 3)

    expect(out).toContain('Structural outline')
    expect(out).not.toContain('exceeds the read cap')
  })

  test('pivot header says the file is large, never that a cap was exceeded', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const out = renderOutline(syms, 'demo.ts', 360, { reason: 'pivot' })

    // The defect this pins: the auto-outline pivot reused the over-cap lead,
    // so files well under every cap were told they exceeded one — measured at
    // 1,809 events over 504 files, none above 3k lines.
    expect(out).not.toContain('exceeds the read cap')
    expect(out).toContain("File 'demo.ts' (360 lines) is large")
    // Still an outline, and still says how to drill in.
    expect(out).toContain("Read(file_path, symbol='a')")
  })

  test('auto-cap truncates a pathological symbol count with a trailer', () => {
    // Enough symbols that the rendered body blows OUTLINE_MAX_TOKENS.
    const lines: string[] = []
    for (let i = 0; i < 6000; i++) {
      lines.push(`function symbolNumber${i}() { return ${i} }`)
    }
    const syms = scanSymbols(lines.join('\n'), 'typescript')
    expect(syms.length).toBe(6000)

    const out = renderOutline(syms, 'huge.ts', 6000, { reason: 'overcap' })
    expect(out).toMatch(/… \(\+\d+ more symbols/)

    const bodyTokens = out.length / 4 // crude upper bound
    expect(bodyTokens).toBeLessThan(OUTLINE_MAX_TOKENS * 2)
  })
})

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

describe('scanSymbols — YAML', () => {
  test('top-level and nested keys with correct depth and line ranges', () => {
    const src = [
      'server:',
      '  port: 8080',
      '  host: localhost',
      'database:',
      '  name: myapp',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.server).toMatchObject({ kind: 'key', depth: 0, startLine: 1 })
    expect(byName.port).toMatchObject({ kind: 'key', depth: 1, startLine: 2 })
    expect(byName.host).toMatchObject({ kind: 'key', depth: 1, startLine: 3 })
    expect(byName.database).toMatchObject({ kind: 'key', depth: 0, startLine: 4 })
    // server section ends at line before database (line 3)
    expect(byName.server.endLine).toBe(3)
    // database section runs to end (line 5)
    expect(byName.database.endLine).toBe(5)
  })

  test('list-item keys are detected', () => {
    const src = [
      'items:',
      '  - name: first',
      '    value: 1',
      '  - name: second',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('items')
    expect(names).toContain('name')
  })

  test('multi-doc separator resets depth', () => {
    const src = [
      'a: 1',
      'b: 2',
      '---',
      'c: 3',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.a.depth).toBe(0)
    expect(byName.c.depth).toBe(0)
  })

  test('block scalars do not produce false keys', () => {
    const src = [
      'script: |',
      '  echo hello',
      '  echo world',
      'next: value',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('script')
    expect(names).toContain('next')
    // echo and world should NOT be detected as keys
    expect(names).not.toContain('echo')
  })

  test('comments and anchors are not keys', () => {
    const src = [
      '# This is a comment',
      'key: &anchor value',
      '  # nested comment',
      '  sub: *alias',
    ].join('\n')
    const syms = scanSymbols(src, 'yaml')
    const names = syms.map(s => s.name)
    expect(names).toContain('key')
    expect(names).toContain('sub')
    expect(names).not.toContain('anchor')
  })

  test('empty and degenerate fail open', () => {
    expect(scanSymbols('', 'yaml')).toEqual([])
    expect(scanSymbols('# only comments\n', 'yaml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

describe('scanSymbols — XML', () => {
  test('elements with id/name attrs and root are tracked', () => {
    const src = [
      '<?xml version="1.0"?>',
      '<beans>',
      '  <bean id="dataSource" class="DataSource"/>',
      '  <bean name="txManager" class="TxManager">',
      '    <property name="timeout" value="30"/>',
      '  </bean>',
      '</beans>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.beans).toBeDefined()
    expect(byName.beans.kind).toBe('element')
    expect(byName.dataSource).toBeDefined()
    expect(byName.txManager).toBeDefined()
  })

  test('nested elements get correct depth', () => {
    const src = [
      '<root>',
      '  <child id="c1">',
      '    <grandchild id="g1"/>',
      '  </child>',
      '</root>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.root.depth).toBe(0)
    expect(byName.c1.depth).toBe(1)
    expect(byName.g1.depth).toBe(2)
  })

  test('comments and CDATA are not elements', () => {
    const src = [
      '<!-- this is a comment -->',
      '<root>',
      '  <![CDATA[some data]]>',
      '</root>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const names = syms.map(s => s.name)
    expect(names).toContain('root')
    expect(names).not.toContain('!--')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'xml')).toEqual([])
    expect(scanSymbols('<!-- only comment -->', 'xml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Config (.properties / .env)
// ---------------------------------------------------------------------------

describe('scanSymbols — Config (.properties / .env)', () => {
  test('extracts key=value and key:value pairs', () => {
    const src = [
      'server.port=8080',
      'server.host: localhost',
      'debug = true',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName['server.port']).toBeDefined()
    expect(byName['server.host']).toBeDefined()
    expect(byName.debug).toBeDefined()
    expect(syms.every(s => s.kind === 'key')).toBe(true)
  })

  test('env files with export prefix', () => {
    const src = [
      'DATABASE_URL=postgres://localhost',
      'export NODE_ENV=production',
      '# a comment',
      'PORT=3000',
    ].join('\n')
    const syms = scanSymbols(src, 'env')
    const names = syms.map(s => s.name)
    expect(names).toContain('DATABASE_URL')
    expect(names).toContain('NODE_ENV')
    expect(names).toContain('PORT')
  })

  test('comments and blank lines are skipped', () => {
    const src = [
      '# comment line',
      '! also a comment (properties)',
      '',
      'key=value',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('key')
  })

  test('line continuation does not create false keys', () => {
    const src = [
      'multi=value \\',
      '  continued \\',
      '  more',
      'next=ok',
    ].join('\n')
    const syms = scanSymbols(src, 'properties')
    const names = syms.map(s => s.name)
    expect(names).toContain('multi')
    expect(names).toContain('next')
    expect(names).not.toContain('continued')
    expect(names).not.toContain('more')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'env')).toEqual([])
    expect(scanSymbols('# only comments\n', 'properties')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

describe('scanSymbols — TOML', () => {
  test('tables and array tables are detected', () => {
    const src = [
      '[package]',
      'name = "myapp"',
      '[dependencies]',
      'serde = "1.0"',
      '[[bin]]',
      'name = "myapp"',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    const names = syms.map(s => s.name)
    expect(names).toContain('package')
    expect(names).toContain('dependencies')
    expect(names).toContain('bin')
  })

  test('dotted table names get depth by dot count', () => {
    const src = [
      '[tool.poetry]',
      'name = "x"',
      '[tool.poetry.dependencies]',
      'pytest = "7"',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName['tool.poetry'].depth).toBe(1)
    expect(byName['tool.poetry.dependencies'].depth).toBe(2)
  })

  test('key=value lines are not tables', () => {
    const src = [
      '[section]',
      'key = "value"',
      '# comment',
    ].join('\n')
    const syms = scanSymbols(src, 'toml')
    expect(syms).toHaveLength(1)
    expect(syms[0]!.name).toBe('section')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'toml')).toEqual([])
    expect(scanSymbols('# only comments\n', 'toml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

describe('scanSymbols — Dockerfile', () => {
  test('instructions are detected with correct depth', () => {
    const src = [
      'FROM node:18 AS builder',
      'RUN npm install',
      'COPY . .',
      'CMD ["node", "server.js"]',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.builder).toMatchObject({ kind: 'key', depth: 0, startLine: 1 })
    expect(byName.RUN).toMatchObject({ kind: 'key', depth: 1, startLine: 2 })
    expect(byName.COPY).toMatchObject({ kind: 'key', depth: 1, startLine: 3 })
    expect(byName.CMD).toMatchObject({ kind: 'key', depth: 1, startLine: 4 })
  })

  test('multi-stage builds reset depth', () => {
    const src = [
      'FROM node:18 AS build',
      'RUN npm run build',
      'FROM nginx:alpine',
      'COPY --from=build /dist /usr/share/nginx/html',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const froms = syms.filter(s => s.depth === 0)
    expect(froms).toHaveLength(2)
    expect(froms[0]!.name).toBe('build')
    // Second FROM without AS gets a generated name
    expect(froms[1]!.name).toMatch(/^FROM_/)
  })

  test('comments are skipped', () => {
    const src = [
      '# Build stage',
      'FROM node:18',
      '# Install deps',
      'RUN npm install',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    expect(syms).toHaveLength(2)
  })
  test('continuation across a comment line does not get stuck', () => {
    // Docker skips comment lines inside a `\`-continuation and keeps it open:
    // `COPY . .` here is continuation text of the RUN, not an instruction.
    // The continuation must then end there (the line has no trailing `\`) so
    // the NEXT real instruction (CMD) is not swallowed too.
    const src = [
      'FROM node:18 AS builder',
      'RUN echo hello \\',
      '# a comment inside the continuation',
      'COPY . .',
      'CMD ["node", "server.js"]',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.builder).toBeDefined()
    expect(byName.RUN).toBeDefined()
    expect(byName.COPY).toBeUndefined()
    expect(byName.CMD).toMatchObject({ kind: 'key', startLine: 5 })
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'dockerfile')).toEqual([])
    expect(scanSymbols('# only comments\n', 'dockerfile')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Makefile
// ---------------------------------------------------------------------------

describe('scanSymbols — Makefile', () => {
  test('targets and variables are detected', () => {
    const src = [
      'CC = gcc',
      'CFLAGS = -Wall -O2',
      'build: main.o util.o',
      '\t$(CC) -o app main.o util.o',
      'clean:',
      '\trm -f *.o app',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.CC).toMatchObject({ kind: 'const' })
    expect(byName.CFLAGS).toMatchObject({ kind: 'const' })
    expect(byName.build).toMatchObject({ kind: 'function', startLine: 3 })
    expect(byName.clean).toMatchObject({ kind: 'function' })
  })

  test('target body extends through recipe lines', () => {
    const src = [
      'build: deps',
      '\tcommand1',
      '\tcommand2',
      'other:',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    // build endLine should include recipe lines (line 3)
    expect(byName.build.endLine).toBe(3)
  })

  test('pattern rules and .PHONY are detected', () => {
    const src = [
      '.PHONY: clean build',
      '%.o: %.c',
      '\t$(CC) -c $< -o $@',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const names = syms.map(s => s.name)
    expect(names).toContain('.PHONY')
    expect(names).toContain('%.o')
  })

  test('tab-indented recipe lines and includes are not targets', () => {
    const src = [
      'include common.mk',
      '\tnot a target',
      'build:',
    ].join('\n')
    const syms = scanSymbols(src, 'makefile')
    const names = syms.map(s => s.name)
    expect(names).toContain('build')
    expect(names).not.toContain('include')
    expect(names).not.toContain('not')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'makefile')).toEqual([])
    expect(scanSymbols('# only comments\n', 'makefile')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

describe('scanSymbols — GraphQL', () => {
  test('type, input, interface, enum, scalar, union definitions', () => {
    const src = [
      'type User {',
      '  id: ID!',
      '  name: String!',
      '}',
      'input UserInput {',
      '  name: String!',
      '}',
      'interface Node {',
      '  id: ID!',
      '}',
      'enum Status { ACTIVE INACTIVE }',
      'scalar DateTime',
      'union Result = User | Error',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.User).toMatchObject({ kind: 'class', depth: 0 })
    expect(byName.UserInput).toMatchObject({ kind: 'record', depth: 0 })
    expect(byName.Node).toMatchObject({ kind: 'interface', depth: 0 })
    expect(byName.Status).toMatchObject({ kind: 'enum', depth: 0 })
    expect(byName.DateTime).toMatchObject({ kind: 'type', depth: 0 })
    expect(byName.Result).toMatchObject({ kind: 'type', depth: 0 })
  })

  test('fields inside types are methods at depth 1', () => {
    const src = [
      'type User {',
      '  id: ID!',
      '  name(prefix: String): String!',
      '  email: String',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.id).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.name).toMatchObject({ kind: 'method', depth: 1 })
    expect(byName.email).toMatchObject({ kind: 'method', depth: 1 })
  })

  test('comments and doc strings are masked', () => {
    const src = [
      '# comment',
      '"""doc string"""',
      'type User {',
      '  id: ID!',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'graphql')
    const names = syms.map(s => s.name)
    expect(names).toContain('User')
    expect(names).not.toContain('comment')
    expect(names).not.toContain('doc')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'graphql')).toEqual([])
    expect(scanSymbols('# only comments\n', 'graphql')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Terraform / HCL
// ---------------------------------------------------------------------------

describe('scanSymbols — Terraform / HCL', () => {
  test('resource, data, module, variable, output, provider blocks', () => {
    const src = [
      'resource "aws_instance" "web" {',
      '  ami = "ami-123"',
      '}',
      'data "aws_ami" "ubuntu" {',
      '  most_recent = true',
      '}',
      'module "vpc" {',
      '  source = "./vpc"',
      '}',
      'variable "name" {',
      '  type = string',
      '}',
      'output "result" {',
      '  value = "ok"',
      '}',
      'provider "aws" {',
      '  region = "us-east-1"',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['aws_instance.web']).toMatchObject({ kind: 'class', depth: 0 })
    expect(byName['aws_ami.ubuntu']).toMatchObject({ kind: 'record', depth: 0 })
    expect(byName.vpc).toMatchObject({ kind: 'module', depth: 0 })
    expect(byName.name).toMatchObject({ kind: 'const', depth: 0 })
    expect(byName.result).toMatchObject({ kind: 'const', depth: 0 })
    expect(byName.aws).toMatchObject({ kind: 'interface', depth: 0 })
  })

  test('locals and terraform blocks', () => {
    const src = [
      'locals {',
      '  common_tags = { Env = "prod" }',
      '}',
      'terraform {',
      '  required_version = ">= 1.0"',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.locals).toMatchObject({ kind: 'module', depth: 0 })
    expect(byName.terraform).toMatchObject({ kind: 'module', depth: 0 })
  })

  test('nested blocks are methods at depth 1', () => {
    const src = [
      'resource "aws_instance" "web" {',
      '  dynamic "ebs_block_device" {',
      '    for_each = var.devices',
      '  }',
      '  provisioner "local-exec" {',
      '    command = "echo done"',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const methods = syms.filter(s => s.kind === 'method')
    expect(methods.length).toBeGreaterThanOrEqual(2)
    const names = methods.map(s => s.name)
    expect(names).toContain('ebs_block_device')
    expect(names).toContain('local-exec')
  })

  test('comments and heredocs are masked', () => {
    const src = [
      '# comment',
      'resource "x" "y" {',
      '  body = <<EOF',
      '    not a block',
      '  EOF',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const names = syms.map(s => s.name)
    expect(names).toContain('x.y')
    expect(names).not.toContain('not')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'terraform')).toEqual([])
    expect(scanSymbols('# only comments\n', 'terraform')).toEqual([])
  })
})

// Regression fixes from the PR #28 review pass — each test guards one
// verified scanner bug (see the PR discussion for the failure scenarios).
describe('scanSymbols — review regression fixes', () => {
  test('detects dotenv variants and GNUmakefile', () => {
    expect(detectOutlineLangFromPath('.env.local')).toBe('env')
    expect(detectOutlineLangFromPath('/app/.env.production')).toBe('env')
    expect(detectOutlineLangFromPath('.env.example')).toBe('env')
    expect(detectOutlineLangFromPath('GNUmakefile')).toBe('makefile')
    // The extension-key guard still holds.
    expect(detectOutlineLangFromPath('env.log')).toBeNull()
    expect(detectOutlineLangFromPath('.envrc')).toBeNull()
  })

  test('Ruby 3 endless methods do not unbalance the outline', () => {
    const src = [
      'class Basket',
      '  def size = @items.count',
      '  def total(tax) = @sum * tax',
      '',
      '  def add(item)',
      '    @items << item',
      '  end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(syms.map(s => s.name).sort()).toEqual([
      'Basket',
      'add',
      'size',
      'total',
    ])
    expect(byName.size).toMatchObject({ startLine: 2, endLine: 2 })
    expect(byName.total).toMatchObject({ startLine: 3, endLine: 3 })
    expect(byName.Basket).toMatchObject({ startLine: 1, endLine: 8 })
  })

  test('Ruby setter defs (`def value=(v)`) still close on `end`', () => {
    const src = [
      'class Cfg',
      '  def value=(v)',
      '    @v = v',
      '  end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['value=']).toMatchObject({ startLine: 2, endLine: 4 })
    expect(byName.Cfg).toMatchObject({ endLine: 5 })
  })

  test('Lua mid-line openers keep the stack balanced', () => {
    const src = [
      'function M.tick(y)',
      '  x = 1; if y then',
      '    x = 2',
      '  end',
      '  return x',
      'end',
      '',
      'function M.other()',
      '  return 0',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'lua')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(syms.map(s => s.name)).toEqual(['tick', 'other'])
    expect(byName.tick).toMatchObject({ startLine: 1, endLine: 6 })
    expect(byName.other).toMatchObject({ startLine: 8, endLine: 10 })
  })

  test('CSS protocol-relative url(//…) is not treated as a SCSS comment', () => {
    const src = [
      '.hero { background: url(//cdn.example.com/x.png) }',
      '',
      '.next {',
      '  color: red;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')

    expect(syms.map(s => s.name)).toEqual(['.hero', '.next'])
  })

  test('Dockerfile comments inside a continuation keep it open', () => {
    const src = [
      'FROM node:20 AS base',
      'RUN echo start \\',
      '  # note — Docker keeps the continuation open across comments',
      '  COPY . .',
      'ENV FOO=bar',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')

    // `COPY . .` is continuation text of the RUN, not a real instruction.
    expect(syms.map(s => s.name)).toEqual(['base', 'RUN', 'ENV'])
  })

  test('HTML heading text strips nested/split tags to a fixpoint', () => {
    const src = [
      '<html><body>',
      '<h1>Intro <scr<b>ipt>alert</h1>',
      '</body></html>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const h1 = syms.find(s => s.signature.includes('<h1>'))

    expect(h1).toBeDefined()
    // No complete tag (and no dangling `<`) survives in the outline text.
    expect(h1!.name).not.toMatch(/</)
  })
})

describe('maskSourceForLang', () => {
  // The whole point of the mask as an oracle: offsets must survive it, so a
  // match found at offset k in the source can be tested at offset k in the mask.
  const OFFSET_PRESERVING: Array<[string, OutlineLang]> = [
    ['const a = "x" // c\nfunction f() {}\n', 'typescript'],
    ['def f():\n    """doc"""\n    return "s"  # c\n', 'python'],
    ['fn f() { let s = "x"; /* c */ }\n', 'rust'],
    ['<?php\n// c\n$a = "x";\nfunction f() {}\n', 'php'],
    ['# c\nf() { echo "x"; }\n', 'bash'],
    ['def f\n  # c\n  "x"\nend\n', 'ruby'],
    ['-- c\nSELECT "x";\n', 'sql'],
    ['/* c */\n.a { color: red; }\n', 'css'],
    ['<!-- c -->\n<div id="x"></div>\n', 'xml'],
  ]

  test.each(OFFSET_PRESERVING)(
    'preserves length and newline offsets (%#)',
    (source, lang) => {
      const masked = maskSourceForLang(source, lang)
      expect(masked).not.toBeNull()
      expect(masked!.length).toBe(source.length)
      for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') expect(masked![i]).toBe('\n')
      }
    },
  )

  test('blanks comment and string bytes, keeps code bytes', () => {
    const src = 'const NAME = "NAME" // NAME\nfunction NAME() {}\n'
    const masked = maskSourceForLang(src, 'typescript')!
    const at = (needle: string, from = 0) => src.indexOf(needle, from)

    // Declaration on line 1 and the function name on line 2 are real code.
    expect(masked[at('NAME')]).toBe('N')
    expect(masked[at('NAME', at('function'))]).toBe('N')
    // The occurrence inside the string literal and inside the comment are not.
    expect(masked[at('NAME', at('"'))]).toBe(' ')
    expect(masked[at('NAME', at('//'))]).toBe(' ')
  })

  test('returns null for languages whose scanner does no masking', () => {
    for (const lang of [
      'markdown',
      'yaml',
      'toml',
      'properties',
      'env',
      'dockerfile',
      'makefile',
    ] as const) {
      expect(maskSourceForLang('anything: value\n', lang)).toBeNull()
    }
  })

  test('empty input is returned as-is, not null', () => {
    expect(maskSourceForLang('', 'typescript')).toBe('')
  })

  describe('stringInterpolations', () => {
    const SRC = 'const s = `a ${ NAME(1) } b`\n'

    test('is off by default — a template stays opaque for the outline', () => {
      const masked = maskSourceForLang(SRC, 'typescript')!

      expect(masked[SRC.indexOf('NAME')]).toBe(' ')
    })

    test('when on, the substitution body reads as code', () => {
      const masked = maskSourceForLang(SRC, 'typescript', {
        stringInterpolations: true,
      })!

      expect(masked[SRC.indexOf('NAME')]).toBe('N')
      // The literal text around it stays masked, and `${`/`}` are blanked as
      // punctuation so brace-depth math over the copy is unchanged.
      expect(masked[SRC.indexOf('a ${')]).toBe(' ')
      expect(masked[SRC.indexOf('${')]).toBe(' ')
      expect(masked[SRC.indexOf('} b')]).toBe(' ')
      expect(masked.length).toBe(SRC.length)
    })

    test('is ignored for Go, whose backtick string has no substitutions', () => {
      const go = 'q := `a ${ NAME } b`\n'
      const masked = maskSourceForLang(go, 'go', {
        stringInterpolations: true,
      })!

      expect(masked[go.indexOf('NAME')]).toBe(' ')
    })

    test('python f-string replacement fields read as code', () => {
      const py = 'a = f"x {NAME(1)} y"\nb = "{NAME}"\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe('N')
      // A plain (non-f) string stays opaque, braces or not.
      expect(masked[py.indexOf('NAME', py.indexOf('b ='))]).toBe(' ')
      expect(masked.length).toBe(py.length)
    })

    test('python f-string: doubled braces are literal text', () => {
      const py = 'a = f"{{NAME}} {NAME}"\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe(' ')
      expect(masked[py.lastIndexOf('NAME')]).toBe('N')
    })

    test('python f-string: prefix variants and triple quotes', () => {
      const py = 'a = rf"""x {NAME} y"""\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe('N')
    })

    test('python f-strings stay opaque by default', () => {
      const py = 'a = f"x {NAME(1)} y"\n'

      expect(maskSourceForLang(py, 'python')![py.indexOf('NAME')]).toBe(' ')
    })

    // One battery per language. `HIT` marks an occurrence the mask must leave
    // as code (a real reference); `MISS` marks one it must keep blanked (plain
    // string text). Both are ordinary identifiers, so the scanner sees no
    // difference — only its interpolation rules decide.
    const CASES: Array<{ lang: OutlineLang; src: string }> = [
      { lang: 'typescript', src: 'const a = `t ${HIT} MISS ${f(HIT)}`\n' },
      { lang: 'javascript', src: 'const a = `t ${HIT} MISS`\nconst b = "MISS"\n' },
      { lang: 'python', src: 'a = f"t {HIT} MISS"\nb = "MISS"\n' },
      { lang: 'kotlin', src: 'val a = "t $HIT MISS ${f(HIT)}"\nval b = "MISS"\n' },
      { lang: 'kotlin', src: 'val a = """t $HIT MISS"""\n' },
      { lang: 'scala', src: 'val a = s"t $HIT MISS ${f(HIT)}"\nval b = "MISS"\n' },
      { lang: 'csharp', src: 'var a = $"t {HIT} MISS";\nvar b = "MISS";\n' },
      { lang: 'swift', src: 'let a = "t \\(HIT) MISS"\nlet b = "MISS"\n' },
      // An escaped opener is literal text, not a field.
      { lang: 'javascript', src: 'const a = `t \\${MISS} MISS`\n' },
      { lang: 'bash', src: 'a="t \\$MISS MISS"\n' },
      { lang: 'ruby', src: 'a = "t #{HIT} MISS"\nb = \'MISS\'\nc = "MISS"\n' },
      { lang: 'php', src: '$a = "t $HIT MISS {$HIT}";\n$b = \'MISS\';\n' },
      { lang: 'bash', src: 'a="t $HIT MISS ${HIT}"\nb=\'MISS\'\n' },
      { lang: 'rust', src: 'let a = format!("t {HIT} MISS");\nlet b = "MISS";\n' },
      // Dart interpolates in both quote styles; an `r` prefix opts out.
      {
        lang: 'dart',
        src: "final a = \"t $HIT ${f(HIT)} MISS\";\nfinal b = r'$MISS';\n",
      },
      { lang: 'dart', src: "final a = '''t $HIT MISS''';\n" },
      // A Groovy GString is double-quoted only.
      {
        lang: 'groovy',
        src: "def a = \"t $HIT ${f(HIT)} MISS\"\ndef b = '$MISS'\n",
      },
      { lang: 'elixir', src: 'a = "t #{HIT} MISS"\n# MISS in a comment\n' },
      {
        lang: 'powershell',
        src: '$a = "t $HIT $(f $HIT) MISS"\n$b = \'$MISS\'\n',
      },
      // Backtick is PowerShell's escape character, so `$ is a literal dollar.
      { lang: 'powershell', src: '$a = "t `$MISS MISS"\n<# MISS #>\n' },
      // Controls — these languages have no interpolation at all, so every
      // occurrence inside a literal stays masked even with the flag on.
      { lang: 'go', src: 'a := `t ${MISS} MISS`\nb := "MISS"\n' },
      { lang: 'java', src: 'String a = "t ${MISS} MISS";\n' },
      { lang: 'lua', src: 'local a = "t ${MISS} MISS"\n' },
    ]

    const occurrences = (src: string, needle: string): number[] => {
      const out: number[] = []
      for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
        out.push(at)
      }
      return out
    }

    for (const { lang, src } of CASES) {
      const label = src.split('\n')[0]!
      test(`${lang}: ${label}`, () => {
        const masked = maskSourceForLang(src, lang, {
          stringInterpolations: true,
        })!

        expect(masked.length).toBe(src.length)
        for (const at of occurrences(src, 'HIT')) {
          expect(masked.slice(at, at + 3)).toBe('HIT')
        }
        for (const at of occurrences(src, 'MISS')) {
          expect(masked.slice(at, at + 4)).toBe('    ')
        }
        // Without the opt-in every language stays fully opaque.
        const opaque = maskSourceForLang(src, lang)!
        for (const at of occurrences(src, 'HIT')) {
          expect(opaque.slice(at, at + 3)).toBe('   ')
        }
      })
    }
  })
})

describe('languages added for Rename', () => {
  test('shell dialects reuse the bash scanner', () => {
    for (const ext of ['sh', 'bash', 'zsh', 'ksh', 'fish']) {
      expect(detectOutlineLangFromPath(`/tmp/x.${ext}`)).toBe('bash')
    }
  })

  test('the new extensions map to their language', () => {
    expect(detectOutlineLangFromPath('/a/lib.dart')).toBe('dart')
    expect(detectOutlineLangFromPath('/a/build.gradle')).toBe('groovy')
    expect(detectOutlineLangFromPath('/a/x.groovy')).toBe('groovy')
    expect(detectOutlineLangFromPath('/a/mod.ex')).toBe('elixir')
    expect(detectOutlineLangFromPath('/a/run.exs')).toBe('elixir')
    expect(detectOutlineLangFromPath('/a/deploy.ps1')).toBe('powershell')
    expect(detectOutlineLangFromPath('/a/mod.psm1')).toBe('powershell')
  })

  // The reason maskElixir exists instead of reusing maskRuby: Ruby reads
  // `<<"tag">>` as a heredoc opener and masks everything after it.
  test("elixir: a binary literal is not a heredoc", () => {
    const src = 'a = <<"tag">>\ndef keep(cfg), do: cfg\n'
    const masked = maskSourceForLang(src, 'elixir')!

    expect(masked.slice(src.indexOf('def keep'), src.indexOf('def keep') + 8)).toBe(
      'def keep',
    )
    // The same source under Ruby's mask is what the dedicated scanner avoids.
    const asRuby = maskSourceForLang(src, 'ruby')!
    expect(asRuby.includes('def keep')).toBe(false)
  })

  test('powershell: here-strings and literal strings', () => {
    const here = '$a = @"\nvalue: $HIT\n"@\n$b = @\'\nMISS\n\'@\n'
    const masked = maskSourceForLang(here, 'powershell', {
      stringInterpolations: true,
    })!

    expect(masked.slice(here.indexOf('HIT'), here.indexOf('HIT') + 3)).toBe('HIT')
    expect(masked.slice(here.indexOf('MISS'), here.indexOf('MISS') + 4)).toBe('    ')
  })

  test('mask-only languages resolve no symbols and do not throw', () => {
    expect(scanSymbols('def cfgValue(n), do: n\n', 'elixir')).toEqual([])
    expect(scanSymbols('function cfgValue { 1 }\n', 'powershell')).toEqual([])
  })

  // `if !(x)` puts `!(` on the line before the literal without being a macro
  // call. Reading that as a format string exposes the string's contents to a
  // rename, which rewrites text the user never meant to touch.
  test('rust: ordinary negation is not a format macro', () => {
    const negation = 'fn f(){ if !(x) { let s = "{name}"; } }'
    const masked = maskSourceForLang(negation, 'rust', {
      stringInterpolations: true,
    })!
    expect(masked.includes('name')).toBe(false)

    for (const macro of ['format', 'println', 'write', 'panic', 'assert']) {
      const src = `fn f(){ ${macro}!("{name}"); }`
      const m = maskSourceForLang(src, 'rust', { stringInterpolations: true })!
      expect(m.slice(src.indexOf('name'), src.indexOf('name') + 4)).toBe('name')
    }
  })

  // `"$foo$bar"` is two references. If the first identifier scan swallows the
  // second sigil, that `$` survives unblanked and reads as an identifier
  // character — which silently drops BOTH sites.
  test('adjacent bare sigils are two separate references', () => {
    for (const [lang, src] of [
      ['kotlin', 'val s = "$foo$bar"'],
      ['groovy', 'def s = "$foo$bar"'],
      ['dart', 'final s = "$foo$bar";'],
    ] as const) {
      const masked = maskSourceForLang(src, lang, {
        stringInterpolations: true,
      })!
      expect(masked).not.toContain('$')
      expect(masked.slice(src.indexOf('foo'), src.indexOf('foo') + 3)).toBe('foo')
      expect(masked.slice(src.indexOf('bar'), src.indexOf('bar') + 3)).toBe('bar')
    }
  })
})
