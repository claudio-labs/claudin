import { describe, expect, test } from 'bun:test'
import { memoryAgeDays, memoryFreshnessNote } from 'src/memory/memdir/memoryAge.js'

const DAY = 86_400_000
const ago = (days: number, extraMs = 0) => Date.now() - days * DAY - extraMs

describe('memoryAgeDays', () => {
  test('floors to whole days: 0 today, 1 yesterday, 2 and up after', () => {
    expect(memoryAgeDays(ago(0, 1000))).toBe(0)
    expect(memoryAgeDays(ago(1, 1000))).toBe(1)
    expect(memoryAgeDays(ago(2, 1000))).toBe(2)
    expect(memoryAgeDays(ago(40, 1000))).toBe(40)
  })

  test('a future mtime (clock skew) clamps to 0', () => {
    expect(memoryAgeDays(Date.now() + 5 * DAY)).toBe(0)
  })
})

describe('memoryFreshnessNote', () => {
  test('says nothing for a memory written today or yesterday', () => {
    expect(memoryFreshnessNote(ago(0, 1000))).toBe('')
    expect(memoryFreshnessNote(ago(1, 1000))).toBe('')
  })

  test('wraps the age caveat in a system-reminder past one day', () => {
    const note = memoryFreshnessNote(ago(17, 1000))
    expect(note.startsWith('<system-reminder>This memory is 17 days old. ')).toBe(true)
    expect(note).toContain('Verify against current code before asserting as fact.')
    expect(note.endsWith('</system-reminder>\n')).toBe(true)
  })
})
