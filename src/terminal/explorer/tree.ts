/**
 * Pure tree-source helpers for the /explorer file pane. We reuse the /diff
 * reviewer's tree builder (buildTreeRows) — it already synthesizes the folder
 * hierarchy, indent guides, sort and compaction from a FLAT list of file paths.
 * The diff reviewer only ever feeds it CHANGED files; here we feed the whole
 * project file list, so the same builder yields a full project tree for free.
 *
 * Framework-free (no React/Ink) → unit-testable under `bun test`.
 */

import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'
import { buildTreeRows, type TreeRow } from 'src/vcs/diff/ui/fileTree.js'
import type { RepoGroup } from 'src/vcs/diff/ui/types.js'
import { basename, relative, resolve } from 'path'

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

/** Collapse key of the "Changed" quick-access group (never a real repo root). */
export const CHANGED_GROUP_KEY = '\u0000explorer-changed'

/**
 * A changed file tagged with the repo it came from. The workspace scan picks up
 * nested repos, so a changed file's OWN root — not the explorer's cwd — is what
 * opens/renames/deletes it, and `label` (its path as seen from the explorer
 * root) is what keeps same-named files apart in the flat list and what matches
 * the project tree's keys for status tinting.
 */
export type ChangedEntry = { file: DiffFile; root: string; label: string }

/** Path of `path` (relative to `repoRoot`) as seen from the explorer root. */
function labelFor(explorerRoot: string, repoRoot: string, path: string): string {
  const rel = relative(explorerRoot, resolve(repoRoot, path))
  // A workspace root outside the cwd (e.g. `/add-dir`) has no sane relative
  // form — name it by its repo folder instead of a `../../..` chain.
  return rel && !rel.startsWith('..') ? rel : `${basename(repoRoot)}/${path}`
}

/** Flatten every repo group's changed files into root-tagged, labelled entries. */
export function collectChangedFiles(
  explorerRoot: string,
  groups: RepoGroup[],
): ChangedEntry[] {
  return groups.flatMap(g =>
    g.files.map(file => ({
      file,
      root: g.root,
      label: labelFor(explorerRoot, g.root, file.path),
    })),
  )
}

/**
 * The "Changed" quick-access group: a header row plus (when expanded) one flat,
 * path-labelled row per changed file. Empty when nothing changed.
 */
export function buildChangedRows(
  entries: ChangedEntry[],
  collapsed: Set<string>,
): TreeRow[] {
  if (entries.length === 0) return []
  const isCollapsed = collapsed.has(CHANGED_GROUP_KEY)
  const out: TreeRow[] = [
    {
      kind: 'group',
      key: CHANGED_GROUP_KEY,
      name: 'Changed',
      meta: `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`,
      branch: '',
      repoIndex: 0,
      collapsed: isCollapsed,
      depth: 0,
    },
  ]
  if (isCollapsed) return out
  for (const e of [...entries].sort((a, b) => a.label.localeCompare(b.label))) {
    out.push({
      kind: 'file',
      file: e.file,
      root: e.root,
      hunks: [],
      depth: 0,
      guides: '',
      label: e.label,
    })
  }
  return out
}
