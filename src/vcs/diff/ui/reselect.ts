import type { TreeRow } from 'src/vcs/diff/ui/fileTree.js'

/**
 * Keeping the reader's place across an automatic re-fetch.
 *
 * The reviewer selects by ROW INDEX, which is only meaningful for one snapshot
 * of the tree: a file the agent just created three rows above shifts everything
 * below it, so re-reading git with the index untouched silently moves the
 * selection to a different file. These helpers re-find the file by identity
 * (repo root + path) and fall back to a clamp when it is gone.
 *
 * Deliberately NOT applied to ordinary navigation — remapping on every data
 * change is what made an earlier attempt snap the selection back on each ↑/↓.
 * The caller consumes a one-shot request, recorded at the moment of the refresh.
 */

export type SelectedFileKey = { root: string; path: string }

/** The identity of the row at `index`, or null when it is not a file row. */
export function selectedFileKey(
  rows: readonly TreeRow[],
  index: number,
): SelectedFileKey | null {
  const row = rows[index]
  if (!row || row.kind !== 'file') return null
  return { root: row.root, path: row.file.path }
}

/** Where that file sits now, or null when it is no longer in the tree. */
export function indexOfFile(
  rows: readonly TreeRow[],
  key: SelectedFileKey,
): number | null {
  const index = rows.findIndex(
    row =>
      row.kind === 'file' &&
      row.root === key.root &&
      row.file.path === key.path,
  )
  return index === -1 ? null : index
}

/** `index` brought inside `[0, length)`; 0 for an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

export type Reselection = {
  /** The row to select now. */
  index: number
  /** Whether that row is the same FILE the caller asked to keep. */
  matched: boolean
}

/**
 * Where to put the selection after a re-fetch: the same file if it survived,
 * else the previous index clamped into the new range (the row that took its
 * place). `matched` is what tells the caller whether the selection is the
 * reader's or merely a fallback — the dialog only suppresses its own
 * "land on the first file" landing for the former.
 */
export function reselect(
  rows: readonly TreeRow[],
  key: SelectedFileKey | null,
  fallback: number,
): Reselection {
  if (key !== null) {
    const found = indexOfFile(rows, key)
    if (found !== null) return { index: found, matched: true }
  }
  return { index: clampIndex(fallback, rows.length), matched: false }
}
