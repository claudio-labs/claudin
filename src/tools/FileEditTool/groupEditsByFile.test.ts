import { describe, expect, test } from 'bun:test'
import { groupEditsByFile } from './utils.js'

describe('groupEditsByFile', () => {
  test('groups items by file path, preserving first-seen order', () => {
    const items = [
      { filePath: 'a.ts', n: 1 },
      { filePath: 'b.ts', n: 2 },
      { filePath: 'a.ts', n: 3 },
      { filePath: 'a.ts', n: 4 },
      { filePath: 'b.ts', n: 5 },
    ]
    const groups = groupEditsByFile(items)
    expect(groups.map(g => g.filePath)).toEqual(['a.ts', 'b.ts'])
    expect(groups[0]!.items.map(i => i.n)).toEqual([1, 3, 4])
    expect(groups[1]!.items.map(i => i.n)).toEqual([2, 5])
  })

  test('returns one single-item group per distinct file', () => {
    const items = [{ filePath: 'x.ts' }, { filePath: 'y.ts' }]
    const groups = groupEditsByFile(items)
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.items.length === 1)).toBe(true)
  })

  test('handles empty input', () => {
    expect(groupEditsByFile([])).toEqual([])
  })

  test('keeps the empty-string path as its own group', () => {
    const items = [{ filePath: '' }, { filePath: 'a.ts' }, { filePath: '' }]
    const groups = groupEditsByFile(items)
    expect(groups.map(g => g.filePath)).toEqual(['', 'a.ts'])
    expect(groups[0]!.items).toHaveLength(2)
  })
})
