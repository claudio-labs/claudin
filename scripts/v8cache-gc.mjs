// GC for ~/.claudio/v8cache/. Node's enableCompileCache writes one entry per
// (file path, mtime) under a fingerprint subdir (e.g. v25.9.0-x64-<hash>-<uid>)
// and never reclaims stale entries. After code-splitting, dist/chunks/[name]-[hash].mjs
// produces hundreds of new files per build, so the cache grows unboundedly in
// active dev. We sweep entries older than `ttlDays` and prune empty fingerprint
// subdirs.
//
// Pure logic split out so it can be unit-tested without spawning the launcher.

import { readdir, stat, unlink, rmdir } from 'fs/promises'
import { join } from 'path'

/**
 * @param {string} cacheDir absolute path to the v8cache root
 * @param {object} opts
 * @param {number} opts.ttlDays entries with mtime older than this are deleted
 * @param {number} [opts.now] epoch ms; defaults to Date.now() (injected for tests)
 * @returns {Promise<{ removedFiles: number, removedDirs: number, removedBytes: number, errors: number }>}
 */
export async function gcV8Cache(cacheDir, { ttlDays, now = Date.now() }) {
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000
  const stats = { removedFiles: 0, removedDirs: 0, removedBytes: 0, errors: 0 }

  let topEntries
  try {
    topEntries = await readdir(cacheDir, { withFileTypes: true })
  } catch {
    // Cache dir doesn't exist yet — nothing to GC.
    return stats
  }

  for (const top of topEntries) {
    const topPath = join(cacheDir, top.name)
    if (!top.isDirectory()) {
      // Stray file at root: respect TTL.
      try {
        const s = await stat(topPath)
        if (s.mtimeMs < cutoff) {
          await unlink(topPath)
          stats.removedFiles++
          stats.removedBytes += s.size
        }
      } catch {
        stats.errors++
      }
      continue
    }

    let inner
    try {
      inner = await readdir(topPath, { withFileTypes: true })
    } catch {
      stats.errors++
      continue
    }

    let remaining = inner.length
    for (const entry of inner) {
      const entryPath = join(topPath, entry.name)
      try {
        const s = await stat(entryPath)
        if (s.mtimeMs < cutoff) {
          await unlink(entryPath)
          stats.removedFiles++
          stats.removedBytes += s.size
          remaining--
        }
      } catch {
        stats.errors++
      }
    }

    if (remaining === 0) {
      try {
        await rmdir(topPath)
        stats.removedDirs++
      } catch {
        // Subdir may have re-populated between readdir and rmdir; benign.
      }
    }
  }

  return stats
}
