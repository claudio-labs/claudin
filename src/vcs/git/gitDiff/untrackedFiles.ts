import { MAX_FILES } from 'src/vcs/git/gitDiff/limits.js'
import type { GitDiffResult, NumstatResult } from 'src/vcs/git/gitDiff/types.js'

/** `git ls-files --others` output: one file per line, never a directory. */
export function parseUntrackedList(stdout: string): string[] {
  return stdout.split('\n').filter(name => name !== '')
}

/**
 * The tracked numbers followed by the untracked files. Every untracked file
 * is counted, but only those that fit in the room the tracked files left get
 * an entry. An untracked file adds no lines: git has no count for it.
 */
export function withUntrackedFiles(tracked: NumstatResult, untracked: readonly string[]): GitDiffResult {
  const perFileStats = new Map(tracked.perFileStats)
  for (const path of untracked) {
    if (perFileStats.size >= MAX_FILES) break
    if (!perFileStats.has(path)) perFileStats.set(path, { added: 0, removed: 0, isBinary: false, isUntracked: true })
  }
  return {
    stats: { ...tracked.stats, filesCount: tracked.stats.filesCount + untracked.length },
    perFileStats,
    hunks: new Map(),
  }
}
