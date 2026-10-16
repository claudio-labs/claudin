import { describe, expect, test } from 'bun:test'
import { memoryAgeDays, memoryFreshnessNote, memoryReadNote } from 'src/memory/memdir/memoryAge.js'

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

describe('memoryReadNote', () => {
  const TODAY = '2026-10-16'

  test('a fresh memory with no expiry, or one not past it, says nothing', () => {
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: null }, TODAY)).toBe('')
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: '2026-10-16' }, TODAY)).toBe('')
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: '2026-12-31' }, TODAY)).toBe('')
  })

  test('an old memory alone is the age caveat, exactly as before', () => {
    expect(memoryReadNote({ mtimeMs: ago(17, 1000), expires: null }, TODAY)).toBe(memoryFreshnessNote(ago(17, 1000)))
  })

  test('a fresh memory past its expires: date asks for a re-verify', () => {
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: '2026-09-30' }, TODAY)).toBe(
      '<system-reminder>Its `expires:` date, 2026-09-30, has passed: re-verify it before relying on it, then move the date or remove the memory.</system-reminder>\n',
    )
  })

  test('old and expired: both in one reminder, the age first', () => {
    const note = memoryReadNote({ mtimeMs: ago(40, 1000), expires: '2026-09-30' }, TODAY)
    expect(note.match(/<system-reminder>/g)?.length).toBe(1)
    expect(note.indexOf('days old')).toBeLessThan(note.indexOf('has passed'))
  })
})
