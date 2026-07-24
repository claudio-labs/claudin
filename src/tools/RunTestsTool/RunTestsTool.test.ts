import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyFilters } from './RunTestsTool.js'
import { readReportDir } from './run.js'
import { buildDossier } from './dossier.js'
import { detectFrameworkFromCommand } from './detect.js'
import { formatTestResult } from './budget.js'
import { parseCargo } from './parsers/cargo.js'
import { parseDart } from './parsers/dartTest.js'
import { parseGoJson } from './parsers/goTest.js'
import { parseHeuristic } from './parsers/heuristic.js'
import { parseJUnitXml } from './parsers/junitXml.js'
import { parseTap } from './parsers/tap.js'
import { parseTestOutput } from './parsers/index.js'
import { hasWatchFlag, isWrappedScript, planReporter } from './reporters.js'
import {
  enrichFailuresWithStackLocation,
  extractFileLine,
  refineFailureLinesFromStdout,
} from './stackTrace.js'
import type { Framework, ParseInput, TestFailure, TestResult } from './types.js'

function emptyInput(over: Partial<ParseInput> = {}): ParseInput {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}

describe('detectFrameworkFromCommand', () => {
  test('maps each runner command to its framework', () => {
    const cases: Array<[string, Framework]> = [
      ['npx vitest run', 'vitest'],
      ['pnpm jest --ci', 'jest'],
      ['bun test', 'bun'],
      ['pytest tests/', 'pytest'],
      ['python -m pytest', 'pytest'],
      ['go test ./...', 'go'],
      ['cargo nextest run', 'nextest'],
      ['cargo test', 'cargo'],
      ['bundle exec rspec', 'rspec'],
      ['dotnet test', 'dotnet'],
      ['mvn test', 'maven'],
      ['./gradlew test', 'gradle'],
      ['deno test', 'deno'],
      ['dart test', 'dart'],
      ['flutter test', 'dart'],
      ['ctest --test-dir build', 'ctest'],
      ['vendor/bin/pest', 'pest'],
      ['npx playwright test', 'playwright'],
      ['mix test', 'elixir'],
      ['rake test', 'minitest'],
      ['bin/rails test', 'minitest'],
      ['make build', 'unknown'],
      // `pest` must match only as a command token, not the bare English word.
      ['echo the best pest around', 'unknown'],
    ]
    for (const [cmd, fw] of cases) {
      expect(detectFrameworkFromCommand(cmd)).toBe(fw)
    }
  })
})

