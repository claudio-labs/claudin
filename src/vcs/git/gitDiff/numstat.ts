import { MAX_FILES } from 'src/vcs/git/gitDiff/limits.js'
import type { NumstatResult, PerFileStats } from 'src/vcs/git/gitDiff/types.js'

const RENAME_ARROW = ' => '
/** What numstat prints in place of a count for a binary file. */
const NO_COUNT = '-'

type NumstatLine = { added: number; removed: number; isBinary: boolean; path: string }

/** Where a file is now, and where it was when git saw a rename (or a copy). */
type ResolvedPath = { path: string; renamedFrom?: string }

/** `git diff --numstat` output to totals over every file and entries for the first ones. */
export function parseGitNumstat(stdout: string): NumstatResult {
  const stats = { filesCount: 0, linesAdded: 0, linesRemoved: 0 }
  const perFileStats = new Map<string, PerFileStats>()
  for (const text of stdout.split('\n')) {
    const line = readNumstatLine(text)
    if (line === null) continue
    stats.filesCount += 1
    stats.linesAdded += line.added
    stats.linesRemoved += line.removed
    if (perFileStats.size < MAX_FILES) {
      const { path, renamedFrom } = resolveRenamedPath(line.path)
      const entry: PerFileStats = { added: line.added, removed: line.removed, isBinary: line.isBinary }
      if (renamedFrom !== undefined) entry.renamedFrom = renamedFrom
      perFileStats.set(path, entry)
    }
  }
  return { stats, perFileStats }
}

/** `<added>\t<removed>\t<path>`; the path is everything after the second tab. */
function readNumstatLine(text: string): NumstatLine | null {
  const firstTab = text.indexOf('\t')
  const secondTab = firstTab === -1 ? -1 : text.indexOf('\t', firstTab + 1)
  if (secondTab === -1) return null
  const added = text.slice(0, firstTab)
  const removed = text.slice(firstTab + 1, secondTab)
  const path = text.slice(secondTab + 1)
  if (added === NO_COUNT || removed === NO_COUNT) return { added: 0, removed: 0, isBinary: true, path }
  return { added: toCount(added), removed: toCount(removed), isBinary: false, path }
}

function toCount(text: string): number {
  const count = Number.parseInt(text, 10)
  return Number.isNaN(count) ? 0 : count
}

/**
 * numstat's rename notation: `old => new`, or `prefix{old => new}suffix` when
 * the two share a directory part. An empty side leaves a doubled slash at the
 * seam, which is not part of either path.
 */
function resolveRenamedPath(printed: string): ResolvedPath {
  const arrow = printed.indexOf(RENAME_ARROW)
  if (arrow === -1) return { path: printed }
  const open = printed.lastIndexOf('{', arrow)
  const close = printed.indexOf('}', arrow + RENAME_ARROW.length)
  if (open === -1 || close === -1) {
    return { path: printed.slice(arrow + RENAME_ARROW.length).trim(), renamedFrom: printed.slice(0, arrow).trim() }
  }
  const prefix = printed.slice(0, open)
  const suffix = printed.slice(close + 1)
  return {
    path: joinAroundSeam(prefix, printed.slice(arrow + RENAME_ARROW.length, close), suffix),
    renamedFrom: joinAroundSeam(prefix, printed.slice(open + 1, arrow), suffix),
  }
}

function joinAroundSeam(prefix: string, middle: string, suffix: string): string {
  if (middle === '' && prefix.endsWith('/') && suffix.startsWith('/')) return prefix + suffix.slice(1)
  return prefix + middle + suffix
}
