import type { Framework, ParseInput, TestFailure, TestResult } from 'src/tools/RunTestsTool/types.js'

/**
 * Last-resort text parser. When no machine reporter was produced (wrapped
 * command, missing plugin, unknown runner) we scrape counts from the summary
 * line and pull whatever `file:line` references we can find near failure
 * markers. Always returns `degraded: true` so the formatter can be honest that
 * extraction was best-effort. Never throws.
 */

// Summary-count patterns across the common runners. First capture = passed,
// with the failed count grabbed by a sibling pattern to stay format-agnostic.
//
// All of these are /g and every match is SUMMED (see sumGroups): one summary
// per run is the exception, not the rule — `dotnet test` prints one line per
// test project, `mix test` one per umbrella app, `rake test` one per suite, a
// wrapped `cargo test` one per test binary. Reading only the first reported
// whichever ran first, so a 1-passed/1-failed run showed up as 0 of 0.
//
// The bare `pass`/`fail`/`skip` alternatives are bun's own wording (`12 pass`),
// which is all we get when the command is a wrapped script and no JUnit
// reporter could be injected. Each keeps a `\b` so it cannot also eat the
// `passed`/`failed` forms and double-count them.
const PASSED_RE = /(\d+)\s+(?:passed|passing|tests? passed|ok\b|pass\b)/gi
const FAILED_RE = /(\d+)\s+(?:failed|failing|failures?|errors?|fail\b)/gi
const SKIPPED_RE = /(\d+)\s+(?:skipped|pending|ignored|deselected|todo|skips?\b)/gi
// pytest-style "===== 3 failed, 10 passed in 1.23s ====="
const PYTEST_TAIL_RE = /=+\s*(.*?)\s+in\s+[\d.]+s\s*=+/
// cargo "test result: FAILED. 5 passed; 1 failed; 0 ignored"
const CARGO_RESULT_RE = /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/gi
// Elixir ExUnit "5 tests, 2 failures" (passed = tests - failures).
const EXUNIT_RE = /(\d+)\s+tests?,\s+(\d+)\s+failures?/gi
// RSpec "5 examples, 1 failure, 0 pending" — it counts EXAMPLES, a word none of
// the generic patterns knows, so without this the passed count went missing and
// the total collapsed to the failure count.
const RSPEC_RE = /(\d+)\s+examples?,\s+(\d+)\s+failures?(?:,\s+(\d+)\s+pending)?/gi
// Ruby minitest "3 runs, 5 assertions, 1 failures, 0 errors, 2 skips".
const MINITEST_RE =
  /(\d+)\s+runs?,\s+\d+\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?(?:,\s+(\d+)\s+skips?)?/gi
// .NET "Failed:     2, Passed:     9, Skipped:     1" — the label comes BEFORE
// the number, so the digits-first patterns above never saw a single count and
// dotnet runs reported 0 passed.
const DOTNET_RE = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/gi

/**
 * The line that counts TESTS, for the runners that also print a coarser one.
 * jest ("Test Suites: 1 failed, 1 passed" before "Tests: 1 failed, 4 passed")
 * and vitest ("Test Files … | 2 passed (3)" before "Tests … | 27 passed (30)")
 * both put the file-level line FIRST, so a real 5-test run reported 2 tests.
 * Runners with a single summary (nextest's "N tests run: A passed, B failed")
 * need no scoping — they have no coarser sibling line to lose to.
 */
const TEST_COUNT_LINE_RE = /^[ \t]*Tests\b.*$/gm

// Generic "path/to/file.ext:line" reference (avoids URLs and bare numbers).
const FILE_LINE_RE = /([\w./\\-]+\.\w{1,5}):(\d+)(?::\d+)?/g
// Lines that look like a failure header. The numbered form covers ExUnit
// ("  1) test multiplies (MathTest)") and minitest ("  1) Failure:" / "Error:")
// blocks — anchored to those shapes so a prose ordered list ("1) install") is
// not mistaken for a failure.
//
// Word markers keep a trailing `\b` (so `FAIL` doesn't swallow `FAILURE`); the
// symbol/colon markers (✗ × ● and the `:`-terminated ones) must NOT — a `\b`
// after a non-word char never holds, which silently dropped jest's `●` and the
// `panic:`/`--- FAIL:`/`Error:` headers.
const FAIL_MARKER_RE =
  /^(?:(?:FAIL|not ok|FAILED|AssertionError)\b|--- FAIL:|Error:|panic:|✗|×|●|\d+\)\s+(?:test\b|Failure:|Error:))/i

