/**
 * Helpers for characterization snapshot tests of messages.ts.
 *
 * Goal: replace non-deterministic fields (UUID v4, epoch-ms timestamps) with
 * stable placeholders so `toMatchSnapshot()` can detect real regressions.
 *
 * Used by `src/services/messages/*.test.ts` to freeze current behavior before
 * splitting messages.ts into per-bucket modules (ROADMAP 11a).
 */

const UUID_V4_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi

// Epoch ms (13 digits) appearing as a number literal in JSON output.
const TIMESTAMP_NUM_RE = /\b1[0-9]{12}\b/g

// ISO timestamps (e.g. "2026-05-17T12:34:56.789Z").
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Walk `obj` (already JSON-serializable) and substitute UUIDs/timestamps with
 * stable placeholders. Returns a clone — input is never mutated.
 *
 * - UUID v4 strings → `<uuid>`
 * - 13-digit epoch ms (as string or number) → `<ts>`
 * - ISO 8601 timestamps → `<iso-ts>`
 *
 * Strings, arrays, plain objects are walked. Non-JSON values (functions,
 * symbols) are dropped via the JSON round-trip in `deepClone`.
 */
export function normalizeForSnapshot<T>(obj: T): T {
  const clone = deepClone(obj)
  return walk(clone) as T
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return normalizeString(value)
  if (typeof value === 'number') {
    return value >= 1_000_000_000_000 && value <= 9_999_999_999_999
      ? '<ts>'
      : value
  }
  if (Array.isArray(value)) return value.map(walk)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v)
    return out
  }
  return value
}

function normalizeString(s: string): string {
  return s
    .replace(UUID_V4_RE, '<uuid>')
    .replace(ISO_DATE_RE, '<iso-ts>')
    .replace(TIMESTAMP_NUM_RE, '<ts>')
}
