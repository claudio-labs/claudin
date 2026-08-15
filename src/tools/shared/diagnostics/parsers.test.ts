import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParseInput } from 'src/tools/shared/diagnostics/types.js'
import { parseCargoJson } from 'src/tools/shared/diagnostics/cargoJson.js'
import { parseDartMachine } from 'src/tools/shared/diagnostics/dartMachine.js'
import { parseDenoText } from 'src/tools/shared/diagnostics/denoText.js'
import { parseGnuStyle } from 'src/tools/shared/diagnostics/gnuStyle.js'
import { scrapeCounts } from 'src/tools/shared/diagnostics/heuristic.js'
import { parseDiagnostics } from 'src/tools/shared/diagnostics/index.js'
import { parseMsvcStyle } from 'src/tools/shared/diagnostics/msvcStyle.js'
import { parsePhpstanJson, parsePsalmJson } from 'src/tools/shared/diagnostics/phpJson.js'
import { parseMypyJson, parsePyrightJson } from 'src/tools/shared/diagnostics/pythonJson.js'

function input(stdout: string, exitCode = 1): ParseInput {
  return { stdout, stderr: '', exitCode }
}

describe('parseMsvcStyle — tsc compact output', () => {
  // Captured from TypeScript 7.0.2 via `tsc --noEmit --pretty false`.
  const COMPACT = [
    "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "a.ts(3,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  ].join('\n')

  test('reads file, line, column, code and message', () => {
    const result = parseMsvcStyle(input(COMPACT))
    expect(result?.diagnostics).toHaveLength(2)
    expect(result?.diagnostics[0]).toMatchObject({
      file: 'a.ts',
      line: 1,
      column: 7,
      severity: 'error',
      code: 'TS2322',
    })
  })

  test('folds indented continuation lines into the message', () => {
    // Real chained output: the explanation lines belong to the diagnostic
    // above them, and losing them loses why the assignment is invalid.
    const chained = [
      "c.ts(2,7): error TS2322: Type '(a: number) => void' is not assignable to type 'Handler'.",
      "  Types of parameters 'a' and 'a' are incompatible.",
      "    Type 'string' is not assignable to type 'number'.",
      'c.ts(4,29): error TS2322: Type ',
    ].join('\n')
    const result = parseMsvcStyle(input(chained))
    expect(result?.diagnostics).toHaveLength(2)
    expect(result?.diagnostics[0]?.message).toContain("Types of parameters 'a' and 'a'")
    expect(result?.diagnostics[0]?.message).toContain("Type 'string' is not assignable")
  })

  test('a package manager command echo does not become a continuation', () => {
    // `bun run typecheck` prints `$ tsc --noEmit …` before the diagnostics.
    const withEcho = ['$ tsc --noEmit --pretty false', 'a.ts(1,7): error TS2322: Nope.'].join('\n')
    const result = parseMsvcStyle(input(withEcho))
    expect(result?.diagnostics).toHaveLength(1)
    expect(result?.diagnostics[0]?.message).toBe('Nope.')
  })

  test('reads a real `dotnet build` line and drops the project suffix', () => {
    // Captured verbatim from the dotnet/sdk:9.0 container. MSBuild appends the
    // owning project to EVERY diagnostic; left in place it would ride along in
    // the message and change the fingerprint for the same error.
    const real =
      "/w/app/Program.cs(1,9): error CS0029: Cannot implicitly convert type 'string' to 'int' [/w/app/app.csproj]"
    const parsed = parseMsvcStyle(input(real))
    expect(parsed?.diagnostics).toHaveLength(1)
    expect(parsed?.diagnostics[0]).toMatchObject({
      file: '/w/app/Program.cs',
      line: 1,
      column: 9,
      code: 'CS0029',
      message: "Cannot implicitly convert type 'string' to 'int'",
    })
  })

  test('pretty layout parses without swallowing the code preview', () => {
    // The shipped Bash-filter fixture is real pretty-mode tsc output. Its
    // `~~~~` underlines are indented, so a naive continuation rule would fold
    // them into the message.
    const fixture = readFileSync(
      join(
        import.meta.dir,
        '../../../outputFilter/Bash/__fixtures__/samples/tsc-errors.txt',
      ),
      'utf8',
    )
    const result = parseMsvcStyle(input(fixture))
    expect(result?.diagnostics.length).toBeGreaterThan(3)
    expect(result?.diagnostics[0]).toMatchObject({
      file: 'src/utils/parser.ts',
      line: 23,
      code: 'TS2322',
    })
    for (const d of result?.diagnostics ?? []) {
      expect(d.message).not.toContain('~~~')
    }
  })

  test('a right-aligned pretty preview is not folded into the message', () => {
    // tsc pads line numbers to the widest in the file, so a two-digit line in a
    // file with three-digit lines is printed with a LEADING SPACE — which makes
    // the code preview look exactly like a chained explanation. Only the blank
    // line after the header separates them.
    const padded = [
      "src/a.ts:9:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
      '',
      '  9     count: "five",',
      '        ~~~~~',
      '',
      "src/a.ts:123:5 - error TS2304: Cannot find name 'x'.",
      '',
      '123     x();',
      '        ~',
      '',
    ].join('\n')
    const result = parseMsvcStyle(input(padded))
    expect(result?.diagnostics).toHaveLength(2)
    expect(result?.diagnostics[0]?.message).toBe(
      "Type 'string' is not assignable to type 'number'.",
    )
    expect(result?.diagnostics[1]?.line).toBe(123)
  })

  test('MSBuild diagnostics drop the repeated project suffix', () => {
    const msbuild =
      "/p/Program.cs(12,20): error CS0103: The name 'x' does not exist [/p/app.csproj]"
    const result = parseMsvcStyle(input(msbuild))
    expect(result?.diagnostics[0]?.code).toBe('CS0103')
    expect(result?.diagnostics[0]?.message).not.toContain('.csproj')
  })

  test('returns null on unrelated text', () => {
    expect(parseMsvcStyle(input('everything is fine'))).toBeNull()
  })
})

describe('parseGnuStyle', () => {
  test('reads go build output and skips its package headers', () => {
    const go = ['# example.com/m/pkg', './main.go:6:2: undefined: foo'].join('\n')
    const result = parseGnuStyle(input(go))
    expect(result?.diagnostics).toHaveLength(1)
    expect(result?.diagnostics[0]).toMatchObject({
      file: './main.go',
      line: 6,
      column: 2,
      severity: 'error',
      message: 'undefined: foo',
    })
  })

  test('reads javac and the maven bracket variant', () => {
    // Captured verbatim from javac 17.0.12. Note the trailing prose: javac ends
    // with a `Note:` line and an `N errors` count, and echoes the offending
    // source with a caret — none of which may become a diagnostic.
    const javac = [
      'Main.java:3: error: incompatible types: String cannot be converted to int',
      '    int n = "not a number";',
      '            ^',
      'Main.java:5: error: incompatible types: int cannot be converted to String',
      '    xs.add(42);',
      '           ^',
      'Note: Some messages have been simplified; recompile with -Xdiags:verbose to get full output',
      '2 errors',
    ].join('\n')
    const parsed = parseGnuStyle(input(javac))
    expect(parsed?.diagnostics).toHaveLength(2)
    expect(parsed?.diagnostics[0]).toMatchObject({
      file: 'Main.java',
      line: 3,
      severity: 'error',
      message: 'incompatible types: String cannot be converted to int',
    })
    // javac reports no column; inventing one would break fingerprint matching.
    expect(parsed?.diagnostics[0]?.column).toBeUndefined()

    const maven = '[ERROR] /p/Main.java:[12,20] cannot find symbol'
    expect(parseGnuStyle(input(maven))?.diagnostics[0]).toMatchObject({
      line: 12,
      column: 20,
      severity: 'error',
    })
  })

  test('a real gradle build reports each javac error exactly once', () => {
    // Captured verbatim from gradle 8.14 (gradle:8-jdk17). Gradle prints the
    // SAME compiler error twice — once as task output, once indented under
    // "What went wrong" — and surrounds it with URLs and a `file://` link. Only
    // the unindented copy may count, or every gradle diagnostic doubles and the
    // baseline records two fingerprints for one error.
    const gradle = [
      '> Task :compileJava FAILED',
      '/w/src/platform/main/java/Main.java:3: error: incompatible types: String cannot be converted to int',
      '    int n = "not a number";',
      '            ^',
      '1 error',
      '',
      '[Incubating] Problems report is available at: file:///w/build/reports/problems/problems-report.html',
      '',
      'FAILURE: Build failed with an exception.',
      '',
      '* What went wrong:',
      "Execution failed for task ':compileJava'.",
      '> Compilation failed; see the compiler output below.',
      '  /w/src/platform/main/java/Main.java:3: error: incompatible types: String cannot be converted to int',
      '      int n = "not a number";',
      '              ^',
      '  1 error',
      '',
      'BUILD FAILED in 5s',
    ].join('\n')
    const parsed = parseGnuStyle(input(gradle))
    expect(parsed?.diagnostics).toHaveLength(1)
    expect(parsed?.diagnostics[0]).toMatchObject({
      file: '/w/src/platform/main/java/Main.java',
      line: 3,
      message: 'incompatible types: String cannot be converted to int',
    })
  })
})

describe('parseDenoText', () => {
  // Captured verbatim from deno 2.9.3 (`deno check main.ts`, NO_COLOR=1).
  // The code sits on its own header line — there is no `error:` prefix — and
  // the run ends with a bare summary line that is NOT a diagnostic.
  const DENO = [
    'Check main.ts',
    "TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.",
    'export const n: number = "not a number"',
    '             ^',
    '    at file:///tmp/dn/main.ts:1:14',
    '',
    'error: Type checking failed.',
  ].join('\n')

  test('joins the header with the position line that follows it', () => {
    const result = parseDenoText(input(DENO))
    expect(result?.diagnostics).toHaveLength(1)
    expect(result?.diagnostics[0]).toMatchObject({
      file: '/tmp/dn/main.ts',
      line: 1,
      column: 14,
      code: 'TS2322',
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'.",
    })
  })

  test('the trailing "Type checking failed" summary is not a diagnostic', () => {
    // It has no position, so it would fingerprint as an error at line 0 that no
    // later run could ever match — permanently "new".
    const result = parseDenoText(input(DENO))
    expect(result?.diagnostics.map(d => d.message)).not.toContain('Type checking failed.')
  })

  test('a bare error: header IS reported once a location confirms it', () => {
    const unresolved = [
      'error: Relative import path "utils" not prefixed with / or ./ or ../',
      '    at file:///abs/mod.ts:3:20',
    ].join('\n')
    expect(parseDenoText(input(unresolved))?.diagnostics[0]).toMatchObject({
      file: '/abs/mod.ts',
      line: 3,
      column: 20,
    })
  })

  test('reads the coloured form, which deno emits even under NO_COLOR', () => {
    // deno colourises whenever FORCE_COLOR is merely PRESENT, whatever its
    // value, so the escape stripping in parseDiagnostics is load-bearing.
    const coloured = [
      '\u001B[0m\u001B[32mCheck\u001B[0m main.ts',
      "\u001B[0m\u001B[1mTS2322 \u001B[0m[ERROR]: Type 'string' is not assignable to type 'number'.",
      '    at \u001B[0m\u001B[36mfile:///tmp/dn/main.ts\u001B[0m:\u001B[0m\u001B[33m1\u001B[0m:\u001B[0m\u001B[33m14\u001B[0m',
    ].join('\n')
    const outcome = parseDiagnostics([parseDenoText], input(coloured))
    expect(outcome.degraded).toBe(false)
    expect(outcome.diagnostics[0]).toMatchObject({
      file: '/tmp/dn/main.ts',
      line: 1,
      column: 14,
      code: 'TS2322',
    })
  })
})

describe('parseCargoJson', () => {
  test('keeps the primary span and drops non-diagnostic events', () => {
    const stream = [
      JSON.stringify({ reason: 'compiler-artifact', target: {} }),
      JSON.stringify({
        reason: 'compiler-message',
        message: {
          level: 'error',
          message: 'mismatched types',
          code: { code: 'E0308' },
          spans: [
            { file_name: 'src/lib.rs', line_start: 99, is_primary: false },
            { file_name: 'src/platform/main.rs', line_start: 4, column_start: 9, is_primary: true },
          ],
        },
      }),
      JSON.stringify({
        reason: 'compiler-message',
        message: { level: 'note', message: 'defined here', spans: [] },
      }),
    ].join('\n')
    const result = parseCargoJson(input(stream))
    expect(result?.diagnostics).toHaveLength(1)
    expect(result?.diagnostics[0]).toMatchObject({
      file: 'src/platform/main.rs',
      line: 4,
      code: 'E0308',
    })
  })
})

describe('python parsers', () => {
  test('pyright ranges are converted from 0-based to 1-based', () => {
    const doc = JSON.stringify({
      generalDiagnostics: [
        {
          file: '/p/a.py',
          severity: 'error',
          message: 'oops',
          rule: 'reportGeneralTypeIssues',
          range: { start: { line: 9, character: 4 } },
        },
      ],
    })
    const result = parsePyrightJson(input(doc))
    expect(result?.diagnostics[0]).toMatchObject({ line: 10, column: 5 })
  })

  test('mypy notes are not diagnostics', () => {
    const stream = [
      JSON.stringify({ file: 'a.py', line: 3, severity: 'error', message: 'bad', code: 'assignment' }),
      JSON.stringify({ file: 'a.py', line: 3, severity: 'note', message: 'see here' }),
    ].join('\n')
    const result = parseMypyJson(input(stream))
    expect(result?.diagnostics).toHaveLength(1)
  })
})

describe('parseDartMachine', () => {
  test('reads a real `dart analyze --format=machine` record', () => {
    // Captured verbatim from the dart:stable container. The machine format
    // reports absolute paths and an 8th "length" field the human format omits.
    const record =
      "ERROR|COMPILE_TIME_ERROR|INVALID_ASSIGNMENT|/w/bin/main.dart|2|11|14|A value of type 'String' can't be assigned to a variable of type 'int'."
    const result = parseDartMachine(input(record, 3))
    expect(result?.diagnostics).toHaveLength(1)
    expect(result?.diagnostics[0]).toMatchObject({
      file: '/w/bin/main.dart',
      line: 2,
      column: 11,
      severity: 'error',
      code: 'INVALID_ASSIGNMENT',
      message: "A value of type 'String' can't be assigned to a variable of type 'int'.",
    })
  })

  test('keeps a message containing an escaped pipe', () => {
    const record = String.raw`ERROR|COMPILE_TIME_ERROR|UNDEFINED_METHOD|/p/a.dart|3|5|10|Use a \| here.`
    const result = parseDartMachine(input(record))
    expect(result?.diagnostics[0]).toMatchObject({
      file: '/p/a.dart',
      line: 3,
      code: 'UNDEFINED_METHOD',
      message: 'Use a | here.',
    })
  })
})

describe('php parsers', () => {
  test('reads real phpstan JSON, preamble line and all', () => {
    // Captured verbatim from phpstan 2.x in the composer:2 container. phpstan
    // prints a `Note:` line BEFORE the JSON even under --no-progress, so the
    // document has to be located rather than assumed to start at byte 0.
    const real =
      'Note: Using configuration file /w/phpstan.neon.\n' +
      '{"totals":{"errors":0,"file_errors":2},"files":{"/w/src/Money.php":{"errors":2,"messages":[' +
      '{"message":"Method Money::cents() should return int but returns string.","line":4,"ignorable":true,"identifier":"return.type"},' +
      '{"message":"Call to an undefined method Money::missingMethod().","line":7,"ignorable":true,"identifier":"method.notFound"}' +
      ']}},"errors":[]}'
    const parsed = parsePhpstanJson(input(real))
    expect(parsed?.diagnostics).toHaveLength(2)
    expect(parsed?.diagnostics[0]).toMatchObject({
      file: '/w/src/Money.php',
      line: 4,
      code: 'return.type',
      severity: 'error',
    })
  })

  test('reads a real psalm issue array', () => {
    // Captured verbatim from psalm 6.x. Note `line_from`/`column_from` rather
    // than line/column, and the escaped forward slashes in its JSON.
    const real =
      '[{"link":"https:\\/\\/psalm.dev\\/011","severity":"error","line_from":3,"line_to":3,' +
      '"type":"InvalidReturnType","message":"The declared return type \'int\' for Money::cents is incorrect, got \'\'not a number\'\'",' +
      '"file_name":"src\\/Money.php","file_path":"\\/w\\/src\\/Money.php","column_from":28,"column_to":31,"shortcode":11,"error_level":6}]'
    const parsed = parsePsalmJson(input(real, 2))
    expect(parsed?.diagnostics).toHaveLength(1)
    expect(parsed?.diagnostics[0]).toMatchObject({
      file: '/w/src/Money.php',
      line: 3,
      column: 28,
      code: 'InvalidReturnType',
      severity: 'error',
    })
  })

  test('phpstan messages are flattened out of the files map', () => {
    const doc = JSON.stringify({
      files: { 'src/A.php': { errors: 1, messages: [{ message: 'boom', line: 7 }] } },
    })
    expect(parsePhpstanJson(input(doc))?.diagnostics[0]).toMatchObject({
      file: 'src/A.php',
      line: 7,
    })
  })

  test('psalm returns a flat array', () => {
    const doc = JSON.stringify([
      { severity: 'error', type: 'InvalidReturnType', message: 'nope', file_path: 'src/B.php', line_from: 4 },
    ])
    expect(parsePsalmJson(input(doc))?.diagnostics[0]).toMatchObject({
      file: 'src/B.php',
      line: 4,
      code: 'InvalidReturnType',
    })
  })
})

describe('parseDiagnostics chain', () => {
  test('a clean exit with no output is a pass, not a degraded run', () => {
    const outcome = parseDiagnostics([parseMsvcStyle], input('', 0))
    expect(outcome.degraded).toBe(false)
    expect(outcome.diagnostics).toEqual([])
  })

  test('falls back to the generic parsers when the native one finds nothing', () => {
    // A cargo run through a composed script never gets --message-format=json,
    // so its human output must still be read rather than degraded.
    const outcome = parseDiagnostics([parseCargoJson], input('src/platform/main.rs:4:9: mismatched types'))
    expect(outcome.degraded).toBe(false)
    expect(outcome.diagnostics[0]?.line).toBe(4)
  })

  test('unreadable failing output degrades with a scraped count', () => {
    const outcome = parseDiagnostics([parseMsvcStyle], input('something went badly error somewhere', 2))
    expect(outcome.degraded).toBe(true)
    expect(outcome.estimatedErrors).toBeGreaterThan(0)
  })
})

describe('scrapeCounts', () => {
  test('never reports zero errors for a failing run', () => {
    expect(scrapeCounts(input('total silence', 1)).errors).toBe(1)
  })

  test('ignores summary lines that would double-count', () => {
    expect(scrapeCounts(input('Found 3 errors in 2 files.', 1)).errors).toBe(1)
  })
})