/**
 * Sum every match's capture groups, or null when the pattern never matched (so
 * the caller can fall through to the next shape). Absent optional groups count
 * as zero.
 */
function sumGroups(text: string, re: RegExp, groups: number): number[] | null {
  const totals = new Array<number>(groups).fill(0)
  let found = false
  for (const m of text.matchAll(re)) {
    found = true
    for (let g = 0; g < groups; g++) {
      totals[g] += Number.parseInt(m[g + 1] ?? '', 10) || 0
    }
  }
  return found ? totals : null
}

type Counts = {
  passed: number | undefined
  failed: number | undefined
  skipped: number | undefined
}

function scrapeGeneric(text: string): Counts {
  return {
    passed: sumGroups(text, PASSED_RE, 1)?.[0],
    failed: sumGroups(text, FAILED_RE, 1)?.[0],
    skipped: sumGroups(text, SKIPPED_RE, 1)?.[0],
  }
}

export function parseHeuristic(
  input: ParseInput,
  framework: Framework,
  command: string,
): TestResult {
  const text = `${input.stdout}\n${input.stderr}`

  let passed: number | undefined
  let failed: number | undefined
  let skipped: number | undefined

  const cargo = sumGroups(text, CARGO_RESULT_RE, 3)
  const dotnet = sumGroups(text, DOTNET_RE, 3)
  const minitest = sumGroups(text, MINITEST_RE, 4)
  const exunit = sumGroups(text, EXUNIT_RE, 2)
  const rspec = sumGroups(text, RSPEC_RE, 3)
  if (cargo) {
    ;[passed, failed, skipped] = cargo
  } else if (dotnet) {
    ;[failed, passed, skipped] = dotnet
  } else if (minitest) {
    const [runs, failures, errors, skips] = minitest
    failed = failures + errors
    skipped = skips
    passed = Math.max(0, runs - failed - skipped)
  } else if (exunit) {
    const [tests, failures] = exunit
    failed = failures
    passed = Math.max(0, tests - failed)
  } else if (rspec) {
    const [examples, failures, pending] = rspec
    failed = failures
    skipped = pending
    passed = Math.max(0, examples - failed - skipped)
  } else {
    // Prefer the test-level line, but only when it actually carries counts: a
    // bare "Tests failed!" would otherwise scope the scrape to a line holding
    // no numbers and discard the real summary elsewhere in the output.
    const scoped = text.match(TEST_COUNT_LINE_RE)?.join('\n')
    const preferred = scoped === undefined ? undefined : scrapeGeneric(scoped)
    const counts =
      preferred && (preferred.passed !== undefined || preferred.failed !== undefined)
        ? preferred
        : scrapeGeneric(text)
    passed = counts.passed
    failed = counts.failed
    skipped = counts.skipped
  }

  // Extract failing cases with any nearby file:line reference.
  const failures: TestFailure[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!FAIL_MARKER_RE.test(lines[i].trim())) continue
    // A per-project dotnet summary opens with "Failed!", which is a failure
    // MARKER but not a failure — its counts were already read above, and naming
    // an entry after the whole summary line is pure noise. (`.match` rather
    // than `.test`: DOTNET_RE is /g and would carry a lastIndex.)
    if (lines[i].match(DOTNET_RE)) continue
    const header = lines[i].trim()
    // Look at the header + next few lines for a file:line.
    const window = lines.slice(i, i + 6).join('\n')
    FILE_LINE_RE.lastIndex = 0
    const fl = FILE_LINE_RE.exec(window)
    failures.push({
      name: header.replace(FAIL_MARKER_RE, '').trim() || header,
      file: fl?.[1],
      line: fl ? Number.parseInt(fl[2], 10) : undefined,
      message: header,
    })
    if (failures.length >= 50) break
  }

  const inferredFail =
    failed ?? (failures.length > 0 ? failures.length : input.exitCode !== 0 ? 1 : 0)
  const total = (passed ?? 0) + inferredFail + (skipped ?? 0)

  // pytest tail as a friendlier message when we have nothing else.
  if (failures.length === 0 && inferredFail > 0) {
    const tail = PYTEST_TAIL_RE.exec(text)
    failures.push({
      name: 'test run',
      message: tail?.[1] ?? `Test run failed (exit ${input.exitCode})`,
    })
  }

  return {
    framework,
    command,
    total,
    passed: passed ?? Math.max(0, total - inferredFail - (skipped ?? 0)),
    failed: inferredFail,
    skipped: skipped ?? 0,
    failures,
    degraded: true,
    exitCode: input.exitCode,
  }
}
