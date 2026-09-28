/**
 * The untracked files folded into the tracked numbers, without git: the count
 * of finding 5 (docs/tech/rewrite/vcs/gitDiff.md) and the room left for
 * entries, pinned directly.
 */
import { describe, expect, test } from 'bun:test'
import type { NumstatResult, PerFileStats } from 'src/vcs/git/gitDiff.js'
import { parseUntrackedList, withUntrackedFiles } from 'src/vcs/git/gitDiff/untrackedFiles.js'

const edited: PerFileStats = { added: 1, removed: 1, isBinary: false }
const untrackedEntry: PerFileStats = { added: 0, removed: 0, isBinary: false, isUntracked: true }

/** `count` tracked files, one line changed in each. */
function trackedFiles(count: number): NumstatResult {
  const names = Array.from({ length: count }, (_, i) => `t-${String(i).padStart(2, '0')}.txt`)
  return {
    stats: { filesCount: count, linesAdded: count, linesRemoved: count },
    perFileStats: new Map(names.map(name => [name, { ...edited }] as const)),
  }
}

describe('withUntrackedFiles', () => {
  test('untracked files follow the tracked ones and add to the count, not to the lines', () => {
    const result = withUntrackedFiles(trackedFiles(2), ['a.txt', 'b.txt'])
    expect([...result.perFileStats]).toStrictEqual([
      ['t-00.txt', edited],
      ['t-01.txt', edited],
      ['a.txt', untrackedEntry],
      ['b.txt', untrackedEntry],
    ])
    expect(result.stats).toStrictEqual({ filesCount: 4, linesAdded: 2, linesRemoved: 2 })
    expect(result.hunks.size).toBe(0)
  })

  test('once the entries are full, the untracked files left over still count', () => {
    const result = withUntrackedFiles(trackedFiles(49), ['a.txt', 'b.txt', 'c.txt'])
    expect(result.perFileStats.size).toBe(50)
    expect([...result.perFileStats.keys()].at(-1)).toBe('a.txt')
    expect(result.stats.filesCount).toBe(52)
  })
})

describe('parseUntrackedList', () => {
  test('one file per line, and the final newline adds none', () => {
    expect(parseUntrackedList('a.txt\nsub/b.txt\n')).toEqual(['a.txt', 'sub/b.txt'])
    expect(parseUntrackedList('')).toEqual([])
  })
})
