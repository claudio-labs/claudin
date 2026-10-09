import { describe, expect, test } from 'bun:test'
import { formatMemoryRecallCounts } from 'src/agent/ui/messages/memoryRecallLine.js'

describe('formatMemoryRecallCounts', () => {
  test('singular and plural, private and team', () => {
    expect(formatMemoryRecallCounts(1, 0)).toBe('1 memory')
    expect(formatMemoryRecallCounts(4, 0)).toBe('4 memories')
    expect(formatMemoryRecallCounts(0, 1)).toBe('1 team memory')
    expect(formatMemoryRecallCounts(0, 2)).toBe('2 team memories')
  })

  test('private precedes team, joined by a comma', () => {
    expect(formatMemoryRecallCounts(1, 2)).toBe('1 memory, 2 team memories')
  })

  test('nothing recalled means no line at all', () => {
    expect(formatMemoryRecallCounts(0, 0)).toBeUndefined()
    expect(formatMemoryRecallCounts(0, 0, 0)).toBeUndefined()
  })

  test('global memories are named global, singular and plural', () => {
    expect(formatMemoryRecallCounts(0, 0, 1)).toBe('1 global memory')
    expect(formatMemoryRecallCounts(0, 0, 2)).toBe('2 global memories')
  })

  test('global, private, team — general to specific', () => {
    expect(formatMemoryRecallCounts(1, 3, 2)).toBe(
      '2 global memories, 1 memory, 3 team memories',
    )
    expect(formatMemoryRecallCounts(1, 0, 1)).toBe('1 global memory, 1 memory')
  })
})