describe('parseJUnitXml', () => {
  test('pytest-style with file/line attributes', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="pytest" tests="3" failures="1" errors="0" skipped="1" time="0.42">
    <testcase classname="tests.test_math" name="test_add" file="tests/test_math.py" line="4" time="0.01"/>
    <testcase classname="tests.test_math" name="test_sub" file="tests/test_math.py" line="9" time="0.01">
      <failure message="assert 3 == 4" type="AssertionError">tests/test_math.py:9: assert 3 == 4</failure>
    </testcase>
    <testcase classname="tests.test_math" name="test_skip"><skipped/></testcase>
  </testsuite>
</testsuites>`
    const r = parseJUnitXml(xml, 'pytest', 'pytest', 1)
    expect(r).not.toBeNull()
    expect(r!.total).toBe(3)
    expect(r!.failed).toBe(1)
    expect(r!.skipped).toBe(1)
    expect(r!.passed).toBe(1)
    expect(r!.failures).toHaveLength(1)
    expect(r!.failures[0].file).toBe('tests/test_math.py')
    expect(r!.failures[0].line).toBe(9)
    expect(r!.failures[0].message).toBe('assert 3 == 4')
  })

  test('counts testcases when suite has no count attributes', () => {
    const xml = `<testsuite name="s">
      <testcase name="a"/>
      <testcase name="b"><failure message="boom">stack</failure></testcase>
    </testsuite>`
    const r = parseJUnitXml(xml, 'unknown', 'x', 1)
    expect(r!.total).toBe(2)
    expect(r!.failed).toBe(1)
    expect(r!.passed).toBe(1)
  })

  test('nested <testsuite> per describe is not multi-counted (bun/jest)', () => {
    // bun wraps a file-level <testsuite> around per-describe <testsuite>s, all
    // carrying tests= attributes. Summing them would report 4; testcases say 2.
    const xml = `<testsuites name="bun test" tests="2" failures="1">
      <testsuite name="file.test.ts" tests="2" failures="1" time="0.3">
        <testsuite name="groupA" tests="1" failures="0">
          <testcase name="a" classname="groupA" />
        </testsuite>
        <testsuite name="groupB" tests="1" failures="1">
          <testcase name="b" classname="groupB"><failure message="boom">x</failure></testcase>
        </testsuite>
      </testsuite>
    </testsuites>`
    const r = parseJUnitXml(xml, 'bun', 'bun test', 1)
    expect(r!.total).toBe(2)
    expect(r!.failed).toBe(1)
    expect(r!.passed).toBe(1)
  })

  test('prefers stack-trace assertion line over testcase declaration line', () => {
    // bun sets <testcase line=> to the test() declaration (7); the stack frame
    // inside the same file points at the failing expect (8) — report the latter.
    const xml = `<testsuites tests="1" failures="1">
      <testsuite name="a.test.ts" file="src/a.test.ts" tests="1" failures="1">
        <testcase name="multiplies wrong" classname="a.test.ts" file="src/a.test.ts" line="7">
          <failure message="expected 9 to be 10">at &lt;anonymous&gt; (/home/u/proj/src/a.test.ts:8:17)</failure>
        </testcase>
      </testsuite>
    </testsuites>`
    const r = parseJUnitXml(xml, 'bun', 'bun test', 1)
    expect(r!.failures).toHaveLength(1)
    expect(r!.failures[0].file).toBe('src/a.test.ts')
    expect(r!.failures[0].line).toBe(8)
  })

  test('maven surefire: file/line from the Java stack in the <failure> body', () => {
    // surefire testcases carry no file/line attrs — the location lives in the
    // failure body's JVM stack frame.
    const xml = `<testsuite name="com.foo.BarTest" tests="2" failures="1" errors="0" skipped="0">
      <testcase name="passes" classname="com.foo.BarTest" time="0.01"/>
      <testcase name="shouldWork" classname="com.foo.BarTest" time="0.02">
        <failure message="expected:&lt;1&gt; but was:&lt;2&gt;" type="org.opentest4j.AssertionFailedError">
org.opentest4j.AssertionFailedError: expected:&lt;1&gt; but was:&lt;2&gt;
	at com.foo.BarTest.shouldWork(BarTest.java:42)
        </failure>
      </testcase>
    </testsuite>`
    const r = parseJUnitXml(xml, 'maven', 'mvn test', 1)
    expect(r!.total).toBe(2)
    expect(r!.failed).toBe(1)
    expect(r!.failures[0].file).toBe('BarTest.java')
    expect(r!.failures[0].line).toBe(42)
  })

  test('returns null on non-JUnit input', () => {
    expect(parseJUnitXml('hello world', 'unknown', 'x', 0)).toBeNull()
  })
})

describe('parseTap', () => {
  test('ok / not ok / skip with YAML diagnostics', () => {
    const tap = `TAP version 13
1..3
ok 1 - adds
not ok 2 - subtracts
  ---
  message: 'expected 3 to equal 4'
  at:
    file: test/math.js
    line: 12
  ...
ok 3 - divides # SKIP not ready`
    const r = parseTap(tap, 'node-test', 'node --test', 1)
    expect(r).not.toBeNull()
    expect(r!.passed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.skipped).toBe(1)
    expect(r!.failures[0].message).toBe('expected 3 to equal 4')
    expect(r!.failures[0].file).toBe('test/math.js')
    expect(r!.failures[0].line).toBe(12)
  })

  test('returns null without ok lines', () => {
    expect(parseTap('no tap here', 'unknown', 'x', 0)).toBeNull()
  })
})

