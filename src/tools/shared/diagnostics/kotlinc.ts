import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from './types.js'

/**
 * The Kotlin compiler's own line format, as it reaches you through Gradle:
 *
 *   e: file:///p/src/main/kotlin/Foo.kt:10:20 Unresolved reference: bar
 *   w: file:///p/src/main/kotlin/Foo.kt:3:5 Variable 'x' is never used
 *   e: /p/src/main/kotlin/Foo.kt: (10, 20): Unresolved reference: bar
 *
 * Both shapes ship: the `file://` URI is what Kotlin 1.7+ prints, the
 * parenthesised one is what older Gradle plugins still emit, and a repo pinned
 * to an old plugin is exactly the repo whose output nobody wants to read raw.
 *
 * `e:`/`w:` lines with no position at all (`w: Kotlin plugin should be enabled`)
 * are the compiler talking about itself, not about the source, and are skipped:
 * a diagnostic with no file resolves no excerpt and would be pure noise in a
 * failures-first report.
 */

/** `file://` form. The file group is lazy so a Windows `file:///C:/…` keeps its drive. */
const URI_RE =
  /^(?<sev>[ew]): file:\/\/(?<file>.+?):(?<line>\d+):(?<col>\d+)(?:\s+(?<msg>.*))?$/

/** Legacy Gradle-plugin form. */
const PAREN_RE =
  /^(?<sev>[ew]): (?<file>\S.*?\.kts?): \((?<line>\d+), (?<col>\d+)\): (?<msg>.+)$/

export function parseKotlinc(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const match = URI_RE.exec(line) ?? PAREN_RE.exec(line)
    if (!match?.groups) continue
    const g = match.groups
    const message = (g.msg ?? '').trim()
    if (!message) continue
    diagnostics.push({
      file: g.file!,
      line: Number(g.line),
      column: Number(g.col),
      severity: g.sev === 'w' ? 'warning' : 'error',
      message,
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
