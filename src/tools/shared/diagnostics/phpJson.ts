import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from './types.js'

/**
 * PHPStan (`--error-format=json`) groups messages under a `files` map keyed by
 * path; Psalm (`--output-format=json`) returns a flat array with the path on
 * each entry. Both are handled here since they are alternatives for the same
 * project, and neither shape can be mistaken for the other.
 */

type PhpstanMessage = { message?: string; line?: number; identifier?: string }
type PhpstanReport = {
  files?: Record<string, { messages?: PhpstanMessage[] }>
  errors?: string[]
}

function parseJsonDocument(stdout: string): unknown {
  const start = stdout.search(/[[{]/)
  if (start < 0) return null
  try {
    return JSON.parse(stdout.slice(start)) as unknown
  } catch {
    return null
  }
}

export function parsePhpstanJson(input: ParseInput): ParsedDiagnostics {
  const doc = parseJsonDocument(input.stdout) as PhpstanReport | null
  if (!doc?.files || typeof doc.files !== 'object') return null

  const diagnostics: RawDiagnostic[] = []
  for (const [file, entry] of Object.entries(doc.files)) {
    for (const message of entry?.messages ?? []) {
      if (!message.message) continue
      diagnostics.push({
        file,
        line: message.line ?? 0,
        severity: 'error',
        code: message.identifier,
        message: message.message,
      })
    }
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}

type PsalmIssue = {
  severity?: string
  type?: string
  message?: string
  file_path?: string
  file_name?: string
  line_from?: number
  column_from?: number
}

export function parsePsalmJson(input: ParseInput): ParsedDiagnostics {
  const doc = parseJsonDocument(input.stdout)
  if (!Array.isArray(doc)) return null

  const diagnostics: RawDiagnostic[] = (doc as PsalmIssue[])
    .filter(issue => issue?.message)
    .map(issue => ({
      file: issue.file_path ?? issue.file_name ?? '',
      line: issue.line_from ?? 0,
      column: issue.column_from,
      severity: issue.severity === 'info' ? 'warning' : 'error',
      code: issue.type,
      message: issue.message ?? '',
    }))

  return diagnostics.length > 0 ? { diagnostics } : null
}
