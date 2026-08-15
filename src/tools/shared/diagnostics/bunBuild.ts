import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from 'src/tools/shared/diagnostics/types.js'

/**
 * Bun's own bundler output, which is neither esbuild's block nor a GNU line:
 *
 *   1 | export const x = = 1
 *                       ^
 *   error: Unexpected =
 *       at /p/src/broken.ts:1:18
 *
 * Message first, position last on an `at` line — the same carry-forward shape
 * as `mix compile`, and the reason neither generic parser can read it: the
 * position line has no message and the message line has no position.
 *
 * What keeps a JavaScript stack frame out — `at build (/p/x.js:9:3)`, which
 * uses the same keyword and would otherwise turn a crash trace into a list of
 * diagnostics pointing at the bundler's own source — is the END anchor: every
 * frame closes with `)`, so its column is never the last thing on the line.
 * An earlier version also excluded parentheses from the path; that was dead
 * weight, since the anchor already rejects the named and the anonymous frame
 * alike, and mutating it changed no test outcome.
 */

const MESSAGE_RE = /^(?<sev>error|warn(?:ing)?):\s*(?<msg>.+)$/
const POSITION_RE = /^\s+at (?<file>\S+):(?<line>\d+):(?<col>\d+)$/

export function parseBunBuild(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []
  let pending: { severity: 'error' | 'warning'; message: string } | null = null

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const message = MESSAGE_RE.exec(line)
    if (message?.groups) {
      pending = {
        severity: message.groups.sev === 'error' ? 'error' : 'warning',
        message: message.groups.msg!.trim(),
      }
      continue
    }

    if (!pending) continue
    const position = POSITION_RE.exec(line)
    if (!position?.groups) continue
    diagnostics.push({
      file: position.groups.file!,
      line: Number(position.groups.line),
      column: Number(position.groups.col),
      severity: pending.severity,
      message: pending.message,
    })
    pending = null
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
