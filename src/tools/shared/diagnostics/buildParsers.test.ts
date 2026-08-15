import { describe, expect, test } from 'bun:test'
import { parseBunBuild } from 'src/tools/shared/diagnostics/bunBuild.js'
import { parseEsbuild } from 'src/tools/shared/diagnostics/esbuild.js'
import { parseGnuStyle } from 'src/tools/shared/diagnostics/gnuStyle.js'
import { parseDiagnostics } from 'src/tools/shared/diagnostics/index.js'
import { parseKotlinc } from 'src/tools/shared/diagnostics/kotlinc.js'
import { parseMixCompile } from 'src/tools/shared/diagnostics/mixCompile.js'
import { parseSbtBracket } from 'src/tools/shared/diagnostics/sbtBracket.js'
import type { ParseInput } from 'src/tools/shared/diagnostics/types.js'

function input(stdout: string, exitCode = 1): ParseInput {
  return { stdout, stderr: '', exitCode }
}

describe('parseKotlinc', () => {
  test('reads the file:// form gradle prints', () => {
    const out = [
      '> Task :app:compileKotlin FAILED',
      'e: file:///p/src/main/kotlin/Foo.kt:10:20 Unresolved reference: bar',
      "w: file:///p/src/main/kotlin/Foo.kt:3:5 Variable 'x' is never used",
    ].join('\n')
    expect(parseKotlinc(input(out))?.diagnostics).toEqual([
      {
        file: '/p/src/main/kotlin/Foo.kt',
        line: 10,
        column: 20,
        severity: 'error',
        message: 'Unresolved reference: bar',
      },
      {
        file: '/p/src/main/kotlin/Foo.kt',
        line: 3,
        column: 5,
        severity: 'warning',
        message: "Variable 'x' is never used",
      },
    ])
  })

  test('keeps the drive letter of a windows file:// URI', () => {
    const out = 'e: file:///C:/p/Foo.kt:4:9 Unresolved reference: bar'
    expect(parseKotlinc(input(out))?.diagnostics[0]).toMatchObject({
      file: '/C:/p/Foo.kt',
      line: 4,
      column: 9,
    })
  })

  test('reads the parenthesised form older gradle plugins emit', () => {
    const out = 'e: /p/src/main/kotlin/Foo.kt: (10, 20): Unresolved reference: bar'
    expect(parseKotlinc(input(out))?.diagnostics[0]).toEqual({
      file: '/p/src/main/kotlin/Foo.kt',
      line: 10,
      column: 20,
      severity: 'error',
      message: 'Unresolved reference: bar',
    })
  })

  test('skips compiler self-talk that names no source position', () => {
    const out = ['w: Kotlin plugin should be enabled before', 'e: some toolchain complaint'].join(
      '\n',
    )
    expect(parseKotlinc(input(out))).toBeNull()
  })
})

describe('parseSbtBracket', () => {
  test('reads the scala 2 position line', () => {
    const out = [
      '[error] /p/src/main/scala/Foo.scala:12:5: not found: value bar',
      '[warn] /p/src/main/scala/Foo.scala:3:1: unused import',
    ].join('\n')
    expect(parseSbtBracket(input(out))?.diagnostics).toEqual([
      {
        file: '/p/src/main/scala/Foo.scala',
        line: 12,
        column: 5,
        severity: 'error',
        message: 'not found: value bar',
      },
      {
        file: '/p/src/main/scala/Foo.scala',
        line: 3,
        column: 1,
        severity: 'warning',
        message: 'unused import',
      },
    ])
  })

  test('reads the scala 3 block head and keeps its error class', () => {
    const out = '[error] -- [E006] Not Found Error: /p/Foo.scala:12:4 ---------------'
    expect(parseSbtBracket(input(out))?.diagnostics[0]).toEqual({
      file: '/p/Foo.scala',
      line: 12,
      column: 4,
      severity: 'error',
      code: 'E006',
      message: 'Not Found Error',
    })
  })

  test('ignores sbt talking about the build rather than the source', () => {
    const out = [
      '[error] (Compile / compileIncremental) Compilation failed',
      '[error] Total time: 3 s, completed 4 Aug 2026',
    ].join('\n')
    expect(parseSbtBracket(input(out))).toBeNull()
  })

  test('a timestamp is not a position — hence the required source extension', () => {
    // `12:30:45 Server ready` has the exact shape of `line:column: message`, so
    // without the extension requirement a logged clock reads as a diagnostic in
    // a file with no name.
    expect(parseSbtBracket(input('[error] 12:30:45 Server ready'))).toBeNull()
  })

  test('is what keeps gnuStyle from capturing the prefix as part of the path', () => {
    // The regression this parser exists for: gnuStyle's file group accepts
    // spaces, so the bracket prefix ends up inside the path.
    const line = '[error] /p/Foo.scala:12:5: not found: value bar'
    expect(parseGnuStyle(input(line))?.diagnostics[0]?.file).toBe('[error] /p/Foo.scala')
    expect(parseSbtBracket(input(line))?.diagnostics[0]?.file).toBe('/p/Foo.scala')
  })
})

