import { describe, expect, test } from 'bun:test'
import type { DiffFile } from 'src/hooks/useDiffData.js'
import type { TreeRow } from 'src/components/diff/fileTree.js'
import { createPrefill, resolveNewFilePath } from 'src/components/explorer/explorerActions.js'

const ROOT = '/repo'

function fileRow(path: string): TreeRow {
  const file = { path } as DiffFile
  return { kind: 'file', file, root: ROOT, hunks: [], depth: 0, guides: '' }
}

function dirRow(rel: string): TreeRow {
  return {
    kind: 'dir',
    key: `${ROOT}\u0000${rel}`,
    label: rel,
    depth: 0,
    collapsed: false,
    guides: '',
  }
}

const groupRow: TreeRow = {
  kind: 'group',
  key: ROOT,
  name: '',
  meta: '',
  branch: '',
  repoIndex: 0,
  collapsed: false,
  depth: 0,
}

describe('createPrefill', () => {
  test('nested file → parent dir with trailing slash', () => {
    expect(createPrefill(fileRow('src/components/X.tsx'), ROOT)).toBe(
      'src/components/',
    )
  })

  test('root-level file → empty', () => {
    expect(createPrefill(fileRow('a.ts'), ROOT)).toBe('')
  })

  test('dir row → its path with trailing slash', () => {
    expect(createPrefill(dirRow('src/components'), ROOT)).toBe(
      'src/components/',
    )
  })

  test('group row and undefined → empty', () => {
    expect(createPrefill(groupRow, ROOT)).toBe('')
    expect(createPrefill(undefined, ROOT)).toBe('')
  })
})

describe('resolveNewFilePath', () => {
  test('plain file name resolves under root', () => {
    const res = resolveNewFilePath(ROOT, 'foo.ts')
    expect(res).toEqual({ ok: true, relPath: 'foo.ts', fullPath: '/repo/foo.ts' })
  })

  test('nested path resolves and normalizes', () => {
    const res = resolveNewFilePath(ROOT, './a/b/c.ts')
    expect(res).toEqual({
      ok: true,
      relPath: 'a/b/c.ts',
      fullPath: '/repo/a/b/c.ts',
    })
  })

  test('empty / whitespace → error', () => {
    expect(resolveNewFilePath(ROOT, '   ').ok).toBe(false)
  })

  test('trailing slash (directory) → error', () => {
    expect(resolveNewFilePath(ROOT, 'src/').ok).toBe(false)
  })

  test('path escaping the project root → error', () => {
    const res = resolveNewFilePath(ROOT, '../escape.ts')
    expect(res.ok).toBe(false)
  })
})
