import { describe, expect, test } from 'bun:test'
import { memoryFreshnessNoteAt } from 'src/memory/memdir/memoryAge.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 28, 12)

describe('memoryFreshnessNoteAt', () => {
  test('silent up to two whole days, including a future mtime', () => {
    expect(memoryFreshnessNoteAt(NOW - 2 * DAY + 1, NOW)).toBe('')
    expect(memoryFreshnessNoteAt(NOW + 3 * DAY, NOW)).toBe('')
  })

  test('from exactly two days, the note names the whole days', () => {
    expect(memoryFreshnessNoteAt(NOW - 2 * DAY, NOW)).toContain('2 days old')
    expect(memoryFreshnessNoteAt(NOW - 10 * DAY - 1, NOW)).toContain('10 days old')
  })
})
