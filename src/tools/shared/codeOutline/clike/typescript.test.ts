import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

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

  test('a call used as an argument is not a symbol', () => {
    // GrepTool.ts:565 — `getCwd(),` sits on its own line inside a multi-line
    // call. It matched the `ident(` method regex and adopted the brace of the
    // NEXT block, so the outline reported a symbol `getCwd` spanning a `for`
    // loop that has nothing to do with it.
    const src = [
      'export const Tool = {',
      '  call() {',
      '    const patterns = normalize(',
      '      readPatterns(),',
      '      getCwd(),',
      '    )',
      '    for (const p of patterns) {',
      '      args.push(p)',
      '    }',
      '  },',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Tool', 'call'])
  })

  test('the last condition of a multi-line if is not a symbol', () => {
    // GrepTool.ts:617. `if (` alone is caught by isControlKeyword, but its
    // CONTINUATION lines carry no such marker, and the `) {` that closes the
    // condition was read as the candidate's body.
    const src = [
      'export const Tool = {',
      '  call() {',
      '    if (',
      '      results.length === 0 &&',
      '      fallbackEnabled()',
      '    ) {',
      '      results = retry()',
      '    }',
      '  },',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Tool', 'call'])
  })

  test('a call statement that opens a block is not a symbol', () => {
    // The shape the paren test cannot see: this line BEGINS inside a `{`, not
    // inside a `(`, so only the forward declaration-shape scan rejects it. Its
    // brace sits at paren depth 1, inside the argument list.
    const src = [
      'export const Tool = {',
      '  call() {',
      '    setExpandedKeys(prev => {',
      '      return prev',
      '    })',
      '  },',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Tool', 'call'])
  })

  // --- nested landmarks -----------------------------------------------------
  //
  // TS_NESTED_LANDMARKS is { minBodyLines: 20, minParentLines: 100 }. These
  // build their fixtures from those shapes rather than restating the numbers,
  // so a deliberate re-tune moves one constant and these still describe the
  // rule: a nested declaration is a landmark only inside a LARGE body, and only
  // when it is itself substantial.
  const filler = (n: number, indent = '  '): string[] =>
    Array.from({ length: n }, (_, i) => `${indent}doThing(${i})`)

  test('a substantial nested handler inside a large function is a landmark', () => {
    const src = [
      'export function Component() {',
      ...filler(60),
      '  const handleSubmit = useCallback(async () => {',
      ...filler(30, '    '),
      '  }, [])',
      ...filler(40),
      '  return null',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Component', 'handleSubmit'])
    expect(syms[1]).toMatchObject({ kind: 'const', depth: 1 })
  })

  test('the same handler inside a small function stays body noise', () => {
    const src = [
      'export function Component() {',
      '  const handleSubmit = useCallback(async () => {',
      ...filler(30, '    '),
      '  }, [])',
      '  return null',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Component'])
  })

  test('a short nested declaration is not a landmark', () => {
    const src = [
      'export function Component() {',
      ...filler(60),
      '  const handleSubmit = useCallback(() => {',
      '    send()',
      '  }, [])',
      ...filler(60),
      '  return null',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Component'])
  })

  test('a local binding with no brace on its line is never a landmark', () => {
    // bashSecurity.ts:1264 — `let escaped = false` matched the const pattern
    // and, being body-requiring, adopted the next block that opened. The
    // outline reported it as a symbol spanning 240 lines.
    const src = [
      'export function parse() {',
      ...filler(60),
      '  let escaped = false',
      '  for (const ch of input) {',
      ...filler(40, '    '),
      '  }',
      '  return escaped',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['parse'])
  })

  test('landmarks are TypeScript-only — a Java inner class is untouched', () => {
    // Java has no `nestedLandmarks`, so its nested types keep passing the
    // filter on their own terms: this one is 3 lines inside a 5-line class and
    // would fail both size gates.
    const src = [
      'public class Outer {',
      '  static class Builder {',
      '    int x;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')

    expect(syms.map(s => s.name)).toEqual(['Outer', 'Builder'])
  })

  test('a file whose mask leaves brackets unbalanced keeps its declarations', () => {
    // axios' AxiosHeaders.js:32. A backtick inside a regex character class
    // starts a phantom template literal in the mask, which blanks the rest of
    // the file and leaves a `[` unclosed. Every later line then looks like it
    // sits inside an expression, so the paren filter would drop all 33 real
    // declarations. It switches itself off instead.
    const src = [
      'const isValid = (s) => /^[-a-z`|~]+$/.test(s)',
      '',
      'function matchHeaderValue(context, value) {',
      '  return value',
      '}',
      '',
      'function formatHeader(header) {',
      '  return header.trim()',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'javascript')

    expect(syms.map(s => s.name)).toContain('matchHeaderValue')
    expect(syms.map(s => s.name)).toContain('formatHeader')
  })

  test('a call statement does not adopt a later, unrelated block', () => {
    // The bound that stops the forward scan from wandering. `useMountEffect()`
    // closes its own parens and never opens a body; three lines later an `if`
    // does, and without the gap limit that brace is read as its body.
    //
    // The component must be a `const` arrow for this to bite: inside a
    // `call() {}` the statement's nearest enclosing symbol would be a method,
    // which the methodContainers filter drops for an unrelated reason, and the
    // test would pass with the bound deleted.
    const src = [
      'export const Component = () => {',
      '  useMountEffect()',
      '  const a = 1',
      '  const b = 2',
      '  if (a) {',
      '    use(b)',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Component'])
  })

  test('a method named in a doc comment is not a symbol', () => {
    // TS/JS detect on the RAW line, and RE_METHOD tolerates a leading `*`, so
    // `* forceRedraw() this does not …` matched. Reaching forward for a body,
    // it adopted the NEXT method's — and then, being the deeper enclosing
    // symbol, filtered that real method out of the table (ink.tsx).
    const src = [
      'class Ink {',
      '  /**',
      '   * forceRedraw() renders immediately; this does not — the reset',
      '   * applies to the upcoming frame.',
      '   */',
      '  prepareFullRepaint(): void {',
      '    this.repaint()',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')

    expect(syms.map(s => s.name)).toEqual(['Ink', 'prepareFullRepaint'])
    expect(syms[1]).toMatchObject({ startLine: 6, endLine: 8 })
  })

  test('a parameter on a continuation line does not replace its function', () => {
    // curl's http2.c:102-104, the densest form of the defect: `struct
    // Curl_easy *data)` is the second parameter, read as a struct
    // declaration. Because a body-requiring candidate stops at the next
    // candidate's line, that phantom also DELETED `populate_settings` — the
    // scanner reported the parameter and not the function.
    const src = [
      'static size_t populate_settings(nghttp2_settings_entry *iv,',
      '                                struct Curl_easy *data)',
      '{',
      '  return 3;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'c')

    expect(syms.map(s => s.name)).toEqual(['populate_settings'])
    expect(syms[0]).toMatchObject({ startLine: 1, endLine: 5 })
  })

  test('a Java throws clause on its own line still finds the body', () => {
    // Gson.java:1197. The `,` between the thrown types sits at paren depth 0,
    // after the parameter list has closed; treating it as a statement
    // terminator cost every such method in Gson.
    const src = [
      'public class Gson {',
      '  public <T> T fromJson(Reader json, Class<T> classOfT)',
      '      throws JsonSyntaxException, JsonIOException {',
      '    return null;',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'java')

    expect(syms.map(s => s.name)).toEqual(['Gson', 'fromJson'])
    expect(syms[1]).toMatchObject({ startLine: 2, endLine: 5 })
  })

  test('a C# constructor initializer still finds the body', () => {
    // BsonReader.cs:129. `: this(…)` opens one more paren group after the
    // parameter list closed, and the body brace is two lines down.
    const src = [
      'public class BsonReader',
      '{',
      '    public BsonReader(Stream stream)',
      '        : this(stream, false, DateTimeKind.Local)',
      '    {',
      '    }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'csharp')

    expect(syms.map(s => s.name)).toEqual(['BsonReader', 'BsonReader'])
    expect(syms[1]).toMatchObject({ kind: 'method', startLine: 3, endLine: 6 })
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
