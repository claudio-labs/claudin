import { LRUCache } from 'lru-cache'
import { normalize } from 'path'
import { unpinToolResult } from '../services/compact/stableStubState.js'

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
  /**
   * tool_use ids this cache accepted through `set` — i.e. the pins it is
   * entitled to release. Entries arriving via `load` (how cloneFileStateCache
   * copies a parent's state) are held WITHOUT ownership: a forked sub-agent
   * runs on such a clone and `clear()`s it on exit, which disposes every
   * inherited entry. Releasing there would unpin blocks the PARENT's entries
   * still vouch for, so the parent would believe its content is protected
   * while it had quietly become clippable again.
   */
  private readonly ownedToolUseIds = new Set<string>()

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
      // A clip-pin protects the tool_result this entry points at, for exactly
      // as long as the entry vouches that the model still needs that content.
      // The moment the entry stops pointing at it — replaced by a different
      // range, overwritten by Edit/Write, deleted, or LRU-evicted — the pin
      // has no owner left. Releasing it here (every dispose reason, since all
      // four cases end the ownership) is structural: doing it at the call
      // sites leaked one pin per abandoned range, and a leaked pin keeps its
      // block mutable, which freezes the prompt-cache clip frontier at that
      // block's index for the rest of the session.
      dispose: value => {
        const id = value.toolUseId
        // delete() doubles as the ownership test: only the cache that took
        // this id in releases it, and only once.
        if (id && this.ownedToolUseIds.delete(id)) unpinToolResult(id)
      },
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  /**
   * `adopt: false` inserts the entry WITHOUT claiming its pin — for callers
   * copying entries another live cache still owns (mergeFileStateCaches). Two
   * owners of one tool_use id means the first dispose releases a pin the other
   * still vouches for.
   */
  set(key: string, value: FileState, options?: { adopt?: boolean }): this {
    const normalized = normalize(key)
    // Overwriting disposes the previous value first, releasing its pin; only
    // then does this cache claim the incoming id, so a same-key replacement
    // hands ownership over rather than dropping it.
    this.cache.set(normalized, value)
    // Claim ownership only if the entry actually landed. lru-cache refuses a
    // value over maxEntrySize — it deletes the key and stores nothing, so no
    // dispose ever fires for it, and an id claimed for an absent entry would
    // sit in this Set for the life of the session.
    if (
      options?.adopt !== false &&
      value.toolUseId &&
      this.cache.peek(normalized) === value
    ) {
      this.ownedToolUseIds.add(value.toolUseId)
    }
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.cache.clear()
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

/**
 * Merge two file state caches, with more recent entries (by timestamp)
 * overriding older ones.
 *
 * Non-owning by construction: `first` is cloned via `load` and `second`'s
 * entries are inserted with `adopt: false`, so the merged cache holds every pin
 * WITHOUT claiming it. Using plain `set` here would let two live caches each
 * believe they own the same tool_use id, and whichever disposed first would
 * release a pin the other still vouches for — re-arming the clip → re-read loop
 * for a file the survivor thinks is protected. Same rule as cloneFileStateCache.
 */
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // Only override if the new entry is more recent
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState, { adopt: false })
    }
  }
  return merged
}
