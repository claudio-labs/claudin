import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from 'src/tools/shared/diagnostics/types.js'

/**
 * The colon-separated position format used by the Go toolchain and javac (both
 * directly and through gradle), plus Maven's bracketed variant:
 *
 *   ./main.go:6:2: undefined: foo
 *   /p/Main.java:12: error: cannot find symbol
 *   [ERROR] /p/Main.java:[12,20] cannot find symbol
 *
 * Go prints no severity word and no rule code — every line it emits here is an
 * error — so `severity` defaults to error and `code` stays undefined rather
 * than being invented.
 */

const COLON_RE =
  /^(?<file>(?:[A-Za-z]:)?[^\s:][^:\n]*\.[A-Za-z0-9]+):(?<line>\d+)(?::(?<col>\d+))?:\s*(?:(?<sev>error|warning):\s*)?(?<msg>.+)$/

const MAVEN_RE =
  /^\[(?:ERROR|WARNING)\]\s+(?<file>(?:[A-Za-z]:)?[^\s:][^:\n]*\.[A-Za-z0-9]+):\[(?<line>\d+),(?<col>\d+)\]\s*(?<msg>.+)$/

/** Go prefixes each failing package with `# example.com/mod/pkg`. */
const GO_PACKAGE_HEADER_RE = /^#\s/

export function parseGnuStyle(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    if (GO_PACKAGE_HEADER_RE.test(line)) continue

    const maven = MAVEN_RE.exec(line)
    if (maven?.groups) {
      const g = maven.groups
      diagnostics.push({
        file: g.file!,
        line: Number(g.line),
        column: Number(g.col),
        severity: line.startsWith('[WARNING]') ? 'warning' : 'error',
        message: g.msg!.trim(),
      })
      continue
    }

    const match = COLON_RE.exec(line)
    if (!match?.groups) continue
    const g = match.groups
    diagnostics.push({
      file: g.file!,
      line: Number(g.line),
      column: g.col ? Number(g.col) : undefined,
      severity: g.sev === 'warning' ? 'warning' : 'error',
      message: g.msg!.trim(),
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
