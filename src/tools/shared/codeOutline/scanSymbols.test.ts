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
    expect(detectOutlineLang('java')).toBe('java')
    expect(detectOutlineLang('kt')).toBe('kotlin')
    expect(detectOutlineLang('.kts')).toBe('kotlin')
    expect(detectOutlineLang('cs')).toBe('csharp')
    expect(detectOutlineLang('rs')).toBe('rust')
    expect(detectOutlineLang('md')).toBe('markdown')
    expect(detectOutlineLang('.markdown')).toBe('markdown')
  })

  test('returns null for unsupported extensions', () => {
    expect(detectOutlineLang('rb')).toBeNull()
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
