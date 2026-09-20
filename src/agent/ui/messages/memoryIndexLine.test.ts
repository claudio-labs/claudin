import { describe, expect, test } from 'bun:test'
import type { MemoryIndexSummary } from 'src/agent/attachments/types.js'
import {
  formatMemoryIndexCounts,
  hasTruncatedMemoryIndex,
} from 'src/agent/ui/messages/memoryIndexLine.js'

function index(
  kind: MemoryIndexSummary['kind'],
  entryCount: number,
  totalEntryCount = entryCount,
): MemoryIndexSummary {
  return {
    path: `/repo/.claudin/memory/${kind}/MEMORY.md`,
    displayPath: `.claudin/memory/${kind}/MEMORY.md`,
    kind,
    entryCount,
    totalEntryCount,
  }
}

describe('formatMemoryIndexCounts', () => {
  test('names the two directories separately', () => {
    expect(formatMemoryIndexCounts([index('auto', 16), index('team', 121)])).toBe(
      '16 memories, 121 team memories',
    )
  })

  test('private always leads, whatever order getMemoryFiles returned', () => {
    expect(formatMemoryIndexCounts([index('team', 121), index('auto', 16)])).toBe(
      '16 memories, 121 team memories',
    )
  })

  test('one index alone is the whole clause', () => {
    expect(formatMemoryIndexCounts([index('auto', 4)])).toBe('4 memories')
    expect(formatMemoryIndexCounts([index('team', 9)])).toBe('9 team memories')
  })

  test('singular is "memory", not "memorys"', () => {
    expect(formatMemoryIndexCounts([index('auto', 1), index('team', 1)])).toBe(
      '1 memory, 1 team memory',
    )
  })

  test('a cut index reports what arrived out of what the file holds', () => {
    // The whole point of the truncated form: without it the cap fires in
    // silence, because the warning truncateEntrypointContent appends goes to
    // the model and claude_md_delta renders null.
    expect(formatMemoryIndexCounts([index('auto', 16), index('team', 96, 121)])).toBe(
      '16 memories, 96 of 121 team memories',
    )
  })

  test('an empty index still reports its zero rather than vanishing', () => {
    expect(formatMemoryIndexCounts([index('team', 0)])).toBe('0 team memories')
  })
})

describe('hasTruncatedMemoryIndex', () => {
  test('false when every index arrived whole', () => {
    expect(hasTruncatedMemoryIndex([index('auto', 16), index('team', 121)])).toBe(
      false,
    )
  })

  test('true when any one of them was cut', () => {
    expect(
      hasTruncatedMemoryIndex([index('auto', 16), index('team', 96, 121)]),
    ).toBe(true)
  })
})
