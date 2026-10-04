/**
 * Reading a headersHelper's stdout: a JSON object of string values, and
 * nothing else. A rejection names a key and a type at most, never a value or
 * a fragment of the output, because the output is meant to hold credentials.
 */

import { jsonParse } from 'src/platform/slowOperations.js'

export type HelperOutputVerdict =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; problem: 'empty' | 'not-json' | 'not-object' }
  | { ok: false; problem: 'non-string-value'; key: string; valueType: string }

export function parseHelperOutput(stdout: string): HelperOutputVerdict {
  const text = stdout.trim()
  if (!text) return { ok: false, problem: 'empty' }

  let value: unknown
  try {
    value = jsonParse(text)
  } catch {
    return { ok: false, problem: 'not-json' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'not-object' }
  }

  const entries = Object.entries(value)
  for (const [key, item] of entries) {
    if (typeof item !== 'string') {
      return { ok: false, problem: 'non-string-value', key, valueType: typeof item }
    }
  }
  // fromEntries defines own properties, so a "__proto__" key stays a header.
  return { ok: true, headers: Object.fromEntries(entries) }
}
