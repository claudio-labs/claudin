import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from '../types.js'

/**
 * `cargo check --message-format=json` streams one JSON object per line. Only
 * `reason: "compiler-message"` entries carry diagnostics; build-script and
 * artifact events share the stream and are skipped.
 *
 * A diagnostic's position comes from its PRIMARY span. Secondary spans point at
 * the definition site rather than the mistake, so keying on `is_primary` is what
 * makes the reported file:line the one worth reading.
 */

type CargoSpan = {
  file_name?: string
  line_start?: number
  column_start?: number
  is_primary?: boolean
}

type CargoMessage = {
  reason?: string
  message?: {
    level?: string
    message?: string
    code?: { code?: string } | null
    spans?: CargoSpan[]
  }
}

/** `note`/`help` are attachments to another diagnostic, not diagnostics. */
const REPORTED_LEVELS = new Set(['error', 'warning'])

export function parseCargoJson(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of input.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: CargoMessage
    try {
      event = JSON.parse(trimmed) as CargoMessage
    } catch {
      continue
    }
    if (event.reason !== 'compiler-message') continue
    const msg = event.message
    if (!msg?.message) continue
    const level = (msg.level ?? '').replace(/^error:.*/, 'error')
    if (!REPORTED_LEVELS.has(level)) continue

    const span = msg.spans?.find(s => s.is_primary) ?? msg.spans?.[0]
    diagnostics.push({
      file: span?.file_name ?? '',
      line: span?.line_start ?? 0,
      column: span?.column_start,
      severity: level === 'warning' ? 'warning' : 'error',
      code: msg.code?.code,
      message: msg.message,
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
