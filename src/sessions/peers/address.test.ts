import { describe, expect, test } from 'bun:test'

import {
  cleanClaimedName,
  parseAddress,
  parsePeerTarget,
  sessionDisplayName,
  sessionRefHash,
  shortestUniqueRef,
} from 'src/sessions/peers/address.js'

describe('parseAddress', () => {
  test('splits the uds and bridge schemes and treats a bare path as uds', () => {
    expect(parseAddress('uds:/run/a.sock')).toEqual({ scheme: 'uds', target: '/run/a.sock' })
    expect(parseAddress('bridge:session_1')).toEqual({ scheme: 'bridge', target: 'session_1' })
    expect(parseAddress('/run/a.sock')).toEqual({ scheme: 'uds', target: '/run/a.sock' })
    expect(parseAddress('claudin-goal')).toEqual({ scheme: 'other', target: 'claudin-goal' })
  })
})

describe('sessionDisplayName', () => {
  test('prefers the session name, then the directory', () => {
    expect(sessionDisplayName('reviewer', '/w/claudin-goal')).toBe('reviewer')
    expect(sessionDisplayName(undefined, '/w/claudin-goal')).toBe('claudin-goal')
  })

  test('drops names another address form would claim', () => {
    for (const reserved of ['main', 'Team-Lead', '*', 'a@b', 'uds:/x', 'x [3fa9c1]']) {
      expect(sessionDisplayName(reserved, '/w/claudin-loop')).toBe('claudin-loop')
    }
    expect(sessionDisplayName('main', '/')).toBe('session')
  })

  test('strips invisible characters and collapses whitespace', () => {
    expect(sessionDisplayName('a\u200b b\n\tc', '/w/x')).toBe('a b c')
    expect(cleanClaimedName('  \u202e  ')).toBeUndefined()
  })
})

describe('refs', () => {
  test('a ref is the shortest unique prefix, never under six digits', () => {
    expect(shortestUniqueRef('abcdef111', ['abcdef111', '999'])).toBe('abcdef')
    expect(shortestUniqueRef('abcdef111', ['abcdef111', 'abcdef122'])).toBe('abcdef11')
    expect(sessionRefHash('/run/a.sock')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('parsePeerTarget splits a trailing ref off the name', () => {
    expect(parsePeerTarget('claudin-goal [3fa9c1]')).toEqual({ name: 'claudin-goal', ref: '3fa9c1' })
    expect(parsePeerTarget(' claudin-goal ')).toEqual({ name: 'claudin-goal' })
    expect(parsePeerTarget('odd [name]')).toEqual({ name: 'odd [name]' })
  })
})
