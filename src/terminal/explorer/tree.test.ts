import { describe, expect, test } from 'bun:test'
import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'
import type { RepoGroup } from 'src/vcs/diff/ui/types.js'
import {
  buildChangedRows,
  buildExplorerGroup,
  buildExplorerRows,
  CHANGED_GROUP_KEY,
  collapseKeyOf,
  collectChangedFiles,
  initialCollapsed,
} from 'src/terminal/explorer/tree.js'

const ROOT = '/repo'
const PATHS = ['a.ts', 'src/b.ts', 'src/c.ts']

describe('buildExplorerGroup', () => {
  test('wraps a flat path list as one synthetic group', () => {
    const g = buildExplorerGroup(ROOT, PATHS)
    expect(g.root).toBe(ROOT)
    expect(g.files.map(f => f.path)).toEqual(PATHS)
    // Synthetic files carry no churn / status flags → clean tree rows.
    expect(g.files[0]).toMatchObject({ isBinary: false, linesAdded: 0 })
  })
})

describe('buildExplorerRows', () => {
  test('expanded: folder first (with children), then top-level files', () => {
    const g = buildExplorerGroup(ROOT, PATHS)
    const rows = buildExplorerRows(g, new Set())
    expect(rows.map(r => r.kind)).toEqual(['dir', 'file', 'file', 'file'])
    expect(rows[0]).toMatchObject({ kind: 'dir', label: 'src', collapsed: false })
    const fileRows = rows.filter(r => r.kind === 'file')
    expect(fileRows.map(r => (r.kind === 'file' ? r.file.path : ''))).toEqual([
      'src/b.ts',
      'src/c.ts',
      'a.ts',
    ])
  })

  test('collapsed top-level dir hides its subtree', () => {
    const g = buildExplorerGroup(ROOT, PATHS)
    const collapsed = initialCollapsed(g)
    const rows = buildExplorerRows(g, collapsed)
    expect(rows.map(r => r.kind)).toEqual(['dir', 'file'])
    expect(rows[0]).toMatchObject({ kind: 'dir', collapsed: true })
    expect(rows[1]).toMatchObject({ kind: 'file' })
    expect(rows[1].kind === 'file' && rows[1].file.path).toBe('a.ts')
  })
})

describe('initialCollapsed', () => {
  test('collapses every top-level directory (compacted chains included)', () => {
    const g = buildExplorerGroup(ROOT, ['deep/very/nested.ts', 'top.ts'])
    const collapsed = initialCollapsed(g)
    // The single-child chain compacts to "deep/very" → that is the real key.
    expect(collapsed.has(`${ROOT}\u0000deep/very`)).toBe(true)
    const rows = buildExplorerRows(g, collapsed)
    expect(rows.map(r => r.kind)).toEqual(['dir', 'file'])
  })
})

describe('collapseKeyOf', () => {
  test('returns the key for dir rows and null for file rows', () => {
    const g = buildExplorerGroup(ROOT, PATHS)
    const rows = buildExplorerRows(g, new Set())
    expect(collapseKeyOf(rows[0]!)).toBe(`${ROOT}\u0000src`)
    const file = rows.find(r => r.kind === 'file')!
    expect(collapseKeyOf(file)).toBeNull()
  })
})

function changedFile(path: string): DiffFile {
  return {
    path,
    linesAdded: 1,
    linesRemoved: 0,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
  }
}

function repoGroup(root: string, paths: string[]): RepoGroup {
  return {
    root,
    name: root.split('/').pop() ?? root,
    branch: 'main',
    files: paths.map(changedFile),
    hunks: new Map(),
  }
}

describe('collectChangedFiles', () => {
  test('keeps each file on its OWN repo root and labels it from the explorer root', () => {
    const entries = collectChangedFiles(ROOT, [
      repoGroup(ROOT, ['a.ts']),
      repoGroup(`${ROOT}/inner`, ['site/api/index.html']),
    ])
    // The nested repo's file must carry the nested root — opening it against
    // the explorer's root resolves to a path that does not exist.
    expect(entries).toEqual([
      { file: changedFile('a.ts'), root: ROOT, label: 'a.ts' },
      {
        file: changedFile('site/api/index.html'),
        root: `${ROOT}/inner`,
        label: 'inner/site/api/index.html',
      },
    ])
  })

  test('names a repo outside the explorer root by its folder', () => {
    const entries = collectChangedFiles(ROOT, [
      repoGroup('/elsewhere/other', ['src/x.ts']),
    ])
    expect(entries[0]!.label).toBe('other/src/x.ts')
  })
})

describe('buildChangedRows', () => {
  const entries = collectChangedFiles(ROOT, [
    repoGroup(`${ROOT}/inner`, ['site/b/index.html', 'site/a/index.html']),
  ])

  test('collapsed by default state: header only', () => {
    const rows = buildChangedRows(entries, new Set([CHANGED_GROUP_KEY]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'group', name: 'Changed', meta: '2 files' })
  })

  test('expanded: one path-labelled row per file, sorted by label', () => {
    const rows = buildChangedRows(entries, new Set())
    const files = rows.filter(r => r.kind === 'file')
    // Same-basename files stay distinguishable — the label, not the basename,
    // is what the row renders.
    expect(files.map(r => (r.kind === 'file' ? r.label : ''))).toEqual([
      'inner/site/a/index.html',
      'inner/site/b/index.html',
    ])
    expect(files[0]).toMatchObject({ root: `${ROOT}/inner`, depth: 0 })
  })

  test('no rows at all when nothing changed', () => {
    expect(buildChangedRows([], new Set())).toEqual([])
  })
})
