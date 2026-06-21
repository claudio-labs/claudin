import { describe, expect, test } from 'bun:test'
import {
  buildExplorerGroup,
  buildExplorerRows,
  collapseKeyOf,
  initialCollapsed,
} from './tree.js'

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
