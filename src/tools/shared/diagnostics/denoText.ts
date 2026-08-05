import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from './types.js'

/**
 * `deno check` has no compact mode, so its human output is the only source.
 * Deno 2 prints the code and severity on their own header line, with the
 * position on a following `at file://…` line:
 *
 *   TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.
 *   export const n: number = "not a number"
 *                ^
 *       at file:///abs/path/mod.ts:1:14
 *
 * Some failures carry no code and use a bare `error:` header instead
 * (unresolved imports, for one). Those are only emitted once a location line
 * confirms them, because the run also ENDS with a bare
 * `error: Type checking failed.` summary — reporting that as a diagnostic would
 * invent an error at no position that no baseline could ever reproduce.
 *
 * A bracketed header without a location is still reported at line 0: losing an
 * error entirely is worse than losing its excerpt.
 */

const CODED_HEADER_RE = /^(?:error:\s*)?(?:(?<code>TS\d+)\s*)?\[(?<sev>ERROR|WARN)\]:\s*(?<msg>.*)$/
const BARE_HEADER_RE = /^error:\s*(?<msg>.+)$/
const LOCATION_RE = /^\s*at\s+(?:file:\/\/)?(?<file>[^\s:]+(?::[^\s:]+)*?):(?<line>\d+):(?<col>\d+)\s*$/

export function parseDenoText(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []
  /** A bracketed header, already pushed, still waiting for its position. */
  let awaitingLocation: RawDiagnostic | null = null
  /** A bare `error:` header, held back until a location proves it is real. */
  let unconfirmed: RawDiagnostic | null = null

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const location = LOCATION_RE.exec(line)
    if (location?.groups) {
      const target = awaitingLocation ?? unconfirmed
      if (target) {
        target.file = location.groups.file!
        target.line = Number(location.groups.line)
        target.column = Number(location.groups.col)
        if (target === unconfirmed) diagnostics.push(target)
        awaitingLocation = null
        unconfirmed = null
      }
      continue
    }

    const coded = CODED_HEADER_RE.exec(line)
    if (coded?.groups?.msg?.trim()) {
      const g = coded.groups
      awaitingLocation = {
        file: '',
        line: 0,
        severity: g.sev === 'WARN' ? 'warning' : 'error',
        code: g.code,
        message: g.msg.trim(),
      }
      unconfirmed = null
      diagnostics.push(awaitingLocation)
      continue
    }

    const bare = BARE_HEADER_RE.exec(line)
    if (bare?.groups?.msg?.trim()) {
      awaitingLocation = null
      unconfirmed = {
        file: '',
        line: 0,
        severity: 'error',
        message: bare.groups.msg.trim(),
      }
    }
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
