/**
 * The in-memory item store.
 *
 * Every read hands out a copy, so a caller can never mutate the store by
 * accident. Field validation lives in validate.ts and is shared with the bulk
 * import; the rules it enforces are in docs/SPEC.md.
 */
import { ApiError, type CleanItem, type NewItemInput, validateNewItem } from './validate.ts'

export { ApiError, normalizeName, normalizeQty, normalizeTags } from './validate.ts'
export type { NewItemInput } from './validate.ts'

export type Item = {
  id: string
  name: string
  qty: number
  tags: string[]
  updatedAt: string
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
    return this.#insert(validateNewItem(input))
  }

  /**
   * Creates several items, in order, and returns them in that order. Every
   * entry is validated before any is inserted, so a failure inserts nothing;
   * it is reported as `invalid_item` with the entry's index.
   */
  createMany(inputs: unknown[]): Item[] {
    const clean = inputs.map((input, index) => {
      try {
        return validateNewItem(input)
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError(400, 'invalid_item', `items[${index}]: ${err.message}`)
        throw err
      }
    })
    return clean.map((item) => this.#insert(item))
  }

  remove(id: string): boolean {
    return this.#items.delete(id)
  }

  #insert(clean: CleanItem): Item {
    const item: Item = { id: this.#nextId(), ...clean, updatedAt: new Date().toISOString() }
    this.#items.set(item.id, item)
    return copy(item)
  }

  #nextId(): string {
    let max = 0
    for (const id of this.#items.keys()) max = Math.max(max, idNumber(id))
    return `itm_${max + 1}`
  }
}
