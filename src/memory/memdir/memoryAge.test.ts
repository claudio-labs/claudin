import { afterEach, describe, expect, test } from 'bun:test'
import { memoryAgeDays, memoryReadNote } from 'src/memory/memdir/memoryAge.js'

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

describe('memoryReadNote', () => {
  const TODAY = '2026-10-16'

  test('a memory written today or yesterday with no expiry, or one not past it, says nothing', () => {
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: null }, TODAY)).toBe('')
    expect(memoryReadNote({ mtimeMs: ago(1, 1000), expires: null }, TODAY)).toBe('')
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: '2026-10-16' }, TODAY)).toBe('')
    expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: '2026-12-31' }, TODAY)).toBe('')
  })

  test('an old memory alone is the age caveat in a system-reminder, exactly as before', () => {
    expect(memoryReadNote({ mtimeMs: ago(17, 1000), expires: null }, TODAY)).toBe(
      '<system-reminder>This memory is 17 days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.</system-reminder>\n',
    )
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

  describe('contradicts:', () => {
    const saved = process.env.CLAUDIN_MEMORY_HYGIENE
    afterEach(() => {
      if (saved === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
      else process.env.CLAUDIN_MEMORY_HYGIENE = saved
    })

    test('a memory marked contradicts: names the others and asks to check before relying on either', () => {
      expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: null, contradicts: ['timeout-a', 'timeout-c'] }, TODAY)).toBe(
        '<system-reminder>It is marked as contradicting `timeout-a`, `timeout-c`: another memory says otherwise and neither settled it. Check the code, or ask, before relying on either.</system-reminder>\n',
      )
    })

    test('an empty list says nothing, and CLAUDIN_MEMORY_HYGIENE=0 drops the note', () => {
      expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: null, contradicts: [] }, TODAY)).toBe('')
      process.env.CLAUDIN_MEMORY_HYGIENE = '0'
      expect(memoryReadNote({ mtimeMs: ago(0, 1000), expires: null, contradicts: ['timeout-a'] }, TODAY)).toBe('')
    })
  })
})
