import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

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
