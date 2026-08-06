import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyFilters } from './RunTestsTool.js'
import { readReportDir, runTests } from './run.js'
import { buildDossier } from './dossier.js'
import { detectFrameworkFromCommand, detectTestRunner } from './detect.js'
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
import type { Framework, ParseInput, TestFailure, TestProgress, TestResult } from './types.js'

function emptyInput(over: Partial<ParseInput> = {}): ParseInput {
  return { stdout: '', stderr: '', exitCode: 0, ...over }
}

/** Materializes a throwaway project tree; keys are paths relative to its root. */
function projectFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rt-fixture-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

const pkgJson = (o: Record<string, unknown>) => JSON.stringify(o)

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
      // Wrapper and task forms: the detected command round-trips through here
      // whenever the model passes it back explicitly, and landing on `unknown`
      // would cost the framework's reporter injection.
      ['./mvnw test', 'maven'],
      ['deno task test', 'deno'],
      ['make build', 'unknown'],
      // `pest` must match only as a command token, not the bare English word.
      ['echo the best pest around', 'unknown'],
    ]
    for (const [cmd, fw] of cases) {
      expect(detectFrameworkFromCommand(cmd)).toBe(fw)
    }
  })
})

describe('detectTestRunner — Python environment', () => {
  // A bare `pytest` resolves to whatever is on PATH, which in a uv/poetry
  // project is a global interpreter that cannot import the project: it collects
  // nothing and reports the import errors as failing tests. The detected
  // command has to go through the project's environment.
  function pythonProject(files: Record<string, string>): string {
    return projectFixture({ 'pyproject.toml': '[project]\nname = "x"\n', ...files })
  }

  const cases: Array<[string, Record<string, string>, string]> = [
    ['uv', { 'uv.lock': 'version = 1' }, 'uv run pytest'],
    ['poetry', { 'poetry.lock': '' }, 'poetry run pytest'],
    ['pdm', { 'pdm.lock': '' }, 'pdm run pytest'],
    ['pipenv', { Pipfile: '' }, 'pipenv run pytest'],
    ['in-tree venv', { '.venv/bin/pytest': '#!/bin/sh' }, '.venv/bin/pytest'],
    ['nothing but pyproject.toml', {}, 'pytest'],
  ]
  for (const [label, files, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      const root = pythonProject(files)
      const detected = detectTestRunner(root)
      expect(detected?.framework).toBe('pytest')
      expect(detected?.command).toBe(expected)
      rmSync(root, { recursive: true, force: true })
    })
  }

  test('a manager lockfile wins over an in-tree venv binary', () => {
    const root = pythonProject({ 'uv.lock': 'version = 1', '.venv/bin/pytest': '#!/bin/sh' })
    expect(detectTestRunner(root)?.command).toBe('uv run pytest')
    rmSync(root, { recursive: true, force: true })
  })

  test('the detected command still resolves back to the pytest framework', () => {
    // planReporter/applyFilters key off the framework, so a prefixed command
    // must not fall through to `unknown` when it round-trips through the
    // command matchers (the path taken when the model passes it explicitly).
    expect(detectFrameworkFromCommand('uv run pytest')).toBe('pytest')
    expect(detectFrameworkFromCommand('poetry run pytest tests/')).toBe('pytest')
    expect(detectFrameworkFromCommand('.venv/bin/pytest')).toBe('pytest')
  })
})

