import type { Stats } from 'node:fs'
import { detectFileEncoding } from 'src/shared/fs/file.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

// What a cached read stays valid for. `cp -p`, `rsync -t`, `touch -r` and an
// atomic rename can each keep the mtime, so the mtime alone is not enough.
type StatStamp = { mtime: number; ctime: number; size: number; inode: number }

function statStamp(stats: Stats): StatStamp {
  return {
    mtime: stats.mtimeMs,
    ctime: stats.ctimeMs,
    size: stats.size,
    inode: stats.ino,
  }
}

function sameStamp(a: StatStamp, b: StatStamp): boolean {
  return (
    a.mtime === b.mtime &&
    a.ctime === b.ctime &&
    a.size === b.size &&
    a.inode === b.inode
  )
}

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  stamp: StatStamp
}

/**
 * A simple in-memory cache for file contents with automatic invalidation based on file stats.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000
  // 256 KB limit per entry — aligned with MAX_OUTPUT_SIZE in file.ts.
  // Compared against stats.size (bytes on disk); for UTF-8 files,
  // content.length <= stats.size, so this is a conservative bound.
  private readonly maxEntryBytes = 256 * 1024

  /**
   * Reads a file with caching. Returns both content and encoding.
   * An entry is valid while its StatStamp still matches the file's.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation; on error the file was deleted
    let stats: Stats
    try {
      stats = fs.statSync(filePath)
    } catch (error: unknown) {
      this.cache.delete(filePath)
      throw error
    }

    const cachedData = this.cache.get(filePath)
    const stamp = statStamp(stats)

    if (cachedData && sameStamp(cachedData.stamp, stamp)) {
      return { content: cachedData.content, encoding: cachedData.encoding }
    }

    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Only cache entries within the size limit; large files are returned but not stored.
    if (stats.size <= this.maxEntryBytes) {
      this.cache.set(filePath, { content, encoding, stamp })

      if (this.cache.size > this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) {
          this.cache.delete(firstKey)
        }
      }
    }

    return { content, encoding }
  }

  /**
   * Clears the entire cache.
   *
   * Heap reclaim semantics: Map.clear() drops the JS-level references
   * synchronously, but JSC sweeps the orphaned string contents lazily —
   * a synchronous gc() right after clear() typically leaves used_heap_size
   * unchanged because background GC work hasn't settled (empirically up to
   * ~200 ms under realistic churn). The strings are eligible for collection;
   * they'll be reclaimed at the next sweep, naturally as pressure builds.
   * We don't force gc() here because the settling time is heap-size
   * dependent and not predictable, and forcing a stop-the-world early
   * would just stall the next operation.
   * RSS often stays high after the heap drops because the allocator
   * (jemalloc/glibc) keeps freed pages around for reuse; that is not a
   * leak — the next allocations reuse them without growing the process.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }

  /**
   * Current number of cached entries. Used by memory profiling benches
   * (scripts/bench/perf/memory-turn-by-turn-bench.ts) to track cache growth
   * per turn without allocating the full entries array that getStats()
   * returns.
   */
  get size(): number {
    return this.cache.size
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
