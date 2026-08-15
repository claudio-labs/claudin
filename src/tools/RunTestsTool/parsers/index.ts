import type { Framework, ParseInput, TestResult } from 'src/tools/RunTestsTool/types.js'
import { parseCargo } from 'src/tools/RunTestsTool/parsers/cargo.js'
import { parseDart } from 'src/tools/RunTestsTool/parsers/dartTest.js'
import { parseGoJson } from 'src/tools/RunTestsTool/parsers/goTest.js'
import { parseHeuristic } from 'src/tools/RunTestsTool/parsers/heuristic.js'
import { parseJUnitXml } from 'src/tools/RunTestsTool/parsers/junitXml.js'
import { parseTap } from 'src/tools/RunTestsTool/parsers/tap.js'

/**
 * Run the fallback chain and return the first structured result. Order matters:
 *
 *   1. JUnit-XML report file (the universal target — most runners can emit it)
 *   2. Framework-native JSON where XML is weak (go test -json, cargo text)
 *   3. TAP (report file or stdout)
 *   4. Heuristic text scrape (always succeeds, marks `degraded: true`)
 *
 * Never throws — a parser that mis-fires returns null and we move on.
 */
export function parseTestOutput(
  framework: Framework,
  command: string,
  input: ParseInput,
): TestResult {
  const candidates: Array<() => TestResult | null> = []

  // 1. JUnit XML report, when one was written.
  if (input.reportContent && /<testcase\b|<testsuite\b/i.test(input.reportContent)) {
    candidates.push(() =>
      parseJUnitXml(input.reportContent as string, framework, command, input.exitCode),
    )
  }

  // 2. Framework-native JSON/text where XML is weak.
  if (framework === 'go') {
    candidates.push(() => parseGoJson(input, command))
  }
  if (framework === 'cargo' || framework === 'nextest') {
    candidates.push(() => parseCargo(input, command))
  }
  if (framework === 'dart') {
    candidates.push(() => parseDart(input, command))
  }

  // 3. TAP from report file or stdout.
  candidates.push(() =>
    parseTap(input.reportContent ?? input.stdout, framework, command, input.exitCode),
  )

  for (const attempt of candidates) {
    try {
      const result = attempt()
      if (result && (result.total > 0 || result.failures.length > 0)) return result
    } catch {
      // A parser throwing is a bug in that parser, not a run failure — skip it.
    }
  }

  // 4. Guaranteed fallback.
  return parseHeuristic(input, framework, command)
}
