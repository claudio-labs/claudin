import { describe, expect, test } from 'bun:test'
import type { TreeRow } from 'src/vcs/diff/ui/fileTree.js'
import {
  clampIndex,
  indexOfFile,
  reselect,
  selectedFileKey,
} from 'src/vcs/diff/ui/reselect.js'

function fileRow(root: string, path: string): TreeRow {
  return {
    kind: 'file',
    root,
    file: {
      path,
      linesAdded: 1,
      linesRemoved: 0,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
    },
    hunks: [],
    depth: 1,
    guides: '',
  }
}

function dirRow(key: string): TreeRow {
  return { kind: 'dir', key, label: key, depth: 0, collapsed: false, guides: '' }
}

const ROOT = '/repo'

describe('selectedFileKey', () => {
  test('reads root and path off a file row', () => {
    const rows = [fileRow(ROOT, 'src/a.ts')]
    expect(selectedFileKey(rows, 0)).toEqual({ root: ROOT, path: 'src/a.ts' })
  })

  test('is null on a folder row and out of range', () => {
    const rows = [dirRow('src'), fileRow(ROOT, 'src/a.ts')]
    expect(selectedFileKey(rows, 0)).toBeNull()
    expect(selectedFileKey(rows, 9)).toBeNull()
  })
})

describe('indexOfFile', () => {
  test('finds the file wherever it moved to', () => {
    const rows = [
      dirRow('src'),
      fileRow(ROOT, 'src/new.ts'),
      fileRow(ROOT, 'src/a.ts'),
    ]
    expect(indexOfFile(rows, { root: ROOT, path: 'src/a.ts' })).toBe(2)
  })

  test('same path in a different repo is a different file', () => {
    const rows = [fileRow('/other', 'src/a.ts'), fileRow(ROOT, 'src/a.ts')]
    expect(indexOfFile(rows, { root: ROOT, path: 'src/a.ts' })).toBe(1)
  })

  test('null when the file is gone', () => {
    expect(indexOfFile([dirRow('src')], { root: ROOT, path: 'x.ts' })).toBeNull()
  })
})

describe('clampIndex', () => {
  test('clamps into range and floors at 0 for an empty list', () => {
    expect(clampIndex(7, 3)).toBe(2)
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(1, 3)).toBe(1)
    expect(clampIndex(4, 0)).toBe(0)
  })
})

describe('reselect', () => {
  test('follows the file when a new one is inserted above it', () => {
    const before = [fileRow(ROOT, 'src/a.ts'), fileRow(ROOT, 'src/b.ts')]
    const key = selectedFileKey(before, 1)
    const after = [
      fileRow(ROOT, 'src/000-new.ts'),
      fileRow(ROOT, 'src/a.ts'),
      fileRow(ROOT, 'src/b.ts'),
    ]
    expect(reselect(after, key, 1)).toEqual({ index: 2, matched: true })
  })

  test('clamps, unmatched, when the selected file stopped being changed', () => {
    const key = { root: ROOT, path: 'src/gone.ts' }
    expect(reselect([fileRow(ROOT, 'src/a.ts')], key, 4)).toEqual({
      index: 0,
      matched: false,
    })
  })

  test('keeps the index when nothing moved', () => {
    const rows = [fileRow(ROOT, 'src/a.ts'), fileRow(ROOT, 'src/b.ts')]
    expect(reselect(rows, selectedFileKey(rows, 1), 1)).toEqual({
      index: 1,
      matched: true,
    })
  })

  test('a null key (folder row selected) just clamps', () => {
    const rows = [dirRow('src'), fileRow(ROOT, 'src/a.ts')]
    expect(reselect(rows, null, 0)).toEqual({ index: 0, matched: false })
    expect(reselect(rows, null, 5)).toEqual({ index: 1, matched: false })
  })
})
