/**
 * Validation of item fields, shared by the store (POST /items) and the bulk
 * import (POST /items/bulk). Each function returns the normalized value or
 * throws an ApiError with status 400. The rules are in docs/SPEC.md §3.
 */

export type NewItemInput = {
  name?: unknown
  qty?: unknown
  tags?: unknown
}

/** A validated, normalized item body, ready to be stored. */
export type CleanItem = { name: string; qty: number; tags: string[] }

/** An error the HTTP layer turns into `{error: {code, message}}`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A name is a string that is not blank once trimmed; it is stored trimmed. */
export function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'invalid_name', 'name must be a non-empty string')
  }
  return value.trim()
}

/** A quantity is an integer >= 0. Strings and fractions are rejected. */
export function normalizeQty(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_qty', 'qty must be an integer >= 0')
  }
  return value
}

/** Tags are lowercased, trimmed, deduplicated and sorted. Missing means []. */
export function normalizeTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new ApiError(400, 'invalid_tags', 'tags must be an array of strings')
  }
  const tags = (value as string[]).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== '')
  return [...new Set(tags)].sort()
}

/** Validates a whole item body, as sent to POST /items or inside a batch. */
export function validateNewItem(input: unknown): CleanItem {
  if (!isPlainObject(input)) throw new ApiError(400, 'invalid_item', 'an item must be a JSON object')
  return {
    name: normalizeName(input.name),
    qty: normalizeQty(input.qty),
    tags: normalizeTags(input.tags),
  }
}

/** The key two names are compared by: trimmed and case-folded. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase()
}