describe('parseGoJson', () => {
  test('aggregates pass/fail and pulls file:line', () => {
    const events = [
      { Action: 'run', Package: 'p', Test: 'TestA' },
      { Action: 'pass', Package: 'p', Test: 'TestA' },
      { Action: 'run', Package: 'p', Test: 'TestB' },
      { Action: 'output', Package: 'p', Test: 'TestB', Output: '    math_test.go:17: got 3 want 4\\n' },
      { Action: 'fail', Package: 'p', Test: 'TestB' },
    ]
      .map(e => JSON.stringify(e))
      .join('\n')
    const r = parseGoJson(emptyInput({ stdout: events, exitCode: 1 }), 'go test -json')
    expect(r).not.toBeNull()
    expect(r!.passed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.failures[0].name).toBe('TestB')
    expect(r!.failures[0].file).toBe('math_test.go')
    expect(r!.failures[0].line).toBe(17)
  })
})

describe('parseDart', () => {
  test('aggregates pass/fail/skip and takes the assertion line from the stack', () => {
    const events = [
      { type: 'testStart', test: { id: 1, name: 'adds', url: 'file:///p/test/math_test.dart', line: 4 } },
      { type: 'testDone', testID: 1, result: 'success', hidden: false, skipped: false },
      { type: 'testStart', test: { id: 2, name: 'multiplies', url: 'file:///p/test/math_test.dart', line: 8 } },
      {
        type: 'error',
        testID: 2,
        error: 'Expected: <10>\n  Actual: <9>',
        stackTrace: 'test/math_test.dart 9:5   main.<fn>\n',
        isFailure: true,
      },
      { type: 'testDone', testID: 2, result: 'failure', hidden: false, skipped: false },
      { type: 'testStart', test: { id: 3, name: 'pending', url: 'file:///p/test/math_test.dart', line: 12 } },
      { type: 'testDone', testID: 3, result: 'success', hidden: false, skipped: true },
      // hidden group entry must be ignored.
      { type: 'testDone', testID: 99, result: 'success', hidden: true, skipped: false },
      { type: 'done', success: false },
    ]
      .map(e => JSON.stringify(e))
      .join('\n')
    const r = parseDart(emptyInput({ stdout: events, exitCode: 1 }), 'dart test --reporter=json')
    expect(r).not.toBeNull()
    expect(r!.passed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.skipped).toBe(1)
    expect(r!.total).toBe(3)
    expect(r!.failures[0].name).toBe('multiplies')
    expect(r!.failures[0].file).toBe('/p/test/math_test.dart')
    // declaration line is 8; the stack pinpoints the failing assertion at 9.
    expect(r!.failures[0].line).toBe(9)
  })

  test('returns null on non-Dart-JSON input', () => {
    expect(parseDart(emptyInput({ stdout: 'plain text' }), 'dart test')).toBeNull()
  })
})

describe('parseCargo', () => {
  test('parses libtest text with panic location', () => {
    const out = `running 2 tests
test tests::ok_one ... ok
test tests::bad_two ... FAILED

failures:

---- tests::bad_two stdout ----
thread 'tests::bad_two' panicked at src/lib.rs:42:9:
assertion \`left == right\` failed
  left: 1
  right: 2

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`
    const r = parseCargo(emptyInput({ stdout: out, exitCode: 101 }), 'cargo test')
    expect(r).not.toBeNull()
    expect(r!.passed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.failures[0].name).toBe('tests::bad_two')
    expect(r!.failures[0].file).toBe('src/lib.rs')
    expect(r!.failures[0].line).toBe(42)
  })
})

