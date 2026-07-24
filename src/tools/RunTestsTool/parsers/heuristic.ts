import type { Framework, ParseInput, TestFailure, TestResult } from '../types.js'

/**
 * Last-resort text parser. When no machine reporter was produced (wrapped
 * command, missing plugin, unknown runner) we scrape counts from the summary
 * line and pull whatever `file:line` references we can find near failure
 * markers. Always returns `degraded: true` so the formatter can be honest that
 * extraction was best-effort. Never throws.
 */

// Summary-count patterns across the common runners. First capture = passed,
// with the failed count grabbed by a sibling pattern to stay format-agnostic.
const PASSED_RE =
  /(\d+)\s+(?:passed|passing|tests? passed|ok\b)/i
const FAILED_RE =
  /(\d+)\s+(?:failed|failing|failures?|errors?)/i
const SKIPPED_RE =
  /(\d+)\s+(?:skipped|pending|ignored|deselected|todo)/i
// pytest-style "===== 3 failed, 10 passed in 1.23s ====="
const PYTEST_TAIL_RE = /=+\s*(.*?)\s+in\s+[\d.]+s\s*=+/
// cargo "test result: FAILED. 5 passed; 1 failed; 0 ignored"
const CARGO_RESULT_RE = /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/i
// Elixir ExUnit "5 tests, 2 failures" (passed = tests - failures).
const EXUNIT_RE = /(\d+)\s+tests?,\s+(\d+)\s+failures?/i
// Ruby minitest "3 runs, 5 assertions, 1 failures, 0 errors, 2 skips".
const MINITEST_RE =
  /(\d+)\s+runs?,\s+\d+\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?(?:,\s+(\d+)\s+skips?)?/i

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

function firstMatchInt(text: string, re: RegExp): number | undefined {
  const m = re.exec(text)
  return m ? Number.parseInt(m[1], 10) : undefined
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

  const cargo = CARGO_RESULT_RE.exec(text)
  const minitest = MINITEST_RE.exec(text)
  const exunit = EXUNIT_RE.exec(text)
  if (cargo) {
    passed = Number.parseInt(cargo[1], 10)
    failed = Number.parseInt(cargo[2], 10)
    skipped = Number.parseInt(cargo[3], 10)
  } else if (minitest) {
    const runs = Number.parseInt(minitest[1], 10)
    failed = Number.parseInt(minitest[2], 10) + Number.parseInt(minitest[3], 10)
    skipped = minitest[4] ? Number.parseInt(minitest[4], 10) : 0
    passed = Math.max(0, runs - failed - skipped)
  } else if (exunit) {
    const tests = Number.parseInt(exunit[1], 10)
    failed = Number.parseInt(exunit[2], 10)
    passed = Math.max(0, tests - failed)
  } else {
    passed = firstMatchInt(text, PASSED_RE)
    failed = firstMatchInt(text, FAILED_RE)
    skipped = firstMatchInt(text, SKIPPED_RE)
  }

  // Extract failing cases with any nearby file:line reference.
  const failures: TestFailure[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!FAIL_MARKER_RE.test(lines[i].trim())) continue
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
