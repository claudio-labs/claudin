import type { StructuredPatchHunk } from 'diff'
import { basename } from 'path'
import type { DiffFile } from 'src/hooks/useDiffData.js'
import { plural } from 'src/shared/text/stringUtils.js'
import type { RepoGroup } from 'src/components/diff/types.js'

/**
 * A flattened, render-ready row of the file tree. `dir`/`group` rows are
 * structural (folders + per-repo headers); `file` rows are selectable and
 * carry everything the dialog needs to show the diff (the hunks + repo root).
 * The dialog owns selection over this row list and toggles `collapsed`.
 */
export type TreeRow =
  | {
      kind: 'group'
      /** Collapse key (the repo root; never collides with dir keys, which embed a NUL). */
      key: string
      name: string
      /** Change count, e.g. "4 files changed" (branch is rendered separately). */
      meta: string
      /** This group's branch, shown with a branch glyph; '' when unknown. */
      branch: string
      /** Position among header'd groups — drives the per-repo swatch color. */
      repoIndex: number
      /** Collapsed groups emit the header row but skip their whole subtree. */
      collapsed: boolean
      depth: number
    }
  | {
      kind: 'dir'
      key: string
      label: string
      depth: number
      collapsed: boolean
      /** Pre-rendered indent-guide prefix (one segment per level). */
      guides: string
    }
  | {
      kind: 'file'
      file: DiffFile
      root: string
      hunks: StructuredPatchHunk[]
      depth: number
      /** Pre-rendered indent-guide prefix (one segment per level). */
      guides: string
      /**
       * Explicit row text, overriding the default basename. Set by flat lists
       * (the /explorer "Changed" group) where no folder row carries the path,
       * so same-named files stay distinguishable.
       */
      label?: string
    }

// Tree indent-guide segments, each two columns wide so they line up exactly
// with the old two-space indent. Box-drawing chars are safe on any monospace
// terminal (the ▾/▸ carets already assume Unicode).
const GUIDE_VERTICAL = '│ ' // a level that still has rows below this one
const GUIDE_LAST = '└ ' // the last child of its folder (elbow connector)
const GUIDE_BLANK = '  ' // an ancestor whose subtree already ended

/**
 * Build a row's indent-guide string: one ancestor column per `ancestorCols`
 * entry (a continuing `│` or a blank), then the row's own connector — an elbow
 * `└` when it's the last child, otherwise a straight `│`. Depth-0 rows (a
 * single-repo's top level) get no guides, matching the flush look there.
 */
function makeGuides(
  depth: number,
  ancestorCols: string[],
  isLast: boolean,
): string {
  if (depth === 0) return ''
  return ancestorCols.join('') + (isLast ? GUIDE_LAST : GUIDE_VERTICAL)
}

type DirNode = {
  name: string
  dirs: Map<string, DirNode>
  files: DiffFile[]
}

function newDir(name: string): DirNode {
  return { name, dirs: new Map(), files: [] }
}

/** Build a nested folder tree from a group's flat file list. */
function buildDirTree(files: DiffFile[]): DirNode {
  const root = newDir('')
  for (const file of files) {
    const parts = file.path.split('/')
    parts.pop() // drop the filename
    let node = root
    for (const part of parts) {
      let child = node.dirs.get(part)
      if (!child) {
        child = newDir(part)
        node.dirs.set(part, child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

/**
 * Depth-first flatten of a folder node into TreeRows: folders first (sorted),
 * then files (sorted by basename). Single-child directory chains are compacted
 * into one row (`components/diff`) like VS Code's compact folders, so deep
 * trees don't waste rows/indentation. Collapsed directories emit their own row
 * but skip their descendants.
 */
function flattenDir(
  node: DirNode,
  prefixPath: string,
  depth: number,
  collapsed: Set<string>,
  root: string,
  hunksOf: (path: string) => StructuredPatchHunk[],
  out: TreeRow[],
  // Resolved guide columns for every ancestor of this node's children.
  ancestorCols: string[],
): void {
  const dirs = [...node.dirs.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const files = [...node.files].sort((a, b) =>
    basename(a.path).localeCompare(basename(b.path)),
  )
  const hasFiles = files.length > 0
  for (let i = 0; i < dirs.length; i++) {
    let dir = dirs[i]!
    let label = dir.name
    let path = prefixPath ? `${prefixPath}/${dir.name}` : dir.name
    // Compact a/b/c chains while each level has exactly one sub-dir and no files.
    while (dir.files.length === 0 && dir.dirs.size === 1) {
      const only = dir.dirs.values().next().value as DirNode
      label = `${label}/${only.name}`
      path = `${path}/${only.name}`
      dir = only
    }
    // Folders precede files, so a folder is the very last child only when it's
    // the last folder AND this node has no files.
    const isLast = i === dirs.length - 1 && !hasFiles
    const key = `${root}\u0000${path}`
    const isCollapsed = collapsed.has(key)
    out.push({
      kind: 'dir',
      key,
      label,
      depth,
      collapsed: isCollapsed,
      guides: makeGuides(depth, ancestorCols, isLast),
    })
    if (!isCollapsed) {
      // This folder contributes a guide column to its descendants only once it
      // has a guide of its own (depth ≥ 1): a continuing `│` unless it was the
      // last child, in which case the column goes blank below it.
      const childCols =
        depth >= 1
          ? [...ancestorCols, isLast ? GUIDE_BLANK : GUIDE_VERTICAL]
          : ancestorCols
      flattenDir(dir, path, depth + 1, collapsed, root, hunksOf, out, childCols)
    }
  }
  for (let j = 0; j < files.length; j++) {
    const file = files[j]!
    const isLast = j === files.length - 1
    out.push({
      kind: 'file',
      file,
      root,
      hunks: hunksOf(file.path),
      depth,
      guides: makeGuides(depth, ancestorCols, isLast),
    })
  }
}

/**
 * Build the full visible row list for the Local Changes file pane: a folder
 * tree per repo group, honouring the collapsed-directory set.
 */
export function buildTreeRows(
  groups: RepoGroup[],
  collapsed: Set<string>,
): TreeRow[] {
  const out: TreeRow[] = []
  const showHeaders = groups.length > 1
  let repoIndex = 0
  for (const group of groups) {
    // Indent a subproject's tree one level under its header so child file/dir
    // rows line up beneath the header's name (the header's caret + swatch make
    // depth-0 children look 2 columns too far left). Single-repo view (no
    // header) stays flush at depth 0.
    const baseDepth = showHeaders ? 1 : 0
    if (showHeaders) {
      // The repo root keys the group's collapse state (no NUL → no dir clash).
      const groupCollapsed = collapsed.has(group.root)
      out.push({
        kind: 'group',
        key: group.root,
        name: group.name,
        meta: `${group.files.length} ${plural(
          group.files.length,
          'file',
        )} changed`,
        branch: group.branch,
        repoIndex: repoIndex++,
        collapsed: groupCollapsed,
        depth: 0,
      })
      if (groupCollapsed) continue // hide this repo's entire file tree
    }
    flattenDir(
      buildDirTree(group.files),
      '',
      baseDepth,
      collapsed,
      group.root,
      p => group.hunks.get(p) ?? [],
      out,
      [],
    )
  }
  return out
}
