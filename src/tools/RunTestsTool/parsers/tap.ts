import type { Framework, TestFailure, TestResult } from 'src/tools/RunTestsTool/types.js'

/**
 * TAP (Test Anything Protocol) parser — the second universal fallback. Handles
 * `ok`/`not ok` lines, `# SKIP`/`# TODO` directives, and the YAML-ish diagnostic
 * block that follows a failure (message + at.file/at.line). Used by node --test,
 * some bun/mocha reporters, and many language-agnostic runners.
 */

const PLAN_RE = /^\s*1\.\.(\d+)\s*$/m
const LINE_RE = /^(ok|not ok)\b\s*(\d+)?\s*-?\s*(.*)$/
const DIRECTIVE_RE = /#\s*(SKIP|TODO)\b/i
const YAML_START_RE = /^\s*---\s*$/
const YAML_END_RE = /^\s*\.\.\.\s*$/
const YAML_MESSAGE_RE = /^\s*message:\s*(.+?)\s*$/
const YAML_FILE_RE = /^\s*file:\s*['"]?([^'"]+?)['"]?\s*$/
const YAML_LINE_RE = /^\s*line:\s*(\d+)\s*$/

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}

export function parseTap(
  text: string,
  framework: Framework,
  command: string,
  exitCode: number,
): TestResult | null {
  if (!/^\s*(ok|not ok)\b/m.test(text)) return null

  const lines = text.split('\n')
  const failures: TestFailure[] = []
  let passed = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i])
    if (!m) continue
    const isOk = m[1] === 'ok'
    const desc = m[3] ?? ''
    const isSkip = DIRECTIVE_RE.test(desc)

    if (isSkip) {
      skipped++
      continue
    }
    if (isOk) {
      passed++
      continue
    }

    failed++
    const failure: TestFailure = {
      name: stripQuotes(desc.replace(DIRECTIVE_RE, '').trim()) || 'unknown',
      message: '',
    }
    // Consume the following YAML diagnostic block, if any.
    if (i + 1 < lines.length && YAML_START_RE.test(lines[i + 1])) {
      const diag: string[] = []
      let j = i + 2
      for (; j < lines.length && !YAML_END_RE.test(lines[j]); j++) {
        const l = lines[j]
        diag.push(l)
        const mm = YAML_MESSAGE_RE.exec(l)
        if (mm && !failure.message) failure.message = stripQuotes(mm[1])
        const fm = YAML_FILE_RE.exec(l)
        if (fm && !failure.file) failure.file = fm[1]
        const lm = YAML_LINE_RE.exec(l)
        if (lm && failure.line === undefined) failure.line = Number.parseInt(lm[1], 10)
      }
      if (diag.length > 0) failure.diff = diag.join('\n').trim()
      i = j
    }
    if (!failure.message) failure.message = 'Test failed'
    failures.push(failure)
  }

  const total = passed + failed + skipped
  if (total === 0) return null

  return {
    framework,
    command,
    total,
    passed,
    failed,
    skipped,
    failures,
    degraded: false,
    exitCode,
  }
}