describe('parseEsbuild', () => {
  test('pairs the message with the position line below it', () => {
    const out = [
      '✘ [ERROR] Could not resolve "./missing"',
      '',
      '    src/app.ts:3:18:',
      '      3 │ import x from "./missing"',
      '        ╵                   ~~~~~~~~',
    ].join('\n')
    expect(parseEsbuild(input(out))?.diagnostics[0]).toEqual({
      file: 'src/app.ts',
      line: 3,
      column: 18,
      severity: 'error',
      message: 'Could not resolve "./missing"',
    })
  })

  test('strips the plugin tag and reads the warning marker', () => {
    const out = ['▲ [WARNING] [plugin vite:resolve] duplicate key', '', '    src/a.ts:1:2:'].join(
      '\n',
    )
    expect(parseEsbuild(input(out))?.diagnostics[0]).toMatchObject({
      severity: 'warning',
      message: 'duplicate key',
      file: 'src/a.ts',
    })
  })

  test('keeps a block that has no position rather than dropping the failure', () => {
    const out = '✘ [ERROR] Could not resolve entry point "src/nope.ts"'
    expect(parseEsbuild(input(out))?.diagnostics[0]).toMatchObject({
      file: '',
      line: 0,
      severity: 'error',
    })
  })

  test('does not pair a message with the next block position', () => {
    const out = [
      '✘ [ERROR] first',
      '',
      '',
      '',
      '',
      '✘ [ERROR] second',
      '',
      '    src/b.ts:9:1:',
    ].join('\n')
    const diagnostics = parseEsbuild(input(out))!.diagnostics
    expect(diagnostics[0]).toMatchObject({ message: 'first', file: '' })
    expect(diagnostics[1]).toMatchObject({ message: 'second', file: 'src/b.ts' })
  })
})

describe('parseMixCompile', () => {
  test('reads the raised compile error', () => {
    const out = [
      '== Compilation error in file lib/foo.ex ==',
      '** (CompileError) lib/foo.ex:12: undefined function bar/0',
    ].join('\n')
    expect(parseMixCompile(input(out))?.diagnostics[0]).toEqual({
      file: 'lib/foo.ex',
      line: 12,
      column: undefined,
      severity: 'error',
      code: 'CompileError',
      message: 'undefined function bar/0',
    })
  })

  test('carries the block message forward to its box-drawing footer', () => {
    const out = [
      '    warning: variable "x" is unused',
      '    │',
      '  5 │   x = 1',
      '    │',
      '    └─ lib/foo.ex:5:3: Foo.run/0',
    ].join('\n')
    expect(parseMixCompile(input(out))?.diagnostics[0]).toEqual({
      file: 'lib/foo.ex',
      line: 5,
      column: 3,
      severity: 'warning',
      message: 'variable "x" is unused',
    })
  })

  test('closes the older two-line form as well', () => {
    const out = ['warning: variable "y" is unused', '  lib/bar.ex:7'].join('\n')
    expect(parseMixCompile(input(out))?.diagnostics[0]).toMatchObject({
      file: 'lib/bar.ex',
      line: 7,
      severity: 'warning',
    })
  })

  test('drops a message that never gets a position', () => {
    const out = ['warning: first thing', 'warning: second thing', '  lib/bar.ex:7'].join('\n')
    const diagnostics = parseMixCompile(input(out))!.diagnostics
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.message).toBe('second thing')
  })
})

describe('parseBunBuild', () => {
  test('pairs the message with the at-line below it', () => {
    // Captured from `bun build ./broken.ts --outdir=out`.
    const out = [
      '1 | export const x = = 1',
      '                    ^',
      'error: Unexpected =',
      '    at /p/src/broken.ts:1:18',
    ].join('\n')
    expect(parseBunBuild(input(out))?.diagnostics[0]).toEqual({
      file: '/p/src/broken.ts',
      line: 1,
      column: 18,
      severity: 'error',
      message: 'Unexpected =',
    })
  })

  test('ignores a stack frame, which uses the same keyword', () => {
    // A bundler crash must not be reported as a list of diagnostics pointing
    // into the bundler's own source. What excludes a frame is POSITION_RE's end
    // anchor: a frame closes with `)`, so its column is not the end of the line.
    const named = ['error: something threw', '    at build (/p/node_modules/x/index.js:9:3)']
    const anonymous = ['error: something threw', '    at (/p/node_modules/x/index.js:9:3)']
    expect(parseBunBuild(input(named.join('\n')))).toBeNull()
    expect(parseBunBuild(input(anonymous.join('\n')))).toBeNull()
  })
})

describe('parseDiagnostics with several native parsers', () => {
  test('merges the formats one gradle run emits from two tasks', () => {
    const out = [
      'e: file:///p/src/main/kotlin/Foo.kt:10:20 Unresolved reference: bar',
      '/p/src/main/java/Bar.java:7: error: cannot find symbol',
    ].join('\n')
    const outcome = parseDiagnostics([parseKotlinc, parseGnuStyle], input(out))
    expect(outcome.degraded).toBe(false)
    expect(outcome.diagnostics.map(d => d.file)).toEqual([
      '/p/src/main/kotlin/Foo.kt',
      '/p/src/main/java/Bar.java',
    ])
  })

  test('reports one entry when two native parsers read the same line', () => {
    const out = '/p/src/main/java/Bar.java:7: error: cannot find symbol'
    const outcome = parseDiagnostics([parseGnuStyle, parseGnuStyle], input(out))
    expect(outcome.diagnostics).toHaveLength(1)
  })
})
