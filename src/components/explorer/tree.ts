/**
 * Pure tree-source helpers for the /explorer file pane. We reuse the /diff
 * reviewer's tree builder (buildTreeRows) — it already synthesizes the folder
 * hierarchy, indent guides, sort and compaction from a FLAT list of file paths.
 * The diff reviewer only ever feeds it CHANGED files; here we feed the whole
 * project file list, so the same builder yields a full project tree for free.
 *
 * Framework-free (no React/Ink) → unit-testable under `bun test`.
 */

import type { DiffFile } from '../../hooks/useDiffData.js'
import { buildTreeRows, type TreeRow } from '../diff/fileTree.js'
import type { RepoGroup } from '../diff/types.js'

/** Wrap a flat list of project-relative paths as one synthetic RepoGroup. */
export function buildExplorerGroup(root: string, paths: string[]): RepoGroup {
  const files: DiffFile[] = paths.map(path => ({
    path,
    linesAdded: 0,
    linesRemoved: 0,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
  }))
  return { root, name: '', branch: '', files, hunks: new Map() }
}

/** Collapse-aware flattened rows for the tree (passthrough to buildTreeRows). */
export function buildExplorerRows(
  group: RepoGroup,
  collapsed: Set<string>,
): TreeRow[] {
  return buildTreeRows([group], collapsed)
}

/**
 * Keys of every top-level directory, so the tree opens collapsed (a project may
 * have thousands of files). Computed from the fully-expanded rows so compacted
 * single-child chains (`a/b/c`) get their real key, which a naive
 * first-segment guess would miss.
 */
export function initialCollapsed(group: RepoGroup): Set<string> {
  const collapsed = new Set<string>()
  for (const row of buildTreeRows([group], new Set())) {
    if (row.kind === 'dir' && row.depth === 0) collapsed.add(row.key)
  }
  return collapsed
}

/** The collapse key for a dir/group row, or null for a file row. */
export function collapseKeyOf(row: TreeRow): string | null {
  return row.kind === 'file' ? null : row.key
}
