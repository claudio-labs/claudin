import { LRUCache } from 'lru-cache'
import { normalize } from 'path'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  // True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
  // the injected content did not match disk (stripped HTML comments, stripped
  // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
  // Edit/Write must require an explicit Read first. `content` here holds the
  // RAW disk bytes (for getChangedFiles diffing), not what the model saw.
  isPartialView?: boolean
  // tool_use id of the Read that carried this content to the model. The
  // dedup stand-down uses it to check whether that tool_result is still
  // intact in the transcript (client-side clip paths rewrite old results to
  // stubs without touching this cache — see FileReadTool's
  // clientClippingDetection.ts). Absent for entries not written by a Read
  // tool call (Edit/Write, auto-injection, contexts without a toolUseId),
  // which keep the pre-existing always-armed dedup behavior.
  //
  // Transcript-scoped: the id is only meaningful against the messages array
  // of the context where the Read ran. A clone that crosses contexts (fork
  // subagents inherit parent messages, so ids normally still resolve;
  // resume reloads the same transcript) can in rare flows carry an id whose
  // tool_result is absent from the new context's messages — the scanner
  // then reports "missing" and dedup stands down, costing one re-send.
  // Fail-safe by design; do not rely on the id resolving outside its
  // original transcript.
  toolUseId?: string
}

// Default max entries for read file state caches
export const READ_FILE_STATE_CACHE_SIZE = 100

// Default size limit for file state caches (25MB)
// This prevents unbounded memory growth from large file contents
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * A file state cache that normalizes all path keys before access.
 * This ensures consistent cache hits regardless of whether callers pass
 * relative vs absolute paths with redundant segments (e.g. /foo/../bar)
 * or mixed path separators on Windows (/ vs \).
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>
  // Consecutive clipped/cleared dedup stand-downs per file, for FileReadTool's
  // re-read circuit breaker. Kept OUT of the FileState value on purpose: a Read
  // rewrites the whole FileState entry via set() every turn, which would reset
  // an embedded counter — this side-map survives the loop's own same-range
  // re-sends, so the streak accumulates. The entry records WHICH range it is
  // counting, making resets structural rather than call-site-scattered:
  // set() drops the entry whenever the incoming FileState's range differs
  // (different-range Read, Edit/Write with offset undefined), and
  // bumpRerunCount restarts at 1 on a range mismatch. Only populated while a
  // file is actually looping (rare). In-memory only; never rendered into the
  // request.
  private rerunCounts = new Map<
    string,
    { offset: number | undefined; limit: number | undefined; count: number }
  >()

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
      // Keep the side-map from outliving its FileState entry on LRU eviction
      // (evictions bypass our delete()). 'set' replacements must NOT clear —
      // the loop's own re-sends replace the entry every turn.
      dispose: (_value, key, reason) => {
        if (reason === 'evict') this.rerunCounts.delete(key)
      },
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  set(key: string, value: FileState): this {
    const normalized = normalize(key)
    // A write whose range differs from the recorded streak breaks the loop by
    // definition (different-range Read, or Edit/Write which store offset
    // undefined) — invalidate. The loop's same-range re-send matches and
    // preserves the streak.
    const rerun = this.rerunCounts.get(normalized)
    if (
      rerun &&
      (rerun.offset !== value.offset || rerun.limit !== value.limit)
    ) {
      this.rerunCounts.delete(normalized)
    }
    this.cache.set(normalized, value)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  delete(key: string): boolean {
    this.rerunCounts.delete(normalize(key))
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.rerunCounts.clear()
    this.cache.clear()
  }

  /** Increment and return the re-read-breaker streak for `key` at this exact
   *  range; a range mismatch with the recorded entry restarts the streak at 1. */
  bumpRerunCount(
    key: string,
    offset: number | undefined,
    limit: number | undefined,
  ): number {
    const normalized = normalize(key)
    const existing = this.rerunCounts.get(normalized)
    const count =
      existing && existing.offset === offset && existing.limit === limit
        ? existing.count + 1
        : 1
    this.rerunCounts.set(normalized, { offset, limit, count })
    return count
  }

  /** Drop the re-read-breaker streak for `key` (loop broken / range changed). */
  clearRerunCount(key: string): void {
    this.rerunCounts.delete(normalize(key))
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
  }
}

/**
 * Factory function to create a size-limited FileStateCache.
 * Uses LRUCache's built-in size-based eviction to prevent memory bloat.
 * Note: Images are not cached (see FileReadTool) so size limit is mainly
 * for large text files, notebooks, and other editable content.
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// Helper function to convert cache to object (used by compact.ts)
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(cache.entries())
}

// Helper function to get all keys from cache (used by several components)
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// Helper function to clone a FileStateCache
// Preserves size limit configuration from the source cache
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  cloned.load(cache.dump())
  return cloned
}

// Merge two file state caches, with more recent entries (by timestamp) overriding older ones
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
