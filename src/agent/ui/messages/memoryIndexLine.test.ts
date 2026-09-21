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
  test('names the two indexes separately', () => {
    expect(formatMemoryIndexCounts([index('auto', 16), index('team', 121)])).toBe(
      'private memories index (16 entries), team memories index (121 entries)',
    )
  })

  test('private always leads, whatever order getMemoryFiles returned', () => {
    expect(formatMemoryIndexCounts([index('team', 121), index('auto', 16)])).toBe(
      'private memories index (16 entries), team memories index (121 entries)',
    )
  })

  test('one index alone is the whole clause', () => {
    expect(formatMemoryIndexCounts([index('auto', 4)])).toBe(
      'private memories index (4 entries)',
    )
    expect(formatMemoryIndexCounts([index('team', 9)])).toBe(
      'team memories index (9 entries)',
    )
  })

  test('singular is "entry", not "entrys"', () => {
    expect(formatMemoryIndexCounts([index('auto', 1), index('team', 1)])).toBe(
      'private memories index (1 entry), team memories index (1 entry)',
    )
  })

  test('a cut index reports what arrived out of what the file holds', () => {
    // The whole point of the truncated form: without it the cap fires in
    // silence, because the warning truncateEntrypointContent appends goes to
    // the model and claude_md_delta renders null.
    expect(formatMemoryIndexCounts([index('auto', 16), index('team', 96, 121)])).toBe(
      'private memories index (16 entries), team memories index (96 of 121 entries)',
    )
  })

  test('an empty index still reports its zero rather than vanishing', () => {
    expect(formatMemoryIndexCounts([index('team', 0)])).toBe(
      'team memories index (0 entries)',
    )
  })

  test('the number counts index entries, never memories — the files did not load', () => {
    // The line used to read "Loaded 16 memories, 121 team memories", which
    // a user took as 137 memory files entering context. Only the pointers do,
    // so no count may sit directly in front of the word "memories".
    const out = formatMemoryIndexCounts([index('auto', 16), index('team', 121)])
    expect(out).not.toMatch(/\d+ (team )?memories/)
    expect(out).toMatch(/\(\d+ entries\)/)
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
