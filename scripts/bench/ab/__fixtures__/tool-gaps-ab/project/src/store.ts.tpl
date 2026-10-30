/**
 * The in-memory item store and the validation of item fields.
 *
 * Every read hands out a copy, so a caller can never mutate the store by
 * accident. The rules each validator enforces are in docs/SPEC.md.
 */

export type Item = {
  id: string
  name: string
  qty: number
  tags: string[]
  updatedAt: string
}

export type NewItemInput = {
  name?: unknown
  qty?: unknown
  tags?: unknown
}

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

function idNumber(id: string): number {
  return Number(id.slice('itm_'.length))
}

function copy(item: Item): Item {
  return { ...item, tags: [...item.tags] }
}

export class Store {
  #items = new Map<string, Item>()

  constructor(seed: Item[] = []) {
    for (const item of seed) this.#items.set(item.id, copy(item))
  }

  /** Every item, sorted by the numeric part of its id. */
  list(): Item[] {
    return [...this.#items.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id)).map(copy)
  }

  get(id: string): Item | undefined {
    const item = this.#items.get(id)
    return item ? copy(item) : undefined
  }

  create(input: NewItemInput): Item {
    const item: Item = {
      id: this.#nextId(),
      name: normalizeName(input.name),
      qty: normalizeQty(input.qty),
      tags: normalizeTags(input.tags),
      updatedAt: new Date().toISOString(),
    }
    this.#items.set(item.id, item)
    return copy(item)
  }

  remove(id: string): boolean {
    return this.#items.delete(id)
  }

  #nextId(): string {
    let max = 0
    for (const id of this.#items.keys()) max = Math.max(max, idNumber(id))
    return `itm_${max + 1}`
  }
}
