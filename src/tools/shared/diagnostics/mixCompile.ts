import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from './types.js'

/**
 * `mix compile` output, in the two shapes Elixir has shipped:
 *
 *   ** (CompileError) lib/foo.ex:12: undefined function bar/0
 *
 *     warning: variable "x" is unused
 *     │
 *   5 │   x = 1
 *     │
 *     └─ lib/foo.ex:5:3: Foo.run/0
 *
 * The block form puts the message first and the position LAST, under a box-
 * drawing footer, so the parser carries a pending message forward instead of
 * matching line by line. The older two-line form (message, then an indented
 * bare `lib/foo.ex:5`) closes the same way, which is why the footer pattern
 * accepts both.
 *
 * A pending message is dropped when another message arrives before a position:
 * emitting it with no file would put an unlocatable entry at the top of a
 * failures-first report.
 */

const RAISED_RE =
  /^\*\*\s+\((?<code>\w+Error)\)\s+(?<file>[^\s:]+):(?<line>\d+)(?::(?<col>\d+))?:?\s*(?<msg>.*)$/

const MESSAGE_RE = /^\s*(?<sev>error|warning):\s*(?<msg>.+)$/

/** Either the box-drawing footer or the older bare indented position. */
const POSITION_RE =
  /^\s*(?:└─\s*)?(?<file>[^\s:]+\.exs?):(?<line>\d+)(?::(?<col>\d+))?(?::.*)?$/

export function parseMixCompile(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []
  let pending: { severity: 'error' | 'warning'; message: string } | null = null

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const raised = RAISED_RE.exec(line)
    if (raised?.groups) {
      const g = raised.groups
      pending = null
      diagnostics.push({
        file: g.file!,
        line: Number(g.line),
        column: g.col ? Number(g.col) : undefined,
        severity: 'error',
        code: g.code,
        message: g.msg!.trim() || g.code!,
      })
      continue
    }

    const message = MESSAGE_RE.exec(line)
    if (message?.groups) {
      pending = {
        severity: message.groups.sev === 'warning' ? 'warning' : 'error',
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
      column: position.groups.col ? Number(position.groups.col) : undefined,
      severity: pending.severity,
      message: pending.message,
    })
    pending = null
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
