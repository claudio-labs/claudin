import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from '../types.js'

/**
 * The two Python checkers, both JSON but shaped differently.
 *
 * pyright `--outputjson` returns one document with `generalDiagnostics`, whose
 * ranges are **0-based** — adding 1 is not cosmetic, it is what makes the
 * excerpt point at the offending line instead of the one above it.
 *
 * mypy `--output=json` streams one object per line, already 1-based.
 */

type PyrightDiagnostic = {
  file?: string
  severity?: string
  message?: string
  rule?: string
  range?: { start?: { line?: number; character?: number } }
}

export function parsePyrightJson(input: ParseInput): ParsedDiagnostics {
  const start = input.stdout.indexOf('{')
  if (start < 0) return null
  let doc: { generalDiagnostics?: PyrightDiagnostic[] }
  try {
    doc = JSON.parse(input.stdout.slice(start)) as { generalDiagnostics?: PyrightDiagnostic[] }
  } catch {
    return null
  }
  const raw = doc.generalDiagnostics
  if (!Array.isArray(raw)) return null

  const diagnostics: RawDiagnostic[] = raw
    .filter(d => d.severity !== 'information' && d.message)
    .map(d => ({
      file: d.file ?? '',
      line: (d.range?.start?.line ?? 0) + 1,
      column: (d.range?.start?.character ?? 0) + 1,
      severity: d.severity === 'warning' ? 'warning' : 'error',
      code: d.rule,
      message: d.message ?? '',
    }))

  return diagnostics.length > 0 ? { diagnostics } : null
}

type MypyDiagnostic = {
  file?: string
  line?: number
  column?: number
  message?: string
  code?: string
  severity?: string
}

export function parseMypyJson(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of input.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let entry: MypyDiagnostic
    try {
      entry = JSON.parse(trimmed) as MypyDiagnostic
    } catch {
      continue
    }
    if (!entry.message || entry.severity === 'note') continue
    diagnostics.push({
      file: entry.file ?? '',
      line: entry.line ?? 0,
      column: entry.column,
      severity: entry.severity === 'warning' ? 'warning' : 'error',
      code: entry.code,
      message: entry.message,
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
