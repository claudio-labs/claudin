/**
 * Narrowing accessors for foreign-agent config trees.
 *
 * Every `/import` adapter reads JSON, JSONC, YAML or TOML written by a tool we
 * do not control, so every value arrives as `unknown`. These return `null`
 * instead of throwing on purpose: a malformed key in somebody else's config
 * should cost that one artifact, not the whole import.
 */

export type JsonTable = Record<string, unknown>

export function asTable(value: unknown): JsonTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as JsonTable
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * A homogeneous string array. Returns null when any element is not a string —
 * a half-read `args` list would produce a command that silently does something
 * else, which is worse than not importing the server at all.
 */
export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

/**
 * An env/header map. Scalars are coerced (TOML and YAML happily write
 * `PORT = 8080` where the target schema wants a string); nested tables and
 * arrays have no string form and are dropped.
 */
export function asStringRecord(value: unknown): Record<string, string> | null {
  const table = asTable(value)
  if (!table) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(table)) {
    if (typeof raw === 'string') {
      out[key] = raw
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw)
    }
  }
  return out
}

/**
 * Walks a nested table, e.g. `at(settings, 'context', 'fileName')`. Returns
 * undefined as soon as a segment is missing or is not a table.
 */
export function at(root: unknown, ...path: string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    const table = asTable(current)
    if (!table) return undefined
    current = table[key]
  }
  return current
}
