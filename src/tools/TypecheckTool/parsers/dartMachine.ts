import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from '../types.js'

/**
 * `dart analyze --format=machine` emits pipe-separated records:
 *
 *   ERROR|COMPILE_TIME_ERROR|UNDEFINED_METHOD|/p/a.dart|3|5|10|The method …
 *
 * Fields are severity, type, code, file, line, column, length, message. The
 * message may itself contain a literal `|`, which the format escapes as `\|`,
 * so the record is split into exactly 8 parts and the tail is kept whole.
 */

const FIELD_COUNT = 8
const ESCAPED_PIPE = /\\\|/g

export function parseDartMachine(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    if (!line.includes('|')) continue
    const parts = line.split('|')
    if (parts.length < FIELD_COUNT) continue
    const [severity, , code, file, lineNo, column] = parts
    if (severity !== 'ERROR' && severity !== 'WARNING' && severity !== 'INFO') continue
    const message = parts.slice(FIELD_COUNT - 1).join('|').replace(ESCAPED_PIPE, '|')
    if (!message.trim()) continue
    diagnostics.push({
      file: file ?? '',
      line: Number(lineNo) || 0,
      column: Number(column) || undefined,
      severity: severity === 'ERROR' ? 'error' : 'warning',
      code,
      message: message.trim(),
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