describe('parseHeuristic', () => {
  test('scrapes pytest-style summary counts and marks degraded', () => {
    const out = `===== 1 failed, 4 passed, 2 skipped in 0.53s =====`
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'pytest', 'pytest')
    expect(r.degraded).toBe(true)
    expect(r.passed).toBe(4)
    expect(r.failed).toBe(1)
    expect(r.skipped).toBe(2)
  })

  test('Elixir ExUnit "N tests, M failures" → passed = tests - failures', () => {
    const out = `  1) test multiplies (MathTest)\n     test/math_test.exs:8\n\n5 tests, 2 failures`
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'elixir', 'mix test')
    expect(r.total).toBe(5)
    expect(r.passed).toBe(3)
    expect(r.failed).toBe(2)
    // best-effort file:line from the ExUnit failure block.
    expect(r.failures[0]?.file).toBe('test/math_test.exs')
    expect(r.failures[0]?.line).toBe(8)
  })

  test('a passing run with a prose numbered list produces no phantom failures', () => {
    // Regression: the ExUnit/minitest `N)` failure marker must not fire on an
    // ordered list in otherwise-passing output.
    const out = `Setup steps:\n1) install deps\n2) run migrations\n\n10 tests, 0 failures`
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 0 }), 'elixir', 'mix test')
    expect(r.failed).toBe(0)
    expect(r.failures).toHaveLength(0)
    expect(r.passed).toBe(10)
  })

  test('Ruby minitest "runs/failures/errors/skips" counts', () => {
    const out = `3 runs, 5 assertions, 1 failures, 1 errors, 1 skips`
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'minitest', 'rake test')
    expect(r.total).toBe(3)
    expect(r.failed).toBe(2) // failures + errors
    expect(r.skipped).toBe(1)
    expect(r.passed).toBe(0)
  })

  test('symbol/colon failure headers (jest ●, ✗, panic:, --- FAIL:) are extracted', () => {
    // Regression: a trailing `\b` after a non-word marker never holds, so these
    // headers used to silently yield zero structured failure blocks.
    for (const [header, expectedName] of [
      ['● Math › multiplies', 'Math › multiplies'],
      ['✗ renders the widget', 'renders the widget'],
      ['panic: runtime error: index out of range', 'runtime error: index out of range'],
      ['--- FAIL: TestFoo', 'TestFoo'],
    ] as const) {
      const out = `1 passed\n2 failed\n${header}\n    at /repo/src/thing.js:12:3`
      const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'jest', 'jest')
      expect(r.failures).toHaveLength(1)
      expect(r.failures[0]?.name).toBe(expectedName)
      expect(r.failures[0]?.file).toBe('/repo/src/thing.js')
      expect(r.failures[0]?.line).toBe(12)
    }
  })
})

describe('parseTestOutput fallback chain', () => {
  test('prefers JUnit XML report over stdout', () => {
    const xml = `<testsuite tests="1" failures="0" skipped="0"><testcase name="a"/></testsuite>`
    const r = parseTestOutput(
      'pytest',
      'pytest',
      emptyInput({ stdout: 'garbage', reportContent: xml, exitCode: 0 }),
    )
    expect(r.degraded).toBe(false)
    expect(r.passed).toBe(1)
  })

  test('falls back to heuristic when nothing structured matches', () => {
    const r = parseTestOutput('unknown', 'x', emptyInput({ stdout: '3 passed', exitCode: 0 }))
    expect(r.degraded).toBe(true)
    expect(r.passed).toBe(3)
  })
})

describe('reporters', () => {
  test('injects JUnit xml for pytest', () => {
    const plan = planReporter('pytest', 'pytest')
    expect(plan.wrapped).toBe(false)
    expect(plan.command).toMatch(/--junitxml=/)
    expect(plan.reportFile).toBeDefined()
  })

  test('adds -json for go', () => {
    expect(planReporter('go', 'go test ./...').command).toContain('-json')
  })

  test('skips injection for wrapped scripts', () => {
    const plan = planReporter('vitest', 'npm test')
    expect(plan.wrapped).toBe(true)
    expect(plan.command).toBe('npm test')
  })

  test('injects JUnit xml for bun (native runner, not a wrapper)', () => {
    const plan = planReporter('bun', 'bun test src/tools/RunTestsTool')
    expect(plan.wrapped).toBe(false)
    expect(plan.command).toMatch(/--reporter=junit/)
    expect(plan.reportFile).toBeDefined()
  })

  test('new runners: deno/ctest/catch2/doctest/pest/playwright JUnit + dart JSON flags', () => {
    expect(planReporter('deno', 'deno test').command).toMatch(/--junit-path=/)
    expect(planReporter('deno', 'deno test').reportFile).toBeDefined()

    expect(planReporter('ctest', 'ctest --test-dir build').command).toMatch(/--output-junit /)
    expect(planReporter('catch2', './tests').command).toMatch(/-r junit -o /)
    expect(planReporter('doctest', './tests').command).toMatch(/--reporters=junit --out=/)
    expect(planReporter('pest', 'vendor/bin/pest').command).toMatch(/--log-junit /)

    const pw = planReporter('playwright', 'npx playwright test')
    expect(pw.command).toMatch(/^PLAYWRIGHT_JUNIT_OUTPUT_NAME=\S+ /)
    expect(pw.command).toMatch(/--reporter=junit/)
    expect(pw.reportFile).toBeDefined()

    // Dart emits JSON on stdout (no report file).
    const dart = planReporter('dart', 'dart test')
    expect(dart.command).toMatch(/--reporter=json/)
    expect(dart.reportFile).toBeUndefined()
    expect(planReporter('dart', 'flutter test').command).toMatch(/--machine/)
    // Don't double-inject when the flag is already present.
    expect(planReporter('dart', 'dart test --reporter=json').command).toBe('dart test --reporter=json')
  })

  test('wrapped + watch detectors', () => {
    expect(isWrappedScript('yarn test')).toBe(true)
    expect(isWrappedScript('npm run ci')).toBe(true)
    expect(isWrappedScript('bun run ci')).toBe(true)
    // `bun test` is Bun's native runner, not a script wrapper.
    expect(isWrappedScript('bun test')).toBe(false)
    expect(isWrappedScript('npx vitest')).toBe(false)
    expect(hasWatchFlag('vitest --watch')).toBe(true)
    expect(hasWatchFlag('vitest run')).toBe(false)
  })
})

