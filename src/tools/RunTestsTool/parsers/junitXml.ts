import { extractFileLine } from 'src/tools/RunTestsTool/stackTrace.js'
import type { Framework, TestFailure, TestResult } from 'src/tools/RunTestsTool/types.js'

/**
 * Lightweight JUnit-XML parser — the universal target. Deliberately regex-based
 * (no XML dependency): JUnit surefire output is flat and predictable, and we
 * only need testsuite counts + failing testcases. Tolerant of `<testsuites>`
 * wrappers, self-closing passing cases, and `<failure>`/`<error>` bodies.
 *
 * pytest's `--junitxml` and a few others add `file`/`line` attributes on
 * `<testcase>`; we use them when present and otherwise leave file:line for the
 * stack-trace extractor.
 */

// Matches both <testsuite ...> and the outer <testsuites ...> wrapper.
const TESTSUITE_RE = /<testsuites?\b([^>]*)>/gi
const TESTCASE_RE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/gi
const FAILURE_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/i
const SKIPPED_RE = /<skipped\b/i
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2]
  }
  return attrs
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#9;/g, '\t')
    .replace(/&amp;/g, '&')
}

function toInt(v: string | undefined): number {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

export function parseJUnitXml(
  xml: string,
  framework: Framework,
  command: string,
  exitCode: number,
): TestResult | null {
  if (!/<testcase\b/i.test(xml) && !/<testsuite\b/i.test(xml)) return null

  // Scan every <testsuite>/<testsuites> open tag once. We deliberately take the
  // MAX of each count (and the max time) rather than the sum: bun and jest emit
  // a nested <testsuite> per describe-block, so the outer aggregate already
  // covers the inner ones and summing would multi-count (24 → 48). These serve
  // only as a fallback; the authoritative counts come from <testcase> below.
  let maxTests = 0
  let maxFailures = 0
  let maxErrors = 0
  let maxSkipped = 0
  let durationMs: number | undefined

  TESTSUITE_RE.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = TESTSUITE_RE.exec(xml)) !== null) {
    const a = parseAttrs(sm[1])
    const t = Number.parseFloat(a.time)
    if (Number.isFinite(t)) durationMs = Math.max(durationMs ?? 0, t * 1000)
    if (a.tests !== undefined) {
      maxTests = Math.max(maxTests, toInt(a.tests))
      maxFailures = Math.max(maxFailures, toInt(a.failures))
      maxErrors = Math.max(maxErrors, toInt(a.errors))
      maxSkipped = Math.max(maxSkipped, toInt(a.skipped))
    }
  }

  const failures: TestFailure[] = []
  let caseCount = 0
  let caseSkipped = 0
  TESTCASE_RE.lastIndex = 0
  let cm: RegExpExecArray | null
  while ((cm = TESTCASE_RE.exec(xml)) !== null) {
    caseCount++
    const attrs = parseAttrs(cm[1])
    const body = cm[3] ?? ''
    if (SKIPPED_RE.test(body)) caseSkipped++

    const fm = FAILURE_RE.exec(body)
    if (!fm) continue

    const failAttrs = parseAttrs(fm[2] ?? '')
    const bodyText = unescapeXml((fm[3] ?? '').trim())
    const message = unescapeXml(failAttrs.message ?? '').trim() || bodyText.split('\n')[0] || 'Test failed'
    const suite = attrs.classname ? `${attrs.classname} › ` : ''
    const declLine = attrs.line ? toInt(attrs.line) : undefined

    // The <testcase line=> attribute is the *declaration* line for bun/jest,
    // whereas a stack frame inside the same test file pinpoints the failing
    // assertion — far more useful. Prefer the stack line when it lands in the
    // test's own file; otherwise keep the declaration line (correct for pytest,
    // whose attribute already points at the assertion).
    let file = attrs.file || undefined
    let line = declLine && declLine > 0 ? declLine : undefined
    const stackLoc = extractFileLine(bodyText)
    if (stackLoc) {
      const norm = (p: string) => p.replace(/\\/g, '/')
      if (file && norm(stackLoc.file).endsWith(norm(file))) {
        line = stackLoc.line
      } else if (!file) {
        file = stackLoc.file
        line = stackLoc.line
      }
    }

    failures.push({
      name: `${suite}${attrs.name ?? 'unknown'}`,
      kind: fm[1].toLowerCase() === 'error' ? 'error' : 'failure',
      file,
      line,
      message,
      diff: bodyText || undefined,
    })
  }

  // <testcase> elements are authoritative (one per test, nesting-proof). Suite
  // attributes are only a fallback for the rare document that reports aggregate
  // counts but omits the individual cases.
  let total: number
  let failed: number
  let skipped: number
  if (caseCount > 0) {
    total = caseCount
    failed = failures.length // FAILURE_RE covers both <failure> and <error>
    skipped = caseSkipped
  } else {
    total = maxTests
    failed = maxFailures + maxErrors
    skipped = maxSkipped
  }
  const passed = Math.max(0, total - failed - skipped)

  return {
    framework,
    command,
    total,
    passed,
    failed,
    skipped,
    durationMs,
    failures,
    degraded: false,
    exitCode,
  }
}
