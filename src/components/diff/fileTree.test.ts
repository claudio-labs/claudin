import { describe, expect, it } from 'bun:test'
import type { DiffFile } from '../../hooks/useDiffData.js'
import type { RepoGroup } from './types.js'
import { buildTreeRows, type TreeRow } from './fileTree.js'

function file(path: string): DiffFile {
  return {
    path,
    linesAdded: 1,
    linesRemoved: 0,
    isBinary: false,
    isLargeFile: false,
    isTruncated: false,
  }
}

function group(root: string, paths: string[]): RepoGroup {
  return {
    root,
    name: root.split('/').pop() ?? root,
    branch: '',
    files: paths.map(file),
    hunks: new Map(),
  }
}

/** Compact "<kind> d<depth> <label|basename|name>" view for assertions. */
function sketch(rows: TreeRow[]): string[] {
  return rows.map(r => {
    const text =
      r.kind === 'dir'
        ? r.label
        : r.kind === 'file'
          ? r.file.path.split('/').pop()
          : r.name
    return `${r.kind} d${r.depth} ${text}`
  })
}

describe('buildTreeRows', () => {
  it('nests files under folders, folders before files, both sorted', () => {
    const g = group('/r', [
      'src/a.ts',
      'src/components/diff/x.tsx',
      'src/components/diff/y.tsx',
      'docs/readme.md',
    ])
    expect(sketch(buildTreeRows([g], new Set()))).toEqual([
      'dir d0 docs',
      'file d1 readme.md',
      'dir d0 src',
      // single-child chain components→diff compacted into one row
      'dir d1 components/diff',
      'file d2 x.tsx',
      'file d2 y.tsx',
      'file d1 a.ts', // folders precede files at the src level
    ])
  })

  it('compacts single-child directory chains', () => {
    const g = group('/r', ['a/b/c/deep.ts'])
    const rows = buildTreeRows([g], new Set())
    expect(rows[0]).toMatchObject({ kind: 'dir', label: 'a/b/c', depth: 0 })
    expect(rows[1]).toMatchObject({ kind: 'file', depth: 1 })
  })

  it('hides descendants of a collapsed directory but keeps the dir row', () => {
    const g = group('/r', ['src/components/diff/x.tsx', 'src/a.ts'])
    const collapsedKey = '/r\u0000src/components/diff'
    const rows = buildTreeRows([g], new Set([collapsedKey]))
    const labels = sketch(rows)
    expect(labels).toContain('dir d1 components/diff')
    // x.tsx is hidden, but a.ts (not under the collapsed dir) remains
    expect(labels).not.toContain('file d2 x.tsx')
    expect(labels).toContain('file d1 a.ts')
    const dir = rows.find(r => r.kind === 'dir' && r.label === 'components/diff')
    expect(dir).toMatchObject({ collapsed: true })
  })

  it('the collapse key is stable across calls (toggle round-trips)', () => {
    const g = group('/r', ['src/components/diff/x.tsx'])
    const dir = buildTreeRows([g], new Set()).find(r => r.kind === 'dir')!
    if (dir.kind !== 'dir') throw new Error('expected dir row')
    // Collapsing using the row's own key must hide the child.
    const collapsed = buildTreeRows([g], new Set([dir.key]))
    expect(collapsed.some(r => r.kind === 'file')).toBe(false)
  })

  it('emits a group header per repo only when more than one group', () => {
    const single = buildTreeRows([group('/r', ['a.ts'])], new Set())
    expect(single.some(r => r.kind === 'group')).toBe(false)

    const multi = buildTreeRows(
      [group('/r1', ['a.ts']), group('/r2', ['b.ts'])],
      new Set(),
    )
    const groups = multi.filter(r => r.kind === 'group')
    expect(groups).toHaveLength(2)
    // Files sit one level under their header so they line up beneath its name.
    const firstFile = multi.find(r => r.kind === 'file')!
    expect(firstFile.depth).toBe(1)
  })

  it('collapses a group by its root key: header stays, whole subtree hidden', () => {
    const rows = buildTreeRows(
      [group('/r1', ['a.ts', 'src/b.ts']), group('/r2', ['c.ts'])],
      new Set(['/r1']),
    )
    const r1 = rows.find(r => r.kind === 'group' && r.name === 'r1')!
    if (r1.kind !== 'group') throw new Error('expected group row')
    expect(r1).toMatchObject({ key: '/r1', collapsed: true })
    // r1 contributes no dir/file rows; r2 renders fully.
    const files = rows.filter(r => r.kind === 'file')
    expect(files.every(r => r.kind === 'file' && r.root === '/r2')).toBe(true)
    expect(rows.some(r => r.kind === 'dir')).toBe(false)
    // r2's header is expanded.
    const r2 = rows.find(r => r.kind === 'group' && r.name === 'r2')!
    expect(r2).toMatchObject({ collapsed: false })
  })

  it('attaches each file row to its group root and hunks', () => {
    const g = group('/repo', ['src/x.ts'])
    g.hunks.set('src/x.ts', [{ oldStart: 1 } as never])
    const fileRow = buildTreeRows([g], new Set()).find(r => r.kind === 'file')!
    if (fileRow.kind !== 'file') throw new Error('expected file row')
    expect(fileRow.root).toBe('/repo')
    expect(fileRow.hunks).toHaveLength(1)
  })
})