describe('readReportDir (maven/gradle stale-report gate)', () => {
  test('reads only report files written at/after run start', () => {
    const root = mkdtempSync(join(tmpdir(), 'rt-surefire-'))
    const dir = join(root, 'surefire-reports')
    mkdirSync(dir)
    const suite = (cls: string, name: string) =>
      `<testsuite name="${cls}" tests="1" failures="0"><testcase name="${name}" classname="${cls}"/></testsuite>`
    writeFileSync(join(dir, 'TEST-Stale.xml'), suite('StaleTest', 'oldCase'))
    writeFileSync(join(dir, 'TEST-Fresh.xml'), suite('FreshTest', 'newCase'))
    // Backdate the stale file to an hour ago.
    const old = Date.now() / 1000 - 3600
    utimesSync(join(dir, 'TEST-Stale.xml'), old, old)

    const xml = readReportDir(root, 'surefire-reports', Date.now() - 2000)
    expect(xml).toContain('newCase')
    expect(xml).not.toContain('oldCase')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('applyFilters', () => {
  test('maven/gradle/dotnet/rspec use framework-native pattern flags (single-quoted)', () => {
    expect(applyFilters('mvn test', 'maven', undefined, 'FooTest')).toBe("mvn test -Dtest='FooTest'")
    expect(applyFilters('./gradlew test', 'gradle', undefined, 'Foo')).toBe(
      "./gradlew test --tests 'Foo'",
    )
    expect(applyFilters('dotnet test', 'dotnet', undefined, 'X')).toBe("dotnet test --filter 'X'")
    expect(applyFilters('bundle exec rspec', 'rspec', undefined, 'renders')).toBe(
      "bundle exec rspec -e 'renders'",
    )
  })

  test('pattern is shell-quoted so metachars cannot be interpreted by bash', () => {
    // `$`, backticks and `\` must be inert — the command is run via bash.
    expect(applyFilters('ctest', 'ctest', undefined, 'Foo.*Bar$')).toBe("ctest -R 'Foo.*Bar$'")
    expect(applyFilters('./t', 'catch2', undefined, 'a`whoami`b')).toBe("./t 'a`whoami`b'")
    // Embedded single quote is escaped as '\'' (still a single bash token).
    expect(applyFilters('go test', 'go', undefined, "it's")).toBe("go test -run 'it'\\''s'")
  })

  test('path positional is skipped for JVM/.NET runners but kept for others', () => {
    // maven/gradle/dotnet have no fs-path positional — appending would break it.
    expect(applyFilters('mvn test', 'maven', 'src/foo')).toBe('mvn test')
    expect(applyFilters('./gradlew test', 'gradle', 'src/foo')).toBe('./gradlew test')
    // pytest/jest still take the path.
    expect(applyFilters('pytest', 'pytest', 'tests/unit')).toBe('pytest tests/unit')
  })

  test('new runners: pattern flags + path handling', () => {
    expect(applyFilters('deno test', 'deno', undefined, 'math')).toBe("deno test --filter 'math'")
    expect(applyFilters('dart test', 'dart', undefined, 'adds')).toBe("dart test --name 'adds'")
    expect(applyFilters('ctest', 'ctest', undefined, 'Suite.*')).toBe("ctest -R 'Suite.*'")
    expect(applyFilters('./t', 'catch2', undefined, '[tag]')).toBe("./t '[tag]'")
    expect(applyFilters('./t', 'doctest', undefined, 'case1')).toBe("./t --test-case='case1'")
    expect(applyFilters('npx playwright test', 'playwright', undefined, 'login')).toBe(
      "npx playwright test -g 'login'",
    )
    expect(applyFilters('vendor/bin/pest', 'pest', undefined, 'It')).toBe("vendor/bin/pest --filter 'It'")
    // ctest/catch2/doctest take no fs-path positional.
    expect(applyFilters('ctest', 'ctest', 'src/foo')).toBe('ctest')
    expect(applyFilters('./t', 'catch2', 'src/foo')).toBe('./t')
    // deno/dart/playwright/pest keep the path positional.
    expect(applyFilters('deno test', 'deno', 'test/math_test.ts')).toBe('deno test test/math_test.ts')
  })
})

describe('stackTrace', () => {
  test('prefers project frame over dependency frame', () => {
    const trace = `at node_modules/chai/lib/assert.js:10:5
at Object.<anonymous> (/repo/test/foo.test.ts:22:3)`
    expect(extractFileLine(trace)).toEqual({ file: '/repo/test/foo.test.ts', line: 22 })
  })

  test('python File "..." line frame', () => {
    expect(extractFileLine('File "tests/test_x.py", line 8, in test_x')).toEqual({
      file: 'tests/test_x.py',
      line: 8,
    })
  })

  test('JVM frame: at com.foo.Bar.method(Bar.java:42)', () => {
    expect(extractFileLine('\tat com.foo.BarTest.shouldWork(BarTest.java:42)')).toEqual({
      file: 'BarTest.java',
      line: 42,
    })
    expect(extractFileLine('\tat FooKt.check(Foo.kt:7)')).toEqual({ file: 'Foo.kt', line: 7 })
  })

  test('Dart frame: `path.dart LINE:COL` (space-separated)', () => {
    expect(extractFileLine('test/widget_test.dart 12:34   main.<fn>')).toEqual({
      file: 'test/widget_test.dart',
      line: 12,
    })
  })

  test('C/C++ frame: /path/foo_test.cpp:42', () => {
    expect(extractFileLine('/home/u/proj/tests/foo_test.cpp:42: FAILED')).toEqual({
      file: '/home/u/proj/tests/foo_test.cpp',
      line: 42,
    })
  })

  test('enrich fills missing file/line from diff', () => {
    const failures: TestFailure[] = [{ name: 't', message: 'boom', diff: 'at /a/b.ts:5:1' }]
    enrichFailuresWithStackLocation(failures)
    expect(failures[0].file).toBe('/a/b.ts')
    expect(failures[0].line).toBe(5)
  })

  test('refines bun declaration line to the stdout assertion frame', () => {
    // bun's empty <failure/> leaves the declaration line (7); stdout carries the
    // real assertion frame (8), attributed by the "(fail) <name>" marker.
    const stdout = `src/a.test.ts:
      at <anonymous> (/home/u/proj/src/a.test.ts:8:17)
(fail) multiplies wrong [0.09ms]`
    const failures: TestFailure[] = [
      { name: 'multiplies wrong', message: 'AssertionError', file: 'src/a.test.ts', line: 7 },
    ]
    refineFailureLinesFromStdout(failures, stdout, 'bun')
    expect(failures[0].line).toBe(8)
  })

  test('refine is a no-op for non-bun frameworks (other JUnit reporters have the real line)', () => {
    // Same stdout, but a vitest run: the declaration line must be left untouched
    // (and the whole-stdout frame scan skipped).
    const stdout = `      at <anonymous> (/home/u/proj/src/a.test.ts:8:17)`
    const failures: TestFailure[] = [
      { name: 'multiplies wrong', message: 'AssertionError', file: 'src/a.test.ts', line: 7 },
    ]
    refineFailureLinesFromStdout(failures, stdout, 'vitest')
    expect(failures[0].line).toBe(7)
  })

  test('attributes same-file frames to the right test by marker', () => {
    const stdout = `src/m.test.ts:
      at <anonymous> (/p/src/m.test.ts:4:3)
(fail) first [0.1ms]
src/m.test.ts:
      at <anonymous> (/p/src/m.test.ts:9:3)
(fail) second [0.1ms]`
    const failures: TestFailure[] = [
      { name: 'first', message: 'x', file: 'src/m.test.ts', line: 3 },
      { name: 'second', message: 'x', file: 'src/m.test.ts', line: 8 },
    ]
    refineFailureLinesFromStdout(failures, stdout, 'bun')
    expect(failures[0].line).toBe(4)
    expect(failures[1].line).toBe(9)
  })
})

describe('formatTestResult (token economy)', () => {
  const base: TestResult = {
    framework: 'vitest',
    command: 'vitest',
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    degraded: false,
    exitCode: 0,
  }

  test('green run is a single count line, no failure blocks', () => {
    const out = formatTestResult({ ...base, total: 5, passed: 5 })
    expect(out.startsWith('✓')).toBe(true)
    expect(out).toContain('5 passed')
    expect(out).not.toContain('✗')
  })

  test('failing run shows dossier and +N more', () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({
      name: `test ${i}`,
      file: `f${i}.ts`,
      line: i + 1,
      message: `boom ${i}`,
      summary: `boom ${i}`,
    }))
    const out = formatTestResult({ ...base, total: 12, failed: 12, failures })
    expect(out.startsWith('✗')).toBe(true)
    expect(out).toContain('f0.ts:1')
    expect(out).toContain('+2 more failing tests')
  })

  test('runError short-circuits', () => {
    const out = formatTestResult({ ...base, runError: 'no suite found' })
    expect(out).toContain('could not start')
    expect(out).toContain('no suite found')
  })

  test('no green check when the runner exits non-zero with zero failures', () => {
    // Assertions passed but the process failed (build/teardown/coverage gate).
    const out = formatTestResult({
      ...base,
      total: 5,
      passed: 5,
      exitCode: 1,
      stdoutTail: 'error: coverage 71% < threshold 80%',
    })
    expect(out.startsWith('✓')).toBe(false)
    expect(out).toContain('⚠')
    expect(out).toContain('exited 1')
    expect(out).toContain('coverage 71%')
  })
})

// End-to-end over a REAL `bun test --reporter=junit` document + on-disk source,
// exercising parse → enrich → dossier the same way run.ts wires them.
describe('integration: real bun JUnit XML + dossier', () => {
  let dir: string
  // Exact shape bun 1.3 emits: self-closing <failure>, file+line on testcase,
  // and both a <testsuites> wrapper and inner <testsuite> carrying counts.
  const BUN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0" time="0.11">
  <testsuite name="failing.test.ts" file="failing.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0">
    <testcase name="passes ok" classname="" file="failing.test.ts" line="2" assertions="1" />
    <testcase name="fails here" classname="" file="failing.test.ts" line="3" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>`

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudin-runtests-'))
    writeFileSync(
      join(dir, 'failing.test.ts'),
      `import { test, expect } from 'bun:test'\ntest('passes ok', () => { expect(1).toBe(1) })\ntest('fails here', () => { expect(2 + 2).toBe(5) })\n`,
    )
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('counts are not double-counted by the <testsuites> wrapper', () => {
    const r = parseTestOutput('bun', 'bun test', emptyInput({ reportContent: BUN_XML, exitCode: 1 }))
    expect(r.total).toBe(2)
    expect(r.passed).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.degraded).toBe(false)
    expect(r.failures[0].file).toBe('failing.test.ts')
    expect(r.failures[0].line).toBe(3)
  })

  test('dossier attaches a source excerpt pointing at the failing line', () => {
    const r = parseTestOutput('bun', 'bun test', emptyInput({ reportContent: BUN_XML, exitCode: 1 }))
    buildDossier(r.failures, dir)
    const f = r.failures[0]
    expect(f.summary).toBeDefined()
    expect(f.excerpt).toBeDefined()
    // The failing line (3) is marked with '>' and shows the assertion source.
    expect(f.excerpt).toContain('> 3 |')
    expect(f.excerpt).toContain('expect(2 + 2).toBe(5)')
  })
})
