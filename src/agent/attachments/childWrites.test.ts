import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  childWriteMtime,
  MAX_CHILD_WRITES,
  recordChildWrite,
  resetChildWrites,
} from 'src/agent/attachments/childWrites.js'
import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import type { SessionId } from 'src/shared/types/ids.js'

// The record is process-wide: every case starts and ends with none.
beforeEach(resetChildWrites)
afterEach(resetChildWrites)

describe('the record of what children wrote', () => {
  test('a recorded write answers with the mtime it left', () => {
    recordChildWrite('/repo/src/quote.ts', 1_000)
    expect(childWriteMtime('/repo/src/quote.ts')).toBe(1_000)
    expect(childWriteMtime('/repo/src/price.ts')).toBeUndefined()
  })

  test('a second write of a file replaces the first', () => {
    recordChildWrite('/repo/src/quote.ts', 1_000)
    recordChildWrite('/repo/src/quote.ts', 2_000)
    expect(childWriteMtime('/repo/src/quote.ts')).toBe(2_000)
  })

  test('past the cap the oldest record goes', () => {
    for (let i = 0; i < MAX_CHILD_WRITES; i++) recordChildWrite(`/repo/f${i}.ts`, i)
    expect(childWriteMtime('/repo/f0.ts')).toBe(0)

    recordChildWrite('/repo/one-more.ts', 9_000)
    expect(childWriteMtime('/repo/f0.ts')).toBeUndefined()
    expect(childWriteMtime('/repo/f1.ts')).toBe(1)
    expect(childWriteMtime('/repo/one-more.ts')).toBe(9_000)
  })

  test('a file written again is no longer the oldest', () => {
    for (let i = 0; i < MAX_CHILD_WRITES; i++) recordChildWrite(`/repo/f${i}.ts`, i)
    recordChildWrite('/repo/f0.ts', 5_000)

    recordChildWrite('/repo/one-more.ts', 9_000)
    expect(childWriteMtime('/repo/f0.ts')).toBe(5_000)
    expect(childWriteMtime('/repo/f1.ts')).toBeUndefined()
  })

  test('the reset forgets everything', () => {
    recordChildWrite('/repo/src/quote.ts', 1_000)
    resetChildWrites()
    expect(childWriteMtime('/repo/src/quote.ts')).toBeUndefined()
  })

  // The wiring: subscribed at module load, so /clear and /resume cannot drift apart.
  test('a session switch forgets everything', () => {
    const original = getSessionId()
    recordChildWrite('/repo/src/quote.ts', 1_000)
    try {
      switchSession('child-writes-switch-probe' as SessionId)
      expect(childWriteMtime('/repo/src/quote.ts')).toBeUndefined()
    } finally {
      switchSession(original)
    }
  })
})
