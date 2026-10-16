/**
 * `expires: YYYY-MM-DD` — an optional frontmatter key of any memory: the last
 * day it is known to hold, for a fact with a natural end (a freeze, a
 * deadline, a temporary workaround, a rotation). Past it, the memory is
 * surfaced for review — on Read (memoryAge.ts), by the audit (memoryAudit.ts)
 * that /memory tidy, the dream digest and the /memory browser render — and
 * never deleted by code: whether it still holds is a judgment, and the dream
 * deletes only what it finds contradicted, as it always did.
 */
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

const EXPIRES_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export type Expires =
  | { kind: 'none' }
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; raw: string }

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * What a frontmatter `expires` value says. A YAML backend may hand an
 * unquoted date over as a Date rather than a string, so both are read; a
 * string must be a real calendar day (`2026-02-30` is not).
 */
export function parseExpires(value: unknown): Expires {
  if (value === undefined || value === null || String(value).trim() === '') return { kind: 'none' }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { kind: 'invalid', raw: String(value) }
      : { kind: 'date', date: value.toISOString().slice(0, 10) }
  }
  const raw = String(value).trim()
  const match = EXPIRES_DATE_RE.exec(raw)
  if (!match) return { kind: 'invalid', raw }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const real = parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  return real ? { kind: 'date', date: raw } : { kind: 'invalid', raw }
}

/** The valid `expires` date of a memory file's content, or null. */
export function expiresOf(content: string): string | null {
  const expires = parseExpires(parseFrontmatter(content).frontmatter.expires)
  return expires.kind === 'date' ? expires.date : null
}

/** Today as the calendar day an `expires:` date is compared with, in local time. */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whether `date` (YYYY-MM-DD) is past: the memory held through that day, not after it. */
export function isExpired(date: string, today: string): boolean {
  return date < today
}
