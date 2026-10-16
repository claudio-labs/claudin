import { describe, expect, test } from 'bun:test'
import { expiresOf, isExpired, localDay, parseExpires, validExpires } from 'src/memory/memdir/memoryExpires.js'

describe('parseExpires', () => {
  test('absent, null or blank is no expiry', () => {
    for (const value of [undefined, null, '', '   ']) expect(parseExpires(value)).toEqual({ kind: 'none' })
  })

  test('a real calendar day is a date, whitespace aside', () => {
    expect(parseExpires('2026-11-30')).toEqual({ kind: 'date', date: '2026-11-30' })
    expect(parseExpires(' 2028-02-29 ')).toEqual({ kind: 'date', date: '2028-02-29' })
  })

  test('a Date from a YAML backend that parses timestamps reads as its day', () => {
    expect(parseExpires(new Date(Date.UTC(2026, 10, 30)))).toEqual({ kind: 'date', date: '2026-11-30' })
    expect(parseExpires(new Date('nope')).kind).toBe('invalid')
  })

  test('anything else is invalid, an impossible day included', () => {
    for (const raw of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-11-3', 'next friday', '30/11/2026']) {
      expect([raw, parseExpires(raw)]).toEqual([raw, { kind: 'invalid', raw }])
    }
    expect(parseExpires(20261130)).toEqual({ kind: 'invalid', raw: '20261130' })
  })
})

describe('expiresOf', () => {
  test('validExpires keeps a valid date and drops the rest', () => {
    expect(validExpires('2026-12-01')).toBe('2026-12-01')
    expect(validExpires('2026-02-30')).toBeNull()
    expect(validExpires(undefined)).toBeNull()
  })

  test('reads the date from the frontmatter, and nothing from a file without one', () => {
    expect(expiresOf('---\nname: x\nexpires: 2026-09-30\n---\n\nbody')).toBe('2026-09-30')
    expect(expiresOf('---\nname: x\n---\n\nbody')).toBeNull()
    expect(expiresOf('---\nname: x\nexpires: soon\n---\n\nbody')).toBeNull()
    expect(expiresOf('no frontmatter at all')).toBeNull()
  })
})

describe('localDay and isExpired', () => {
  test('a memory holds through its expires day and is expired the day after', () => {
    expect(isExpired('2026-09-30', '2026-09-30')).toBe(false)
    expect(isExpired('2026-09-30', '2026-10-01')).toBe(true)
    expect(isExpired('2026-12-31', '2026-10-16')).toBe(false)
  })

  test('the day is local and zero-padded', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
