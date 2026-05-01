import type { Stats } from 'node:fs'
import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

/**
 * A simple in-memory cache for file contents with automatic invalidation based on modification time.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000
  // 256 KB limit per entry — aligned with MAX_OUTPUT_SIZE in file.ts.
  // Uses stats.size (bytes on disk) as a pre-read guard and content.length
  // (UTF-16 code units) as the post-read check; the pre-read check is
  // conservative (stats.size >= content.length for UTF-8), so no valid
  // entry is ever silently rejected.
  private readonly maxEntryBytes = 256 * 1024

  /**
   * Reads a file with caching. Returns both content and encoding.
   * Cache key includes file path and modification time for automatic invalidation.
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

    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return { content: cachedData.content, encoding: cachedData.encoding }
    }

    const encoding = detectFileEncoding(filePath)

    // Skip allocation for files that can't fit in cache (stats.size >= content.length for UTF-8)
    if (stats.size > this.maxEntryBytes) {
      return {
        content: fs.readFileSync(filePath, { encoding }).replaceAll('\r\n', '\n'),
        encoding,
      }
    }

    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Only cache entries within the size limit; large files are returned but not stored.
    if (content.length <= this.maxEntryBytes) {
      this.cache.set(filePath, { content, encoding, mtime: stats.mtimeMs })

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
   * Clears the entire cache. Useful for testing or memory management.
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
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
