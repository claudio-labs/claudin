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
  })
})
