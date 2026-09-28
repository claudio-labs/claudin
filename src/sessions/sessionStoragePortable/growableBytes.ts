const DEFAULT_INITIAL_CAPACITY = 64 * 1024

/**
 * An append-only byte buffer that doubles as it fills. When the caller knows
 * how large the content can get, growth stops at that `limit`, so a buffer
 * that ends up full carries no slack.
 */
export class GrowableBytes {
  private bytes: Buffer
  private used = 0
  private readonly limit: number

  constructor(limit = Number.POSITIVE_INFINITY, initialCapacity = DEFAULT_INITIAL_CAPACITY) {
    this.limit = limit
    this.bytes = Buffer.allocUnsafe(Math.min(initialCapacity, limit))
  }

  get length(): number {
    return this.used
  }

  lastByte(): number | undefined {
    return this.used === 0 ? undefined : this.bytes[this.used - 1]
  }

  append(chunk: Uint8Array): void {
    this.reserve(chunk.length)
    this.bytes.set(chunk, this.used)
    this.used += chunk.length
  }

  /** What was appended so far, without a copy. */
  view(): Buffer {
    return this.bytes.subarray(0, this.used)
  }

  private reserve(extra: number): void {
    const needed = this.used + extra
    if (needed <= this.bytes.length) return
    const doubled = Math.max(needed, this.bytes.length * 2)
    const grown = Buffer.allocUnsafe(Math.max(needed, Math.min(doubled, this.limit)))
    this.bytes.copy(grown, 0, 0, this.used)
    this.bytes = grown
  }
}
