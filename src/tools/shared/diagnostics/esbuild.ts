import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from 'src/tools/shared/diagnostics/types.js'

/**
 * esbuild's block format, which vite, tsup and anything else bundling through
 * esbuild inherits:
 *
 *   ✘ [ERROR] Could not resolve "./missing"
 *
 *       src/app.ts:3:18:
 *         3 │ import x from "./missing"
 *           ╵                   ~~~~~~~~
 *
 * The message and the position are on different lines, which is why this needs
 * its own parser rather than a regex in the generic chain: the position line
 * carries no message and the message line carries no position, so either one
 * alone parses to a useless half-diagnostic.
 *
 * A block with no position line still counts. "Could not resolve" against a
 * missing entry point has nowhere to point, and dropping it would report a
 * failing build as unreadable.
 */

/** `✘ [ERROR]`, `▲ [WARNING]`, and the ASCII fallback esbuild uses without unicode. */
const HEAD_RE =
  /^\s*[✘▲X]\s+\[(?<sev>ERROR|WARNING)\]\s*(?:\[plugin\s+[^\]]+\]\s*)?(?<msg>.+)$/

/** The indented `path:line:col:` line under a head, with nothing after the colon. */
const LOCATION_RE = /^\s+(?<file>[^\s:][^:\n]*):(?<line>\d+):(?<col>\d+):\s*$/

/**
 * How far below a head to look for its position. esbuild emits one blank line
 * and then the location; anything further away belongs to the next block, and
 * pairing across blocks would attach a message to the wrong file.
 */
const LOCATION_LOOKAHEAD = 3

export function parseEsbuild(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []
  const lines = `${input.stdout}\n${input.stderr}`.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const head = HEAD_RE.exec(lines[i]!)
    if (!head?.groups) continue

    let position: { file: string; line: number; column: number } | null = null
    for (let j = i + 1; j <= i + LOCATION_LOOKAHEAD && j < lines.length; j++) {
      const found = LOCATION_RE.exec(lines[j]!)
      if (found?.groups) {
        position = {
          file: found.groups.file!,
          line: Number(found.groups.line),
          column: Number(found.groups.col),
        }
        break
      }
    }

    diagnostics.push({
      file: position?.file ?? '',
      line: position?.line ?? 0,
      column: position?.column,
      severity: head.groups.sev === 'WARNING' ? 'warning' : 'error',
      message: head.groups.msg!.trim(),
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
