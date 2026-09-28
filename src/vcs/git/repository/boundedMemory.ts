/**
 * A memory with a fixed capacity that forgets the least recently used entry
 * first. The root lookups are asked about every path the session touches, so
 * an unbounded map would grow with the file tree.
 */
export class BoundedMemory<K, V extends NonNullable<unknown> | null> {
  private readonly entries = new Map<K, V>()

  /** `capacity` is how many entries are kept before the stalest one goes. */
  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  /** The remembered value, which also becomes the most recently used. */
  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size <= this.capacity) return
    const stalest = this.entries.keys().next()
    if (!stalest.done) this.entries.delete(stalest.value)
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Wraps a string-keyed lookup so each answer, null included, is kept in a bounded memory reachable as `.cache`. */
export function rememberLookups<V extends NonNullable<unknown> | null>(
  lookup: (key: string) => V,
  capacity: number,
): ((key: string) => V) & { readonly cache: BoundedMemory<string, V> } {
  const cache = new BoundedMemory<string, V>(capacity)
  const remembered = (key: string): V => {
    const known = cache.get(key)
    if (known !== undefined) return known
    const answer = lookup(key)
    cache.set(key, answer)
    return answer
  }
  return Object.assign(remembered, { cache })
}
