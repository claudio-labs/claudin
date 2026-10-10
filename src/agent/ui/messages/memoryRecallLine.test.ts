import { describe, expect, test } from 'bun:test'
import { formatMemoryRecallCounts } from 'src/agent/ui/messages/memoryRecallLine.js'

describe('formatMemoryRecallCounts', () => {
  test('singular and plural, private and team', () => {
    expect(formatMemoryRecallCounts({ private: { read: 1 } })).toBe('1 private memory')
    expect(formatMemoryRecallCounts({ private: { read: 4 } })).toBe('4 private memories')
    expect(formatMemoryRecallCounts({ team: { read: 1 } })).toBe('1 team memory')
    expect(formatMemoryRecallCounts({ team: { read: 2 } })).toBe('2 team memories')
  })

  test('private precedes team, joined by a comma', () => {
    expect(
      formatMemoryRecallCounts({ team: { read: 2 }, private: { read: 1 } }),
    ).toBe('1 private memory, 2 team memories')
  })

  test('nothing recalled means no line at all', () => {
    expect(formatMemoryRecallCounts(undefined)).toBeUndefined()
    expect(formatMemoryRecallCounts({})).toBeUndefined()
    // A scope that only searched or wrote is present with a zero read.
    expect(
      formatMemoryRecallCounts({ global: { read: 0 }, private: { read: 0 } }),
    ).toBeUndefined()
  })

  test('global memories are named global, singular and plural', () => {
    expect(formatMemoryRecallCounts({ global: { read: 1 } })).toBe('1 global memory')
    expect(formatMemoryRecallCounts({ global: { read: 2 } })).toBe('2 global memories')
  })

  test('global, private, team — general to specific, whatever the key order', () => {
    expect(
      formatMemoryRecallCounts({
        team: { read: 3 },
        private: { read: 1 },
        global: { read: 2 },
      }),
    ).toBe('2 global memories, 1 private memory, 3 team memories')
    expect(
      formatMemoryRecallCounts({ private: { read: 1 }, global: { read: 1 } }),
    ).toBe('1 global memory, 1 private memory')
  })
})