// Every case here is the same defect the Python branch had: the synthesized
// command runs OUTSIDE the environment the project declares, so it fails (or
// silently runs the wrong thing) in a way that reads as a broken suite.
describe('detectTestRunner — other language environments', () => {
  function expectDetected(files: Record<string, string>, framework: Framework, command: string) {
    const root = projectFixture(files)
    const detected = detectTestRunner(root)
    expect(detected?.framework).toBe(framework)
    expect(detected?.command).toBe(command)
    rmSync(root, { recursive: true, force: true })
  }

  describe('bun: `bun test` is Bun\'s own runner, not the `test` script', () => {
    test('a bun-lockfile project with a foreign test script runs the script', () => {
      // `bun test` here would ignore ava entirely and run Bun's runner over any
      // *.test.ts it finds — failures from a runner the project never chose.
      expectDetected(
        { 'bun.lock': '', 'package.json': pkgJson({ scripts: { test: 'ava' } }) },
        'unknown',
        'bun run test',
      )
      expectDetected(
        { 'bun.lock': '', 'package.json': pkgJson({ scripts: { test: 'node --test' } }) },
        'node-test',
        'bun run test',
      )
    })

    test('a script that IS bun test keeps the direct form, so a reporter fits', () => {
      expectDetected(
        { 'bun.lock': '', 'package.json': pkgJson({ scripts: { test: 'bun test' } }) },
        'bun',
        'bun test',
      )
    })

    test('the other package managers still run their script', () => {
      // `npm|pnpm|yarn test` DO run the script — only bun collides.
      expectDetected(
        { 'pnpm-lock.yaml': '', 'package.json': pkgJson({ scripts: { test: 'jest' } }) },
        'jest',
        'pnpm test',
      )
    })
  })

  describe('deno: a bare `deno test` has no permissions', () => {
    test('prefers the declared test task, which carries the suite\'s flags', () => {
      expectDetected(
        { 'deno.json': JSON.stringify({ tasks: { test: 'deno test -A' } }) },
        'deno',
        'deno task test',
      )
      // Deno 2 also allows the object form.
      expectDetected(
        { 'deno.jsonc': JSON.stringify({ tasks: { test: { command: 'deno test -A' } } }) },
        'deno',
        'deno task test',
      )
    })

    test('falls back to the bare runner when no task is declared', () => {
      expectDetected({ 'deno.json': JSON.stringify({ imports: {} }) }, 'deno', 'deno test')
    })

    test('the task form is not treated as a script wrapper — deno forwards args', () => {
      // Verified against deno 2.9: `deno task test --junit-path=x` reaches the
      // runner and writes the file, so the reporter must still be injected.
      const plan = planReporter('deno', 'deno task test')
      expect(plan.wrapped).toBe(false)
      expect(plan.command).toMatch(/--junit-path=/)
    })
  })

  describe('ruby: minitest needs bundler exactly like rspec does', () => {
    test('shells through bundle exec when a Gemfile is present', () => {
      expectDetected(
        { Rakefile: '', 'test/x_test.rb': '', Gemfile: '' },
        'minitest',
        'bundle exec rake test',
      )
    })

    test('stays bare without a Gemfile — there is no bundle to exec', () => {
      expectDetected({ Rakefile: '', 'test/x_test.rb': '' }, 'minitest', 'rake test')
    })
  })

  describe('maven: the wrapper is often the only build tool present', () => {
    test('prefers ./mvnw, mirroring the gradle branch', () => {
      expectDetected({ 'pom.xml': '', mvnw: '' }, 'maven', './mvnw test')
    })

    test('falls back to a global mvn when there is no wrapper', () => {
      expectDetected({ 'pom.xml': '' }, 'maven', 'mvn test')
    })
  })

  describe('php: vendor/bin is only the default location', () => {
    test('an installed binary still wins — it parses structured output', () => {
      expectDetected(
        { 'composer.json': pkgJson({ scripts: { test: 'phpunit' } }), 'vendor/bin/pest': '' },
        'pest',
        'vendor/bin/pest',
      )
      expectDetected(
        { 'composer.json': pkgJson({ scripts: { test: 'phpunit' } }), 'vendor/bin/phpunit': '' },
        'phpunit',
        'vendor/bin/phpunit',
      )
    })

    test('falls back to the declared script when no binary sits at the default path', () => {
      expectDetected(
        { 'composer.json': pkgJson({ scripts: { test: 'pest' } }), 'tests/Pest.php': '' },
        'pest',
        'composer test',
      )
      // Array form, and a script whose runner token we cannot resolve.
      expectDetected(
        { 'composer.json': pkgJson({ scripts: { test: ['@php artisan test'] } }) },
        'phpunit',
        'composer test',
      )
    })

    test('composer test is a script wrapper — composer eats injected flags', () => {
      expect(isWrappedScript('composer test')).toBe(true)
      expect(isWrappedScript('composer run-script test')).toBe(true)
      expect(planReporter('phpunit', 'composer test').wrapped).toBe(true)
      expect(planReporter('phpunit', 'composer test').command).toBe('composer test')
    })
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
    expect(r!.failures[0].kind).toBe('failure')
  })

  test('a collection <error> is tagged as an error, not an assertion failure', () => {
    // What pytest writes when a conftest import blows up: the cases exist only
    // as error placeholders, so nothing ran.
    const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="pytest" errors="2" failures="0" skipped="0" tests="2" time="0.2">
  <testcase classname="" name="modules.backend.tests" time="0.0">
    <error message="collection failure">E   ModuleNotFoundError: No module named 'httpx'</error>
  </testcase>
  <testcase classname="" name="modules.web.tests" time="0.0">
    <error message="collection failure">E   ModuleNotFoundError: No module named 'legendarr_backend'</error>
  </testcase>
</testsuite></testsuites>`
    const r = parseJUnitXml(xml, 'pytest', 'pytest', 2)
    expect(r!.failed).toBe(2)
    expect(r!.passed).toBe(0)
    expect(r!.failures.map(f => f.kind)).toEqual(['error', 'error'])
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

  // Captured from a real `cargo test` on a crate with a lib and one integration
  // test: TWO `test result:` lines, the empty lib target reporting first.
  const MULTI_TARGET = [
    '     Running unittests src/lib.rs (target/debug/deps/rtprobe-ebe2)',
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
    '',
    '     Running tests/probe_test.rs (target/debug/deps/probe_test-30d4)',
    '',
    'running 2 tests',
    'test passes ... ok',
    'test fails_on_purpose ... FAILED',
    '',
    'failures:',
    '',
    '---- fails_on_purpose stdout ----',
    "thread 'fails_on_purpose' panicked at tests/probe_test.rs:7:5:",
    'assertion `left == right` failed: BUG: add is wrong',
    '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out',
  ].join('\n')

  test('sums every per-binary result line instead of trusting the first', () => {
    const r = parseCargo(emptyInput({ stdout: MULTI_TARGET, exitCode: 101 }), 'cargo test')
    expect(r).not.toBeNull()
    // Reading only the first line took the empty lib target's counts, so a
    // failing run rendered as "0 passed (0 total)" with the failure below it.
    expect(r!.passed).toBe(1)
    expect(r!.failed).toBe(1)
    expect(r!.total).toBe(2)
    expect(r!.failures.map(f => f.name)).toEqual(['fails_on_purpose'])
    expect(r!.failures[0].line).toBe(7)
  })

  test('repeat calls return the same counts (the /g regex keeps no lastIndex)', () => {
    const first = parseCargo(emptyInput({ stdout: MULTI_TARGET, exitCode: 101 }), 'cargo test')
    const second = parseCargo(emptyInput({ stdout: MULTI_TARGET, exitCode: 101 }), 'cargo test')
    expect(second!.passed).toBe(first!.passed)
    expect(second!.failed).toBe(first!.failed)
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

  // ---------------------------------------------------------------------------
  // Multi-summary output. Every runner in the degraded lane can print MORE than
  // one summary — one per test binary, project, umbrella app or suite — and
  // jest/vitest print a FILE-level line before the test-level one. Reading the
  // first match reported whichever came first.
  // ---------------------------------------------------------------------------

  test('jest: the "Tests:" line wins over "Test Suites:"', () => {
    // Captured from a real `bunx jest` run over 2 files / 5 tests. Taking the
    // first "N passed" read the suite line and reported 1 passed of 2 total.
    const out = [
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       1 failed, 4 passed, 5 total',
      'Snapshots:   0 total',
      'Time:        0.412 s',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stderr: out, exitCode: 1 }), 'jest', 'jest')
    expect(r.passed).toBe(4)
    expect(r.failed).toBe(1)
    expect(r.total).toBe(5)
  })

  test('vitest through a wrapper script: the "Tests" line wins over "Test Files"', () => {
    const out = [
      ' Test Files  1 failed | 2 passed (3)',
      '      Tests  3 failed | 27 passed (30)',
      '   Duration  1.20s',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'vitest', 'npm test')
    expect(r.passed).toBe(27)
    expect(r.failed).toBe(3)
    expect(r.total).toBe(30)
  })

  test('a count-less "Tests" line does not blank out counts found elsewhere', () => {
    // Preferring that line unconditionally would scope the scrape to a line
    // holding no numbers and throw away the real summary below it.
    const out = 'Tests failed!\n\n4 passed, 1 failed'
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'jest', 'jest')
    expect(r.passed).toBe(4)
    expect(r.failed).toBe(1)
  })

  test('dotnet: sums the per-project summaries and reads its label-first counts', () => {
    // `dotnet test` over a solution prints one line per test project, and writes
    // the label BEFORE the number, which the digits-first patterns never saw.
    const out = [
      'Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5, Duration: 12 ms - Api.Tests.dll',
      'Failed!  - Failed:     2, Passed:     9, Skipped:     1, Total:    12, Duration: 44 ms - Core.Tests.dll',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'dotnet', 'dotnet test')
    expect(r.passed).toBe(14)
    expect(r.failed).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.total).toBe(17)
  })

  test('dotnet: a per-project summary line is not reported as a failure', () => {
    // "Failed!" trips the failure-header marker, which named a failure after the
    // whole summary line — noise on top of a run whose real failures are listed.
    const out =
      'Failed!  - Failed:     2, Passed:     9, Skipped:     1, Total:    12, Duration: 44 ms - Core.Tests.dll'
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'dotnet', 'dotnet test')
    // Only the synthetic "test run" entry the formatter falls back to when a
    // failing run yielded no per-test failure block — no entry named after the
    // summary line itself.
    expect(r.failures.map(f => f.name)).toEqual(['test run'])
  })

  test('elixir umbrella: sums the per-app summaries', () => {
    const out = [
      'Finished in 0.1 seconds',
      '3 tests, 0 failures',
      '',
      'Finished in 0.2 seconds',
      '8 tests, 2 failures',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'elixir', 'mix test')
    expect(r.total).toBe(11)
    expect(r.failed).toBe(2)
    expect(r.passed).toBe(9)
  })

  test('minitest: sums the per-suite summaries', () => {
    const out = [
      '4 runs, 4 assertions, 0 failures, 0 errors, 0 skips',
      '',
      '7 runs, 9 assertions, 1 failures, 0 errors, 2 skips',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'minitest', 'rake test')
    expect(r.total).toBe(11)
    expect(r.failed).toBe(1)
    expect(r.skipped).toBe(2)
    expect(r.passed).toBe(8)
  })

  test('rspec "N examples, M failures, K pending"', () => {
    // rspec counts EXAMPLES, a word none of the digits-first patterns knew, so
    // the passed count was missing entirely and the total collapsed to 1.
    const out = 'Failures:\n\n5 examples, 1 failure, 0 pending'
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'rspec', 'bundle exec rspec')
    expect(r.total).toBe(5)
    expect(r.failed).toBe(1)
    expect(r.passed).toBe(4)
  })

  test('cargo through a wrapper script: sums every per-binary result line', () => {
    // Same bug parsers/cargo.ts had, on the degraded lane a wrapped cargo takes.
    const out = [
      'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 101 }), 'unknown', 'bun run test:rust')
    expect(r.passed).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.total).toBe(2)
  })

  test('nextest: counts come from its own Summary line', () => {
    const out = [
      '    Starting 21 tests across 3 binaries',
      '        PASS [   0.005s] mycrate::unit tests::works',
      '        FAIL [   0.006s] mycrate::integration tests::breaks',
      '------------',
      '     Summary [   0.030s] 21 tests run: 20 passed, 1 failed, 0 skipped',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 100 }), 'nextest', 'cargo nextest run')
    expect(r.passed).toBe(20)
    expect(r.failed).toBe(1)
    expect(r.skipped).toBe(0)
    expect(r.total).toBe(21)
  })

  test('nextest: the summary omits segments that are zero', () => {
    // Straight from the nextest docs: no "failed" segment on a green run, and
    // the "Starting N tests … (177 tests skipped)" line must not be scraped.
    const out = [
      '     Starting 14 tests across 3 binaries (177 tests skipped)',
      '     Summary [   0.021s] 14 tests run: 14 passed, 177 skipped',
    ].join('\n')
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 0 }), 'nextest', 'cargo nextest run')
    expect(r.passed).toBe(14)
    expect(r.failed).toBe(0)
    expect(r.skipped).toBe(177)
  })

  test('bun through `bun run <script>`: the "N pass / N fail" shape', () => {
    // A wrapped script gets no --reporter=junit, so bun's own text is all we
    // have — and "pass"/"fail" never matched the "passed"/"failing" patterns.
    const out = [' 12 pass', ' 1 fail', ' 2 skip', ' 34 expect() calls', 'Ran 15 tests across 3 files.'].join(
      '\n',
    )
    const r = parseHeuristic(emptyInput({ stdout: out, exitCode: 1 }), 'bun', 'bun run test:provider')
    expect(r.passed).toBe(12)
    expect(r.failed).toBe(1)
    expect(r.skipped).toBe(2)
    expect(r.total).toBe(15)
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

  test('flags a run where every entry is a collection error and nothing passed', () => {
    // "0 passed, 3 failed" on its own reads as three broken tests; it is really
    // a suite that never ran (wrong environment, bad import).
    const out = formatTestResult({
      ...base,
      framework: 'pytest',
      total: 3,
      failed: 3,
      exitCode: 2,
      failures: [1, 2, 3].map(i => ({
        name: `module${i}.tests`,
        kind: 'error' as const,
        message: 'collection failure',
      })),
    })
    expect(out).toContain('never ran')
    expect(out).toContain('uv run pytest')
  })

  test('does not flag a suite that ran — a passing case, or a real assertion failure', () => {
    const withPasses = formatTestResult({
      ...base,
      total: 4,
      passed: 3,
      failed: 1,
      failures: [{ name: 'setup', kind: 'error', message: 'fixture blew up' }],
    })
    expect(withPasses).not.toContain('never ran')

    const assertionOnly = formatTestResult({
      ...base,
      total: 1,
      failed: 1,
      failures: [{ name: 'test_add', kind: 'failure', message: 'assert 3 == 4' }],
    })
    expect(assertionOnly).not.toContain('never ran')
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

describe('runTests — the live progress line', () => {
  test('a running suite reports what it last printed', async () => {
    const seen: TestProgress[] = []
    await runTests({
      command: 'echo "ok 1 - first"; sleep 1; echo "ok 2 - second"; sleep 1',
      // `unknown` so `planReporter` leaves the command alone — a reporter flag
      // injected into `echo` would change what the tail says.
      framework: 'unknown',
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      timeoutMs: 30_000,
      onProgress: p => seen.push(p),
    })

    // The two `sleep 1`s outlast the ~1s poll interval, so at least one tick
    // lands. How MANY land is a race against the scheduler — asserting a count
    // would measure the poller's cadence rather than this wiring.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every(p => p.framework === 'unknown')).toBe(true)
    const lines = ['ok 1 - first', 'ok 2 - second']
    expect(seen.every(p => p.label === '' || lines.includes(p.label))).toBe(true)
  }, 30_000)
})
